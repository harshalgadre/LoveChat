import { describe, expect, it } from "vitest";

import { ClientEventSchema, MessageStoreSchema, ServerEventSchema, UserStoreSchema } from "../src/schemas";

describe("schemas", () => {
  it("validates user store with two fixed users", () => {
    const parsed = UserStoreSchema.parse({
      users: [
        {
          id: "userA",
          displayName: "User A",
          webauthnCredentials: []
        },
        {
          id: "userB",
          displayName: "User B",
          webauthnCredentials: []
        }
      ]
    });

    expect(parsed.users).toHaveLength(2);
  });

  it("validates client and server websocket events", () => {
    const client = ClientEventSchema.parse({
      v: 1,
      messageId: "evt-12345678",
      timestamp: Date.now(),
      type: "typing:start",
      payload: { to: "userB" }
    });

    const server = ServerEventSchema.parse({
      v: 1,
      messageId: "evt-87654321",
      timestamp: Date.now(),
      type: "sync:batch",
      payload: { messages: [] }
    });

    expect(client.type).toBe("typing:start");
    expect(server.type).toBe("sync:batch");
  });

  it("validates encrypted message persistence schema", () => {
    const parsed = MessageStoreSchema.parse({
      messages: [
        {
          id: 1,
          clientMessageId: "msg-12345678",
          sender: "userA",
          recipient: "userB",
          type: "text",
          encryptedPayload: {
            protocolVersion: 1,
            algorithm: "AES-256-GCM",
            nonce: "nonce-abc123xyz",
            ciphertext: "cipher-def456uvw",
            salt: "salt-value",
            epoch: 1,
            counter: 1,
            senderKeyId: "sender01",
            recipientKeyId: "recv0001",
            metadataHash: "hashvalue-001"
          },
          createdAt: Date.now()
        }
      ]
    });

    expect(parsed.messages[0].encryptedPayload.algorithm).toBe("AES-256-GCM");
  });
});
