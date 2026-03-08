import { z } from "zod";

export const UserIdSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(3)
  .max(24)
  .regex(/^[a-z0-9_]+$/);
export type UserId = z.infer<typeof UserIdSchema>;

export const PhoneNumberSchema = z
  .string()
  .trim()
  .regex(/^\+?[0-9]{8,15}$/);

export const MessageTypeSchema = z.enum([
  "text",
  "image",
  "video",
  "audio",
  "document",
  "system"
]);
export type MessageType = z.infer<typeof MessageTypeSchema>;

export const CallTypeSchema = z.enum(["audio", "video"]);
export type CallType = z.infer<typeof CallTypeSchema>;

export const EventTypeSchema = z.enum([
  "message:send",
  "message:recv",
  "message:ack",
  "typing:start",
  "typing:stop",
  "sync:request",
  "sync:batch",
  "call:start",
  "call:accept",
  "call:decline",
  "call:end"
]);
export type EventType = z.infer<typeof EventTypeSchema>;

export const EncryptedPayloadSchema = z.object({
  protocolVersion: z.number().int().positive(),
  algorithm: z.literal("AES-256-GCM"),
  nonce: z.string().min(10),
  ciphertext: z.string().min(10),
  salt: z.string().min(10),
  epoch: z.number().int().positive(),
  counter: z.number().int().positive(),
  senderKeyId: z.string().min(4),
  recipientKeyId: z.string().min(4),
  metadataHash: z.string().min(10)
});
export type EncryptedPayload = z.infer<typeof EncryptedPayloadSchema>;

export const MessageRecordSchema = z.object({
  id: z.number().int().positive(),
  clientMessageId: z.string().min(8),
  sender: UserIdSchema,
  recipient: UserIdSchema,
  type: MessageTypeSchema,
  encryptedPayload: EncryptedPayloadSchema,
  mediaId: z.string().min(8).optional(),
  createdAt: z.number().int().positive()
});
export type MessageRecord = z.infer<typeof MessageRecordSchema>;

export const MessageStoreSchema = z.object({
  messages: z.array(MessageRecordSchema)
});
export type MessageStore = z.infer<typeof MessageStoreSchema>;

export const UserCredentialSchema = z.object({
  id: z.string().min(8),
  publicKey: z.string().min(8),
  counter: z.number().int().nonnegative(),
  transports: z.array(z.string()).optional(),
  credentialDeviceType: z.string().optional(),
  credentialBackedUp: z.boolean().optional()
});
export type UserCredential = z.infer<typeof UserCredentialSchema>;

export const UserRecordSchema = z.object({
  id: UserIdSchema,
  displayName: z.string().min(1),
  phoneNumber: PhoneNumberSchema,
  webauthnCredentials: z.array(UserCredentialSchema),
  identityPublicKey: z.string().min(10).optional(),
  identityKeyUpdatedAt: z.number().int().positive().optional()
});
export type UserRecord = z.infer<typeof UserRecordSchema>;

export const UserStoreSchema = z.object({
  users: z.array(UserRecordSchema).max(5)
});
export type UserStore = z.infer<typeof UserStoreSchema>;

export const MediaRecordSchema = z.object({
  id: z.string().min(8),
  sender: UserIdSchema,
  recipient: UserIdSchema,
  mimeType: z.string().min(3),
  fileName: z.string().min(1),
  byteLength: z.number().int().positive(),
  fileEncryptionPayload: EncryptedPayloadSchema,
  storagePath: z.string().min(1),
  createdAt: z.number().int().positive(),
  expiresAt: z.number().int().positive(),
  ackedBy: z.array(UserIdSchema)
});
export type MediaRecord = z.infer<typeof MediaRecordSchema>;

export const MediaStoreSchema = z.object({
  media: z.array(MediaRecordSchema)
});
export type MediaStore = z.infer<typeof MediaStoreSchema>;

export const AuthRegisterChallengeRequestSchema = z.object({
  username: UserIdSchema,
  phoneNumber: PhoneNumberSchema
});

export const AuthChallengeRequestSchema = z.object({
  username: UserIdSchema
});

export const AuthVerifyRegisterRequestSchema = z.object({
  username: UserIdSchema,
  phoneNumber: PhoneNumberSchema,
  response: z.unknown(),
  identityPublicKey: z.string().min(10).optional()
});

export const AuthVerifyLoginRequestSchema = z.object({
  username: UserIdSchema,
  response: z.unknown()
});

export const IdentityKeyUpdateSchema = z.object({
  publicKey: z.string().min(10)
});

export const UploadMediaBodySchema = z.object({
  recipient: UserIdSchema,
  mimeType: z.string().min(3),
  fileName: z.string().min(1),
  encryptedPayload: EncryptedPayloadSchema,
  clientMessageId: z.string().min(8),
  messageType: z.enum(["image", "video", "audio", "document"])
});

export const MessagesQuerySchema = z.object({
  after: z.coerce.number().int().min(0).default(0)
});

export const CallTokenRequestSchema = z.object({
  callType: CallTypeSchema,
  roomName: z.string().min(3)
});

export const WsEnvelopeBaseSchema = z.object({
  v: z.literal(1),
  messageId: z.string().min(8),
  timestamp: z.number().int().positive(),
  type: EventTypeSchema,
  payload: z.unknown()
});

const MessageSendPayloadSchema = z.object({
  to: UserIdSchema,
  type: MessageTypeSchema,
  encryptedPayload: EncryptedPayloadSchema,
  mediaId: z.string().min(8).optional(),
  clientMessageId: z.string().min(8)
});

const MessageAckPayloadSchema = z.object({
  serverMessageId: z.number().int().positive(),
  clientMessageId: z.string().min(8).optional(),
  to: UserIdSchema.optional()
});

const TypingPayloadSchema = z.object({
  to: UserIdSchema
});

const SyncRequestPayloadSchema = z.object({
  afterId: z.number().int().min(0)
});

const SyncBatchPayloadSchema = z.object({
  messages: z.array(MessageRecordSchema)
});

const CallStartPayloadSchema = z.object({
  to: UserIdSchema,
  callType: CallTypeSchema,
  roomName: z.string().min(3)
});

const CallRespondPayloadSchema = z.object({
  to: UserIdSchema,
  roomName: z.string().min(3),
  callType: CallTypeSchema
});

const CallEndPayloadSchema = z.object({
  to: UserIdSchema,
  roomName: z.string().min(3)
});

function makeEnvelope<T extends z.ZodTypeAny>(
  type: EventType,
  payload: T
) {
  return WsEnvelopeBaseSchema.extend({
    type: z.literal(type),
    payload
  });
}

export const ClientEventSchema = z.discriminatedUnion("type", [
  makeEnvelope("message:send", MessageSendPayloadSchema),
  makeEnvelope("message:ack", MessageAckPayloadSchema),
  makeEnvelope("typing:start", TypingPayloadSchema),
  makeEnvelope("typing:stop", TypingPayloadSchema),
  makeEnvelope("sync:request", SyncRequestPayloadSchema),
  makeEnvelope("call:start", CallStartPayloadSchema),
  makeEnvelope("call:accept", CallRespondPayloadSchema),
  makeEnvelope("call:decline", CallRespondPayloadSchema),
  makeEnvelope("call:end", CallEndPayloadSchema)
]);

export const ServerEventSchema = z.discriminatedUnion("type", [
  makeEnvelope("message:recv", MessageRecordSchema),
  makeEnvelope("message:ack", MessageAckPayloadSchema),
  makeEnvelope("typing:start", TypingPayloadSchema),
  makeEnvelope("typing:stop", TypingPayloadSchema),
  makeEnvelope("sync:batch", SyncBatchPayloadSchema),
  makeEnvelope("call:start", CallStartPayloadSchema),
  makeEnvelope("call:accept", CallRespondPayloadSchema),
  makeEnvelope("call:decline", CallRespondPayloadSchema),
  makeEnvelope("call:end", CallEndPayloadSchema)
]);

export type ClientEventType =
  | "message:send"
  | "message:ack"
  | "typing:start"
  | "typing:stop"
  | "sync:request"
  | "call:start"
  | "call:accept"
  | "call:decline"
  | "call:end";

export type ServerEventType =
  | "message:recv"
  | "message:ack"
  | "typing:start"
  | "typing:stop"
  | "sync:batch"
  | "call:start"
  | "call:accept"
  | "call:decline"
  | "call:end";

export interface ClientEvent {
  v: 1;
  type: ClientEventType;
  messageId: string;
  timestamp: number;
  payload: unknown;
}

export interface ServerEvent {
  v: 1;
  type: ServerEventType;
  messageId: string;
  timestamp: number;
  payload: unknown;
}
