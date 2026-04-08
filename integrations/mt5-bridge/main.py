from datetime import datetime, timedelta

import MetaTrader5 as mt5
from fastapi import FastAPI, HTTPException
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


@asynccontextmanager
async def lifespan(app: FastAPI):
    MT5Client.initialize()
    yield
    MT5Client.shutdown()


app = FastAPI(title="MT5 Bridge API", lifespan=lifespan)


@app.get("/health", response_model=HealthResponse)
def get_health():
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


@app.get("/account", response_model=AccountResponse)
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


@app.get("/symbols/{symbol}/tick", response_model=TickResponse)
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


@app.get("/positions", response_model=list[PositionResponse])
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


@app.post("/orders")
def place_order(req: MarketOrderRequest):
    try:
        return MT5Client.place_market_order(
            req.symbol,
            req.side,
            req.volume,
            req.sl,
            req.tp,
            req.comment,
        )
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.post("/positions/{ticket}/close")
def close_position(ticket: int):
    try:
        return MT5Client.close_position(ticket)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.post("/connect")
def connect():
    connected = MT5Client.initialize()
    return {"connected": connected}


@app.post("/disconnect")
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


@app.get("/orders")
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


@app.get("/history")
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
