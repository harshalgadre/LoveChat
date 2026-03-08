import type { FastifyInstance } from "fastify";

import { MessagesQuerySchema } from "@love-chat/shared";

import { requireUser } from "../auth/requestAuth";
import { MessagesService } from "../services/messagesService";

interface MessageRouteDeps {
  messagesService: MessagesService;
}

export async function registerMessageRoutes(app: FastifyInstance, deps: MessageRouteDeps) {
  app.get("/messages", async (request, reply) => {
    const userId = await requireUser(request, reply);
    if (!userId) {
      return;
    }

    const parsed = MessagesQuerySchema.safeParse(request.query ?? {});
    if (!parsed.success) {
      return reply.status(400).send({ error: "INVALID_QUERY", details: parsed.error.flatten() });
    }

    const messages = await deps.messagesService.getMessagesForUser(userId, parsed.data.after);
    return reply.send({ messages });
  });
}