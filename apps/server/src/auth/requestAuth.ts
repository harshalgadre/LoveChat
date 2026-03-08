import type { FastifyReply, FastifyRequest } from "fastify";

import type { UserId } from "@love-chat/shared";

import { getCookieName, verifySessionToken } from "./session";

function readBearerToken(authorizationHeader: string | undefined): string | null {
  if (!authorizationHeader) {
    return null;
  }
  const [scheme, token] = authorizationHeader.split(" ");
  if (!scheme || !token || scheme.toLowerCase() !== "bearer") {
    return null;
  }
  return token.trim() || null;
}

export async function requireUser(request: FastifyRequest, reply: FastifyReply): Promise<UserId | null> {
  const cookieName = getCookieName();
  const cookieToken = request.cookies[cookieName];
  const bearerToken = readBearerToken(request.headers.authorization);
  const token = cookieToken ?? bearerToken;
  if (!token) {
    reply.status(401).send({ error: "UNAUTHORIZED", message: "Missing session cookie or bearer token" });
    return null;
  }

  const userId = await verifySessionToken(token);
  if (!userId) {
    if (cookieToken) {
      reply.clearCookie(cookieName);
    }
    reply.status(401).send({ error: "INVALID_SESSION" });
    return null;
  }

  return userId;
}
