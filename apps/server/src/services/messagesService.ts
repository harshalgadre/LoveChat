import type { EncryptedPayload, MessageRecord, MessageType, UserId } from "@love-chat/shared";

import { getCollections, nextCounterValue, parseMessageRecord } from "../storage/mongo";

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
    const { messages } = await getCollections();
    const nextId = await nextCounterValue("messages");

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

    await messages.insertOne(record);
    return parseMessageRecord(record);
  }

  async getMessagesForUser(userId: UserId, afterId: number): Promise<MessageRecord[]> {
    const { messages } = await getCollections();
    const docs = await messages
      .find(
        {
          id: { $gt: afterId },
          $or: [{ sender: userId }, { recipient: userId }]
        },
        {
          sort: { id: 1 }
        }
      )
      .toArray();

    return docs.map((doc) => parseMessageRecord(doc));
  }
}