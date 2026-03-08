import { x25519 } from "@noble/curves/ed25519";
import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha256";
import type { EncryptedPayload } from "./schemas";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export type PlaintextValue = string | Uint8Array;

export interface IdentityKeyPair {
  privateKey: string;
  publicKey: string;
  keyId: string;
  createdAt: number;
}

export interface SessionState {
  sharedSecret: string;
  sessionSalt: string;
  epoch: number;
  sendCounter: number;
  rotateAfter: number;
  senderKeyId: string;
  recipientKeyId: string;
}

export interface EncryptionMetadata {
  sender: string;
  recipient: string;
  messageId: string;
  timestamp: number;
  type: string;
}

function ensureCrypto() {
  if (!globalThis.crypto?.subtle) {
    const secureContextHint =
      typeof window !== "undefined"
        ? `isSecureContext=${String(window.isSecureContext)}. Use HTTPS (or localhost) and update Android System WebView/Chrome.`
        : "Ensure the runtime exposes globalThis.crypto.subtle.";
    throw new Error(`WebCrypto API is not available in this runtime. ${secureContextHint}`);
  }
  return globalThis.crypto;
}

function toBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(bytes).toString("base64");
  }
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function fromBase64(base64: string): Uint8Array {
  if (typeof Buffer !== "undefined") {
    return new Uint8Array(Buffer.from(base64, "base64"));
  }
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export function toBase64Url(bytes: Uint8Array): string {
  return toBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function fromBase64Url(base64Url: string): Uint8Array {
  const padded = base64Url.replace(/-/g, "+").replace(/_/g, "/");
  const padding = padded.length % 4 === 0 ? "" : "=".repeat(4 - (padded.length % 4));
  return fromBase64(padded + padding);
}

export function utf8Bytes(input: PlaintextValue): Uint8Array {
  return typeof input === "string" ? encoder.encode(input) : input;
}

export function utf8String(input: Uint8Array): string {
  return decoder.decode(input);
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

export async function sha256Base64Url(input: string | Uint8Array): Promise<string> {
  const crypto = ensureCrypto();
  const bytes = utf8Bytes(input);
  const hash = await crypto.subtle.digest("SHA-256", toArrayBuffer(bytes));
  return toBase64Url(new Uint8Array(hash));
}

export async function computeKeyId(publicKeyBase64Url: string): Promise<string> {
  const hash = await sha256Base64Url(publicKeyBase64Url);
  return hash.slice(0, 16);
}

export async function generateIdentityKeyPair(): Promise<IdentityKeyPair> {
  const privateKey = x25519.utils.randomPrivateKey();
  const publicKey = x25519.getPublicKey(privateKey);
  const privateKeyB64 = toBase64Url(privateKey);
  const publicKeyB64 = toBase64Url(publicKey);

  return {
    privateKey: privateKeyB64,
    publicKey: publicKeyB64,
    keyId: await computeKeyId(publicKeyB64),
    createdAt: Date.now()
  };
}

export function computeSharedSecret(
  privateKeyBase64Url: string,
  peerPublicKeyBase64Url: string
): string {
  const privateKey = fromBase64Url(privateKeyBase64Url);
  const peerPublicKey = fromBase64Url(peerPublicKeyBase64Url);
  const shared = x25519.getSharedSecret(privateKey, peerPublicKey);
  return toBase64Url(shared);
}

export function createSessionState(input: {
  sharedSecret: string;
  senderKeyId: string;
  recipientKeyId: string;
  rotateAfter?: number;
}): SessionState {
  const randomSalt = new Uint8Array(16);
  ensureCrypto().getRandomValues(randomSalt);

  return {
    sharedSecret: input.sharedSecret,
    sessionSalt: toBase64Url(randomSalt),
    epoch: 1,
    sendCounter: 0,
    rotateAfter: input.rotateAfter ?? 64,
    senderKeyId: input.senderKeyId,
    recipientKeyId: input.recipientKeyId
  };
}

export function shouldRotateSession(session: SessionState): boolean {
  return session.sendCounter >= session.rotateAfter;
}

export function rotateSession(session: SessionState): SessionState {
  const randomSalt = new Uint8Array(16);
  ensureCrypto().getRandomValues(randomSalt);
  return {
    ...session,
    epoch: session.epoch + 1,
    sendCounter: 0,
    sessionSalt: toBase64Url(randomSalt)
  };
}

function buildNonce(epoch: number, counter: number): Uint8Array {
  const nonce = new Uint8Array(12);
  const view = new DataView(nonce.buffer);
  view.setUint32(0, epoch, false);
  view.setBigUint64(4, BigInt(counter), false);
  return nonce;
}

async function deriveAesKey(
  sharedSecretBase64Url: string,
  sessionSaltBase64Url: string,
  epoch: number,
  counter: number
): Promise<globalThis.CryptoKey> {
  const secret = fromBase64Url(sharedSecretBase64Url);
  const salt = fromBase64Url(sessionSaltBase64Url);
  const info = encoder.encode(`lovechat:v1:epoch:${epoch}:counter:${counter}`);

  const keyBytes = hkdf(sha256, secret, salt, info, 32);

  return ensureCrypto().subtle.importKey("raw", toArrayBuffer(new Uint8Array(keyBytes)), { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

export async function encryptPayload(
  session: SessionState,
  plaintext: PlaintextValue,
  metadata: EncryptionMetadata,
  protocolVersion = 1
): Promise<{ payload: EncryptedPayload; session: SessionState }> {
  const crypto = ensureCrypto();
  const counter = session.sendCounter + 1;
  const nonce = buildNonce(session.epoch, counter);
  const metadataHash = await sha256Base64Url(JSON.stringify(metadata));
  const key = await deriveAesKey(session.sharedSecret, session.sessionSalt, session.epoch, counter);

  const encrypted = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: toArrayBuffer(nonce),
      additionalData: toArrayBuffer(encoder.encode(metadataHash))
    },
    key,
    toArrayBuffer(utf8Bytes(plaintext))
  );

  const payload: EncryptedPayload = {
    protocolVersion,
    algorithm: "AES-256-GCM",
    nonce: toBase64Url(nonce),
    ciphertext: toBase64Url(new Uint8Array(encrypted)),
    salt: session.sessionSalt,
    epoch: session.epoch,
    counter,
    senderKeyId: session.senderKeyId,
    recipientKeyId: session.recipientKeyId,
    metadataHash
  };

  return {
    payload,
    session: {
      ...session,
      sendCounter: counter
    }
  };
}

export async function decryptPayload(
  sharedSecretBase64Url: string,
  payload: EncryptedPayload,
  metadata: EncryptionMetadata
): Promise<Uint8Array> {
  const crypto = ensureCrypto();
  const expectedMetadataHash = await sha256Base64Url(JSON.stringify(metadata));
  if (payload.metadataHash !== expectedMetadataHash) {
    throw new Error("Metadata hash mismatch");
  }

  const key = await deriveAesKey(sharedSecretBase64Url, payload.salt, payload.epoch, payload.counter);
  const decrypted = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: toArrayBuffer(fromBase64Url(payload.nonce)),
      additionalData: toArrayBuffer(encoder.encode(payload.metadataHash))
    },
    key,
    toArrayBuffer(fromBase64Url(payload.ciphertext))
  );

  return new Uint8Array(decrypted);
}

export async function decryptToText(
  sharedSecretBase64Url: string,
  payload: EncryptedPayload,
  metadata: EncryptionMetadata
): Promise<string> {
  const bytes = await decryptPayload(sharedSecretBase64Url, payload, metadata);
  return utf8String(bytes);
}

export async function encryptBinary(
  session: SessionState,
  bytes: Uint8Array,
  metadata: EncryptionMetadata,
  protocolVersion = 1
): Promise<{ payload: EncryptedPayload; session: SessionState }> {
  return encryptPayload(session, bytes, metadata, protocolVersion);
}

export async function decryptBinary(
  sharedSecretBase64Url: string,
  payload: EncryptedPayload,
  metadata: EncryptionMetadata
): Promise<Uint8Array> {
  return decryptPayload(sharedSecretBase64Url, payload, metadata);
}
