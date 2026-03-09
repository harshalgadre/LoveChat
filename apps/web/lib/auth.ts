import { startAuthentication, startRegistration } from "@simplewebauthn/browser";

import type { UserId } from "@love-chat/shared";

import { jsonRequest } from "./api";
import { clearSessionToken, setSessionToken } from "./sessionToken";
import type { AuthSession } from "./types";

interface ChallengePayload {
  username: UserId;
  phoneNumber?: string;
}

interface VerifyPayload {
  username: UserId;
  phoneNumber?: string;
  response: unknown;
  identityPublicKey?: string;
}

export async function registerPasskey(userId: UserId, phoneNumber: string, identityPublicKey: string) {
  const options = await jsonRequest<any>("/auth/challenge/register", {
    method: "POST",
    body: { username: userId, phoneNumber } satisfies ChallengePayload
  });

  const credential = await startRegistration({ optionsJSON: options });

  const session = await jsonRequest<AuthSession>("/auth/verify/register", {
    method: "POST",
    body: {
      username: userId,
      phoneNumber,
      response: credential,
      identityPublicKey
    } satisfies VerifyPayload
  });
  if (session.sessionToken) {
    setSessionToken(session.sessionToken);
  }
  return session;
}

export async function loginWithPasskey(userId: UserId) {
  const options = await jsonRequest<any>("/auth/challenge/login", {
    method: "POST",
    body: { username: userId } satisfies ChallengePayload
  });

  const assertion = await startAuthentication({ optionsJSON: options });

  const session = await jsonRequest<AuthSession>("/auth/verify/login", {
    method: "POST",
    body: {
      username: userId,
      response: assertion
    } satisfies VerifyPayload
  });
  if (session.sessionToken) {
    setSessionToken(session.sessionToken);
  }
  return session;
}

export async function fetchSession(): Promise<AuthSession> {
  const session = await jsonRequest<AuthSession>("/auth/me");
  if (session.sessionToken) {
    setSessionToken(session.sessionToken);
  }
  return session;
}

export async function updateIdentityPublicKey(publicKey: string): Promise<void> {
  await jsonRequest<{ ok: boolean }>("/keys/identity", {
    method: "POST",
    body: { publicKey }
  });
}

export async function updateProfile(input: { displayName?: string; avatarUrl?: string }) {
  return jsonRequest<{
    ok: boolean;
    profile: {
      id: UserId;
      displayName: string;
      avatarUrl: string | null;
      phoneNumber: string;
    };
  }>("/profile", {
    method: "POST",
    body: input
  });
}

export async function logout(): Promise<void> {
  try {
    await jsonRequest<{ ok: boolean }>("/auth/logout", {
      method: "POST"
    });
  } finally {
    clearSessionToken();
  }
}

export async function deleteAccount(): Promise<void> {
  try {
    await jsonRequest<{ ok: boolean }>("/auth/account", {
      method: "DELETE"
    });
  } finally {
    clearSessionToken();
  }
}
