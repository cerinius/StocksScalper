# Stock Radar

US swing-first scanner with scalping support. Provides a Fastify API, BullMQ workers, and a Next.js dashboard.

## Requirements

- Node.js 20+
- Docker + Docker Compose

## Quick start (Docker)

```bash
cp .env.example .env
npm install
npm run prisma:generate -w packages/db
npm run build -w packages/core -w packages/db -w apps/api -w apps/worker -w apps/web

docker compose up --build
```

Visit:
- API: http://localhost:3001
- Docs: http://localhost:3001/docs
- Web: http://localhost:3000

## Local dev

```bash
npm install
npm run prisma:generate -w packages/db
npm run dev -w apps/api
npm run dev -w apps/worker
npm run dev -w apps/web
```

## Configuration

Set these in `.env`:

```
DATABASE_URL=postgresql://stockradar:stockradar@localhost:5432/stockradar
REDIS_URL=redis://localhost:6379
DATA_PROVIDER=polygon|mock
POLYGON_API_KEY=
NEWS_PROVIDER=polygon|mock
WEBHOOK_SECRET=changeme
MARKET_TIMEZONE=America/New_York
NEXT_PUBLIC_API_BASE=http://localhost:3001
```

## TradingView webhook

POST `/api/tradingview/webhook` with header `x-webhook-secret`.

Example payload:

```json
{
  "symbol": "AAPL",
  "eventType": "orb_break",
  "payload": { "level": 188.5 }
}
```

Sample Pine Script snippet:

```pinescript
//@version=5
indicator("Stock Radar Alert", overlay=true)
orbHigh = ta.highest(high, 5)
orbBreak = ta.crossover(close, orbHigh)
alertcondition(orbBreak, title="ORB Break", message="ORB breakout")
```

## Disclaimer

This tool is for research/education. Not financial advice. Markets are risky.
