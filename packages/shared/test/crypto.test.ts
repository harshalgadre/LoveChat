import { webcrypto } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  computeSharedSecret,
  createSessionState,
  decryptToText,
  encryptPayload,
  generateIdentityKeyPair,
  rotateSession,
  shouldRotateSession
} from "../src/crypto";

if (!globalThis.crypto) {
  Object.defineProperty(globalThis, "crypto", {
    value: webcrypto,
    configurable: true
  });
}

describe("crypto", () => {
  it("derives matching shared secrets for both peers", async () => {
    const alice = await generateIdentityKeyPair();
    const bob = await generateIdentityKeyPair();

    const aliceShared = computeSharedSecret(alice.privateKey, bob.publicKey);
    const bobShared = computeSharedSecret(bob.privateKey, alice.publicKey);

    expect(aliceShared).toEqual(bobShared);
  });

  it("encrypts and decrypts a payload", async () => {
    const alice = await generateIdentityKeyPair();
    const bob = await generateIdentityKeyPair();
    const shared = computeSharedSecret(alice.privateKey, bob.publicKey);

    let session = createSessionState({
      sharedSecret: shared,
      senderKeyId: alice.keyId,
      recipientKeyId: bob.keyId,
      rotateAfter: 2
    });

    const metadata = {
      sender: "userA",
      recipient: "userB",
      messageId: "msg-12345678",
      timestamp: Date.now(),
      type: "text"
    };

    const encrypted = await encryptPayload(
      session,
      "hello world",
      metadata,
      1
    );

    session = encrypted.session;
    const plaintext = await decryptToText(shared, encrypted.payload, metadata);

    expect(plaintext).toBe("hello world");
    expect(session.sendCounter).toBe(1);
  });

  it("increments counter and rotates sessions", async () => {
    const alice = await generateIdentityKeyPair();
    const bob = await generateIdentityKeyPair();
    const shared = computeSharedSecret(alice.privateKey, bob.publicKey);

    let session = createSessionState({
      sharedSecret: shared,
      senderKeyId: alice.keyId,
      recipientKeyId: bob.keyId,
      rotateAfter: 1
    });

    session = (await encryptPayload(
      session,
      "m1",
      {
        sender: "userA",
        recipient: "userB",
        messageId: "msg-rotate-1",
        timestamp: 100,
        type: "text"
      },
      1
    )).session;

    expect(shouldRotateSession(session)).toBe(true);

    const rotated = rotateSession(session);
    expect(rotated.epoch).toBe(2);
    expect(rotated.sendCounter).toBe(0);
  });
});
