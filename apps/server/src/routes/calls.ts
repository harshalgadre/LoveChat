import type { FastifyInstance } from "fastify";
import { AccessToken } from "livekit-server-sdk";

import { CallTokenRequestSchema } from "@love-chat/shared";

import { requireUser } from "../auth/requestAuth";
import { config } from "../config";

export async function registerCallRoutes(app: FastifyInstance) {
  app.post("/calls/token", async (request, reply) => {
    const userId = await requireUser(request, reply);
    if (!userId) {
      return;
    }

    if (!config.livekit.url || !config.livekit.apiKey || !config.livekit.apiSecret) {
      return reply.status(503).send({ error: "LIVEKIT_NOT_CONFIGURED" });
    }

    const parsed = CallTokenRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "INVALID_BODY", details: parsed.error.flatten() });
    }

    const token = new AccessToken(config.livekit.apiKey, config.livekit.apiSecret, {
      identity: userId,
      name: userId,
      ttl: "15m"
    });

    token.addGrant({
      roomJoin: true,
      room: parsed.data.roomName,
      canPublish: true,
      canSubscribe: true
    });

    return reply.send({
      token: await token.toJwt(),
      livekitUrl: config.livekit.url,
      roomName: parsed.data.roomName
    });
  });
}