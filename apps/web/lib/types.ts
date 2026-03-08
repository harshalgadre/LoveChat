import type { EncryptedPayload, MessageType, UserId } from "@love-chat/shared";

export interface MediaDescriptor {
  mediaId: string;
  fileName: string;
  mimeType: string;
  size: number;
  fileEncryptionPayload: EncryptedPayload;
  fileMetaMessageId: string;
  fileMetaTimestamp: number;
  fileType: MessageType;
}

export interface UiMessage {
  localId: string;
  serverId?: number;
  clientMessageId: string;
  sender: UserId;
  recipient: UserId;
  type: MessageType;
  text?: string;
  media?: MediaDescriptor;
  createdAt: number;
  status: "sending" | "sent" | "received";
}

export interface AuthSession {
  userId: UserId;
  peerId: UserId;
  wsToken: string;
  sessionToken?: string;
  selfIdentityPublicKey: string | null;
  peerIdentityPublicKey: string | null;
}
