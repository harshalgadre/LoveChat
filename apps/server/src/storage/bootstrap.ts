import fs from "node:fs/promises";
import path from "node:path";

import { MessageStoreSchema, MediaStoreSchema, UserStoreSchema } from "@love-chat/shared";

import { config } from "../config";
import { JsonFileStore } from "./jsonStore";

export const userStore = new JsonFileStore(
  path.join(config.storage.dataDir, "users.json"),
  UserStoreSchema,
  {
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
  }
);

export const messageStore = new JsonFileStore(
  path.join(config.storage.dataDir, "chat.json"),
  MessageStoreSchema,
  { messages: [] }
);

export const mediaStore = new JsonFileStore(
  path.join(config.storage.dataDir, "media.json"),
  MediaStoreSchema,
  { media: [] }
);

export async function ensureStorageReady(): Promise<void> {
  await fs.mkdir(config.storage.dataDir, { recursive: true });
  await fs.mkdir(config.storage.mediaDir, { recursive: true });

  await Promise.all([
    userStore.ensureFile(),
    messageStore.ensureFile(),
    mediaStore.ensureFile()
  ]);
}