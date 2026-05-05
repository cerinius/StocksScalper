import type { StructuredDecision } from "@stock-radar/types";
import { stableHash } from "@stock-radar/shared";
import type { AccountContext } from "./types";

export interface PlaceOrderInputs {
  mt5AdapterUrl: string;
  account: AccountContext;
  decision: StructuredDecision;
  decisionId: string;
  candidateId: string;
}

export interface PlaceOrderResult {
  ok: boolean;
  status: number;
  clientOrderId: string;
  brokerOrderId: string | null;
  orderStatus: string | null;
  errorMessage: string | null;
  raw: unknown;
}

/**
 * Send an order to the MT5 adapter. Attaches an idempotent
 * X-Command-Id header (hash of decisionId + account + symbol +
 * minute) so retries are de-duplicated by the bridge.
 *
 * The bridge is expected to reject duplicate client order IDs within
 * a short window. Phase D will add bridge-side command-id tracking.
 */
export const placeOrder = async (inputs: PlaceOrderInputs): Promise<PlaceOrderResult> => {
  const { account, decision } = inputs;
  if (!decision.executionParameters) {
    throw new Error("placeOrder called with no executionParameters on decision");
  }
  const params = decision.executionParameters;
  const clientOrderId = stableHash({
    decisionId: inputs.decisionId,
    accountId: account.accountId,
    symbol: params.symbol,
    direction: params.direction,
    minute: new Date().toISOString().slice(0, 16),
  });

  let response: Response;
  try {
    response = await fetch(`${inputs.mt5AdapterUrl}/orders`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-command-id": clientOrderId,
        "x-account-id": account.accountId,
        "x-integration-id": account.integrationId,
      },
      body: JSON.stringify({
        ...params,
        decisionId: inputs.decisionId,
        accountId: account.accountId,
        clientOrderId,
      }),
    });
  } catch (err) {
    return {
      ok: false,
      status: 0,
      clientOrderId,
      brokerOrderId: null,
      orderStatus: null,
      errorMessage: `bridge unreachable: ${(err as Error).message}`,
      raw: null,
    };
  }

  const raw = (await response.json().catch(() => null)) as
    | { orderId?: string; brokerOrderId?: string; status?: string; reason?: string; error?: string; detail?: string }
    | null;

  if (!response.ok) {
    const errorMessage =
      raw?.reason ??
      raw?.error ??
      raw?.detail ??
      `Broker rejected order with status ${response.status}.`;
    return {
      ok: false,
      status: response.status,
      clientOrderId,
      brokerOrderId: raw?.brokerOrderId ?? null,
      orderStatus: null,
      errorMessage,
      raw,
    };
  }

  return {
    ok: true,
    status: response.status,
    clientOrderId,
    brokerOrderId: raw?.brokerOrderId ?? null,
    orderStatus: raw?.status ?? "SUBMITTED",
    errorMessage: null,
    raw,
  };
};
