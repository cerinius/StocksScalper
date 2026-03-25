from pydantic import BaseModel
from typing import Literal, Optional


class HealthResponse(BaseModel):
    connected: bool
    login: Optional[int] = None
    server: Optional[str] = None
    balance: Optional[float] = None
    equity: Optional[float] = None
    error: Optional[str] = None


class AccountResponse(BaseModel):
    login: int
    server: str
    balance: float
    equity: float
    margin: float
    margin_free: float
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


class ClosePositionRequest(BaseModel):
    position_ticket: int
    symbol: str
    volume: float