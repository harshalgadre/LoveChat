import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MongoMemoryServer } from "mongodb-memory-server";

let mongoServer: MongoMemoryServer;
let createServer: typeof import("../src/index").createServer;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();

  process.env.NODE_ENV = "test";
  process.env.MONGODB_URI = mongoServer.getUri();
  process.env.MONGODB_DB_NAME = "lovechat_test";
  process.env.SESSION_JWT_SECRET = "test_session_secret_1234567890";
  process.env.WS_TOKEN_SECRET = "test_ws_secret_1234567890";
  process.env.WEB_ORIGIN = "http://localhost:3000";
  process.env.SERVER_ORIGIN = "http://localhost:4000";
  process.env.WEBAUTHN_RP_ID = "localhost";
  process.env.WEBAUTHN_ORIGIN = "http://localhost:3000";

  const mod = await import("../src/index");
  createServer = mod.createServer;
});

afterAll(async () => {
  const storage = await import("../src/storage/mongo");
  await storage.closeMongo();
  await mongoServer.stop();
});

describe("server", () => {
  it("returns health status", async () => {
    const app = await createServer();
    const response = await app.inject({ method: "GET", url: "/health" });

    expect(response.statusCode).toBe(200);
    expect(response.json().ok).toBe(true);

    await app.close();
  });

  it("rejects unauthenticated message fetch", async () => {
    const app = await createServer();
    const response = await app.inject({ method: "GET", url: "/messages?after=0" });

    expect(response.statusCode).toBe(401);

    await app.close();
  });
});