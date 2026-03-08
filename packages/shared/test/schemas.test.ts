import { describe, expect, it } from "vitest";

import {
  ClientEventSchema,
  MessageStoreSchema,
  ProfileUpdateSchema,
  ServerEventSchema,
  UserStoreSchema
} from "../src/schemas";

describe("schemas", () => {
  it("validates user store with up to five users", () => {
    const parsed = UserStoreSchema.parse({
      users: [
        {
          id: "harshal",
          displayName: "Harshal",
          phoneNumber: "+919900000001",
          webauthnCredentials: []
        },
        {
          id: "purnima",
          displayName: "Purnima",
          phoneNumber: "+919900000002",
          webauthnCredentials: []
        },
        {
          id: "amit",
          displayName: "Amit",
          phoneNumber: "+919900000003",
          webauthnCredentials: []
        },
        {
          id: "riya",
          displayName: "Riya",
          phoneNumber: "+919900000004",
          webauthnCredentials: []
        },
        {
          id: "neha",
          displayName: "Neha",
          phoneNumber: "+919900000005",
          webauthnCredentials: []
        }
      ]
    });

    expect(parsed.users).toHaveLength(5);
  });

  it("rejects more than five users", () => {
    expect(() =>
      UserStoreSchema.parse({
        users: [
          { id: "u100", displayName: "U100", phoneNumber: "+911111111101", webauthnCredentials: [] },
          { id: "u101", displayName: "U101", phoneNumber: "+911111111102", webauthnCredentials: [] },
          { id: "u102", displayName: "U102", phoneNumber: "+911111111103", webauthnCredentials: [] },
          { id: "u103", displayName: "U103", phoneNumber: "+911111111104", webauthnCredentials: [] },
          { id: "u104", displayName: "U104", phoneNumber: "+911111111105", webauthnCredentials: [] },
          { id: "u105", displayName: "U105", phoneNumber: "+911111111106", webauthnCredentials: [] }
        ]
      })
    ).toThrow();
  });

  it("validates client and server websocket events", () => {
    const client = ClientEventSchema.parse({
      v: 1,
      messageId: "evt-12345678",
      timestamp: Date.now(),
      type: "typing:start",
      payload: { to: "purnima" }
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
          sender: "harshal",
          recipient: "purnima",
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

  it("validates profile update payload", () => {
    const parsed = ProfileUpdateSchema.parse({
      displayName: "Harshal G",
      avatarUrl: "https://example.com/avatar.png"
    });

    expect(parsed.displayName).toBe("Harshal G");
  });
});
