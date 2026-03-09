import { Binary } from "mongodb";

import type { EncryptedPayload, MediaRecord, UserId } from "@love-chat/shared";

import { config } from "../config";
import { getCollections, parseMediaRecord } from "../storage/mongo";

interface CreateMediaRecordInput {
  sender: UserId;
  recipient: UserId;
  mimeType: string;
  fileName: string;
  byteLength: number;
  encryptedPayload: EncryptedPayload;
  encryptedBytes: Uint8Array;
  storagePath?: string;
}

interface MediaBlobResponse {
  media: MediaRecord;
  bytes: Uint8Array;
}

export class MediaService {
  async createMediaRecord(input: CreateMediaRecordInput): Promise<MediaRecord> {
    const { media, mediaBlobs } = await getCollections();
    const now = Date.now();
    const storageKey = input.storagePath ?? crypto.randomUUID();

    const record: MediaRecord = {
      id: crypto.randomUUID(),
      sender: input.sender,
      recipient: input.recipient,
      mimeType: input.mimeType,
      fileName: input.fileName,
      byteLength: input.byteLength,
      fileEncryptionPayload: input.encryptedPayload,
      storagePath: storageKey,
      createdAt: now,
      expiresAt: now + config.retention.mediaRetentionMs,
      ackedBy: []
    };

    await media.insertOne(record);
    await mediaBlobs.insertOne({
      _id: storageKey,
      data: new Binary(Buffer.from(input.encryptedBytes)),
      createdAt: now,
      expiresAt: record.expiresAt
    });

    return parseMediaRecord(record);
  }

  async getMediaForUser(mediaId: string, userId: UserId): Promise<MediaRecord | null> {
    const { media } = await getCollections();
    const doc = await media.findOne({
      id: mediaId,
      $or: [{ sender: userId }, { recipient: userId }]
    });

    return doc ? parseMediaRecord(doc) : null;
  }

  async getMediaBlobForUser(mediaId: string, userId: UserId): Promise<MediaBlobResponse | null> {
    const { mediaBlobs } = await getCollections();
    const record = await this.getMediaForUser(mediaId, userId);
    if (!record) {
      return null;
    }

    const blob = await mediaBlobs.findOne({ _id: record.storagePath });
    if (!blob) {
      return null;
    }

    return {
      media: record,
      bytes: this.binaryToBytes(blob.data)
    };
  }

  async ackMedia(mediaId: string, userId: UserId): Promise<MediaRecord | null> {
    const { media, mediaBlobs } = await getCollections();
    const existing = await media.findOne({ id: mediaId });
    if (!existing) {
      return null;
    }

    await media.updateOne({ id: mediaId }, { $addToSet: { ackedBy: userId } });
    const updated = await media.findOne({ id: mediaId });
    if (!updated) {
      return null;
    }

    const parsed = parseMediaRecord(updated);
    const bothAcked = parsed.ackedBy.includes(parsed.sender) && parsed.ackedBy.includes(parsed.recipient);
    if (bothAcked) {
      await media.deleteOne({ id: mediaId });
      await mediaBlobs.deleteOne({ _id: parsed.storagePath });
    }

    return parsed;
  }

  async cleanupExpiredMedia(now = Date.now()): Promise<number> {
    const { media, mediaBlobs } = await getCollections();
    const expired = await media.find({ expiresAt: { $lte: now } }).toArray();
    if (!expired.length) {
      return 0;
    }

    const mediaIds = expired.map((item) => item.id);
    const blobIds = expired.map((item) => item.storagePath);

    await media.deleteMany({ id: { $in: mediaIds } });
    await mediaBlobs.deleteMany({ _id: { $in: blobIds } });

    return expired.length;
  }

  async deleteMediaByIds(mediaIds: string[]): Promise<number> {
    if (!mediaIds.length) {
      return 0;
    }

    const uniqueIds = [...new Set(mediaIds)];
    const { media, mediaBlobs } = await getCollections();
    const docs = await media.find({ id: { $in: uniqueIds } }).toArray();
    if (!docs.length) {
      return 0;
    }

    const blobIds = docs.map((doc) => doc.storagePath);
    await media.deleteMany({ id: { $in: uniqueIds } });
    await mediaBlobs.deleteMany({ _id: { $in: blobIds } });
    return docs.length;
  }

  async deleteMediaForUser(userId: UserId): Promise<number> {
    const { media, mediaBlobs } = await getCollections();
    const docs = await media
      .find({
        $or: [{ sender: userId }, { recipient: userId }]
      })
      .toArray();

    if (!docs.length) {
      return 0;
    }

    const mediaIds = docs.map((doc) => doc.id);
    const blobIds = docs.map((doc) => doc.storagePath);
    await media.deleteMany({ id: { $in: mediaIds } });
    await mediaBlobs.deleteMany({ _id: { $in: blobIds } });
    return docs.length;
  }

  private binaryToBytes(value: Binary): Uint8Array {
    return new Uint8Array(value.buffer);
  }
}
