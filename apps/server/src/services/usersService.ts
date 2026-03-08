import type { UserCredential, UserId, UserRecord } from "@love-chat/shared";

import { config } from "../config";
import { getCollections, parseUserRecord } from "../storage/mongo";

export class UserServiceError extends Error {
  constructor(
    readonly code: "UNKNOWN_USER" | "PHONE_ALREADY_USED" | "PHONE_MISMATCH" | "MAX_USERS_REACHED",
    message: string
  ) {
    super(message);
    this.name = "UserServiceError";
  }
}

interface CreateUserInput {
  id: UserId;
  phoneNumber: string;
}

export interface UserDirectoryEntry {
  id: UserId;
  displayName: string;
  avatarUrl: string | null;
  identityPublicKey: string | null;
}

function defaultDisplayName(userId: string): string {
  if (!userId.length) {
    return userId;
  }
  return `${userId[0]!.toUpperCase()}${userId.slice(1)}`;
}

export class UsersService {
  async listUsers(): Promise<UserRecord[]> {
    const { users } = await getCollections();
    const docs = await users.find({}, { sort: { id: 1 } }).toArray();
    return docs.map((doc) => parseUserRecord(doc));
  }

  async listUserDirectory(): Promise<UserDirectoryEntry[]> {
    const users = await this.listUsers();
    return users.map((user) => ({
      id: user.id,
      displayName: user.displayName,
      avatarUrl: user.avatarUrl ?? null,
      identityPublicKey: user.identityPublicKey ?? null
    }));
  }

  async getUser(userId: UserId): Promise<UserRecord> {
    const { users } = await getCollections();
    const doc = await users.findOne({ id: userId });
    if (!doc) {
      throw new UserServiceError("UNKNOWN_USER", `Unknown user ${userId}`);
    }

    return parseUserRecord(doc);
  }

  async findUser(userId: UserId): Promise<UserRecord | null> {
    const { users } = await getCollections();
    const doc = await users.findOne({ id: userId });
    return doc ? parseUserRecord(doc) : null;
  }

  async findUserByPhone(phoneNumber: string): Promise<UserRecord | null> {
    const { users } = await getCollections();
    const doc = await users.findOne({ phoneNumber });
    return doc ? parseUserRecord(doc) : null;
  }

  async validateRegistrationInput(userId: UserId, phoneNumber: string): Promise<void> {
    const existing = await this.findUser(userId);
    if (existing) {
      if (existing.phoneNumber !== phoneNumber) {
        throw new UserServiceError(
          "PHONE_MISMATCH",
          "This username is already linked to a different phone number"
        );
      }
      return;
    }

    const phoneOwner = await this.findUserByPhone(phoneNumber);
    if (phoneOwner && phoneOwner.id !== userId) {
      throw new UserServiceError("PHONE_ALREADY_USED", "Phone number is already registered");
    }

    const { users } = await getCollections();
    const totalUsers = await users.countDocuments();
    if (totalUsers >= config.maxUsers) {
      throw new UserServiceError("MAX_USERS_REACHED", `User limit reached (${config.maxUsers})`);
    }
  }

  async ensureUser(input: CreateUserInput): Promise<UserRecord> {
    const existing = await this.findUser(input.id);
    if (existing) {
      if (existing.phoneNumber !== input.phoneNumber) {
        throw new UserServiceError(
          "PHONE_MISMATCH",
          "This username is already linked to a different phone number"
        );
      }
      return existing;
    }

    await this.validateRegistrationInput(input.id, input.phoneNumber);

    const { users } = await getCollections();
    const record: UserRecord = {
      id: input.id,
      displayName: defaultDisplayName(input.id),
      phoneNumber: input.phoneNumber,
      webauthnCredentials: []
    };

    await users.insertOne(record);
    return parseUserRecord(record);
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

  async updateProfile(
    userId: UserId,
    input: {
      displayName?: string;
      avatarUrl?: string;
    }
  ): Promise<UserRecord> {
    const update: Record<string, unknown> = {};
    if (input.displayName !== undefined) {
      update.displayName = input.displayName;
    }
    if (input.avatarUrl !== undefined) {
      update.avatarUrl = input.avatarUrl;
    }

    if (!Object.keys(update).length) {
      return this.getUser(userId);
    }

    const { users } = await getCollections();
    await users.updateOne(
      { id: userId },
      {
        $set: update
      }
    );

    return this.getUser(userId);
  }
}
