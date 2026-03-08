import { jwtVerify, SignJWT } from "jose";

import type { UserId } from "@love-chat/shared";

import { config } from "../config";

const sessionSecret = new TextEncoder().encode(config.sessionJwtSecret);
const wsSecret = new TextEncoder().encode(config.wsTokenSecret);

interface BaseToken {
  sub: UserId;
  type: "session" | "ws";
}

export async function createSessionToken(userId: UserId): Promise<string> {
  return new SignJWT({ type: "session" })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime(`${config.sessionTtlSeconds}s`)
    .sign(sessionSecret);
}

export async function createWsToken(userId: UserId): Promise<string> {
  return new SignJWT({ type: "ws" })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime(`${config.wsTokenTtlSeconds}s`)
    .sign(wsSecret);
}

async function verifyToken(token: string, expectedType: BaseToken["type"]): Promise<UserId | null> {
  try {
    const secret = expectedType === "session" ? sessionSecret : wsSecret;
    const verified = await jwtVerify<BaseToken>(token, secret, {
      algorithms: ["HS256"]
    });

    if (verified.payload.type !== expectedType) {
      return null;
    }

    return verified.payload.sub as UserId;
  } catch {
    return null;
  }
}

export function getCookieName() {
  return config.sessionCookieName;
}

export async function verifySessionToken(token: string): Promise<UserId | null> {
  return verifyToken(token, "session");
}

export async function verifyWsToken(token: string): Promise<UserId | null> {
  return verifyToken(token, "ws");
}