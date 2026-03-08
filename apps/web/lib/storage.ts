import { createStore, get, set } from "idb-keyval";

import type { IdentityKeyPair, SessionState } from "@love-chat/shared";

import type { UiMessage } from "./types";

const store = createStore("lovechat-db", "kv");

function key(prefix: string, userId: string): string {
  return `${prefix}:${userId}`;
}

export async function getIdentity(userId: string): Promise<IdentityKeyPair | null> {
  return (await get<IdentityKeyPair>(key("identity", userId), store)) ?? null;
}

export async function setIdentity(userId: string, identity: IdentityKeyPair): Promise<void> {
  await set(key("identity", userId), identity, store);
}

export async function getSession(userId: string): Promise<SessionState | null> {
  return (await get<SessionState>(key("session", userId), store)) ?? null;
}

export async function setSession(userId: string, session: SessionState): Promise<void> {
  await set(key("session", userId), session, store);
}

export async function getMessages(userId: string): Promise<UiMessage[]> {
  return (await get<UiMessage[]>(key("messages", userId), store)) ?? [];
}

export async function setMessages(userId: string, messages: UiMessage[]): Promise<void> {
  await set(key("messages", userId), messages, store);
}

export async function getLastServerId(userId: string): Promise<number> {
  return (await get<number>(key("lastServerId", userId), store)) ?? 0;
}

export async function setLastServerId(userId: string, value: number): Promise<void> {
  await set(key("lastServerId", userId), value, store);
}