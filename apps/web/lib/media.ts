import type { EncryptedPayload, MessageType, UserId } from "@love-chat/shared";

import { serverUrl } from "./config";
import { jsonRequest, uploadRequest } from "./api";

export async function uploadEncryptedMedia(input: {
  recipient: UserId;
  fileName: string;
  mimeType: string;
  encryptedPayload: EncryptedPayload;
  encryptedBytes: Uint8Array;
  clientMessageId: string;
  messageType: Extract<MessageType, "image" | "video" | "audio" | "document">;
}): Promise<{ mediaId: string; size: number }> {
  const encryptedArrayBuffer = input.encryptedBytes.buffer.slice(
    input.encryptedBytes.byteOffset,
    input.encryptedBytes.byteOffset + input.encryptedBytes.byteLength
  ) as ArrayBuffer;

  const blob = new Blob([encryptedArrayBuffer], {
    type: "application/octet-stream"
  });

  const formData = new FormData();
  formData.append("file", blob, `${input.clientMessageId}.bin`);
  formData.append("recipient", input.recipient);
  formData.append("mimeType", input.mimeType);
  formData.append("fileName", input.fileName);
  formData.append("encryptedPayload", JSON.stringify(input.encryptedPayload));
  formData.append("clientMessageId", input.clientMessageId);
  formData.append("messageType", input.messageType);

  return uploadRequest<{ mediaId: string; size: number }>("/upload-media", formData);
}

export async function downloadEncryptedMedia(mediaId: string): Promise<Uint8Array> {
  const response = await fetch(serverUrl(`/media/${mediaId}`), {
    credentials: "include",
    method: "GET",
    cache: "no-store"
  });

  if (!response.ok) {
    throw new Error(`Failed to download media: ${response.status}`);
  }

  const buffer = await response.arrayBuffer();
  return new Uint8Array(buffer);
}

export async function ackMedia(mediaId: string): Promise<void> {
  await jsonRequest(`/media/${mediaId}/ack`, {
    method: "POST"
  });
}
