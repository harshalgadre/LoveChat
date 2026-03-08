import type { EncryptedPayload, MessageRecord, MessageType, UserId } from "@love-chat/shared";

import { messageStore } from "../storage/bootstrap";

interface AppendMessageInput {
  clientMessageId: string;
  sender: UserId;
  recipient: UserId;
  type: MessageType;
  encryptedPayload: EncryptedPayload;
  mediaId?: string;
  createdAt?: number;
}

export class MessagesService {
  async appendMessage(input: AppendMessageInput): Promise<MessageRecord> {
    return messageStore.update((current) => {
      const nextId = current.messages.at(-1)?.id ? current.messages.at(-1)!.id + 1 : 1;
      const record: MessageRecord = {
        id: nextId,
        clientMessageId: input.clientMessageId,
        sender: input.sender,
        recipient: input.recipient,
        type: input.type,
        encryptedPayload: input.encryptedPayload,
        mediaId: input.mediaId,
        createdAt: input.createdAt ?? Date.now()
      };

      return {
        next: {
          messages: [...current.messages, record]
        },
        result: record
      };
    });
  }

  async getMessagesForUser(userId: UserId, afterId: number): Promise<MessageRecord[]> {
    const { messages } = await messageStore.read();
    return messages.filter((message) => message.id > afterId && (message.sender === userId || message.recipient === userId));
  }
}