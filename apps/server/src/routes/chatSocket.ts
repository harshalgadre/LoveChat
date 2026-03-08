import type { FastifyInstance } from "fastify";

import { verifyWsToken } from "../auth/session";
import { ChatGateway } from "../services/chatGateway";

interface ChatSocketDeps {
  chatGateway: ChatGateway;
}

export async function registerChatSocket(app: FastifyInstance, deps: ChatSocketDeps) {
  app.get("/chat", { websocket: true }, async (socket, request) => {
    const token = (request.query as { token?: string })?.token;
    if (!token) {
      socket.close(1008, "Missing token");
      return;
    }

    const userId = await verifyWsToken(token);
    if (!userId) {
      socket.close(1008, "Invalid token");
      return;
    }

    deps.chatGateway.connect(userId, socket);
    await deps.chatGateway.sendSyncBatch(userId, 0);
  });
}
