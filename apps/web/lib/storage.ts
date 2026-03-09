import { createStore, del, get, keys, set } from "idb-keyval";

import type { IdentityKeyPair, SessionState } from "@love-chat/shared";

import type { UiMessage } from "./types";

const store = createStore("lovechat-db", "kv");
const HOURLY_BACKUP_PREFIX = "lovechat:backup";

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

export async function getNicknames(userId: string): Promise<Record<string, string>> {
  return (await get<Record<string, string>>(key("nicknames", userId), store)) ?? {};
}

export async function getNickname(userId: string, peerId: string): Promise<string | null> {
  const nicknames = await getNicknames(userId);
  return nicknames[peerId] ?? null;
}

export async function setNickname(userId: string, peerId: string, nickname: string): Promise<void> {
  const current = await getNicknames(userId);
  const next = {
    ...current
  };

  const trimmed = nickname.trim();
  if (trimmed) {
    next[peerId] = trimmed;
  } else {
    delete next[peerId];
  }

  await set(key("nicknames", userId), next, store);
}

export async function clearConversationData(userId: string, peerId: string): Promise<void> {
  await del(conversationKey("messages", userId, peerId), store);
  await del(conversationKey("session", userId, peerId), store);
}

function backupStorageKey(userId: string): string {
  return `${HOURLY_BACKUP_PREFIX}:${userId}`;
}

export interface HourlyBackupSnapshot {
  savedAt: number;
  selectedPeerId: string | null;
  messageCount: number;
  lastServerId: number;
  nicknames: Record<string, string>;
  latestConversationMessages: UiMessage[];
}

export function getHourlyBackup(userId: string): HourlyBackupSnapshot | null {
  if (typeof window === "undefined") {
    return null;
  }

  const raw = window.localStorage.getItem(backupStorageKey(userId));
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as HourlyBackupSnapshot;
    if (!parsed || typeof parsed !== "object") {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function setHourlyBackup(userId: string, snapshot: HourlyBackupSnapshot): void {
  if (typeof window === "undefined") {
    return;
  }
  window.localStorage.setItem(backupStorageKey(userId), JSON.stringify(snapshot));
}

export function clearHourlyBackup(userId: string): void {
  if (typeof window === "undefined") {
    return;
  }
  window.localStorage.removeItem(backupStorageKey(userId));
}

export async function getChatBackground(userId: string): Promise<string | null> {
  return (await get<string>(key("chatBackground", userId), store)) ?? null;
}

export async function setChatBackground(userId: string, value: string | null): Promise<void> {
  if (!value) {
    await del(key("chatBackground", userId), store);
    return;
  }
  await set(key("chatBackground", userId), value, store);
}

export async function clearUserLocalData(userId: string): Promise<void> {
  const allKeys = await keys(store);
  const prefixes = [`identity:${userId}`, `lastServerId:${userId}`, `nicknames:${userId}`, `chatBackground:${userId}`];
  const conversationPrefixes = [`messages:${userId}:`, `session:${userId}:`];

  const deletions: Promise<void>[] = [];
  for (const existing of allKeys) {
    if (typeof existing !== "string") {
      continue;
    }

    if (prefixes.includes(existing) || conversationPrefixes.some((prefix) => existing.startsWith(prefix))) {
      deletions.push(del(existing, store));
    }
  }

  await Promise.all(deletions);
  clearHourlyBackup(userId);
}
