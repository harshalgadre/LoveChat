import type { FastifyReply, FastifyRequest } from "fastify";

import type { UserId } from "@love-chat/shared";

import { getCookieName, verifySessionToken } from "./session";

export async function requireUser(request: FastifyRequest, reply: FastifyReply): Promise<UserId | null> {
  const cookieName = getCookieName();
  const token = request.cookies[cookieName];
  if (!token) {
    reply.status(401).send({ error: "UNAUTHORIZED" });
    return null;
  }

  const userId = await verifySessionToken(token);
  if (!userId) {
    reply.clearCookie(cookieName);
    reply.status(401).send({ error: "INVALID_SESSION" });
    return null;
  }

  return userId;
}