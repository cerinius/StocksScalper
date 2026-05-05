from datetime import datetime, timedelta
from threading import Lock
import secrets
import time
from typing import Any

import MetaTrader5 as mt5
from fastapi import Depends, FastAPI, Header, HTTPException, Request
from contextlib import asynccontextmanager

from schemas import (
    AccountResponse,
    ClosePositionRequest,
    HealthResponse,
    MarketOrderRequest,
    PositionResponse,
    TickResponse,
)
from mt5_client import MT5Client
from config import settings


@asynccontextmanager
async def lifespan(app: FastAPI):
    MT5Client.initialize()
    yield
    MT5Client.shutdown()


app = FastAPI(title="MT5 Bridge API", lifespan=lifespan)


_command_cache_lock = Lock()
_command_cache: dict[str, tuple[float, int, dict[str, Any]]] = {}


def require_bridge_auth(authorization: str | None = Header(default=None)):
    expected = settings.bridge_auth_token.strip()
    if not expected:
        raise HTTPException(status_code=500, detail="BRIDGE_AUTH_TOKEN is not configured")

    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing or invalid Authorization header")

    provided = authorization.split(" ", 1)[1].strip()
    if not secrets.compare_digest(provided, expected):
        raise HTTPException(status_code=401, detail="Unauthorized")


def _purge_expired_command_cache(now_ts: float) -> None:
    ttl = max(1, settings.command_id_ttl_seconds)
    expired = [command_id for command_id, (expires_at, _status, _payload) in _command_cache.items() if expires_at <= now_ts]
    for command_id in expired:
        _command_cache.pop(command_id, None)


def _get_cached_command(command_id: str) -> tuple[int, dict[str, Any]] | None:
    now_ts = time.time()
    with _command_cache_lock:
        _purge_expired_command_cache(now_ts)
        cached = _command_cache.get(command_id)
        if not cached:
            return None
        _expires_at, status_code, payload = cached
        return status_code, payload


def _store_cached_command(command_id: str, status_code: int, payload: dict[str, Any]) -> None:
    now_ts = time.time()
    ttl = max(1, settings.command_id_ttl_seconds)
    with _command_cache_lock:
        _purge_expired_command_cache(now_ts)
        if len(_command_cache) >= max(1, settings.command_id_cache_max_entries):
            oldest_key = min(_command_cache.items(), key=lambda entry: entry[1][0])[0]
            _command_cache.pop(oldest_key, None)
        _command_cache[command_id] = (now_ts + ttl, status_code, payload)


def _extract_required_command_id(request: Request) -> str:
    command_id = request.headers.get("x-command-id", "").strip()
    if not command_id:
        raise HTTPException(status_code=400, detail="Missing required x-command-id header")
    return command_id


def _check_duplicate_command(command_id: str) -> None:
    cached = _get_cached_command(command_id)
    if cached is None:
        return
    status_code, payload = cached
    raise HTTPException(
        status_code=409,
        detail={
            "error": "Duplicate command id",
            "commandId": command_id,
            "originalStatus": status_code,
            "originalResponse": payload,
        },
    )


@app.get("/health", response_model=HealthResponse)
def get_health():
    """Public status endpoint — no auth required so monitoring tools can poll freely."""
    connected = MT5Client.initialize()
    if not connected:
        return HealthResponse(connected=False, error=str(mt5.last_error()))

    acc = mt5.account_info()
    if acc is None:
        return HealthResponse(
            connected=False,
            error="Could not retrieve account info",
        )

    return HealthResponse(
        connected=True,
        login=acc.login,
        server=acc.server,
        balance=acc.balance,
        equity=acc.equity,
    )


@app.get("/health/deep")
def get_health_deep():
    started_at = time.time()
    connected = MT5Client.initialize()
    term_info = mt5.terminal_info() if connected else None
    acc_info = mt5.account_info() if connected else None

    latency_ms = int((time.time() - started_at) * 1000)
    terminal_connected = bool(term_info)
    broker_connected = bool(acc_info)
    login_matches = bool(acc_info and acc_info.login == settings.mt5_login)
    status = "CONNECTED"
    if not connected or not terminal_connected or not broker_connected:
        status = "DISCONNECTED"
    elif latency_ms > 2000:
        status = "DEGRADED"

    return {
        "ok": connected and terminal_connected and broker_connected,
        "reachable": connected,
        "bridgeConnected": connected and terminal_connected,
        "terminalConnected": terminal_connected,
        "brokerConnected": broker_connected,
        "loginMatches": login_matches,
        "latencyMs": latency_ms,
        "status": status,
        "loginNumber": acc_info.login if acc_info else None,
        "server": acc_info.server if acc_info else None,
        "tradeAllowed": bool(getattr(term_info, "trade_allowed", False)) if term_info else False,
        "lastTickTime": None,
        "lastError": None if connected else str(mt5.last_error()),
        "timestamp": datetime.utcnow().isoformat() + "Z",
    }


@app.get("/account", response_model=AccountResponse, dependencies=[Depends(require_bridge_auth)])
def get_account():
    try:
        MT5Client.ensure_connected()
        acc = mt5.account_info()
        if acc is None:
            raise HTTPException(status_code=500, detail="Could not retrieve account info")

        return AccountResponse(
            login=acc.login,
            server=acc.server,
            balance=acc.balance,
            equity=acc.equity,
            margin=acc.margin,
            margin_free=acc.margin_free,
            profit=acc.profit,
            currency=acc.currency,
            leverage=acc.leverage,
        )
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/symbols/{symbol}/tick", response_model=TickResponse, dependencies=[Depends(require_bridge_auth)])
def get_tick(symbol: str):
    try:
        MT5Client.ensure_connected()
        tick = mt5.symbol_info_tick(symbol)
        if tick is None:
            raise HTTPException(
                status_code=404,
                detail=f"Tick data not found for {symbol}",
            )

        return TickResponse(
            symbol=symbol,
            bid=tick.bid,
            ask=tick.ask,
            last=tick.last,
            time=tick.time,
        )
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/positions", response_model=list[PositionResponse], dependencies=[Depends(require_bridge_auth)])
def get_positions():
    try:
        MT5Client.ensure_connected()
        positions = mt5.positions_get()

        results: list[PositionResponse] = []
        if positions:
            for p in positions:
                type_str = "buy" if p.type == mt5.ORDER_TYPE_BUY else "sell"
                results.append(
                    PositionResponse(
                        ticket=p.ticket,
                        symbol=p.symbol,
                        type=type_str,
                        volume=p.volume,
                        price_open=p.price_open,
                        sl=p.sl,
                        tp=p.tp,
                        profit=p.profit,
                    )
                )

        return results
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/orders", dependencies=[Depends(require_bridge_auth)])
def place_order(req: MarketOrderRequest, request: Request):
    command_id = _extract_required_command_id(request)
    _check_duplicate_command(command_id)

    try:
        result = MT5Client.place_market_order(
            req.symbol,
            req.side,
            req.volume,
            req.sl,
            req.tp,
            req.comment,
        )
        payload = {"commandId": command_id, **result}
        _store_cached_command(command_id, 200, payload)
        return payload
    except Exception as e:
        _store_cached_command(command_id, 400, {"error": str(e)})
        raise HTTPException(status_code=400, detail=str(e))


@app.post("/positions/{ticket}/close", dependencies=[Depends(require_bridge_auth)])
def close_position(ticket: int, request: Request):
    command_id = _extract_required_command_id(request)
    _check_duplicate_command(command_id)

    try:
        result = MT5Client.close_position(ticket)
        payload = {"commandId": command_id, **result}
        _store_cached_command(command_id, 200, payload)
        return payload
    except ValueError as e:
        _store_cached_command(command_id, 404, {"error": str(e)})
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        _store_cached_command(command_id, 400, {"error": str(e)})
        raise HTTPException(status_code=400, detail=str(e))


@app.post("/connect", dependencies=[Depends(require_bridge_auth)])
def connect():
    connected = MT5Client.initialize()
    return {"connected": connected}


@app.post("/disconnect", dependencies=[Depends(require_bridge_auth)])
def disconnect():
    MT5Client.shutdown()
    return {"connected": False}


@app.get("/quote/{symbol}")
def get_quote(symbol: str):
    try:
        MT5Client.ensure_connected()

        # Ensure symbol is in Market Watch before querying tick
        # (MT5 only returns tick data for symbols visible in Market Watch)
        symbol_info = mt5.symbol_info(symbol)
        if symbol_info is None:
            raise HTTPException(
                status_code=404,
                detail=f"Symbol '{symbol}' not found in MT5. Check the symbol name matches your broker's format (e.g. XAUUSD, EURUSD).",
            )

        if not symbol_info.visible:
            if not mt5.symbol_select(symbol, True):
                raise HTTPException(
                    status_code=503,
                    detail=f"Could not add '{symbol}' to Market Watch: {mt5.last_error()}",
                )

        tick = mt5.symbol_info_tick(symbol)
        if tick is None:
            raise HTTPException(
                status_code=503,
                detail=f"No tick data available for '{symbol}'. MT5 error: {mt5.last_error()}",
            )

        mid = (tick.bid + tick.ask) / 2 if (tick.bid and tick.ask) else tick.last or 0
        spread_pct = ((tick.ask - tick.bid) / mid * 100) if mid > 0 else 0

        return {
            "symbol": symbol,
            "bid": tick.bid,
            "ask": tick.ask,
            "last": tick.last,
            "mid": round(mid, 6),
            "spread": round(spread_pct, 4),
            "spreadPct": round(spread_pct, 4),
            "connected": True,
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/orders", dependencies=[Depends(require_bridge_auth)])
def get_orders():
    try:
        MT5Client.ensure_connected()
        orders = mt5.orders_get()

        results = []
        if orders:
            for o in orders:
                results.append({
                    "ticket": o.ticket,
                    "symbol": o.symbol,
                    "type": "buy" if o.type == mt5.ORDER_TYPE_BUY else "sell",
                    "volume": o.volume_initial,
                    "price": o.price_open,
                    "sl": o.sl,
                    "tp": o.tp,
                    "status": "pending",
                })

        return results
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/history", dependencies=[Depends(require_bridge_auth)])
def get_history():
    try:
        MT5Client.ensure_connected()
        from_date = datetime.now() - timedelta(days=30)
        deals = mt5.history_deals_get(from_date)

        results = []
        if deals:
            for d in deals:
                if d.type in [mt5.DEAL_TYPE_BUY, mt5.DEAL_TYPE_SELL]:
                    results.append({
                        "ticket": d.ticket,
                        "symbol": d.symbol,
                        "type": "buy" if d.type == mt5.DEAL_TYPE_BUY else "sell",
                        "volume": d.volume,
                        "price": d.price,
                        "profit": d.profit,
                        "time": d.time,
                    })

        return results
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
