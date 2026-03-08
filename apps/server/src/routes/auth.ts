import type { FastifyInstance } from "fastify";

import {
  AuthChallengeRequestSchema,
  AuthVerifyLoginRequestSchema,
  AuthVerifyRegisterRequestSchema,
  IdentityKeyUpdateSchema
} from "@love-chat/shared";

import { config } from "../config";
import { createSessionToken, createWsToken, getCookieName } from "../auth/session";
import { requireUser } from "../auth/requestAuth";
import { UsersService } from "../services/usersService";
import { WebAuthnService } from "../auth/webauthn";

interface AuthRouteDeps {
  usersService: UsersService;
  webAuthnService: WebAuthnService;
}

export async function registerAuthRoutes(app: FastifyInstance, deps: AuthRouteDeps) {
  app.post("/auth/challenge/register", async (request, reply) => {
    const parsed = AuthChallengeRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "INVALID_BODY", details: parsed.error.flatten() });
    }

    const options = await deps.webAuthnService.createRegistrationChallenge(parsed.data.username);
    return reply.send(options);
  });

  app.post("/auth/verify/register", async (request, reply) => {
    const parsed = AuthVerifyRegisterRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "INVALID_BODY", details: parsed.error.flatten() });
    }

    const verification = await deps.webAuthnService.verifyRegistration(parsed.data.username, parsed.data.response);
    if (!verification.verified) {
      return reply.status(401).send({ verified: false });
    }

    if (parsed.data.identityPublicKey) {
      await deps.usersService.setIdentityPublicKey(parsed.data.username, parsed.data.identityPublicKey);
    }

    const sessionToken = await createSessionToken(parsed.data.username);
    const wsToken = await createWsToken(parsed.data.username);
    const peer = await deps.usersService.getPeerUser(parsed.data.username);
    const self = await deps.usersService.getUser(parsed.data.username);

    reply.setCookie(getCookieName(), sessionToken, {
      path: "/",
      httpOnly: true,
      sameSite: "strict",
      secure: config.isProd,
      maxAge: config.sessionTtlSeconds
    });

    return reply.send({
      verified: true,
      userId: parsed.data.username,
      wsToken,
      peerIdentityPublicKey: peer.identityPublicKey ?? null,
      selfIdentityPublicKey: self.identityPublicKey ?? null
    });
  });

  app.post("/auth/challenge/login", async (request, reply) => {
    const parsed = AuthChallengeRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "INVALID_BODY", details: parsed.error.flatten() });
    }

    const options = await deps.webAuthnService.createLoginChallenge(parsed.data.username);
    return reply.send(options);
  });

  app.post("/auth/verify/login", async (request, reply) => {
    const parsed = AuthVerifyLoginRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "INVALID_BODY", details: parsed.error.flatten() });
    }

    const verification = await deps.webAuthnService.verifyLogin(parsed.data.username, parsed.data.response);
    if (!verification.verified) {
      return reply.status(401).send({ verified: false });
    }

    const sessionToken = await createSessionToken(parsed.data.username);
    const wsToken = await createWsToken(parsed.data.username);
    const peer = await deps.usersService.getPeerUser(parsed.data.username);
    const self = await deps.usersService.getUser(parsed.data.username);

    reply.setCookie(getCookieName(), sessionToken, {
      path: "/",
      httpOnly: true,
      sameSite: "strict",
      secure: config.isProd,
      maxAge: config.sessionTtlSeconds
    });

    return reply.send({
      verified: true,
      userId: parsed.data.username,
      wsToken,
      peerIdentityPublicKey: peer.identityPublicKey ?? null,
      selfIdentityPublicKey: self.identityPublicKey ?? null
    });
  });

  app.get("/auth/me", async (request, reply) => {
    const userId = await requireUser(request, reply);
    if (!userId) {
      return;
    }

    const peer = await deps.usersService.getPeerUser(userId);
    const self = await deps.usersService.getUser(userId);
    const wsToken = await createWsToken(userId);

    return reply.send({
      userId,
      peerId: peer.id,
      peerIdentityPublicKey: peer.identityPublicKey ?? null,
      selfIdentityPublicKey: self.identityPublicKey ?? null,
      wsToken
    });
  });

  app.post("/auth/logout", async (request, reply) => {
    const userId = await requireUser(request, reply);
    if (!userId) {
      return;
    }

    reply.clearCookie(getCookieName(), { path: "/" });
    return reply.send({ ok: true });
  });

  app.post("/keys/identity", async (request, reply) => {
    const userId = await requireUser(request, reply);
    if (!userId) {
      return;
    }

    const parsed = IdentityKeyUpdateSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "INVALID_BODY", details: parsed.error.flatten() });
    }

    await deps.usersService.setIdentityPublicKey(userId, parsed.data.publicKey);
    return reply.send({ ok: true });
  });
}
