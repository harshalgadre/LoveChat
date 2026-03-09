import Fastify from "fastify";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import websocket from "@fastify/websocket";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { config } from "./config";
import { WebAuthnService } from "./auth/webauthn";
import { registerAuthRoutes } from "./routes/auth";
import { registerCallRoutes } from "./routes/calls";
import { registerChatSocket } from "./routes/chatSocket";
import { registerMediaRoutes } from "./routes/media";
import { registerMessageRoutes } from "./routes/messages";
import { ChatGateway } from "./services/chatGateway";
import { MediaService } from "./services/mediaService";
import { MessagesService } from "./services/messagesService";
import { UsersService } from "./services/usersService";
import { closeMongo, ensureMongoReady } from "./storage/mongo";

export async function createServer() {
  await ensureMongoReady();

  const app = Fastify({
    logger: true
  });

  await app.register(cors, {
    origin: config.webOrigin,
    credentials: true
  });
  await app.register(cookie);
  await app.register(multipart, {
    limits: {
      // Mongo document size max is 16MB; keep upload comfortably below it.
      fileSize: 12 * 1024 * 1024
    }
  });
  await app.register(websocket);

  const usersService = new UsersService();
  const webAuthnService = new WebAuthnService(usersService);
  const messagesService = new MessagesService();
  const mediaService = new MediaService();
  const chatGateway = new ChatGateway(messagesService);

  await registerAuthRoutes(app, { usersService, webAuthnService, messagesService, mediaService });
  await registerMessageRoutes(app, { messagesService, mediaService });
  await registerMediaRoutes(app, { mediaService });
  await registerCallRoutes(app);
  await registerChatSocket(app, { chatGateway });

  app.get("/health", async () => ({ ok: true, now: Date.now() }));

  const cleanup = setInterval(async () => {
    await mediaService.cleanupExpiredMedia();
  }, 60_000);

  app.addHook("onClose", async () => {
    clearInterval(cleanup);
    await closeMongo();
  });

  return app;
}

async function start() {
  const app = await createServer();
  await app.listen({
    host: "0.0.0.0",
    port: config.serverPort
  });
}

const isEntrypoint = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntrypoint) {
  start().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
