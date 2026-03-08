import type { UserCredential, UserId, UserRecord } from "@love-chat/shared";

import { userStore } from "../storage/bootstrap";

export class UsersService {
  async listUsers(): Promise<UserRecord[]> {
    const store = await userStore.read();
    return store.users;
  }

  async getUser(userId: UserId): Promise<UserRecord> {
    const users = await this.listUsers();
    const user = users.find((entry) => entry.id === userId);
    if (!user) {
      throw new Error(`Unknown user ${userId}`);
    }
    return user;
  }

  async getPeerUser(userId: UserId): Promise<UserRecord> {
    const users = await this.listUsers();
    const peer = users.find((entry) => entry.id !== userId);
    if (!peer) {
      throw new Error("Peer user not found");
    }
    return peer;
  }

  async upsertCredential(userId: UserId, credential: UserCredential): Promise<void> {
    await userStore.update((current) => {
      const nextUsers = current.users.map((entry) => {
        if (entry.id !== userId) {
          return entry;
        }

        const existing = entry.webauthnCredentials.filter((item) => item.id !== credential.id);
        return {
          ...entry,
          webauthnCredentials: [...existing, credential]
        };
      });

      return {
        next: { users: nextUsers },
        result: undefined
      };
    });
  }

  async updateCredentialCounter(userId: UserId, credentialId: string, counter: number): Promise<void> {
    await userStore.update((current) => {
      const nextUsers = current.users.map((entry) => {
        if (entry.id !== userId) {
          return entry;
        }

        return {
          ...entry,
          webauthnCredentials: entry.webauthnCredentials.map((credential) =>
            credential.id === credentialId
              ? {
                  ...credential,
                  counter
                }
              : credential
          )
        };
      });

      return {
        next: { users: nextUsers },
        result: undefined
      };
    });
  }

  async setIdentityPublicKey(userId: UserId, publicKey: string): Promise<void> {
    await userStore.update((current) => {
      const nextUsers = current.users.map((entry) =>
        entry.id === userId
          ? {
              ...entry,
              identityPublicKey: publicKey,
              identityKeyUpdatedAt: Date.now()
            }
          : entry
      );

      return {
        next: { users: nextUsers },
        result: undefined
      };
    });
  }

  async getIdentityPublicKey(userId: UserId): Promise<string | null> {
    const user = await this.getUser(userId);
    return user.identityPublicKey ?? null;
  }
}