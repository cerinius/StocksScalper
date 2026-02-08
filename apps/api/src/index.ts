import Fastify from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import { universeRoutes } from "./routes/universe";
import { symbolRoutes } from "./routes/symbols";
import { setupRoutes } from "./routes/setups";
import { journalRoutes } from "./routes/journal";
import { jobRoutes } from "./routes/jobs";
import { tradingViewRoutes } from "./routes/tradingview";

const app = Fastify({ logger: true });

const start = async () => {
  await app.register(cors, { origin: true });
  await app.register(helmet);
  await app.register(swagger, {
    swagger: {
      info: {
        title: "Stock Radar API",
        version: "0.1.0",
      },
    },
  });
  await app.register(swaggerUi, { routePrefix: "/docs" });

  await app.register(universeRoutes);
  await app.register(symbolRoutes);
  await app.register(setupRoutes);
  await app.register(journalRoutes);
  await app.register(jobRoutes);
  await app.register(tradingViewRoutes);

  const port = Number(process.env.PORT ?? "3001");
  await app.listen({ port, host: "0.0.0.0" });
};

start().catch((error) => {
  app.log.error(error);
  process.exit(1);
});
