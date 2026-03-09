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

export interface MessageDeletionResult {
  deletedCount: number;
  mediaIds: string[];
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

  async getMessagesForUser(userId: UserId, afterId: number, peerId?: UserId): Promise<MessageRecord[]> {
    const { messages } = await getCollections();
    const query =
      peerId && peerId !== userId
        ? {
            id: { $gt: afterId },
            $or: [
              { sender: userId, recipient: peerId },
              { sender: peerId, recipient: userId }
            ]
          }
        : {
            id: { $gt: afterId },
            $or: [{ sender: userId }, { recipient: userId }]
          };

    const docs = await messages
      .find(query, {
        sort: { id: 1 }
      })
      .toArray();

    return docs.map((doc) => parseMessageRecord(doc));
  }

  async deleteMessageForUser(userId: UserId, messageId: number): Promise<MessageRecord | null> {
    const { messages } = await getCollections();
    const existing = await messages.findOne({
      id: messageId,
      $or: [{ sender: userId }, { recipient: userId }]
    });

    if (!existing) {
      return null;
    }

    await messages.deleteOne({ id: messageId });
    return parseMessageRecord(existing);
  }

  async clearConversationForUser(userId: UserId, peerId: UserId): Promise<MessageDeletionResult> {
    const { messages } = await getCollections();
    const query = {
      $or: [
        { sender: userId, recipient: peerId },
        { sender: peerId, recipient: userId }
      ]
    };

    const existing = await messages
      .find(query, {
        projection: {
          id: 1,
          mediaId: 1
        }
      })
      .toArray();

    if (!existing.length) {
      return {
        deletedCount: 0,
        mediaIds: []
      };
    }

    await messages.deleteMany(query);
    const mediaIds = existing
      .map((record) => record.mediaId)
      .filter((value): value is string => typeof value === "string" && value.length > 0);

    return {
      deletedCount: existing.length,
      mediaIds
    };
  }

  async deleteAllForUser(userId: UserId): Promise<MessageDeletionResult> {
    const { messages } = await getCollections();
    const query = {
      $or: [{ sender: userId }, { recipient: userId }]
    };

    const existing = await messages
      .find(query, {
        projection: {
          id: 1,
          mediaId: 1
        }
      })
      .toArray();

    if (!existing.length) {
      return {
        deletedCount: 0,
        mediaIds: []
      };
    }

    await messages.deleteMany(query);
    const mediaIds = existing
      .map((record) => record.mediaId)
      .filter((value): value is string => typeof value === "string" && value.length > 0);

    return {
      deletedCount: existing.length,
      mediaIds
    };
  }
}
