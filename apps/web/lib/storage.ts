import { createStore, get, set } from "idb-keyval";

import type { IdentityKeyPair, SessionState } from "@love-chat/shared";

import type { UiMessage } from "./types";

const store = createStore("lovechat-db", "kv");

function key(prefix: string, userId: string): string {
  return `${prefix}:${userId}`;
}

function conversationKey(prefix: string, userId: string, peerId: string): string {
  return `${prefix}:${userId}:${peerId}`;
}

export async function getIdentity(userId: string): Promise<IdentityKeyPair | null> {
  return (await get<IdentityKeyPair>(key("identity", userId), store)) ?? null;
}

export async function setIdentity(userId: string, identity: IdentityKeyPair): Promise<void> {
  await set(key("identity", userId), identity, store);
}

export async function getSession(userId: string, peerId: string): Promise<SessionState | null> {
  return (await get<SessionState>(conversationKey("session", userId, peerId), store)) ?? null;
}

export async function setSession(userId: string, peerId: string, session: SessionState): Promise<void> {
  await set(conversationKey("session", userId, peerId), session, store);
}

export async function getMessages(userId: string, peerId: string): Promise<UiMessage[]> {
  return (await get<UiMessage[]>(conversationKey("messages", userId, peerId), store)) ?? [];
}

export async function setMessages(userId: string, peerId: string, messages: UiMessage[]): Promise<void> {
  await set(conversationKey("messages", userId, peerId), messages, store);
}

export async function getLastServerId(userId: string): Promise<number> {
  return (await get<number>(key("lastServerId", userId), store)) ?? 0;
}

export async function setLastServerId(userId: string, value: number): Promise<void> {
  await set(key("lastServerId", userId), value, store);
}
