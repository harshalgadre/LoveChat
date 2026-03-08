import type { UserCredential, UserId, UserRecord } from "@love-chat/shared";

import { getCollections, parseUserRecord } from "../storage/mongo";

export class UsersService {
  async listUsers(): Promise<UserRecord[]> {
    const { users } = await getCollections();
    const docs = await users.find({}, { sort: { id: 1 } }).toArray();
    return docs.map((doc) => parseUserRecord(doc));
  }

  async getUser(userId: UserId): Promise<UserRecord> {
    const { users } = await getCollections();
    const doc = await users.findOne({ id: userId });
    if (!doc) {
      throw new Error(`Unknown user ${userId}`);
    }

    return parseUserRecord(doc);
  }

  async getPeerUser(userId: UserId): Promise<UserRecord> {
    const { users } = await getCollections();
    const doc = await users.findOne({ id: { $ne: userId } });
    if (!doc) {
      throw new Error("Peer user not found");
    }

    return parseUserRecord(doc);
  }

  async upsertCredential(userId: UserId, credential: UserCredential): Promise<void> {
    const current = await this.getUser(userId);
    const nextCredentials = [
      ...current.webauthnCredentials.filter((item) => item.id !== credential.id),
      credential
    ];

    const { users } = await getCollections();
    await users.updateOne(
      { id: userId },
      {
        $set: {
          webauthnCredentials: nextCredentials
        }
      }
    );
  }

  async updateCredentialCounter(userId: UserId, credentialId: string, counter: number): Promise<void> {
    const current = await this.getUser(userId);
    const nextCredentials = current.webauthnCredentials.map((credential) =>
      credential.id === credentialId
        ? {
            ...credential,
            counter
          }
        : credential
    );

    const { users } = await getCollections();
    await users.updateOne(
      { id: userId },
      {
        $set: {
          webauthnCredentials: nextCredentials
        }
      }
    );
  }

  async setIdentityPublicKey(userId: UserId, publicKey: string): Promise<void> {
    const { users } = await getCollections();
    await users.updateOne(
      { id: userId },
      {
        $set: {
          identityPublicKey: publicKey,
          identityKeyUpdatedAt: Date.now()
        }
      }
    );
  }

  async getIdentityPublicKey(userId: UserId): Promise<string | null> {
    const user = await this.getUser(userId);
    return user.identityPublicKey ?? null;
  }
}