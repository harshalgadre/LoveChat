import type { FastifyInstance } from "fastify";

import { EncryptedPayloadSchema, UploadMediaBodySchema, toBase64Url } from "@love-chat/shared";

import { requireUser } from "../auth/requestAuth";
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
    const normalizedEncryptedPayload = {
      ...encryptedParsed.data,
      ciphertext: toBase64Url(fileBuffer)
    };

    const bodyParsed = UploadMediaBodySchema.safeParse({
      recipient: fields.recipient,
      mimeType: fields.mimeType,
      fileName: fields.fileName,
      encryptedPayload: normalizedEncryptedPayload,
      clientMessageId: fields.clientMessageId,
      messageType: fields.messageType
    });

    if (!bodyParsed.success) {
      return reply.status(400).send({ error: "INVALID_BODY", details: bodyParsed.error.flatten() });
    }

    const mediaRecord = await deps.mediaService.createMediaRecord({
      sender: userId,
      recipient: bodyParsed.data.recipient,
      mimeType: bodyParsed.data.mimeType,
      fileName: bodyParsed.data.fileName,
      byteLength: fileBuffer.byteLength,
      encryptedPayload: bodyParsed.data.encryptedPayload,
      encryptedBytes: fileBuffer
    });

    return reply.send({ mediaId: mediaRecord.id, size: mediaRecord.byteLength });
  });

  app.get("/media/:id", async (request, reply) => {
    const userId = await requireUser(request, reply);
    if (!userId) {
      return;
    }

    const mediaId = (request.params as { id: string }).id;
    const response = await deps.mediaService.getMediaBlobForUser(mediaId, userId);
    if (!response) {
      return reply.status(404).send({ error: "MEDIA_NOT_FOUND" });
    }

    reply.header("Content-Type", "application/octet-stream");
    reply.header("X-LoveChat-FileName", response.media.fileName);
    return reply.send(Buffer.from(response.bytes));
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
