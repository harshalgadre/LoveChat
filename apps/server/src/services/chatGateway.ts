import type { RawData, WebSocket } from "ws";

import { ClientEventSchema, type ServerEvent, type UserId } from "@love-chat/shared";

import { MessagesService } from "./messagesService";

function createServerEvent(type: ServerEvent["type"], payload: any): ServerEvent {
  return {
    v: 1,
    type,
    payload,
    messageId: crypto.randomUUID(),
    timestamp: Date.now()
  };
}

function stringifyEvent(event: ServerEvent): string {
  return JSON.stringify(event);
}

export class ChatGateway {
  private readonly sockets = new Map<UserId, Set<WebSocket>>();

  constructor(private readonly messagesService: MessagesService) {}

  connect(userId: UserId, socket: WebSocket): void {
    const set = this.sockets.get(userId) ?? new Set<WebSocket>();
    set.add(socket);
    this.sockets.set(userId, set);

    socket.on("message", async (raw: RawData) => {
      await this.handleSocketMessage(userId, raw, socket);
    });

    socket.on("close", () => {
      const active = this.sockets.get(userId);
      if (!active) {
        return;
      }
      active.delete(socket);
      if (active.size === 0) {
        this.sockets.delete(userId);
      }
    });
  }

  async sendSyncBatch(userId: UserId, afterId: number): Promise<void> {
    const messages = await this.messagesService.getMessagesForUser(userId, afterId);
    this.sendToUser(userId, createServerEvent("sync:batch", { messages }));
  }

  private async handleSocketMessage(userId: UserId, raw: RawData, socket: WebSocket): Promise<void> {
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(raw.toString());
    } catch {
      socket.send(JSON.stringify({ error: "INVALID_JSON" }));
      return;
    }

    const parsed = ClientEventSchema.safeParse(parsedJson);
    if (!parsed.success) {
      socket.send(JSON.stringify({ error: "INVALID_EVENT", details: parsed.error.flatten() }));
      return;
    }

    const event = parsed.data as any;

    switch (event.type) {
      case "message:send": {
        const message = await this.messagesService.appendMessage({
          clientMessageId: event.payload.clientMessageId,
          sender: userId,
          recipient: event.payload.to,
          type: event.payload.type,
          encryptedPayload: event.payload.encryptedPayload,
          mediaId: event.payload.mediaId,
          createdAt: event.timestamp
        });

        this.sendToUser(
          userId,
          createServerEvent("message:ack", {
            serverMessageId: message.id,
            clientMessageId: message.clientMessageId,
            to: event.payload.to
          })
        );

        this.sendToUser(event.payload.to, createServerEvent("message:recv", message));
        return;
      }
      case "message:ack": {
        if (event.payload.to) {
          this.sendToUser(
            event.payload.to,
            createServerEvent("message:ack", {
              serverMessageId: event.payload.serverMessageId,
              clientMessageId: event.payload.clientMessageId,
              to: userId
            })
          );
        }
        return;
      }
      case "typing:start":
      case "typing:stop":
      case "call:start":
      case "call:accept":
      case "call:decline":
      case "call:end": {
        const recipient = event.payload.to;
        this.sendToUser(recipient, {
          ...event,
          payload: {
            ...event.payload,
            to: userId
          },
          messageId: crypto.randomUUID(),
          timestamp: Date.now()
        } as ServerEvent);
        return;
      }
      case "sync:request": {
        const messages = await this.messagesService.getMessagesForUser(userId, event.payload.afterId);
        this.sendToUser(userId, createServerEvent("sync:batch", { messages }));
        return;
      }
      default:
        return;
    }
  }

  private sendToUser(userId: UserId, event: ServerEvent): void {
    const targets = this.sockets.get(userId);
    if (!targets) {
      return;
    }

    const serialized = stringifyEvent(event);
    for (const socket of targets) {
      if (socket.readyState === 1) {
        socket.send(serialized);
      }
    }
  }
}
