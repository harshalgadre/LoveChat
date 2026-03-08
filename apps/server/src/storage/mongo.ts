import { Binary, Collection, Db, MongoClient } from "mongodb";

import type { MediaRecord, MessageRecord, UserRecord } from "@love-chat/shared";
import { MediaRecordSchema, MessageRecordSchema, UserRecordSchema } from "@love-chat/shared";

import { config } from "../config";

interface CounterDoc {
  _id: string;
  seq: number;
}

interface MediaBlobDoc {
  _id: string;
  data: Binary;
  createdAt: number;
  expiresAt: number;
}

interface Collections {
  users: Collection<UserRecord>;
  messages: Collection<MessageRecord>;
  media: Collection<MediaRecord>;
  mediaBlobs: Collection<MediaBlobDoc>;
  counters: Collection<CounterDoc>;
}

let mongoClient: MongoClient | null = null;
let mongoDbPromise: Promise<Db> | null = null;

async function connectDb(): Promise<Db> {
  if (!mongoDbPromise) {
    mongoClient = new MongoClient(config.mongo.uri, {
      ignoreUndefined: true
    });

    mongoDbPromise = mongoClient.connect().then((client) => client.db(config.mongo.dbName));
  }

  return mongoDbPromise;
}

export async function getCollections(): Promise<Collections> {
  const db = await connectDb();

  return {
    users: db.collection<UserRecord>("users"),
    messages: db.collection<MessageRecord>("messages"),
    media: db.collection<MediaRecord>("media"),
    mediaBlobs: db.collection<MediaBlobDoc>("media_blobs"),
    counters: db.collection<CounterDoc>("counters")
  };
}

export async function ensureMongoReady(): Promise<void> {
  const { users, messages, media, mediaBlobs } = await getCollections();

  await Promise.all([
    users.createIndex({ id: 1 }, { unique: true }),
    users.createIndex(
      { phoneNumber: 1 },
      {
        unique: true,
        partialFilterExpression: { phoneNumber: { $type: "string" } }
      }
    ),
    messages.createIndex({ id: 1 }, { unique: true }),
    messages.createIndex({ sender: 1, recipient: 1, id: 1 }),
    media.createIndex({ id: 1 }, { unique: true }),
    media.createIndex({ expiresAt: 1 }),
    mediaBlobs.createIndex({ expiresAt: 1 })
  ]);

  // Backward-compat migration for old records created before phone numbers were mandatory.
  const missingPhone = await users
    .find({
      $or: [{ phoneNumber: { $exists: false } }, { phoneNumber: "" }]
    })
    .toArray();

  for (let index = 0; index < missingPhone.length; index += 1) {
    const doc = missingPhone[index];
    const fallbackPhone = `+1999${String(index + 1).padStart(8, "0")}`;
    const fallbackDisplayName =
      typeof doc.displayName === "string" && doc.displayName.trim().length > 0
        ? doc.displayName
        : typeof doc.id === "string" && doc.id.length > 0
          ? `${doc.id[0]!.toUpperCase()}${doc.id.slice(1)}`
          : "User";

    await users.updateOne(
      { _id: doc._id },
      {
        $set: {
          phoneNumber: fallbackPhone,
          displayName: fallbackDisplayName,
          webauthnCredentials: Array.isArray(doc.webauthnCredentials) ? doc.webauthnCredentials : []
        }
      }
    );
  }
}

export async function nextCounterValue(counterId: string): Promise<number> {
  const { counters } = await getCollections();
  const result = await counters.findOneAndUpdate(
    { _id: counterId },
    { $inc: { seq: 1 } },
    {
      upsert: true,
      returnDocument: "after"
    }
  );

  if (!result) {
    throw new Error(`Counter update failed for ${counterId}`);
  }

  return result.seq;
}

export function parseUserRecord(input: unknown): UserRecord {
  return UserRecordSchema.parse(input);
}

export function parseMessageRecord(input: unknown): MessageRecord {
  return MessageRecordSchema.parse(input);
}

export function parseMediaRecord(input: unknown): MediaRecord {
  return MediaRecordSchema.parse(input);
}

export async function closeMongo(): Promise<void> {
  if (mongoClient) {
    await mongoClient.close();
    mongoClient = null;
    mongoDbPromise = null;
  }
}
