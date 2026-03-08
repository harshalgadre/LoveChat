import fs from "node:fs/promises";
import path from "node:path";

import type { EncryptedPayload, MediaRecord, UserId } from "@love-chat/shared";

import { config } from "../config";
import { mediaStore } from "../storage/bootstrap";

interface CreateMediaRecordInput {
  sender: UserId;
  recipient: UserId;
  mimeType: string;
  fileName: string;
  byteLength: number;
  encryptedPayload: EncryptedPayload;
  storagePath: string;
}

export class MediaService {
  async createMediaRecord(input: CreateMediaRecordInput): Promise<MediaRecord> {
    return mediaStore.update((current) => {
      const now = Date.now();
      const record: MediaRecord = {
        id: crypto.randomUUID(),
        sender: input.sender,
        recipient: input.recipient,
        mimeType: input.mimeType,
        fileName: input.fileName,
        byteLength: input.byteLength,
        fileEncryptionPayload: input.encryptedPayload,
        storagePath: input.storagePath,
        createdAt: now,
        expiresAt: now + config.storage.mediaRetentionMs,
        ackedBy: []
      };

      return {
        next: {
          media: [...current.media, record]
        },
        result: record
      };
    });
  }

  async getMediaForUser(mediaId: string, userId: UserId): Promise<MediaRecord | null> {
    const { media } = await mediaStore.read();
    const record = media.find((entry) => entry.id === mediaId);
    if (!record) {
      return null;
    }
    if (record.sender !== userId && record.recipient !== userId) {
      return null;
    }
    return record;
  }

  async ackMedia(mediaId: string, userId: UserId): Promise<MediaRecord | null> {
    return mediaStore.update(async (current) => {
      const index = current.media.findIndex((entry) => entry.id === mediaId);
      if (index < 0) {
        return { next: current, result: null };
      }

      const record = current.media[index];
      const ackedBy = Array.from(new Set([...record.ackedBy, userId]));
      const updated: MediaRecord = { ...record, ackedBy };

      let nextMedia = [...current.media];
      nextMedia[index] = updated;

      const bothAcked = updated.ackedBy.includes(updated.sender) && updated.ackedBy.includes(updated.recipient);
      if (bothAcked) {
        nextMedia = nextMedia.filter((entry) => entry.id !== mediaId);
        await this.safeDeleteFile(path.join(config.storage.mediaDir, updated.storagePath));
        return {
          next: { media: nextMedia },
          result: updated
        };
      }

      return {
        next: { media: nextMedia },
        result: updated
      };
    });
  }

  async cleanupExpiredMedia(now = Date.now()): Promise<number> {
    return mediaStore.update(async (current) => {
      const expired = current.media.filter((entry) => entry.expiresAt <= now);
      if (!expired.length) {
        return { next: current, result: 0 };
      }

      await Promise.all(expired.map((entry) => this.safeDeleteFile(path.join(config.storage.mediaDir, entry.storagePath))));

      return {
        next: {
          media: current.media.filter((entry) => entry.expiresAt > now)
        },
        result: expired.length
      };
    });
  }

  private async safeDeleteFile(filePath: string): Promise<void> {
    try {
      await fs.unlink(filePath);
    } catch {
      // Ignore missing files during retention cleanup.
    }
  }
}
