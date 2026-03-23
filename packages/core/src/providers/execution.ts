import type {
  AccountStateSnapshot,
  ExecutionPositionSnapshot,
  Mt5ConnectRequest,
  Mt5OrderRequest,
  OrderStatus,
  PositionStatus,
  TradingMode,
} from "../types";

export interface ExecutionOrderResult {
  orderId: string;
  brokerOrderId: string;
  status: OrderStatus;
  reason?: string;
}

export interface ExecutionPositionResult extends ExecutionPositionSnapshot {
  positionId: string;
  status: PositionStatus;
}

export interface ExecutionAdapter {
  connect(request: Mt5ConnectRequest): Promise<{ connected: boolean; mode: TradingMode }>;
  disconnect(): Promise<{ connected: boolean }>;
  getHealth(): Promise<{ connected: boolean; mode: TradingMode; lastSyncAt: string }>;
  getAccountState(): Promise<AccountStateSnapshot>;
  getPositions(): Promise<ExecutionPositionResult[]>;
  getOrders(): Promise<Array<ExecutionOrderResult & { symbol: string; createdAt: string }>>;
  placeOrder(request: Mt5OrderRequest): Promise<ExecutionOrderResult>;
  closePosition(positionId: string): Promise<{ closed: boolean; reason?: string }>;
}
