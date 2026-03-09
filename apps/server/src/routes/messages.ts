import type { FastifyInstance } from "fastify";

import { ClearMessagesBodySchema, MessagesQuerySchema } from "@love-chat/shared";

import { requireUser } from "../auth/requestAuth";
import { MediaService } from "../services/mediaService";
import { MessagesService } from "../services/messagesService";

interface MessageRouteDeps {
  messagesService: MessagesService;
  mediaService: MediaService;
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

    const messages = await deps.messagesService.getMessagesForUser(userId, parsed.data.after, parsed.data.peer);
    return reply.send({ messages });
  });

  app.post("/messages/clear", async (request, reply) => {
    const userId = await requireUser(request, reply);
    if (!userId) {
      return;
    }

    const parsed = ClearMessagesBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "INVALID_BODY", details: parsed.error.flatten() });
    }

    const deleted = await deps.messagesService.clearConversationForUser(userId, parsed.data.peer);
    const deletedMediaCount = await deps.mediaService.deleteMediaByIds(deleted.mediaIds);
    return reply.send({
      ok: true,
      deletedMessages: deleted.deletedCount,
      deletedMedia: deletedMediaCount
    });
  });

  app.delete("/messages/:id", async (request, reply) => {
    const userId = await requireUser(request, reply);
    if (!userId) {
      return;
    }

    const messageIdRaw = (request.params as { id: string }).id;
    const messageId = Number(messageIdRaw);
    if (!Number.isInteger(messageId) || messageId <= 0) {
      return reply.status(400).send({ error: "INVALID_MESSAGE_ID" });
    }

    const deleted = await deps.messagesService.deleteMessageForUser(userId, messageId);
    if (!deleted) {
      return reply.status(404).send({ error: "MESSAGE_NOT_FOUND" });
    }

    const deletedMedia = deleted.mediaId ? await deps.mediaService.deleteMediaByIds([deleted.mediaId]) : 0;
    return reply.send({
      ok: true,
      deletedMessageId: messageId,
      deletedMedia
    });
  });
}
