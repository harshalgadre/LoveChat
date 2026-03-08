import { startAuthentication, startRegistration } from "@simplewebauthn/browser";

import type { UserId } from "@love-chat/shared";

import { jsonRequest } from "./api";
import type { AuthSession } from "./types";

interface ChallengePayload {
  username: UserId;
}

interface VerifyPayload {
  username: UserId;
  response: unknown;
  identityPublicKey?: string;
}

export async function registerPasskey(userId: UserId, identityPublicKey: string) {
  const options = await jsonRequest<any>("/auth/challenge/register", {
    method: "POST",
    body: { username: userId } satisfies ChallengePayload
  });

  const credential = await startRegistration({ optionsJSON: options });

  return jsonRequest<AuthSession>("/auth/verify/register", {
    method: "POST",
    body: {
      username: userId,
      response: credential,
      identityPublicKey
    } satisfies VerifyPayload
  });
}

export async function loginWithPasskey(userId: UserId) {
  const options = await jsonRequest<any>("/auth/challenge/login", {
    method: "POST",
    body: { username: userId } satisfies ChallengePayload
  });

  const assertion = await startAuthentication({ optionsJSON: options });

  return jsonRequest<AuthSession>("/auth/verify/login", {
    method: "POST",
    body: {
      username: userId,
      response: assertion
    } satisfies VerifyPayload
  });
}

export async function fetchSession(): Promise<AuthSession> {
  return jsonRequest<AuthSession>("/auth/me");
}

export async function updateIdentityPublicKey(publicKey: string): Promise<void> {
  await jsonRequest<{ ok: boolean }>("/keys/identity", {
    method: "POST",
    body: { publicKey }
  });
}

export async function logout(): Promise<void> {
  await jsonRequest<{ ok: boolean }>("/auth/logout", {
    method: "POST"
  });
}