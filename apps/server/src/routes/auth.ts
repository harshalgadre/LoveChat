import type { FastifyInstance, FastifyReply } from "fastify";

import {
  AuthChallengeRequestSchema,
  AuthRegisterChallengeRequestSchema,
  AuthVerifyLoginRequestSchema,
  AuthVerifyRegisterRequestSchema,
  IdentityKeyUpdateSchema,
  type UserId
} from "@love-chat/shared";

import { config } from "../config";
import { createSessionToken, createWsToken, getCookieName } from "../auth/session";
import { requireUser } from "../auth/requestAuth";
import { UserServiceError, UsersService } from "../services/usersService";
import { WebAuthnService } from "../auth/webauthn";

interface AuthRouteDeps {
  usersService: UsersService;
  webAuthnService: WebAuthnService;
}

function sendServiceError(reply: FastifyReply, error: unknown): FastifyReply | null {
  if (error instanceof UserServiceError) {
    const status = error.code === "UNKNOWN_USER" ? 404 : 409;
    return reply.status(status).send({
      error: error.code,
      message: error.message
    });
  }
  return null;
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function buildAuthResponse(deps: AuthRouteDeps, userId: UserId, sessionToken: string, wsToken: string) {
  const self = await deps.usersService.getUser(userId);
  const users = await deps.usersService.listUserDirectory();

  return {
    userId,
    sessionToken,
    wsToken,
    selfIdentityPublicKey: self.identityPublicKey ?? null,
    users
  };
}

function refreshAuthCookie(reply: FastifyReply, sessionToken: string) {
  reply.setCookie(getCookieName(), sessionToken, {
    path: "/",
    httpOnly: true,
    sameSite: config.sessionCookieSameSite,
    secure: config.isProd,
    maxAge: config.sessionTtlSeconds
  });
}

export async function registerAuthRoutes(app: FastifyInstance, deps: AuthRouteDeps) {
  app.post("/auth/challenge/register", async (request, reply) => {
    const parsed = AuthRegisterChallengeRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "INVALID_BODY", details: parsed.error.flatten() });
    }

    try {
      const options = await deps.webAuthnService.createRegistrationChallenge(
        parsed.data.username,
        parsed.data.phoneNumber
      );
      return reply.send(options);
    } catch (error) {
      const handled = sendServiceError(reply, error);
      if (handled) {
        return handled;
      }
      return reply.status(400).send({ error: "REGISTER_CHALLENGE_FAILED", message: toErrorMessage(error) });
    }
  });

  app.post("/auth/verify/register", async (request, reply) => {
    const parsed = AuthVerifyRegisterRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "INVALID_BODY", details: parsed.error.flatten() });
    }

    try {
      const verification = await deps.webAuthnService.verifyRegistration(
        parsed.data.username,
        parsed.data.phoneNumber,
        parsed.data.response
      );
      if (!verification.verified) {
        return reply.status(401).send({ verified: false });
      }
    } catch (error) {
      const handled = sendServiceError(reply, error);
      if (handled) {
        return handled;
      }
      return reply.status(400).send({ error: "REGISTER_VERIFY_FAILED", message: toErrorMessage(error) });
    }

    if (parsed.data.identityPublicKey) {
      await deps.usersService.setIdentityPublicKey(parsed.data.username, parsed.data.identityPublicKey);
    }

    const sessionToken = await createSessionToken(parsed.data.username);
    const wsToken = await createWsToken(parsed.data.username);
    refreshAuthCookie(reply, sessionToken);
    return reply.send(await buildAuthResponse(deps, parsed.data.username, sessionToken, wsToken));
  });

  app.post("/auth/challenge/login", async (request, reply) => {
    const parsed = AuthChallengeRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "INVALID_BODY", details: parsed.error.flatten() });
    }

    try {
      const options = await deps.webAuthnService.createLoginChallenge(parsed.data.username);
      return reply.send(options);
    } catch (error) {
      const handled = sendServiceError(reply, error);
      if (handled) {
        return handled;
      }
      return reply.status(400).send({ error: "LOGIN_CHALLENGE_FAILED", message: toErrorMessage(error) });
    }
  });

  app.post("/auth/verify/login", async (request, reply) => {
    const parsed = AuthVerifyLoginRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "INVALID_BODY", details: parsed.error.flatten() });
    }

    try {
      const verification = await deps.webAuthnService.verifyLogin(parsed.data.username, parsed.data.response);
      if (!verification.verified) {
        return reply.status(401).send({ verified: false });
      }
    } catch (error) {
      const handled = sendServiceError(reply, error);
      if (handled) {
        return handled;
      }
      return reply.status(401).send({ error: "LOGIN_VERIFY_FAILED", message: toErrorMessage(error) });
    }

    const sessionToken = await createSessionToken(parsed.data.username);
    const wsToken = await createWsToken(parsed.data.username);
    refreshAuthCookie(reply, sessionToken);
    return reply.send(await buildAuthResponse(deps, parsed.data.username, sessionToken, wsToken));
  });

  app.get("/auth/me", async (request, reply) => {
    const userId = await requireUser(request, reply);
    if (!userId) {
      return;
    }

    const sessionToken = await createSessionToken(userId);
    const wsToken = await createWsToken(userId);
    refreshAuthCookie(reply, sessionToken);
    return reply.send(await buildAuthResponse(deps, userId, sessionToken, wsToken));
  });

  app.get("/users", async (request, reply) => {
    const userId = await requireUser(request, reply);
    if (!userId) {
      return;
    }

    return reply.send({
      users: await deps.usersService.listUserDirectory()
    });
  });

  app.post("/auth/logout", async (_request, reply) => {
    reply.clearCookie(getCookieName(), {
      path: "/",
      sameSite: config.sessionCookieSameSite,
      secure: config.isProd
    });
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
