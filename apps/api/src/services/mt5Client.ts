type MarketOrderPayload = {
  symbol: string;
  side: 'buy' | 'sell';
  volume: number;
  sl?: number;
  tp?: number;
  comment?: string;
};

type ClosePositionPayload = {
  position_ticket: number;
};

export class MT5Error extends Error {
  constructor(public statusCode: number, message: string) {
    super(message);
    this.name = 'MT5Error';
  }
}

export class MT5Client {
  private readonly baseUrl: string;

  constructor(baseUrl?: string) {
    this.baseUrl = (baseUrl || process.env.MT5_BRIDGE_URL || 'http://host.docker.internal:8000').replace(/\/+$/, '');
  }

  private async request<T>(endpoint: string, options?: RequestInit): Promise<T> {
    const url = `${this.baseUrl}${endpoint}`;

    const timeoutMs = parseInt(process.env.MT5_TERMINAL_TIMEOUT || '10000', 10);
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        ...options,
        headers: {
          'Content-Type': 'application/json',
          ...(options?.headers ?? {}),
        },
        signal: controller.signal,
      });

      if (!response.ok) {
        let errData: unknown = {};
        try {
          errData = await response.json();
        } catch {
          errData = {};
        }

        const detail =
          typeof errData === 'object' &&
          errData !== null &&
          'detail' in errData &&
          typeof (errData as { detail?: unknown }).detail === 'string'
            ? (errData as { detail: string }).detail
            : response.statusText;

        throw new MT5Error(response.status, `MT5 Bridge Error: ${response.status} - ${detail}`);
      }

      return (await response.json()) as T;
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new MT5Error(504, `MT5 Bridge timeout calling ${endpoint}`);
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async getHealth() {
    return this.request('/health');
  }

  async getAccount() {
    return this.request('/account');
  }

  async getSymbolTick(symbol: string) {
    return this.request(`/symbols/${encodeURIComponent(symbol)}/tick`);
  }

  async getPositions() {
    return this.request('/positions');
  }

  async getHistoryOrders(days: number = 30) {
    return this.request(`/history/orders?days=${days}`);
  }

  async getHistoryDeals(days: number = 30) {
    return this.request(`/history/deals?days=${days}`);
  }

  async placeMarketOrder(payload: MarketOrderPayload) {
    return this.request('/orders/market', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  }

  async closePosition(payload: ClosePositionPayload) {
    return this.request('/orders/close', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  }
}