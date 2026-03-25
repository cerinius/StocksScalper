import logging

import MetaTrader5 as mt5

from config import settings

logger = logging.getLogger(__name__)


class MT5Client:
    @staticmethod
    def initialize() -> bool:
        """Initialize MT5 connection."""
        term_info = mt5.terminal_info()
        acc_info = mt5.account_info()

        # Reuse existing connection if already connected to the expected account
        if term_info is not None and acc_info is not None:
            if acc_info.login == settings.mt5_login:
                return True

        logger.info(
            "Connecting to MT5 %s (Login: %s)...",
            settings.mt5_server,
            settings.mt5_login,
        )

        init_result = mt5.initialize(
            path=settings.mt5_path,
            login=settings.mt5_login,
            password=settings.mt5_password,
            server=settings.mt5_server,
            timeout=settings.mt5_timeout_ms,
        )

        if not init_result:
            logger.error("MT5 initialization failed. Error: %s", mt5.last_error())
            return False

        logger.info("MT5 initialization successful.")
        return True

    @staticmethod
    def shutdown() -> None:
        """Cleanly shutdown MT5 session."""
        mt5.shutdown()
        logger.info("MT5 shutdown completed.")

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

        side_normalized = side.lower()
        if side_normalized not in ("buy", "sell"):
            raise ValueError("side must be 'buy' or 'sell'")

        symbol_info = mt5.symbol_info(symbol)
        if symbol_info is None:
            raise ValueError(f"Symbol not found: {symbol}")

        if not symbol_info.visible:
            selected = mt5.symbol_select(symbol, True)
            if not selected:
                raise ValueError(f"Symbol {symbol} is not visible and could not be selected")

        tick = mt5.symbol_info_tick(symbol)
        if tick is None:
            raise ValueError(f"Could not get tick for symbol {symbol}")

        order_type = mt5.ORDER_TYPE_BUY if side_normalized == "buy" else mt5.ORDER_TYPE_SELL
        price = tick.ask if order_type == mt5.ORDER_TYPE_BUY else tick.bid

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
            "type_filling": mt5.ORDER_FILLING_IOC,
        }

        result = mt5.order_send(request)
        if result is None:
            raise RuntimeError(f"Order failed: {mt5.last_error()}")

        if result.retcode != mt5.TRADE_RETCODE_DONE:
            raise RuntimeError(
                f"Order failed: retcode={result.retcode}, comment={result.comment}"
            )

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
            selected = mt5.symbol_select(pos.symbol, True)
            if not selected:
                raise ValueError(
                    f"Symbol {pos.symbol} is not visible and could not be selected"
                )

        tick = mt5.symbol_info_tick(pos.symbol)
        if tick is None:
            raise ValueError(f"Could not get tick for symbol {pos.symbol}")

        # Closing requires the opposite order type
        order_type = (
            mt5.ORDER_TYPE_SELL
            if pos.type == mt5.ORDER_TYPE_BUY
            else mt5.ORDER_TYPE_BUY
        )
        price = tick.bid if pos.type == mt5.ORDER_TYPE_BUY else tick.ask

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
            "type_filling": mt5.ORDER_FILLING_IOC,
        }

        result = mt5.order_send(request)
        if result is None:
            raise RuntimeError(f"Close failed: {mt5.last_error()}")

        if result.retcode != mt5.TRADE_RETCODE_DONE:
            raise RuntimeError(
                f"Close failed: retcode={result.retcode}, comment={result.comment}"
            )

        return {
            "ticket": result.order,
            "price": result.price,
            "volume": result.volume,
            "retcode": result.retcode,
            "comment": result.comment,
        }