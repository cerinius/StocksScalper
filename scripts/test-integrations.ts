/**
 * Integration health-check script.
 * Run from the repo root:
 *   npx tsx scripts/test-integrations.ts
 */

const MT5_BRIDGE_URL = process.env.MT5_BRIDGE_URL?.replace("host.docker.internal", "localhost")
  || "http://192.168.50.65:8000";

const MT5_ADAPTER_URL = process.env.MT5_ADAPTER_URL || "http://localhost:4310";

const MT5_BRIDGE_AUTH_TOKEN = process.env.MT5_BRIDGE_AUTH_TOKEN || "local-mt5-bridge-token";

const authHeaders = {
  Authorization: `Bearer ${MT5_BRIDGE_AUTH_TOKEN}`,
  "Content-Type": "application/json",
};

async function testPolygon() {
  const apiKey = process.env.MASSIVE_API_KEY || process.env.POLYGON_API_KEY;
  console.log("\nTesting Polygon.io...");
  if (!apiKey) {
    console.error("❌ Failed: MASSIVE_API_KEY / POLYGON_API_KEY not set.");
    return;
  }
  try {
    const res = await fetch(`https://api.polygon.io/v2/reference/news?limit=1&apiKey=${apiKey}`);
    res.ok
      ? console.log("✅ Polygon.io: OK")
      : console.error(`❌ Polygon.io: ${res.status} ${res.statusText}`);
  } catch (e: any) {
    console.error("❌ Polygon.io network error:", e.message);
  }
}

async function testDiscord() {
  const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
  console.log("\nTesting Discord Webhook...");
  if (!webhookUrl) {
    console.error("❌ Failed: DISCORD_WEBHOOK_URL not set.");
    return;
  }
  try {
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "🔄 **Integration Test**: Systems are online!" }),
    });
    res.ok
      ? console.log("✅ Discord Webhook: message sent")
      : console.error(`❌ Discord Webhook: ${res.status} ${res.statusText}`);
  } catch (e: any) {
    console.error("❌ Discord network error:", e.message);
  }
}

async function testMT5BridgeDirect() {
  console.log(`\nTesting MT5 Python bridge directly at ${MT5_BRIDGE_URL} ...`);

  // 1. Health (public — no auth)
  try {
    const res = await fetch(`${MT5_BRIDGE_URL}/health`);
    const data = (await res.json()) as any;
    if (res.ok && data.connected) {
      console.log(`  ✅ /health: connected  login=${data.login}  balance=${data.balance}  equity=${data.equity}`);
    } else {
      console.error(`  ❌ /health: not connected —`, data);
    }
  } catch (e: any) {
    console.error(`  ❌ /health: unreachable — ${e.message}`);
    console.log("  ℹ️  Ensure integrations/mt5-bridge/run.ps1 is running on your Windows machine.");
    return;
  }

  // 2. Health/deep (auth required)
  try {
    const res = await fetch(`${MT5_BRIDGE_URL}/health/deep`, { headers: authHeaders });
    const data = (await res.json()) as any;
    if (res.ok) {
      console.log(`  ✅ /health/deep: terminal=${data.terminalConnected} broker=${data.brokerConnected} latency=${data.latencyMs}ms`);
    } else {
      console.error(`  ❌ /health/deep: ${res.status} —`, data);
    }
  } catch (e: any) {
    console.error(`  ❌ /health/deep error: ${e.message}`);
  }

  // 3. Account (auth required)
  try {
    const res = await fetch(`${MT5_BRIDGE_URL}/account`, { headers: authHeaders });
    const data = (await res.json()) as any;
    if (res.ok) {
      console.log(`  ✅ /account: balance=${data.balance}  equity=${data.equity}  margin_free=${data.margin_free}`);
    } else {
      console.error(`  ❌ /account: ${res.status} —`, data);
    }
  } catch (e: any) {
    console.error(`  ❌ /account error: ${e.message}`);
  }

  // 4. Positions (auth required)
  try {
    const res = await fetch(`${MT5_BRIDGE_URL}/positions`, { headers: authHeaders });
    const data = (await res.json()) as any[];
    if (res.ok) {
      console.log(`  ✅ /positions: ${data.length} open position(s)`);
      if (data.length > 0) {
        const p = data[0];
        console.log(`     First: ticket=${p.ticket}  symbol=${p.symbol}  type=${p.type}  volume=${p.volume}  price_open=${p.price_open}  profit=${p.profit}`);
      }
    } else {
      console.error(`  ❌ /positions: ${res.status} —`, data);
    }
  } catch (e: any) {
    console.error(`  ❌ /positions error: ${e.message}`);
  }

  // 5. Quote (public)
  try {
    const res = await fetch(`${MT5_BRIDGE_URL}/quote/EURUSD`, { headers: authHeaders });
    const data = (await res.json()) as any;
    if (res.ok) {
      console.log(`  ✅ /quote/EURUSD: bid=${data.bid}  ask=${data.ask}  spread=${data.spreadPct}%`);
    } else {
      console.error(`  ❌ /quote/EURUSD: ${res.status} —`, data);
    }
  } catch (e: any) {
    console.error(`  ❌ /quote error: ${e.message}`);
  }
}

async function testMT5AdapterProxy() {
  console.log(`\nTesting MT5 Node adapter (proxy layer) at ${MT5_ADAPTER_URL} ...`);

  // 1. Health
  try {
    const res = await fetch(`${MT5_ADAPTER_URL}/health`);
    const data = (await res.json()) as any;
    if (res.ok) {
      console.log(`  ✅ /health: bridgeConnected=${data.bridgeConnected}  bridgeUrl=${data.bridgeUrl}`);
      if (!data.bridgeConnected) {
        console.warn(`  ⚠️  Bridge not connected — bridgeError: ${data.bridgeError}`);
      }
    } else {
      console.error(`  ❌ /health: ${res.status} —`, data);
    }
  } catch (e: any) {
    console.error(`  ❌ Adapter unreachable at ${MT5_ADAPTER_URL} — ${e.message}`);
    console.log("  ℹ️  Start the stack with: docker compose up -d");
    return;
  }

  // 2. Health/deep
  try {
    const res = await fetch(`${MT5_ADAPTER_URL}/health/deep`);
    const data = (await res.json()) as any;
    console.log(`  ✅ /health/deep: terminal=${data.terminalConnected} broker=${data.brokerConnected} latency=${data.latencyMs}ms loginMatches=${data.loginMatches}`);
  } catch (e: any) {
    console.error(`  ❌ /health/deep error: ${e.message}`);
  }

  // 3. Account (proxied)
  try {
    const res = await fetch(`${MT5_ADAPTER_URL}/account`);
    const data = (await res.json()) as any;
    if (res.ok) {
      console.log(`  ✅ /account: balance=${data.balance}  equity=${data.equity}  riskState=${data.riskState}  mode=${data.mode}`);
    } else {
      console.error(`  ❌ /account: ${res.status} —`, data);
    }
  } catch (e: any) {
    console.error(`  ❌ /account error: ${e.message}`);
  }

  // 4. Positions (proxied)
  try {
    const res = await fetch(`${MT5_ADAPTER_URL}/positions`);
    const data = (await res.json()) as any[];
    if (res.ok) {
      console.log(`  ✅ /positions: ${Array.isArray(data) ? data.length : "?"} open position(s)`);
    } else {
      console.error(`  ❌ /positions: ${res.status} —`, data);
    }
  } catch (e: any) {
    console.error(`  ❌ /positions error: ${e.message}`);
  }

  // 5. Quote (proxied)
  try {
    const res = await fetch(`${MT5_ADAPTER_URL}/quote/EURUSD`);
    const data = (await res.json()) as any;
    if (res.ok) {
      console.log(`  ✅ /quote/EURUSD: bid=${data.bid}  ask=${data.ask}  spread=${data.spreadPct}%`);
    } else {
      console.error(`  ❌ /quote/EURUSD: ${res.status} —`, data);
    }
  } catch (e: any) {
    console.error(`  ❌ /quote error: ${e.message}`);
  }
}

async function runAll() {
  console.log("=============================================");
  console.log("      INTEGRATION HEALTH CHECK               ");
  console.log("=============================================");

  await testPolygon();
  await testDiscord();
  await testMT5BridgeDirect();
  await testMT5AdapterProxy();

  console.log("\n=============================================");
  console.log("                 DONE                        ");
  console.log("=============================================\n");
}

runAll().catch(console.error);
