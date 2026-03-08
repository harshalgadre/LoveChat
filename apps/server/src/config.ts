import dotenv from "dotenv";
import { z } from "zod";

import path from "node:path";

dotenv.config({ path: path.resolve(process.cwd(), ".env") });
if (!process.env.SESSION_JWT_SECRET || !process.env.WS_TOKEN_SECRET) {
  dotenv.config({ path: path.resolve(process.cwd(), "../../.env") });
}

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().optional(),
  SERVER_PORT: z.coerce.number().int().positive().optional(),
  WEB_ORIGIN: z.string().url().default("http://localhost:3000"),
  SERVER_ORIGIN: z.string().url().default("http://localhost:4000"),
  SESSION_COOKIE_NAME: z.string().default("lovechat_session"),
  SESSION_COOKIE_SAMESITE: z.enum(["strict", "lax", "none"]).default("strict"),
  SESSION_TTL_SECONDS: z.coerce.number().int().positive().default(43200),
  SESSION_JWT_SECRET: z.string().min(16),
  WS_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  WS_TOKEN_SECRET: z.string().min(16),
  WEBAUTHN_RP_NAME: z.string().default("LoveChat"),
  WEBAUTHN_RP_ID: z.string().default("localhost"),
  WEBAUTHN_ORIGIN: z.string().url().default("http://localhost:3000"),
  MONGODB_URI: z.string().min(10),
  MONGODB_DB_NAME: z.string().min(1).default("lovechat"),
  MEDIA_RETENTION_MINUTES: z.coerce.number().int().positive().default(120),
  LIVEKIT_URL: z.string().default(""),
  LIVEKIT_API_KEY: z.string().default(""),
  LIVEKIT_API_SECRET: z.string().default(""),
  CRYPTO_PROTOCOL_VERSION: z.coerce.number().int().positive().default(1)
});

const parsed = EnvSchema.safeParse(process.env);
if (!parsed.success) {
  throw new Error(`Invalid env configuration: ${parsed.error.message}`);
}

const env = parsed.data;
const resolvedServerPort = env.SERVER_PORT ?? env.PORT ?? 4000;

export const config = {
  nodeEnv: env.NODE_ENV,
  isProd: env.NODE_ENV === "production",
  serverPort: resolvedServerPort,
  webOrigin: env.WEB_ORIGIN,
  serverOrigin: env.SERVER_ORIGIN,
  sessionCookieName: env.SESSION_COOKIE_NAME,
  sessionCookieSameSite: env.SESSION_COOKIE_SAMESITE,
  sessionTtlSeconds: env.SESSION_TTL_SECONDS,
  sessionJwtSecret: env.SESSION_JWT_SECRET,
  wsTokenTtlSeconds: env.WS_TOKEN_TTL_SECONDS,
  wsTokenSecret: env.WS_TOKEN_SECRET,
  webauthn: {
    rpName: env.WEBAUTHN_RP_NAME,
    rpID: env.WEBAUTHN_RP_ID,
    origin: env.WEBAUTHN_ORIGIN
  },
  mongo: {
    uri: env.MONGODB_URI,
    dbName: env.MONGODB_DB_NAME
  },
  retention: {
    mediaRetentionMs: env.MEDIA_RETENTION_MINUTES * 60_000
  },
  livekit: {
    url: env.LIVEKIT_URL,
    apiKey: env.LIVEKIT_API_KEY,
    apiSecret: env.LIVEKIT_API_SECRET
  },
  cryptoProtocolVersion: env.CRYPTO_PROTOCOL_VERSION
} as const;

export type Config = typeof config;
