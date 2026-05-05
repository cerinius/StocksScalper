"""
MT5 Account Worker
==================
One process per MT5 account. Connects to its own portable MT5 terminal
instance and exposes the full bridge API on a dedicated port.

Launched by manager.py — do NOT run directly unless debugging a single account.

Usage:
    python worker.py --account-id account_1 --port 8001
"""

import argparse
import json
import logging
import sys
import time
from contextlib import asynccontextmanager
from datetime import datetime, timedelta
from pathlib import Path
from threading import Lock
from typing import Any, Literal, Optional

import MetaTrader5 as mt5
import uvicorn
from fastapi import Depends, FastAPI, Header, HTTPException, Request, Response
from pydantic import BaseModel

# ── CLI args ─────────────────────────────────────────────────────────────────────
_parser = argparse.ArgumentParser(description="MT5 Account Worker")
_parser.add_argument("--account-id", required=True, help="Account ID from accounts.json")
_parser.add_argument("--port", type=int, required=True, help="Port to listen on")
_parser.add_argument(
    "--accounts-file",
    default=str(Path(__file__).parent / "accounts.json"),
    help="Path to accounts.json",
)
_args = _parser.parse_args()

# ── Load account config ──────────────────────────────────────────────────────────
with open(_args.accounts_file) as _f:
    _config = json.load(_f)

_account = next((a for a in _config["accounts"] if a["id"] == _args.account_id), None)
if _account is None:
    print(f"ERROR: Account '{_args.account_id}' not found in {_args.accounts_file}", flush=True)
    sys.exit(1)

ACCOUNT_ID: str = _account["id"]
ACCOUNT_NAME: str = _account.get("name", ACCOUNT_ID)
MT5_PATH: str = str(Path(_account["mt5_dir"]) / "terminal64.exe")
MT5_LOGIN: int = int(_account["login"])
MT5_PASSWORD: str = _account["password"]
MT5_SERVER: str = _account["server"]
MT5_TIMEOUT_MS: int = int(_account.get("timeout_ms", 60000))
AUTH_TOKEN: str = _config.get("bridge_auth_token", "")
PORT: int = _args.port

# ── Logging ──────────────────────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format=f"%(asctime)s [{ACCOUNT_ID}] [%(levelname)s] %(message)s",
    handlers=[logging.StreamHandler(sys.stdout)],
    force=True,
)
logger = logging.getLogger(f"worker.{ACCOUNT_ID}")


# ── Schemas ──────────────────────────────────────────────────────────────────────
class HealthResponse(BaseModel):
    connected: bool
    accountId: str
    login: Optional[int] = None
    server: Optional[str] = None
    balance: Optional[float] = None
    equity: Optional[float] = None
    error: Optional[str] = None


class AccountResponse(BaseModel):
    accountId: str
    login: int
    server: str
    balance: float
    equity: float
    margin: float
    margin_free: float
    profit: float
    currency: str
    leverage: int


class TickResponse(BaseModel):
    symbol: str
    bid: float
    ask: float
    last: float
    time: int


class PositionResponse(BaseModel):
    ticket: int
    symbol: str
    type: str
    volume: float
    price_open: float
    sl: float
    tp: float
    profit: float


class MarketOrderRequest(BaseModel):
    symbol: str
    side: Literal["buy", "sell"]
    volume: float
    sl: Optional[float] = 0.0
    tp: Optional[float] = 0.0
    comment: Optional[str] = "API order"


# ── MT5 Client ────────────────────────────────────────────────────────────────────
class MT5Client:
    """
    Thin wrapper around the MetaTrader5 module.
    The MT5 Python library is NOT thread-safe and holds global process state,
    which is why each account runs in its own process.
    """

    @staticmethod
    def initialize() -> bool:
        term_info = mt5.terminal_info()
        acc_info = mt5.account_info()

        # Reuse existing connection if already connected to the right account
        if term_info is not None and acc_info is not None:
            if acc_info.login == MT5_LOGIN:
                return True

        logger.info("Connecting to MT5 %s (login: %s) at %s", MT5_SERVER, MT5_LOGIN, MT5_PATH)
        result = mt5.initialize(
            path=MT5_PATH,
            login=MT5_LOGIN,
            password=MT5_PASSWORD,
            server=MT5_SERVER,
            timeout=MT5_TIMEOUT_MS,
        )
        if not result:
            logger.error("MT5 init failed: %s", mt5.last_error())
        return result

    @staticmethod
    def shutdown() -> None:
        mt5.shutdown()
        logger.info("MT5 shutdown.")

    @staticmethod
    def ensure_connected() -> None:
        if not MT5Client.initialize():
            raise RuntimeError(f"MT5 connection failed: {mt5.last_error()}")

    @staticmethod
    def place_market_order(
        symbol: str,
        side: str,
        volume: float,
        sl: float = 0.0,
        tp: float = 0.0,
        comment: str = "",
    ) -> dict:
        MT5Client.ensure_connected()

        side_norm = side.lower()
        if side_norm not in ("buy", "sell"):
            raise ValueError("side must be 'buy' or 'sell'")

        symbol_info = mt5.symbol_info(symbol)
        if symbol_info is None:
            raise ValueError(f"Symbol not found: {symbol}")

        if not symbol_info.visible:
            if not mt5.symbol_select(symbol, True):
                raise ValueError(f"Symbol {symbol} could not be added to Market Watch")

        tick = mt5.symbol_info_tick(symbol)
        if tick is None:
            raise ValueError(f"No tick data for {symbol}")

        order_type = mt5.ORDER_TYPE_BUY if side_norm == "buy" else mt5.ORDER_TYPE_SELL
        price = tick.ask if order_type == mt5.ORDER_TYPE_BUY else tick.bid

        # Auto-detect filling mode (bitmask: 1=FOK, 2=IOC, 4=RETURN)
        filling_flags = symbol_info.filling_mode
        if filling_flags & 4:
            filling = mt5.ORDER_FILLING_RETURN
        elif filling_flags & 1:
            filling = mt5.ORDER_FILLING_FOK
        else:
            filling = mt5.ORDER_FILLING_IOC

        request = {
            "action": mt5.TRADE_ACTION_DEAL,
            "symbol": symbol,
            "volume": float(volume),
            "type": order_type,
            "price": float(price),
            "sl": float(sl) if sl else 0.0,
            "tp": float(tp) if tp else 0.0,
            "deviation": 20,
            "magic": 100100,
            "comment": comment or "API order",
            "type_time": mt5.ORDER_TIME_GTC,
            "type_filling": filling,
        }

        result = mt5.order_send(request)
        if result is None:
            raise RuntimeError(f"Order send failed: {mt5.last_error()}")
        if result.retcode != mt5.TRADE_RETCODE_DONE:
            raise RuntimeError(f"Order failed: retcode={result.retcode}, comment={result.comment}")

        return {
            "ticket": result.order,
            "price": result.price,
            "volume": result.volume,
            "retcode": result.retcode,
            "comment": result.comment,
        }

    @staticmethod
    def close_position(ticket: int) -> dict:
        MT5Client.ensure_connected()

        positions = mt5.positions_get(ticket=ticket)
        if not positions:
            raise ValueError(f"Position {ticket} not found")
        pos = positions[0]

        symbol_info = mt5.symbol_info(pos.symbol)
        if symbol_info is None:
            raise ValueError(f"Symbol not found: {pos.symbol}")

        if not symbol_info.visible:
            if not mt5.symbol_select(pos.symbol, True):
                raise ValueError(f"Symbol {pos.symbol} could not be added to Market Watch")

        tick = mt5.symbol_info_tick(pos.symbol)
        if tick is None:
            raise ValueError(f"No tick data for {pos.symbol}")

        order_type = (
            mt5.ORDER_TYPE_SELL if pos.type == mt5.ORDER_TYPE_BUY else mt5.ORDER_TYPE_BUY
        )
        price = tick.bid if pos.type == mt5.ORDER_TYPE_BUY else tick.ask

        filling_flags = symbol_info.filling_mode
        if filling_flags & 4:
            filling = mt5.ORDER_FILLING_RETURN
        elif filling_flags & 1:
            filling = mt5.ORDER_FILLING_FOK
        else:
            filling = mt5.ORDER_FILLING_IOC

        request = {
            "action": mt5.TRADE_ACTION_DEAL,
            "symbol": pos.symbol,
            "volume": float(pos.volume),
            "type": order_type,
            "position": int(ticket),
            "price": float(price),
            "deviation": 20,
            "magic": 100100,
            "comment": "API Close",
            "type_time": mt5.ORDER_TIME_GTC,
            "type_filling": filling,
        }

        result = mt5.order_send(request)
        if result is None:
            raise RuntimeError(f"Close failed: {mt5.last_error()}")
        if result.retcode != mt5.TRADE_RETCODE_DONE:
            raise RuntimeError(f"Close failed: retcode={result.retcode}, comment={result.comment}")

        return {
            "ticket": result.order,
            "price": result.price,
            "volume": result.volume,
            "retcode": result.retcode,
            "comment": result.comment,
        }


# ── Idempotency cache ─────────────────────────────────────────────────────────────
_cache_lock = Lock()
_command_cache: dict[str, tuple[float, int, dict[str, Any]]] = {}
_COMMAND_TTL = 86400
_COMMAND_MAX = 5000


def _purge_cache(now: float) -> None:
    expired = [cid for cid, (exp, _, _) in _command_cache.items() if exp <= now]
    for cid in expired:
        _command_cache.pop(cid, None)


def _get_cached(command_id: str) -> Optional[tuple[int, dict]]:
    now = time.time()
    with _cache_lock:
        _purge_cache(now)
        entry = _command_cache.get(command_id)
        if entry is None:
            return None
        _, status, payload = entry
        return status, payload


def _store_cached(command_id: str, status: int, payload: dict) -> None:
    now = time.time()
    with _cache_lock:
        _purge_cache(now)
        if len(_command_cache) >= _COMMAND_MAX:
            oldest = min(_command_cache.items(), key=lambda e: e[1][0])[0]
            _command_cache.pop(oldest, None)
        _command_cache[command_id] = (now + _COMMAND_TTL, status, payload)


# ── Auth ──────────────────────────────────────────────────────────────────────────
import secrets


def require_auth(authorization: str | None = Header(default=None)):
    if not AUTH_TOKEN:
        raise HTTPException(status_code=500, detail="bridge_auth_token is not configured")
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing or invalid Authorization header")
    provided = authorization.split(" ", 1)[1].strip()
    if not secrets.compare_digest(provided, AUTH_TOKEN):
        raise HTTPException(status_code=401, detail="Unauthorized")


def get_command_id(request: Request) -> str:
    cid = request.headers.get("x-command-id", "").strip()
    if not cid:
        raise HTTPException(status_code=400, detail="Missing required x-command-id header")
    return cid


def check_duplicate(command_id: str) -> None:
    cached = _get_cached(command_id)
    if cached is not None:
        status, payload = cached
        raise HTTPException(
            status_code=409,
            detail={
                "error": "Duplicate command id",
                "commandId": command_id,
                "originalStatus": status,
                "originalResponse": payload,
            },
        )


# ── FastAPI app ───────────────────────────────────────────────────────────────────
@asynccontextmanager
async def lifespan(app: FastAPI):
    MT5Client.initialize()
    yield
    MT5Client.shutdown()


app = FastAPI(title=f"MT5 Worker — {ACCOUNT_NAME}", lifespan=lifespan)


@app.get("/health", response_model=HealthResponse)
def get_health():
    connected = MT5Client.initialize()
    if not connected:
        return HealthResponse(accountId=ACCOUNT_ID, connected=False, error=str(mt5.last_error()))
    acc = mt5.account_info()
    if acc is None:
        return HealthResponse(accountId=ACCOUNT_ID, connected=False, error="Could not retrieve account info")
    return HealthResponse(
        accountId=ACCOUNT_ID,
        connected=True,
        login=acc.login,
        server=acc.server,
        balance=acc.balance,
        equity=acc.equity,
    )


@app.get("/health/deep")
def get_health_deep():
    started = time.time()
    connected = MT5Client.initialize()
    term_info = mt5.terminal_info() if connected else None
    acc_info = mt5.account_info() if connected else None
    latency_ms = int((time.time() - started) * 1000)

    ok = connected and bool(term_info) and bool(acc_info)
    status = "CONNECTED" if ok else ("DEGRADED" if connected else "DISCONNECTED")
    if ok and latency_ms > 2000:
        status = "DEGRADED"

    return {
        "ok": ok,
        "accountId": ACCOUNT_ID,
        "status": status,
        "reachable": connected,
        "terminalConnected": bool(term_info),
        "brokerConnected": bool(acc_info),
        "loginMatches": bool(acc_info and acc_info.login == MT5_LOGIN),
        "latencyMs": latency_ms,
        "loginNumber": acc_info.login if acc_info else None,
        "server": acc_info.server if acc_info else None,
        "tradeAllowed": bool(getattr(term_info, "trade_allowed", False)) if term_info else False,
        "lastError": None if connected else str(mt5.last_error()),
        "timestamp": datetime.utcnow().isoformat() + "Z",
    }


@app.get("/account", response_model=AccountResponse, dependencies=[Depends(require_auth)])
def get_account():
    MT5Client.ensure_connected()
    acc = mt5.account_info()
    if acc is None:
        raise HTTPException(status_code=500, detail="Could not retrieve account info")
    return AccountResponse(
        accountId=ACCOUNT_ID,
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


@app.get("/positions", response_model=list[PositionResponse], dependencies=[Depends(require_auth)])
def get_positions():
    MT5Client.ensure_connected()
    positions = mt5.positions_get()
    results = []
    if positions:
        for p in positions:
            results.append(
                PositionResponse(
                    ticket=p.ticket,
                    symbol=p.symbol,
                    type="buy" if p.type == mt5.ORDER_TYPE_BUY else "sell",
                    volume=p.volume,
                    price_open=p.price_open,
                    sl=p.sl,
                    tp=p.tp,
                    profit=p.profit,
                )
            )
    return results


@app.get("/orders", dependencies=[Depends(require_auth)])
def get_orders():
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


@app.get("/history", dependencies=[Depends(require_auth)])
def get_history():
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


@app.get("/quote/{symbol}")
def get_quote(symbol: str):
    MT5Client.ensure_connected()
    symbol_info = mt5.symbol_info(symbol)
    if symbol_info is None:
        raise HTTPException(status_code=404, detail=f"Symbol '{symbol}' not found")
    if not symbol_info.visible:
        if not mt5.symbol_select(symbol, True):
            raise HTTPException(status_code=503, detail=f"Could not add '{symbol}' to Market Watch")
    tick = mt5.symbol_info_tick(symbol)
    if tick is None:
        raise HTTPException(status_code=503, detail=f"No tick data for '{symbol}'")
    mid = (tick.bid + tick.ask) / 2 if tick.bid and tick.ask else tick.last or 0
    spread_pct = ((tick.ask - tick.bid) / mid * 100) if mid > 0 else 0
    return {
        "symbol": symbol,
        "bid": tick.bid,
        "ask": tick.ask,
        "last": tick.last,
        "mid": round(mid, 6),
        "spreadPct": round(spread_pct, 4),
        "connected": True,
    }


@app.get("/symbols/{symbol}/tick", response_model=TickResponse, dependencies=[Depends(require_auth)])
def get_tick(symbol: str):
    MT5Client.ensure_connected()
    tick = mt5.symbol_info_tick(symbol)
    if tick is None:
        raise HTTPException(status_code=404, detail=f"No tick data for {symbol}")
    return TickResponse(symbol=symbol, bid=tick.bid, ask=tick.ask, last=tick.last, time=tick.time)


@app.post("/orders", dependencies=[Depends(require_auth)])
def place_order(req: MarketOrderRequest, request: Request):
    command_id = get_command_id(request)
    check_duplicate(command_id)
    try:
        result = MT5Client.place_market_order(
            req.symbol, req.side, req.volume, req.sl, req.tp, req.comment
        )
        payload = {"commandId": command_id, **result}
        _store_cached(command_id, 200, payload)
        return payload
    except Exception as e:
        _store_cached(command_id, 400, {"error": str(e)})
        raise HTTPException(status_code=400, detail=str(e))


@app.post("/positions/{ticket}/close", dependencies=[Depends(require_auth)])
def close_position(ticket: int, request: Request):
    command_id = get_command_id(request)
    check_duplicate(command_id)
    try:
        result = MT5Client.close_position(ticket)
        payload = {"commandId": command_id, **result}
        _store_cached(command_id, 200, payload)
        return payload
    except ValueError as e:
        _store_cached(command_id, 404, {"error": str(e)})
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        _store_cached(command_id, 400, {"error": str(e)})
        raise HTTPException(status_code=400, detail=str(e))


@app.post("/connect", dependencies=[Depends(require_auth)])
def connect():
    return {"connected": MT5Client.initialize(), "accountId": ACCOUNT_ID}


@app.post("/disconnect", dependencies=[Depends(require_auth)])
def disconnect():
    MT5Client.shutdown()
    return {"connected": False, "accountId": ACCOUNT_ID}


# ── Entry point ───────────────────────────────────────────────────────────────────
if __name__ == "__main__":
    logger.info("Starting worker for %s on port %d", ACCOUNT_NAME, PORT)
    uvicorn.run(app, host="0.0.0.0", port=PORT, log_level="info")
