import {
  computeKeyId,
  computeSharedSecret,
  createSessionState,
  decryptBinary,
  decryptToText,
  encryptBinary,
  encryptPayload,
  generateIdentityKeyPair,
  rotateSession,
  shouldRotateSession,
  type EncryptedPayload,
  type EncryptionMetadata,
  type IdentityKeyPair,
  type SessionState
} from "@love-chat/shared";

import { getIdentity, getSession, setIdentity, setSession } from "./storage";

export interface ConversationCrypto {
  identity: IdentityKeyPair;
  sharedSecret: string;
  session: SessionState;
}

export async function ensureIdentityKey(userId: string): Promise<IdentityKeyPair> {
  const existing = await getIdentity(userId);
  if (existing) {
    return existing;
  }

  const generated = await generateIdentityKeyPair();
  await setIdentity(userId, generated);
  return generated;
}

export async function ensureConversationCrypto(
  userId: string,
  peerId: string,
  peerPublicKey: string
): Promise<ConversationCrypto> {
  const identity = await ensureIdentityKey(userId);
  const sharedSecret = computeSharedSecret(identity.privateKey, peerPublicKey);
  const recipientKeyId = await computeKeyId(peerPublicKey);
  const cachedSession = await getSession(userId, peerId);

  let session = cachedSession;
  if (!session || session.senderKeyId !== identity.keyId || session.recipientKeyId !== recipientKeyId) {
    session = createSessionState({
      sharedSecret,
      senderKeyId: identity.keyId,
      recipientKeyId: recipientKeyId,
      rotateAfter: 64
    });
    await setSession(userId, peerId, session);
  }

  return {
    identity,
    sharedSecret,
    session
  };
}

export async function encryptTextWithSession(
  userId: string,
  peerId: string,
  session: SessionState,
  text: string,
  metadata: EncryptionMetadata
): Promise<{ payload: EncryptedPayload; session: SessionState }> {
  const activeSession = shouldRotateSession(session) ? rotateSession(session) : session;
  const encrypted = await encryptPayload(activeSession, text, metadata, 1);
  await setSession(userId, peerId, encrypted.session);
  return encrypted;
}

export async function encryptBytesWithSession(
  userId: string,
  peerId: string,
  session: SessionState,
  bytes: Uint8Array,
  metadata: EncryptionMetadata
): Promise<{ payload: EncryptedPayload; session: SessionState }> {
  const activeSession = shouldRotateSession(session) ? rotateSession(session) : session;
  const encrypted = await encryptBinary(activeSession, bytes, metadata, 1);
  await setSession(userId, peerId, encrypted.session);
  return encrypted;
}

export async function decryptTextPayload(
  sharedSecret: string,
  payload: EncryptedPayload,
  metadata: EncryptionMetadata
): Promise<string> {
  return decryptToText(sharedSecret, payload, metadata);
}

export async function decryptBinaryPayload(
  sharedSecret: string,
  payload: EncryptedPayload,
  metadata: EncryptionMetadata
): Promise<Uint8Array> {
  return decryptBinary(sharedSecret, payload, metadata);
}
