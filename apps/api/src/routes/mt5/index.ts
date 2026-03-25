import type { FastifyPluginAsync } from 'fastify';
import { MT5Client, MT5Error } from '../../services/mt5Client';

type SymbolTickParams = {
  symbol: string;
};

type HistoryOrdersQuerystring = {
  days?: number;
};

type MarketOrderBody = {
  symbol: string;
  side: 'buy' | 'sell';
  volume: number;
  sl?: number;
  tp?: number;
  comment?: string;
};

type ClosePositionBody = {
  position_ticket: number;
};

const mt5Routes: FastifyPluginAsync = async (fastify) => {
  const mt5Client = new MT5Client();

  fastify.get('/health', async (request, reply) => {
    try {
      const data = await mt5Client.getHealth();
      return reply.send(data);
    } catch (error) {
      const statusCode = error instanceof MT5Error ? error.statusCode : 500;
      const message = error instanceof Error ? error.message : 'Unknown error';
      request.log.error({ err: error }, 'Failed to connect to MT5 Bridge');

      return reply.status(statusCode).send({
        error: 'Failed to connect to MT5 Bridge',
        details: message,
      });
    }
  });

  fastify.get('/account', async (request, reply) => {
    try {
      const data = await mt5Client.getAccount();
      return reply.send(data);
    } catch (error) {
      const statusCode = error instanceof MT5Error ? error.statusCode : 500;
      const message = error instanceof Error ? error.message : 'Unknown error';
      request.log.error({ err: error }, 'Failed to retrieve account info');

      return reply.status(statusCode).send({
        error: 'Failed to retrieve account info',
        details: message,
      });
    }
  });

  fastify.get<{ Params: SymbolTickParams }>(
    '/symbols/:symbol/tick',
    {
      schema: {
        params: {
          type: 'object',
          required: ['symbol'],
          properties: {
            symbol: { type: 'string' }
          }
        }
      }
    },
    async (request, reply) => {
      const { symbol } = request.params;

      try {
        const data = await mt5Client.getSymbolTick(symbol);
        return reply.send(data);
      } catch (error) {
        const statusCode = error instanceof MT5Error ? error.statusCode : 500;
        const message = error instanceof Error ? error.message : 'Unknown error';
        request.log.error({ err: error, symbol }, 'Failed to retrieve symbol tick');

        return reply.status(statusCode).send({
          error: `Failed to retrieve tick for ${symbol}`,
          details: message,
        });
      }
    }
  );

  fastify.get('/positions', async (request, reply) => {
    try {
      const data = await mt5Client.getPositions();
      return reply.send(data);
    } catch (error) {
      const statusCode = error instanceof MT5Error ? error.statusCode : 500;
      const message = error instanceof Error ? error.message : 'Unknown error';
      request.log.error({ err: error }, 'Failed to retrieve positions');

      return reply.status(statusCode).send({
        error: 'Failed to retrieve positions',
        details: message,
      });
    }
  });

  fastify.get<{ Querystring: HistoryOrdersQuerystring }>(
    '/history/orders',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: {
            days: { type: 'number', minimum: 1, maximum: 365 }
          }
        }
      }
    },
    async (request, reply) => {
      const days = request.query.days || 30;
      try {
        const data = await mt5Client.getHistoryOrders(days);
        return reply.send(data);
      } catch (error) {
        const statusCode = error instanceof MT5Error ? error.statusCode : 500;
        const message = error instanceof Error ? error.message : 'Unknown error';
        request.log.error({ err: error, days }, 'Failed to retrieve history orders');
        return reply.status(statusCode).send({ error: 'Failed to retrieve history orders', details: message });
      }
    }
  );

  fastify.get<{ Querystring: HistoryOrdersQuerystring }>(
    '/history/deals',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: {
            days: { type: 'number', minimum: 1, maximum: 365 }
          }
        }
      }
    },
    async (request, reply) => {
      const days = request.query.days || 30;
      try {
        const data = await mt5Client.getHistoryDeals(days);
        return reply.send(data);
      } catch (error) {
        const statusCode = error instanceof MT5Error ? error.statusCode : 500;
        const message = error instanceof Error ? error.message : 'Unknown error';
        request.log.error({ err: error, days }, 'Failed to retrieve history deals');
        return reply.status(statusCode).send({ error: 'Failed to retrieve history deals', details: message });
      }
    }
  );

  fastify.post<{ Body: MarketOrderBody }>(
    '/orders/market',
    {
      schema: {
        body: {
          type: 'object',
          required: ['symbol', 'side', 'volume'],
          properties: {
            symbol: { type: 'string' },
            side: { type: 'string', enum: ['buy', 'sell'] },
            volume: { type: 'number', minimum: 0.01 },
            sl: { type: 'number' },
            tp: { type: 'number' },
            comment: { type: 'string' }
          }
        }
      }
    },
    async (request, reply) => {
      const body = request.body;

      try {
        const data = await mt5Client.placeMarketOrder(body);
        return reply.send(data);
      } catch (error) {
        const statusCode = error instanceof MT5Error ? error.statusCode : 400;
        const message = error instanceof Error ? error.message : 'Unknown error';
        request.log.error({ err: error, body }, 'Order failed');

        return reply.status(statusCode).send({
          error: 'Order failed',
          details: message,
        });
      }
    }
  );

  fastify.post<{ Body: ClosePositionBody }>(
    '/orders/close',
    {
      schema: {
        body: {
          type: 'object',
          required: ['position_ticket'],
          properties: {
            position_ticket: { type: 'number' }
          }
        }
      }
    },
    async (request, reply) => {
      const body = request.body;

      try {
        const data = await mt5Client.closePosition(body);
        return reply.send(data);
      } catch (error) {
        const statusCode = error instanceof MT5Error ? error.statusCode : 400;
        const message = error instanceof Error ? error.message : 'Unknown error';
        request.log.error({ err: error, body }, 'Failed to close position');

        return reply.status(statusCode).send({
          error: 'Failed to close position',
          details: message,
        });
      }
    }
  );
};

export default mt5Routes;