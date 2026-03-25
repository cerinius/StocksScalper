import { setInterval } from 'timers/promises';
import { prisma } from '@stock-radar/db';

/**
 * Note: Ensure you have `Mt5Order` and `Mt5Deal` models mapped to your Postgres DB 
 * in your packages/db/schema.prisma before running this script.
 */

const API_URL = (process.env.API_BASE_URL || 'http://localhost:4210').replace(/\/+$/, '');
const SYNC_INTERVAL = parseInt(process.env.MT5_SYNC_INTERVAL_MS || '30000', 10);
const DAYS_TO_SYNC = 7; // Number of days to continuously cache retroactively

async function fetchFromApi(endpoint: string) {
  const res = await fetch(`${API_URL}${endpoint}`);
  if (!res.ok) {
    throw new Error(`API Error: ${res.status} ${res.statusText}`);
  }
  return res.json();
}

async function syncOrders() {
  try {
    console.log(`[MT5 Sync] Fetching orders for last ${DAYS_TO_SYNC} days...`);
    const orders = await fetchFromApi(`/mt5/history/orders?days=${DAYS_TO_SYNC}`);
    
    for (const order of orders) {
      await prisma.mt5Order.upsert({
        where: { ticket: BigInt(order.ticket) },
        update: {
          state: order.state,
          volumeCurrent: order.volume_current,
          priceCurrent: order.price_current,
          timeDone: new Date(order.time_done * 1000),
        },
        create: {
          ticket: BigInt(order.ticket),
          symbol: order.symbol,
          type: order.type,
          state: order.state,
          volumeInitial: order.volume_initial,
          volumeCurrent: order.volume_current,
          priceOpen: order.price_open,
          sl: order.sl,
          tp: order.tp,
          priceCurrent: order.price_current,
          comment: order.comment,
          timeSetup: new Date(order.time_setup * 1000),
          timeDone: new Date(order.time_done * 1000),
        },
      });
    }
    console.log(`[MT5 Sync] Successfully synced ${orders.length} orders.`);
  } catch (error: any) {
    console.error(`[MT5 Sync] Error syncing orders:`, error.message);
  }
}

async function syncDeals() {
  try {
    console.log(`[MT5 Sync] Fetching deals for last ${DAYS_TO_SYNC} days...`);
    const deals = await fetchFromApi(`/mt5/history/deals?days=${DAYS_TO_SYNC}`);
    
    for (const deal of deals) {
      await prisma.mt5Deal.upsert({
        where: { ticket: BigInt(deal.ticket) },
        update: {}, // Deals are immutable execution receipts, no update logic needed once stored
        create: {
          ticket: BigInt(deal.ticket),
          orderId: BigInt(deal.order),
          symbol: deal.symbol,
          type: deal.type,
          entry: deal.entry,
          volume: deal.volume,
          price: deal.price,
          profit: deal.profit,
          commission: deal.commission,
          swap: deal.swap,
          fee: deal.fee,
          comment: deal.comment,
          time: new Date(deal.time * 1000),
        },
      });
    }
    console.log(`[MT5 Sync] Successfully synced ${deals.length} deals.`);
  } catch (error: any) {
    console.error(`[MT5 Sync] Error syncing deals:`, error.message);
  }
}

async function start() {
  console.log(`[MT5 Sync] Starting background sync worker. Polling interval: ${SYNC_INTERVAL}ms`);
  
  // Continuous loop caching logic
  for await (const _ of setInterval(SYNC_INTERVAL)) {
    await syncOrders();
    await syncDeals();
  }
}

start().catch(console.error);