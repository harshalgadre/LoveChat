import fs from "node:fs/promises";
import path from "node:path";

import type { FastifyInstance } from "fastify";

import { EncryptedPayloadSchema, UploadMediaBodySchema } from "@love-chat/shared";

import { requireUser } from "../auth/requestAuth";
import { config } from "../config";
import { MediaService } from "../services/mediaService";

interface MediaRouteDeps {
  mediaService: MediaService;
}

export async function registerMediaRoutes(app: FastifyInstance, deps: MediaRouteDeps) {
  app.post("/upload-media", async (request, reply) => {
    const userId = await requireUser(request, reply);
    if (!userId) {
      return;
    }

    const fields: Record<string, string> = {};
    let fileBuffer = new Uint8Array(0);

    const parts = request.parts();
    for await (const part of parts) {
      if (part.type === "file") {
        fileBuffer = new Uint8Array(await part.toBuffer());
      } else {
        fields[part.fieldname] = String(part.value ?? "");
      }
    }

    if (!fileBuffer.length) {
      return reply.status(400).send({ error: "FILE_REQUIRED" });
    }

    let encryptedPayload: unknown;
    try {
      encryptedPayload = JSON.parse(fields.encryptedPayload ?? "{}");
    } catch {
      return reply.status(400).send({ error: "INVALID_ENCRYPTED_PAYLOAD" });
    }

    const encryptedParsed = EncryptedPayloadSchema.safeParse(encryptedPayload);
    if (!encryptedParsed.success) {
      return reply.status(400).send({ error: "INVALID_ENCRYPTED_PAYLOAD", details: encryptedParsed.error.flatten() });
    }

    const bodyParsed = UploadMediaBodySchema.safeParse({
      recipient: fields.recipient,
      mimeType: fields.mimeType,
      fileName: fields.fileName,
      encryptedPayload: encryptedParsed.data,
      clientMessageId: fields.clientMessageId,
      messageType: fields.messageType
    });

    if (!bodyParsed.success) {
      return reply.status(400).send({ error: "INVALID_BODY", details: bodyParsed.error.flatten() });
    }

    const mediaFileName = `${crypto.randomUUID()}.bin`;
    const storagePath = mediaFileName;
    const absolutePath = path.join(config.storage.mediaDir, storagePath);
    await fs.writeFile(absolutePath, fileBuffer);

    const mediaRecord = await deps.mediaService.createMediaRecord({
      sender: userId,
      recipient: bodyParsed.data.recipient,
      mimeType: bodyParsed.data.mimeType,
      fileName: bodyParsed.data.fileName,
      byteLength: fileBuffer.byteLength,
      encryptedPayload: bodyParsed.data.encryptedPayload,
      storagePath
    });

    return reply.send({ mediaId: mediaRecord.id, size: mediaRecord.byteLength });
  });

  app.get("/media/:id", async (request, reply) => {
    const userId = await requireUser(request, reply);
    if (!userId) {
      return;
    }

    const mediaId = (request.params as { id: string }).id;
    const media = await deps.mediaService.getMediaForUser(mediaId, userId);
    if (!media) {
      return reply.status(404).send({ error: "MEDIA_NOT_FOUND" });
    }

    const file = await fs.readFile(path.join(config.storage.mediaDir, media.storagePath));
    reply.header("Content-Type", "application/octet-stream");
    reply.header("X-LoveChat-FileName", media.fileName);
    return reply.send(file);
  });

  app.post("/media/:id/ack", async (request, reply) => {
    const userId = await requireUser(request, reply);
    if (!userId) {
      return;
    }

    const mediaId = (request.params as { id: string }).id;
    const updated = await deps.mediaService.ackMedia(mediaId, userId);

    if (!updated) {
      return reply.status(404).send({ error: "MEDIA_NOT_FOUND" });
    }

    return reply.send({ ok: true, ackedBy: updated.ackedBy });
  });
}
