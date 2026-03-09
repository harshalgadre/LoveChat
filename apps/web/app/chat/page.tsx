"use client";

import { fromBase64Url, type ClientEvent, type MessageRecord, type MessageType, type UserId } from "@love-chat/shared";
import type { SessionState } from "@love-chat/shared";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useRouter } from "next/navigation";

import { jsonRequest } from "../../lib/api";
import { deleteAccount, fetchSession, logout, updateIdentityPublicKey, updateProfile } from "../../lib/auth";
import { fileToBytes } from "../../lib/bytes";
import { bindRemoteTrack, createLiveKitConnection, endLiveKitConnection, type ActiveCall } from "../../lib/calls";
import {
  decryptBinaryPayload,
  decryptTextPayload,
  encryptBytesWithSession,
  encryptTextWithSession,
  ensureConversationCrypto,
  ensureIdentityKey
} from "../../lib/cryptoSession";
import { ackMedia, downloadEncryptedMedia, uploadEncryptedMedia } from "../../lib/media";
import {
  cancelCallNotification,
  initializeNotifications,
  notifyIncomingCall,
  notifyIncomingMessage
} from "../../lib/notifications";
import {
  clearConversationData,
  clearUserLocalData,
  clearHourlyBackup,
  getChatBackground,
  getHourlyBackup,
  getLastServerId,
  getMessages,
  getNicknames,
  setChatBackground,
  setHourlyBackup,
  setLastServerId,
  setMessages,
  setNickname
} from "../../lib/storage";
import type { AuthSession, MediaDescriptor, UiMessage } from "../../lib/types";
import { ChatSocket, makeClientEvent } from "../../lib/wsClient";

type CallState = {
  peerId: UserId;
  roomName: string;
  callType: "audio" | "video";
};

type OutgoingCall = CallState & {
  startedAt: number;
};

type IncomingCall = {
  from: UserId;
  roomName: string;
  callType: "audio" | "video";
};

type MediaPreview = {
  objectUrl: string;
  mimeType: string;
};

type ComposeActionMode = "idle" | "armed" | "voice" | "video";

const HOLD_TO_RECORD_MS = 260;
const DRAG_TO_VIDEO_THRESHOLD = 52;
const VIEW_ONCE_PREFIX = "[[VO1]]:";
const VIEW_ONCE_AUTO_DELETE_MS = 5_000;
const HOURLY_BACKUP_INTERVAL_MS = 60 * 60 * 1000;

function formatTime(value: number): string {
  return new Date(value).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit"
  });
}

function isInlineMedia(mimeType: string): boolean {
  return mimeType.startsWith("image/") || mimeType.startsWith("audio/") || mimeType.startsWith("video/");
}

function createBlobUrl(bytes: Uint8Array, mimeType: string): string {
  const mediaBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const blob = new Blob([mediaBuffer], { type: mimeType });
  return URL.createObjectURL(blob);
}

function triggerDownload(fileName: string, objectUrl: string) {
  const link = document.createElement("a");
  link.href = objectUrl;
  link.download = fileName;
  link.click();
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") {
        resolve(reader.result);
        return;
      }
      reject(new Error("Unable to read file"));
    };
    reader.onerror = () => reject(reader.error ?? new Error("Unable to read file"));
    reader.readAsDataURL(file);
  });
}

function isUnauthorizedRequestError(error: unknown): boolean {
  return error instanceof Error && error.message.includes("Request failed (401)");
}

function mergeUiMessages(current: UiMessage[], incoming: UiMessage[]): UiMessage[] {
  if (incoming.length === 0) {
    return current;
  }

  const next = [...current];
  for (const message of incoming) {
    const index = next.findIndex((entry) => {
      if (message.serverId && entry.serverId) {
        return message.serverId === entry.serverId;
      }
      return message.clientMessageId === entry.clientMessageId;
    });

    if (index >= 0) {
      next[index] = {
        ...next[index],
        ...message
      };
      continue;
    }
    next.push(message);
  }

  next.sort((a, b) => a.createdAt - b.createdAt);
  return next;
}

function Avatar({
  name,
  avatarUrl,
  size = 34
}: {
  name: string;
  avatarUrl?: string | null;
  size?: number;
}) {
  const initial = name.trim().charAt(0).toUpperCase() || "?";
  const style: Record<string, string | number> = {
    width: `${size}px`,
    height: `${size}px`,
    borderRadius: "50%",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    fontWeight: 700,
    color: "#f4fbff",
    background: "linear-gradient(140deg, #1a4d5d, #0d2d3a)",
    border: "1px solid rgba(159, 195, 209, 0.35)",
    flexShrink: 0
  };

  if (avatarUrl) {
    style.backgroundImage = `url(${avatarUrl})`;
    style.backgroundSize = "cover";
    style.backgroundPosition = "center";
    style.color = "transparent";
  }

  return <span style={style}>{initial}</span>;
}

export default function ChatPage() {
  const router = useRouter();

  const [auth, setAuth] = useState<AuthSession | null>(null);
  const [selectedPeerId, setSelectedPeerId] = useState<UserId | null>(null);
  const [messages, setMessagesState] = useState<UiMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [status, setStatus] = useState("Initializing...");
  const [socketStatus, setSocketStatus] = useState<"connecting" | "connected" | "disconnected">("disconnected");
  const [peerTyping, setPeerTyping] = useState(false);
  const [incomingCall, setIncomingCall] = useState<IncomingCall | null>(null);
  const [outgoingCall, setOutgoingCall] = useState<OutgoingCall | null>(null);
  const [activeCall, setActiveCall] = useState<CallState | null>(null);
  const [audioRecording, setAudioRecording] = useState(false);
  const [videoRecording, setVideoRecording] = useState(false);
  const [mediaPreviews, setMediaPreviews] = useState<Record<string, MediaPreview>>({});
  const [nicknames, setNicknamesState] = useState<Record<string, string>>({});
  const [nicknameDraft, setNicknameDraft] = useState("");
  const [dashboardTab, setDashboardTab] = useState<"main" | "directory" | "settings">("main");
  const [mobileDrawerOpen, setMobileDrawerOpen] = useState(false);
  const [profileDisplayName, setProfileDisplayName] = useState("");
  const [profileAvatarUrl, setProfileAvatarUrl] = useState("");
  const [profileSaving, setProfileSaving] = useState(false);
  const [composeActionMode, setComposeActionMode] = useState<ComposeActionMode>("idle");
  const [composeDragOffset, setComposeDragOffset] = useState(0);
  const [remoteVideoTracks, setRemoteVideoTracks] = useState(0);
  const [activeMeetUrl, setActiveMeetUrl] = useState<string | null>(null);
  const [callError, setCallError] = useState<string | null>(null);
  const [sendViewOnce, setSendViewOnce] = useState(false);
  const [chatBackground, setChatBackgroundState] = useState<string | null>(null);
  const [chatBackgroundDraft, setChatBackgroundDraft] = useState("");
  const [clearingChat, setClearingChat] = useState(false);
  const [deletingAccount, setDeletingAccount] = useState(false);
  const [hourlyBackupStatus, setHourlyBackupStatus] = useState<string>("");

  const authRef = useRef<AuthSession | null>(null);
  const selectedPeerRef = useRef<UserId | null>(null);
  const sharedSecretRef = useRef<string | null>(null);
  const sessionRef = useRef<SessionState | null>(null);
  const outgoingCallRef = useRef<OutgoingCall | null>(null);
  const incomingCallRef = useRef<IncomingCall | null>(null);
  const callTimeoutRef = useRef<number | null>(null);
  const socketRef = useRef<ChatSocket | null>(null);
  const typingSentRef = useRef(false);
  const audioRecorderRef = useRef<MediaRecorder | null>(null);
  const videoRecorderRef = useRef<MediaRecorder | null>(null);
  const videoPreviewRef = useRef<HTMLVideoElement | null>(null);
  const draftInputRef = useRef<HTMLTextAreaElement | null>(null);
  const videoStreamRef = useRef<MediaStream | null>(null);
  const callRef = useRef<ActiveCall | null>(null);
  const remoteTrackCleanupRef = useRef<(() => void) | null>(null);
  const remoteTracksHostRef = useRef<HTMLDivElement | null>(null);
  const mediaPreviewsRef = useRef<Record<string, MediaPreview>>({});
  const threadRef = useRef<HTMLDivElement | null>(null);
  const activeCallRef = useRef<CallState | null>(null);
  const nicknamesRef = useRef<Record<string, string>>({});
  const conversationLoadRef = useRef(0);
  const audioUploadBehaviorRef = useRef<"send" | "discard">("send");
  const videoUploadBehaviorRef = useRef<"send" | "discard">("send");
  const composePointerIdRef = useRef<number | null>(null);
  const composePointerStartYRef = useRef<number | null>(null);
  const composeHoldTimerRef = useRef<number | null>(null);
  const composeWantsVideoRef = useRef(false);
  const suppressComposeClickRef = useRef(false);
  const composeActionModeRef = useRef<ComposeActionMode>("idle");
  const viewOnceTimersRef = useRef<Map<string, number>>(new Map());

  const peers = useMemo(() => {
    if (!auth) {
      return [] as AuthSession["users"];
    }
    return auth.users.filter((entry) => entry.id !== auth.userId);
  }, [auth]);

  const selectedPeer = useMemo(() => {
    if (!auth || !selectedPeerId) {
      return null;
    }
    return auth.users.find((entry) => entry.id === selectedPeerId) ?? null;
  }, [auth, selectedPeerId]);

  const displayNameForUser = useCallback((userId: UserId) => {
    const nickname = nicknamesRef.current[userId];
    if (nickname) {
      return nickname;
    }
    const directoryUser = authRef.current?.users.find((entry) => entry.id === userId);
    return directoryUser?.displayName ?? userId;
  }, []);

  const clearCallTimeout = useCallback(() => {
    if (callTimeoutRef.current !== null) {
      window.clearTimeout(callTimeoutRef.current);
      callTimeoutRef.current = null;
    }
  }, []);

  const persistMessages = useCallback(async (nextMessages: UiMessage[]) => {
    const userId = authRef.current?.userId;
    const peerId = selectedPeerRef.current;
    if (!userId || !peerId) {
      return;
    }

    await setMessages(userId, peerId, nextMessages);
    const maxServerId = nextMessages.reduce((acc, item) => {
      if (item.serverId && item.serverId > acc) {
        return item.serverId;
      }
      return acc;
    }, 0);
    const previousLastId = await getLastServerId(userId);
    const nextLastId = Math.max(previousLastId, maxServerId);
    if (nextLastId !== previousLastId) {
      await setLastServerId(userId, nextLastId);
    }
  }, []);

  const scrollThreadToBottom = useCallback((behavior: ScrollBehavior = "auto") => {
    const container = threadRef.current;
    if (!container) {
      return;
    }

    container.scrollTo({
      top: container.scrollHeight,
      behavior
    });
  }, []);

  const clearComposeHoldTimer = useCallback(() => {
    if (composeHoldTimerRef.current !== null) {
      window.clearTimeout(composeHoldTimerRef.current);
      composeHoldTimerRef.current = null;
    }
  }, []);

  const clearViewOnceTimer = useCallback((messageId: string) => {
    const existing = viewOnceTimersRef.current.get(messageId);
    if (typeof existing === "number") {
      window.clearTimeout(existing);
      viewOnceTimersRef.current.delete(messageId);
    }
  }, []);

  const removeMessageByClientId = useCallback(
    (clientMessageId: string) => {
      setMessagesState((current) => {
        const next = current.filter((entry) => entry.clientMessageId !== clientMessageId);
        void persistMessages(next);
        return next;
      });
    },
    [persistMessages]
  );

  const scheduleViewOnceRemoval = useCallback(
    (message: UiMessage) => {
      const timerId = window.setTimeout(() => {
        clearViewOnceTimer(message.clientMessageId);
        removeMessageByClientId(message.clientMessageId);
        if (message.serverId) {
          void jsonRequest<{ ok: boolean }>(`/messages/${message.serverId}`, {
            method: "DELETE"
          }).catch(() => {
            // Best effort cleanup only.
          });
        }
      }, VIEW_ONCE_AUTO_DELETE_MS);

      clearViewOnceTimer(message.clientMessageId);
      viewOnceTimersRef.current.set(message.clientMessageId, timerId);
    },
    [clearViewOnceTimer, removeMessageByClientId]
  );

  const bindCallMediaTracks = useCallback((call: ActiveCall) => {
    remoteTrackCleanupRef.current?.();
    remoteTrackCleanupRef.current = null;

    const host = remoteTracksHostRef.current;
    if (host) {
      host.innerHTML = "";
    }
    setRemoteVideoTracks(0);

    remoteTrackCleanupRef.current = bindRemoteTrack(
      call.room,
      (_trackId, kind, element) => {
        const container = remoteTracksHostRef.current;
        if (!container) {
          element.remove();
          return;
        }

        if (kind === "audio") {
          element.className = "messenger-remote-audio";
        } else {
          element.className = "messenger-remote-video";
          setRemoteVideoTracks((count) => count + 1);
        }

        container.appendChild(element);
        void element.play().catch(() => {
          // Ignore autoplay restrictions while call is active.
        });
      },
      (_trackId, kind) => {
        if (kind === "video") {
          setRemoteVideoTracks((count) => Math.max(0, count - 1));
        }
      }
    );
  }, []);

  useEffect(() => {
    outgoingCallRef.current = outgoingCall;
  }, [outgoingCall]);

  useEffect(() => {
    incomingCallRef.current = incomingCall;
  }, [incomingCall]);

  useEffect(() => {
    activeCallRef.current = activeCall;
  }, [activeCall]);

  useEffect(() => {
    if (!activeCall || !callRef.current) {
      return;
    }
    bindCallMediaTracks(callRef.current);
  }, [activeCall, bindCallMediaTracks]);

  useEffect(() => {
    composeActionModeRef.current = composeActionMode;
  }, [composeActionMode]);

  useEffect(() => {
    mediaPreviewsRef.current = mediaPreviews;
  }, [mediaPreviews]);

  useEffect(() => {
    nicknamesRef.current = nicknames;
  }, [nicknames]);

  useEffect(() => {
    if (!mobileDrawerOpen) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setMobileDrawerOpen(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [mobileDrawerOpen]);

  useEffect(() => {
    if (!selectedPeerId) {
      setNicknameDraft("");
      return;
    }
    setNicknameDraft(nicknames[selectedPeerId] ?? "");
  }, [nicknames, selectedPeerId]);

  useEffect(() => {
    scrollThreadToBottom("auto");
  }, [messages, selectedPeerId, scrollThreadToBottom]);

  useEffect(() => {
    const input = draftInputRef.current;
    if (!input) {
      return;
    }

    input.style.height = "0px";
    const nextHeight = Math.max(50, Math.min(input.scrollHeight, 190));
    input.style.height = `${nextHeight}px`;
  }, [draft]);

  useEffect(() => {
    if (!draft.trim() && sendViewOnce) {
      setSendViewOnce(false);
    }
  }, [draft, sendViewOnce]);

  useEffect(() => {
    for (const message of messages) {
      if (!message.viewOnce || !message.viewedAt) {
        continue;
      }
      if (viewOnceTimersRef.current.has(message.clientMessageId)) {
        continue;
      }

      const elapsed = Date.now() - message.viewedAt;
      const remaining = Math.max(250, VIEW_ONCE_AUTO_DELETE_MS - elapsed);
      const timerId = window.setTimeout(() => {
        clearViewOnceTimer(message.clientMessageId);
        removeMessageByClientId(message.clientMessageId);
      }, remaining);
      viewOnceTimersRef.current.set(message.clientMessageId, timerId);
    }
  }, [clearViewOnceTimer, messages, removeMessageByClientId]);

  const mergeMessage = useCallback(
    async (message: UiMessage) => {
      setMessagesState((current) => {
        const next = mergeUiMessages(current, [message]);
        void persistMessages(next);
        return next;
      });
    },
    [persistMessages]
  );

  const decryptServerRecord = useCallback(async (record: MessageRecord): Promise<UiMessage | null> => {
    const currentAuth = authRef.current;
    const peerId = selectedPeerRef.current;
    const sharedSecret = sharedSecretRef.current;
    if (!currentAuth || !peerId || !sharedSecret) {
      return null;
    }

    const belongsToSelectedConversation =
      (record.sender === currentAuth.userId && record.recipient === peerId) ||
      (record.sender === peerId && record.recipient === currentAuth.userId);
    if (!belongsToSelectedConversation) {
      return null;
    }

    const metadata = {
      sender: record.sender,
      recipient: record.recipient,
      messageId: record.clientMessageId,
      timestamp: record.createdAt,
      type: record.type
    };

    try {
      if (record.type === "text" || record.type === "system") {
        const decryptedText = await decryptTextPayload(sharedSecret, record.encryptedPayload, metadata);
        const viewOnce = decryptedText.startsWith(VIEW_ONCE_PREFIX);
        const text = viewOnce ? decryptedText.slice(VIEW_ONCE_PREFIX.length) : decryptedText;
        return {
          localId: `srv-${record.id}`,
          serverId: record.id,
          clientMessageId: record.clientMessageId,
          sender: record.sender,
          recipient: record.recipient,
          type: record.type,
          text,
          viewOnce,
          createdAt: record.createdAt,
          status: "received"
        };
      }

      const descriptorJson = await decryptTextPayload(sharedSecret, record.encryptedPayload, metadata);
      const descriptor = JSON.parse(descriptorJson) as MediaDescriptor;

      return {
        localId: `srv-${record.id}`,
        serverId: record.id,
        clientMessageId: record.clientMessageId,
        sender: record.sender,
        recipient: record.recipient,
        type: record.type,
        media: descriptor,
        createdAt: record.createdAt,
        status: "received"
      };
    } catch {
      return {
        localId: `srv-${record.id}`,
        serverId: record.id,
        clientMessageId: record.clientMessageId,
        sender: record.sender,
        recipient: record.recipient,
        type: "system",
        text: "[Unable to decrypt payload]",
        createdAt: record.createdAt,
        status: "received"
      };
    }
  }, []);

  const applyServerRecords = useCallback(
    async (records: MessageRecord[]) => {
      const currentAuth = authRef.current;
      const peerId = selectedPeerRef.current;
      if (!currentAuth || !peerId) {
        return;
      }

      const relevantRecords = records.filter(
        (record) =>
          (record.sender === currentAuth.userId && record.recipient === peerId) ||
          (record.sender === peerId && record.recipient === currentAuth.userId)
      );
      if (!relevantRecords.length) {
        return;
      }

      const decrypted = await Promise.all(relevantRecords.map((record) => decryptServerRecord(record)));
      const nextMessages = decrypted.filter((record): record is UiMessage => record !== null);
      if (!nextMessages.length) {
        return;
      }

      setMessagesState((current) => {
        const next = mergeUiMessages(current, nextMessages);
        void persistMessages(next);
        return next;
      });
    },
    [decryptServerRecord, persistMessages]
  );

  const sendClientEvent = useCallback((event: ClientEvent) => {
    socketRef.current?.send(event);
  }, []);

  const terminateCall = useCallback(
    async (notifyPeer: boolean) => {
      const currentActiveCall = activeCallRef.current;
      if (notifyPeer && currentActiveCall) {
        sendClientEvent(
          makeClientEvent("call:end", {
            to: currentActiveCall.peerId,
            roomName: currentActiveCall.roomName
          })
        );
      }

      clearCallTimeout();

      if (currentActiveCall?.roomName) {
        await cancelCallNotification(currentActiveCall.roomName);
      }
      if (incomingCallRef.current?.roomName) {
        await cancelCallNotification(incomingCallRef.current.roomName);
      }

      remoteTrackCleanupRef.current?.();
      remoteTrackCleanupRef.current = null;
      const remoteHost = remoteTracksHostRef.current;
      if (remoteHost) {
        remoteHost.innerHTML = "";
      }
      setRemoteVideoTracks(0);
      setActiveMeetUrl(null);
      setCallError(null);

      await endLiveKitConnection(callRef.current);
      callRef.current = null;
      setIncomingCall(null);
      incomingCallRef.current = null;
      setOutgoingCall(null);
      outgoingCallRef.current = null;
      setActiveCall(null);
      activeCallRef.current = null;
    },
    [clearCallTimeout, sendClientEvent]
  );

  const handleSocketEvent = useCallback(
    async (event: any) => {
      switch (event.type) {
        case "message:recv": {
          const senderId = event.payload.sender as UserId;
          const userId = authRef.current?.userId;
          if (userId && typeof event.payload.id === "number") {
            const lastSeen = await getLastServerId(userId);
            if (event.payload.id > lastSeen) {
              await setLastServerId(userId, event.payload.id);
            }
          }

          if (selectedPeerRef.current !== senderId) {
            await notifyIncomingMessage(
              displayNameForUser(senderId),
              event.payload.type === "text" ? "New message" : `${event.payload.type.toUpperCase()} note`
            );
          }
          const ui = await decryptServerRecord(event.payload);
          if (ui) {
            await mergeMessage(ui);
          }
          return;
        }
        case "message:ack": {
          if (selectedPeerRef.current && event.payload.to && event.payload.to !== selectedPeerRef.current) {
            return;
          }
          setMessagesState((current) => {
            const next = current.map((entry) =>
              event.payload.clientMessageId && entry.clientMessageId === event.payload.clientMessageId
                ? {
                    ...entry,
                    serverId: event.payload.serverMessageId,
                    status: "sent" as const
                  }
                : entry
            ) as UiMessage[];
            void persistMessages(next);
            return next;
          });
          return;
        }
        case "typing:start":
          setPeerTyping(event.payload.to === selectedPeerRef.current);
          return;
        case "typing:stop":
          if (event.payload.to === selectedPeerRef.current) {
            setPeerTyping(false);
          }
          return;
        case "sync:batch":
          await applyServerRecords(event.payload.messages);
          return;
        case "call:start":
          if (activeCallRef.current || outgoingCallRef.current || incomingCallRef.current) {
            sendClientEvent(
              makeClientEvent("call:decline", {
                to: event.payload.to,
                roomName: event.payload.roomName,
                callType: event.payload.callType
              })
            );
            return;
          }
          const nextIncoming = {
            from: event.payload.to,
            roomName: event.payload.roomName,
            callType: event.payload.callType
          };
          setCallError(null);
          setIncomingCall(nextIncoming);
          incomingCallRef.current = nextIncoming;
          await notifyIncomingCall({
            from: displayNameForUser(event.payload.to),
            callType: event.payload.callType,
            roomName: event.payload.roomName
          });
          setStatus(`Incoming ${event.payload.callType} call from ${displayNameForUser(event.payload.to)}`);
          return;
        case "call:accept":
          if (
            outgoingCallRef.current &&
            outgoingCallRef.current.peerId === event.payload.to &&
            outgoingCallRef.current.roomName === event.payload.roomName
          ) {
            clearCallTimeout();
            const pending = outgoingCallRef.current;
            setOutgoingCall(null);
            outgoingCallRef.current = null;
            setCallError(null);
            try {
              const call = await createLiveKitConnection(pending.roomName, pending.callType);
              callRef.current = call;
              setActiveMeetUrl(call.meetUrl);
              setActiveCall({
                peerId: pending.peerId,
                roomName: pending.roomName,
                callType: pending.callType
              });
              setStatus(`Connected with ${displayNameForUser(pending.peerId)}`);
            } catch {
              setCallError("Unable to join LiveKit room. Check call permissions and server setup.");
              setStatus("Unable to connect call");
              sendClientEvent(
                makeClientEvent("call:end", {
                  to: pending.peerId,
                  roomName: pending.roomName
                })
              );
              await terminateCall(false);
            }
          }
          return;
        case "call:decline":
          if (outgoingCallRef.current && outgoingCallRef.current.peerId === event.payload.to) {
            clearCallTimeout();
            setOutgoingCall(null);
            outgoingCallRef.current = null;
          }
          setCallError(null);
          setStatus(`${displayNameForUser(event.payload.to)} declined the call`);
          await terminateCall(false);
          return;
        case "call:end":
          clearCallTimeout();
          setOutgoingCall(null);
          outgoingCallRef.current = null;
          setCallError(null);
          setStatus("Call ended");
          await terminateCall(false);
          return;
        default:
          return;
      }
    },
    [
      applyServerRecords,
      clearCallTimeout,
      decryptServerRecord,
      displayNameForUser,
      mergeMessage,
      persistMessages,
      sendClientEvent,
      terminateCall
    ]
  );

  const applyAuthSession = useCallback((session: AuthSession) => {
    authRef.current = session;
    setAuth(session);
    setProfileDisplayName(session.profile.displayName);
    setProfileAvatarUrl(session.profile.avatarUrl ?? "");
  }, []);

  const loadConversationForPeer = useCallback(
    async (peerId: UserId, sourceSession?: AuthSession) => {
      const currentSession = sourceSession ?? authRef.current;
      if (!currentSession) {
        return;
      }
      const loadId = conversationLoadRef.current + 1;
      conversationLoadRef.current = loadId;

      selectedPeerRef.current = peerId;
      const localMessages = await getMessages(currentSession.userId, peerId);
      if (conversationLoadRef.current !== loadId || selectedPeerRef.current !== peerId) {
        return;
      }
      setMessagesState(localMessages);
      setPeerTyping(false);

      const peer = currentSession.users.find((item) => item.id === peerId);
      if (!peer?.identityPublicKey) {
        sharedSecretRef.current = null;
        sessionRef.current = null;
        if (conversationLoadRef.current === loadId && selectedPeerRef.current === peerId) {
          setStatus(`"${peerId}" has no identity key yet. Ask them to login once.`);
        }
        return;
      }

      const context = await ensureConversationCrypto(currentSession.userId, peerId, peer.identityPublicKey);
      if (conversationLoadRef.current !== loadId || selectedPeerRef.current !== peerId) {
        return;
      }
      sharedSecretRef.current = context.sharedSecret;
      sessionRef.current = context.session;

      const history = await jsonRequest<{ messages: MessageRecord[] }>(
        `/messages?after=0&peer=${encodeURIComponent(peerId)}`
      );
      if (conversationLoadRef.current !== loadId || selectedPeerRef.current !== peerId) {
        return;
      }
      await applyServerRecords(history.messages);
      if (conversationLoadRef.current === loadId && selectedPeerRef.current === peerId) {
        setStatus(`Secure channel ready with ${displayNameForUser(peerId)}`);
      }
    },
    [applyServerRecords, displayNameForUser]
  );

  const bootstrap = useCallback(async () => {
    const session = await fetchSession();
    applyAuthSession(session);

    const storedNicknames = await getNicknames(session.userId);
    setNicknamesState(storedNicknames);

    const storedBackground = await getChatBackground(session.userId);
    setChatBackgroundState(storedBackground);
    setChatBackgroundDraft(storedBackground ?? "");

    const backup = getHourlyBackup(session.userId);
    if (backup) {
      setHourlyBackupStatus(`Last backup ${new Date(backup.savedAt).toLocaleTimeString()}`);
    } else {
      setHourlyBackupStatus("No hourly backup yet");
    }

    const identity = await ensureIdentityKey(session.userId);
    if (!session.selfIdentityPublicKey || session.selfIdentityPublicKey !== identity.publicKey) {
      await updateIdentityPublicKey(identity.publicKey);
    }

    const peers = session.users.filter((item) => item.id !== session.userId);
    if (peers.length > 0) {
      const defaultPeerId = peers[0]!.id;
      setSelectedPeerId(defaultPeerId);
    } else {
      setSelectedPeerId(null);
      selectedPeerRef.current = null;
      setStatus("No contacts available yet. Register another user first.");
      setMessagesState([]);
    }

    const socket = new ChatSocket(
      session.wsToken,
      (event) => {
        void handleSocketEvent(event);
      },
      (nextStatus) => {
        setSocketStatus(nextStatus);
        if (nextStatus === "connected") {
          void (async () => {
            const afterId = await getLastServerId(session.userId);
            socket.send(
              makeClientEvent("sync:request", {
                afterId
              })
            );
          })();
        }
      },
      {
        refreshToken: async () => {
          try {
            const refreshed = await fetchSession();
            applyAuthSession(refreshed);
            return refreshed.wsToken;
          } catch (error) {
            if (isUnauthorizedRequestError(error)) {
              return null;
            }
            throw error;
          }
        },
        onAuthExpired: () => {
          setStatus("Session expired. Please login again.");
          router.replace("/login");
        }
      }
    );

    socketRef.current?.close();
    socketRef.current = socket;
    socket.connect();
  }, [applyAuthSession, handleSocketEvent, router]);

  useEffect(() => {
    bootstrap().catch(() => {
      router.replace("/login");
    });
    const activeTimers = viewOnceTimersRef.current;

    return () => {
      clearComposeHoldTimer();
      clearCallTimeout();
      for (const timerId of activeTimers.values()) {
        window.clearTimeout(timerId);
      }
      activeTimers.clear();
      socketRef.current?.close();
      remoteTrackCleanupRef.current?.();
      remoteTrackCleanupRef.current = null;
      void terminateCall(false);
      const stream = videoStreamRef.current;
      if (stream) {
        stream.getTracks().forEach((track) => track.stop());
      }
      Object.values(mediaPreviewsRef.current).forEach((entry) => {
        URL.revokeObjectURL(entry.objectUrl);
      });
    };
  }, [bootstrap, clearCallTimeout, clearComposeHoldTimer, router, terminateCall]);

  useEffect(() => {
    const currentSession = authRef.current;
    if (!currentSession || !selectedPeerId) {
      return;
    }

    void loadConversationForPeer(selectedPeerId, currentSession);
  }, [loadConversationForPeer, selectedPeerId]);

  const sendText = useCallback(async () => {
    const currentAuth = authRef.current;
    const peerId = selectedPeerRef.current;
    const sessionState = sessionRef.current;
    const normalizedDraft = draft.trim();

    if (!currentAuth || !peerId || !sessionState || !normalizedDraft) {
      return;
    }

    const createdAt = Date.now();
    const clientMessageId = crypto.randomUUID();
    const outgoingText = sendViewOnce ? `${VIEW_ONCE_PREFIX}${normalizedDraft}` : normalizedDraft;

    const encrypted = await encryptTextWithSession(currentAuth.userId, peerId, sessionState, outgoingText, {
      sender: currentAuth.userId,
      recipient: peerId,
      messageId: clientMessageId,
      timestamp: createdAt,
      type: "text"
    });
    sessionRef.current = encrypted.session;

    sendClientEvent(
      makeClientEvent("message:send", {
        to: peerId,
        type: "text",
        encryptedPayload: encrypted.payload,
        clientMessageId
      }, createdAt)
    );

    await mergeMessage({
      localId: clientMessageId,
      clientMessageId,
      sender: currentAuth.userId,
      recipient: peerId,
      type: "text",
      text: normalizedDraft,
      viewOnce: sendViewOnce,
      createdAt,
      status: "sending"
    });

    setDraft("");
    setSendViewOnce(false);
    if (typingSentRef.current) {
      sendClientEvent(makeClientEvent("typing:stop", { to: peerId }));
      typingSentRef.current = false;
    }
    scrollThreadToBottom("smooth");
  }, [draft, mergeMessage, scrollThreadToBottom, sendClientEvent, sendViewOnce]);

  const sendMediaFile = useCallback(
    async (file: File, forcedType?: Extract<MessageType, "image" | "video" | "audio" | "document">) => {
      const currentAuth = authRef.current;
      const peerId = selectedPeerRef.current;
      const sessionState = sessionRef.current;
      if (!currentAuth || !peerId || !sessionState) {
        return;
      }

      const clientMessageId = crypto.randomUUID();
      const createdAt = Date.now();

      const messageType: Extract<MessageType, "image" | "video" | "audio" | "document"> =
        forcedType ??
        (file.type.startsWith("image/")
          ? "image"
          : file.type.startsWith("video/")
            ? "video"
            : file.type.startsWith("audio/")
              ? "audio"
              : "document");

      const fileBytes = await fileToBytes(file);
      const fileMetaMessageId = `${clientMessageId}:file`;
      const fileMetaTimestamp = createdAt;

      const encryptedFile = await encryptBytesWithSession(currentAuth.userId, peerId, sessionState, fileBytes, {
        sender: currentAuth.userId,
        recipient: peerId,
        messageId: fileMetaMessageId,
        timestamp: fileMetaTimestamp,
        type: messageType
      });
      sessionRef.current = encryptedFile.session;

      const upload = await uploadEncryptedMedia({
        recipient: peerId,
        fileName: file.name,
        mimeType: file.type || "application/octet-stream",
        encryptedPayload: encryptedFile.payload,
        encryptedBytes: fromBase64Url(encryptedFile.payload.ciphertext),
        clientMessageId,
        messageType
      });

      const descriptor: MediaDescriptor = {
        mediaId: upload.mediaId,
        fileName: file.name,
        mimeType: file.type || "application/octet-stream",
        size: file.size,
        fileEncryptionPayload: encryptedFile.payload,
        fileMetaMessageId,
        fileMetaTimestamp,
        fileType: messageType
      };

      const encryptedDescriptor = await encryptTextWithSession(
        currentAuth.userId,
        peerId,
        sessionRef.current,
        JSON.stringify(descriptor),
        {
          sender: currentAuth.userId,
          recipient: peerId,
          messageId: clientMessageId,
          timestamp: createdAt,
          type: messageType
        }
      );
      sessionRef.current = encryptedDescriptor.session;

      sendClientEvent(
        makeClientEvent("message:send", {
          to: peerId,
          type: messageType,
          encryptedPayload: encryptedDescriptor.payload,
          mediaId: upload.mediaId,
          clientMessageId
        }, createdAt)
      );

      await mergeMessage({
        localId: clientMessageId,
        clientMessageId,
        sender: currentAuth.userId,
        recipient: peerId,
        type: messageType,
        media: descriptor,
        createdAt,
        status: "sending"
      });
      scrollThreadToBottom("smooth");
    },
    [mergeMessage, scrollThreadToBottom, sendClientEvent]
  );

  const stopVideoCaptureStream = useCallback(() => {
    const stream = videoStreamRef.current;
    if (stream) {
      stream.getTracks().forEach((track) => track.stop());
      videoStreamRef.current = null;
    }

    if (videoPreviewRef.current) {
      videoPreviewRef.current.srcObject = null;
    }
  }, []);

  const startAudioNote = useCallback(async () => {
    if (audioRecorderRef.current || videoRecorderRef.current) {
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const chunks: BlobPart[] = [];
      const recorder = new MediaRecorder(stream);

      audioUploadBehaviorRef.current = "send";
      audioRecorderRef.current = recorder;

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          chunks.push(event.data);
        }
      };

      recorder.onstop = () => {
        const shouldSend = audioUploadBehaviorRef.current === "send";
        const blob = new Blob(chunks, { type: "audio/webm" });
        if (shouldSend && blob.size > 0) {
          const file = new File([blob], `voice-${Date.now()}.webm`, { type: "audio/webm" });
          void sendMediaFile(file, "audio");
        }

        stream.getTracks().forEach((track) => track.stop());
        setAudioRecording(false);
        audioRecorderRef.current = null;
        audioUploadBehaviorRef.current = "send";
      };

      recorder.start();
      setAudioRecording(true);
    } catch {
      setStatus("Microphone access is required for voice notes.");
      setComposeActionMode("idle");
    }
  }, [sendMediaFile]);

  const stopAudioNote = useCallback((behavior: "send" | "discard" = "send"): Promise<void> => {
    audioUploadBehaviorRef.current = behavior;

    return new Promise((resolve) => {
      const recorder = audioRecorderRef.current;
      if (!recorder || recorder.state === "inactive") {
        setAudioRecording(false);
        audioRecorderRef.current = null;
        resolve();
        return;
      }

      recorder.addEventListener(
        "stop",
        () => {
          resolve();
        },
        { once: true }
      );
      recorder.stop();
    });
  }, []);

  const startVideoNote = useCallback(async () => {
    if (videoRecorderRef.current || audioRecorderRef.current) {
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
      videoStreamRef.current = stream;
      if (videoPreviewRef.current) {
        videoPreviewRef.current.srcObject = stream;
        void videoPreviewRef.current.play().catch(() => {
          // Ignore autoplay restrictions.
        });
      }

      const chunks: BlobPart[] = [];
      const candidates = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"];
      const mimeType = candidates.find((entry) => MediaRecorder.isTypeSupported(entry));
      const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);

      videoUploadBehaviorRef.current = "send";
      videoRecorderRef.current = recorder;
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          chunks.push(event.data);
        }
      };

      recorder.onstop = () => {
        const shouldSend = videoUploadBehaviorRef.current === "send";
        const blob = new Blob(chunks, { type: mimeType ?? "video/webm" });
        if (shouldSend && blob.size > 0) {
          const file = new File([blob], `video-note-${Date.now()}.webm`, { type: mimeType ?? "video/webm" });
          void sendMediaFile(file, "video");
        }
        stopVideoCaptureStream();
        setVideoRecording(false);
        videoRecorderRef.current = null;
        videoUploadBehaviorRef.current = "send";
      };

      recorder.start();
      setVideoRecording(true);
    } catch {
      setStatus("Camera and microphone access are required for video notes.");
      setComposeActionMode("idle");
    }
  }, [sendMediaFile, stopVideoCaptureStream]);

  const stopVideoNote = useCallback(
    (behavior: "send" | "discard" = "send"): Promise<void> => {
      videoUploadBehaviorRef.current = behavior;

      return new Promise((resolve) => {
        const recorder = videoRecorderRef.current;
        if (!recorder || recorder.state === "inactive") {
          stopVideoCaptureStream();
          setVideoRecording(false);
          videoRecorderRef.current = null;
          resolve();
          return;
        }

        recorder.addEventListener(
          "stop",
          () => {
            resolve();
          },
          { once: true }
        );
        recorder.stop();
      });
    },
    [stopVideoCaptureStream]
  );

  const startHoldRecording = useCallback(async () => {
    if (draft.trim() || !selectedPeerRef.current || audioRecorderRef.current || videoRecorderRef.current) {
      setComposeActionMode("idle");
      return;
    }

    if (composeWantsVideoRef.current) {
      setComposeActionMode("video");
      await startVideoNote();
      return;
    }

    setComposeActionMode("voice");
    await startAudioNote();
  }, [draft, startAudioNote, startVideoNote]);

  const switchVoiceRecordingToVideo = useCallback(async () => {
    if (!audioRecorderRef.current || videoRecorderRef.current) {
      return;
    }
    await stopAudioNote("discard");
    await startVideoNote();
  }, [startVideoNote, stopAudioNote]);

  const finalizeComposeGesture = useCallback(
    async (commit: boolean) => {
      clearComposeHoldTimer();

      composePointerIdRef.current = null;
      composePointerStartYRef.current = null;
      composeWantsVideoRef.current = false;
      setComposeDragOffset(0);

      const mode = composeActionModeRef.current;
      if (mode === "voice") {
        suppressComposeClickRef.current = true;
        await stopAudioNote(commit ? "send" : "discard");
      } else if (mode === "video") {
        suppressComposeClickRef.current = true;
        await stopVideoNote(commit ? "send" : "discard");
      } else if (mode === "armed") {
        suppressComposeClickRef.current = true;
      }

      setComposeActionMode("idle");
    },
    [clearComposeHoldTimer, stopAudioNote, stopVideoNote]
  );

  const onComposeActionPointerDown = useCallback(
    (event: React.PointerEvent<HTMLButtonElement>) => {
      if (draft.trim() || !selectedPeerRef.current || audioRecorderRef.current || videoRecorderRef.current) {
        return;
      }

      composePointerIdRef.current = event.pointerId;
      composePointerStartYRef.current = event.clientY;
      composeWantsVideoRef.current = false;
      setComposeDragOffset(0);
      setComposeActionMode("armed");

      clearComposeHoldTimer();
      composeHoldTimerRef.current = window.setTimeout(() => {
        composeHoldTimerRef.current = null;
        void startHoldRecording();
      }, HOLD_TO_RECORD_MS);

      event.currentTarget.setPointerCapture(event.pointerId);
    },
    [clearComposeHoldTimer, draft, startHoldRecording]
  );

  const onComposeActionPointerMove = useCallback(
    (event: React.PointerEvent<HTMLButtonElement>) => {
      if (composePointerIdRef.current !== event.pointerId) {
        return;
      }

      const startY = composePointerStartYRef.current;
      if (startY === null) {
        return;
      }

      const dragUp = Math.max(0, startY - event.clientY);
      setComposeDragOffset(Math.min(120, dragUp));
      const wantsVideo = dragUp >= DRAG_TO_VIDEO_THRESHOLD;
      const previouslyWantedVideo = composeWantsVideoRef.current;
      composeWantsVideoRef.current = wantsVideo;

      if (wantsVideo && !previouslyWantedVideo && composeActionModeRef.current === "voice") {
        setComposeActionMode("video");
        void switchVoiceRecordingToVideo();
      }
    },
    [switchVoiceRecordingToVideo]
  );

  const onComposeActionPointerUp = useCallback(
    (event: React.PointerEvent<HTMLButtonElement>) => {
      if (composePointerIdRef.current !== event.pointerId) {
        return;
      }
      void finalizeComposeGesture(true);
    },
    [finalizeComposeGesture]
  );

  const onComposeActionPointerCancel = useCallback(
    (event: React.PointerEvent<HTMLButtonElement>) => {
      if (composePointerIdRef.current !== event.pointerId) {
        return;
      }
      void finalizeComposeGesture(false);
    },
    [finalizeComposeGesture]
  );

  const onComposeActionClick = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      if (suppressComposeClickRef.current) {
        event.preventDefault();
        suppressComposeClickRef.current = false;
        return;
      }

      if (!selectedPeerRef.current) {
        return;
      }

      if (draft.trim()) {
        void sendText();
      }
    },
    [draft, sendText]
  );

  const onDraftChange = useCallback(
    (value: string) => {
      setDraft(value);
      const peerId = selectedPeerRef.current;
      if (!peerId) {
        return;
      }

      if (value.trim() && !typingSentRef.current) {
        sendClientEvent(makeClientEvent("typing:start", { to: peerId }));
        typingSentRef.current = true;
      }

      if (!value.trim() && typingSentRef.current) {
        sendClientEvent(makeClientEvent("typing:stop", { to: peerId }));
        typingSentRef.current = false;
      }
    },
    [sendClientEvent]
  );

  const openInlineMedia = useCallback(
    async (message: UiMessage): Promise<string | null> => {
      if (!message.media || !sharedSecretRef.current) {
        return null;
      }

      const existing = mediaPreviews[message.media.mediaId];
      if (existing) {
        return existing.objectUrl;
      }

      await downloadEncryptedMedia(message.media.mediaId);
      const decrypted = await decryptBinaryPayload(sharedSecretRef.current, message.media.fileEncryptionPayload, {
        sender: message.sender,
        recipient: message.recipient,
        messageId: message.media.fileMetaMessageId,
        timestamp: message.media.fileMetaTimestamp,
        type: message.media.fileType
      });

      const objectUrl = createBlobUrl(decrypted, message.media.mimeType);
      setMediaPreviews((current) => ({
        ...current,
        [message.media!.mediaId]: {
          objectUrl,
          mimeType: message.media!.mimeType
        }
      }));

      await ackMedia(message.media.mediaId);
      return objectUrl;
    },
    [mediaPreviews]
  );

  const downloadMediaMessage = useCallback(
    async (message: UiMessage) => {
      if (!message.media) {
        return;
      }

      const existing = mediaPreviews[message.media.mediaId];
      const objectUrl = existing ? existing.objectUrl : await openInlineMedia(message);
      if (!objectUrl) {
        return;
      }

      triggerDownload(message.media.fileName, objectUrl);
    },
    [mediaPreviews, openInlineMedia]
  );

  const revealViewOnceMessage = useCallback(
    (message: UiMessage) => {
      if (!message.viewOnce || message.viewedAt) {
        return;
      }

      setMessagesState((current) => {
        const next = current.map((entry) =>
          entry.clientMessageId === message.clientMessageId
            ? {
                ...entry,
                viewedAt: Date.now()
              }
            : entry
        );
        void persistMessages(next);
        return next;
      });

      scheduleViewOnceRemoval({
        ...message,
        viewedAt: Date.now()
      });
    },
    [persistMessages, scheduleViewOnceRemoval]
  );

  const deleteMessage = useCallback(
    async (message: UiMessage) => {
      if (message.serverId) {
        try {
          await jsonRequest<{ ok: boolean }>(`/messages/${message.serverId}`, {
            method: "DELETE"
          });
        } catch {
          // Continue with local removal if server cleanup fails.
        }
      }

      clearViewOnceTimer(message.clientMessageId);
      if (message.media) {
        setMediaPreviews((current) => {
          const preview = current[message.media!.mediaId];
          if (!preview) {
            return current;
          }
          URL.revokeObjectURL(preview.objectUrl);
          const next = {
            ...current
          };
          delete next[message.media!.mediaId];
          return next;
        });
      }
      setMessagesState((current) => {
        const next = current.filter((entry) => entry.clientMessageId !== message.clientMessageId);
        void persistMessages(next);
        return next;
      });
    },
    [clearViewOnceTimer, persistMessages]
  );

  const clearCurrentChat = useCallback(async () => {
    const currentAuth = authRef.current;
    const peerId = selectedPeerRef.current;
    if (!currentAuth || !peerId || clearingChat) {
      return;
    }

    if (!window.confirm(`Clear full chat with ${displayNameForUser(peerId)}? This cannot be undone.`)) {
      return;
    }

    setClearingChat(true);
    try {
      await jsonRequest<{ ok: boolean }>("/messages/clear", {
        method: "POST",
        body: {
          peer: peerId
        }
      });
      await clearConversationData(currentAuth.userId, peerId);

      for (const timerId of viewOnceTimersRef.current.values()) {
        window.clearTimeout(timerId);
      }
      viewOnceTimersRef.current.clear();

      setMediaPreviews((current) => {
        Object.values(current).forEach((entry) => {
          URL.revokeObjectURL(entry.objectUrl);
        });
        return {};
      });
      setMessagesState([]);
      setStatus(`Cleared chat with ${displayNameForUser(peerId)}`);
    } finally {
      setClearingChat(false);
    }
  }, [clearingChat, displayNameForUser]);

  const deleteMyAccount = useCallback(async () => {
    const currentAuth = authRef.current;
    if (!currentAuth || deletingAccount) {
      return;
    }

    if (!window.confirm("Delete your account and all chats permanently?")) {
      return;
    }

    setDeletingAccount(true);
    try {
      await deleteAccount();
      await clearUserLocalData(currentAuth.userId);
      clearHourlyBackup(currentAuth.userId);
      socketRef.current?.close();
      router.replace("/login");
    } finally {
      setDeletingAccount(false);
    }
  }, [deletingAccount, router]);

  const saveChatBackground = useCallback(async () => {
    const currentAuth = authRef.current;
    if (!currentAuth) {
      return;
    }

    const trimmed = chatBackgroundDraft.trim();
    const nextValue = trimmed || null;
    await setChatBackground(currentAuth.userId, nextValue);
    setChatBackgroundState(nextValue);
    setStatus(nextValue ? "Chat background updated" : "Chat background cleared");
  }, [chatBackgroundDraft]);

  const onBackgroundFilePick = useCallback(async (file: File) => {
    const currentAuth = authRef.current;
    if (!currentAuth) {
      return;
    }

    const dataUrl = await fileToDataUrl(file);
    setChatBackgroundDraft(dataUrl);
    await setChatBackground(currentAuth.userId, dataUrl);
    setChatBackgroundState(dataUrl);
    setStatus("Chat background updated");
  }, []);

  const saveHourlyBackupSnapshot = useCallback(async () => {
    const currentAuth = authRef.current;
    if (!currentAuth) {
      return;
    }

    const peerId = selectedPeerRef.current;
    const currentLastServerId = await getLastServerId(currentAuth.userId);
    setHourlyBackup(currentAuth.userId, {
      savedAt: Date.now(),
      selectedPeerId: peerId,
      messageCount: messages.length,
      lastServerId: currentLastServerId,
      nicknames: nicknamesRef.current,
      latestConversationMessages: messages.slice(-200)
    });
    setHourlyBackupStatus(`Backup saved at ${new Date().toLocaleTimeString()}`);
  }, [messages]);

  const restoreHourlyBackupSnapshot = useCallback(async () => {
    const currentAuth = authRef.current;
    if (!currentAuth) {
      return;
    }

    const backup = getHourlyBackup(currentAuth.userId);
    if (!backup || !backup.selectedPeerId) {
      setHourlyBackupStatus("No backup available to restore");
      return;
    }

    await setMessages(currentAuth.userId, backup.selectedPeerId, backup.latestConversationMessages);
    await setLastServerId(currentAuth.userId, backup.lastServerId);
    setNicknamesState(backup.nicknames);
    setSelectedPeerId(backup.selectedPeerId as UserId);
    selectedPeerRef.current = backup.selectedPeerId as UserId;
    setMessagesState(backup.latestConversationMessages);
    setStatus("Restored last local backup");
  }, []);

  useEffect(() => {
    if (!auth?.userId) {
      return;
    }

    const timer = window.setInterval(() => {
      void saveHourlyBackupSnapshot();
    }, HOURLY_BACKUP_INTERVAL_MS);

    return () => {
      window.clearInterval(timer);
    };
  }, [auth?.userId, saveHourlyBackupSnapshot]);

  const startCall = useCallback(
    async (callType: "audio" | "video") => {
      const peerId = selectedPeerRef.current;
      if (!peerId || outgoingCallRef.current || incomingCallRef.current || activeCall) {
        return;
      }

      const roomName = `lovechat-${Date.now()}`;
      const pendingCall: OutgoingCall = {
        peerId,
        roomName,
        callType,
        startedAt: Date.now()
      };
      sendClientEvent(
        makeClientEvent("call:start", {
          to: peerId,
          roomName,
          callType
        })
      );

      setOutgoingCall(pendingCall);
      outgoingCallRef.current = pendingCall;
      setCallError(null);
      setActiveMeetUrl(null);
      setStatus(`Calling ${displayNameForUser(peerId)}...`);

      clearCallTimeout();
      callTimeoutRef.current = window.setTimeout(() => {
        if (!outgoingCallRef.current || outgoingCallRef.current.roomName !== roomName) {
          return;
        }

        sendClientEvent(
          makeClientEvent("call:end", {
            to: peerId,
            roomName
          })
        );
        setOutgoingCall(null);
        outgoingCallRef.current = null;
        setStatus("No answer. Call timed out.");
      }, 30_000);
    },
    [activeCall, clearCallTimeout, displayNameForUser, sendClientEvent]
  );

  const acceptIncomingCall = useCallback(async () => {
    const currentIncoming = incomingCallRef.current;
    if (!currentIncoming || outgoingCallRef.current) {
      return;
    }

    setSelectedPeerId(currentIncoming.from);
    selectedPeerRef.current = currentIncoming.from;
    await cancelCallNotification(currentIncoming.roomName);

    sendClientEvent(
      makeClientEvent("call:accept", {
        to: currentIncoming.from,
        roomName: currentIncoming.roomName,
        callType: currentIncoming.callType
      })
    );

    setCallError(null);
    try {
      const call = await createLiveKitConnection(currentIncoming.roomName, currentIncoming.callType);
      callRef.current = call;
      setActiveMeetUrl(call.meetUrl);
      setActiveCall({
        peerId: currentIncoming.from,
        roomName: currentIncoming.roomName,
        callType: currentIncoming.callType
      });
      setIncomingCall(null);
      incomingCallRef.current = null;
      setStatus(`Connected with ${displayNameForUser(currentIncoming.from)}`);
    } catch {
      setCallError("Unable to connect call.");
      sendClientEvent(
        makeClientEvent("call:end", {
          to: currentIncoming.from,
          roomName: currentIncoming.roomName
        })
      );
      await terminateCall(false);
      setStatus("Call connection failed");
    }
  }, [displayNameForUser, sendClientEvent, terminateCall]);

  const declineIncomingCall = useCallback(() => {
    const currentIncoming = incomingCallRef.current;
    if (!currentIncoming) {
      return;
    }

    void cancelCallNotification(currentIncoming.roomName);

    sendClientEvent(
      makeClientEvent("call:decline", {
        to: currentIncoming.from,
        roomName: currentIncoming.roomName,
        callType: currentIncoming.callType
      })
    );
    setIncomingCall(null);
    incomingCallRef.current = null;
    setStatus("Call declined");
  }, [sendClientEvent]);

  useEffect(() => {
    void initializeNotifications(async (payload, actionId) => {
      if (payload.kind !== "call" || !payload.roomName) {
        return;
      }

      const currentIncoming = incomingCallRef.current;
      if (!currentIncoming || currentIncoming.roomName !== payload.roomName) {
        return;
      }

      if (actionId === "accept") {
        await acceptIncomingCall();
      }
      if (actionId === "decline") {
        declineIncomingCall();
      }
    });
  }, [acceptIncomingCall, declineIncomingCall]);

  const saveNickname = useCallback(async () => {
    const currentAuth = authRef.current;
    const peerId = selectedPeerRef.current;
    if (!currentAuth || !peerId) {
      return;
    }

    await setNickname(currentAuth.userId, peerId, nicknameDraft);
    setNicknamesState((current) => {
      const next = {
        ...current
      };
      const trimmed = nicknameDraft.trim();
      if (trimmed) {
        next[peerId] = trimmed;
      } else {
        delete next[peerId];
      }
      return next;
    });
  }, [nicknameDraft]);

  const saveProfile = useCallback(async () => {
    const currentAuth = authRef.current;
    if (!currentAuth) {
      return;
    }

    setProfileSaving(true);
    try {
      const displayName = profileDisplayName.trim() || currentAuth.profile.displayName;
      const avatarUrl = profileAvatarUrl.trim() || undefined;
      const response = await updateProfile({
        displayName,
        avatarUrl
      });

      const nextAuth: AuthSession = {
        ...currentAuth,
        profile: response.profile,
        users: currentAuth.users.map((entry) =>
          entry.id === currentAuth.userId
            ? {
                ...entry,
                displayName: response.profile.displayName,
                avatarUrl: response.profile.avatarUrl
              }
            : entry
        )
      };
      authRef.current = nextAuth;
      setAuth(nextAuth);
      setDashboardTab("main");
      setStatus("Profile updated");
    } finally {
      setProfileSaving(false);
    }
  }, [profileAvatarUrl, profileDisplayName]);

  const handleLogout = useCallback(async () => {
    await logout();
    socketRef.current?.close();
    router.replace("/login");
  }, [router]);

  const switchPeer = useCallback(
    (nextPeer: UserId) => {
      if (!nextPeer) {
        return;
      }
      if (typingSentRef.current && selectedPeerRef.current) {
        sendClientEvent(makeClientEvent("typing:stop", { to: selectedPeerRef.current }));
        typingSentRef.current = false;
      }
      setDraft("");
      setSendViewOnce(false);
      setSelectedPeerId(nextPeer);
      setDashboardTab("main");
      setMobileDrawerOpen(false);
    },
    [sendClientEvent]
  );

  const heading = useMemo(
    () => (selectedPeerId ? displayNameForUser(selectedPeerId) : "Choose a chat"),
    [displayNameForUser, selectedPeerId]
  );

  const composeHint = useMemo(() => {
    if (!selectedPeerId) {
      return "Choose a user to start chatting.";
    }
    if (sendViewOnce && draft.trim()) {
      return "View once enabled. Message auto-deletes after first view.";
    }
    if (videoRecording || composeActionMode === "video") {
      return "Release to send video note.";
    }
    if (audioRecording || composeActionMode === "voice") {
      return "Recording voice note. Drag up to switch video.";
    }
    if (!draft.trim()) {
      return "Hold button for voice. Drag up while holding for video note.";
    }
    return "Tap send to deliver encrypted message.";
  }, [audioRecording, composeActionMode, draft, selectedPeerId, sendViewOnce, videoRecording]);

  const composeActionLabel = useMemo(() => {
    if (draft.trim()) {
      return "Send";
    }
    if (videoRecording || composeActionMode === "video") {
      return "Video";
    }
    if (audioRecording || composeActionMode === "voice") {
      return "Voice";
    }
    if (composeDragOffset >= DRAG_TO_VIDEO_THRESHOLD) {
      return "Video";
    }
    return "Hold";
  }, [audioRecording, composeActionMode, composeDragOffset, draft, videoRecording]);

  const composeActionClassName = useMemo(() => {
    if (draft.trim()) {
      return "compose-action-button ready-send";
    }
    if (videoRecording || composeActionMode === "video" || composeDragOffset >= DRAG_TO_VIDEO_THRESHOLD) {
      return "compose-action-button recording-video";
    }
    if (audioRecording || composeActionMode === "voice") {
      return "compose-action-button recording-voice";
    }
    if (composeActionMode === "armed") {
      return "compose-action-button armed";
    }
    return "compose-action-button";
  }, [audioRecording, composeActionMode, composeDragOffset, draft, videoRecording]);

  const openMeetLink = useCallback(() => {
    if (!activeMeetUrl) {
      return;
    }
    window.open(activeMeetUrl, "_blank", "noopener,noreferrer");
  }, [activeMeetUrl]);

  const chatPanelStyle = useMemo<CSSProperties | undefined>(() => {
    if (!chatBackground) {
      return undefined;
    }

    return {
      backgroundImage: `linear-gradient(155deg, rgba(5, 18, 24, 0.8), rgba(5, 18, 24, 0.92)), url(${chatBackground})`,
      backgroundSize: "cover",
      backgroundPosition: "center"
    };
  }, [chatBackground]);

  return (
    <main className={`messenger-layout${mobileDrawerOpen ? " sidebar-open" : ""}`}>
      <button
        type="button"
        className={`messenger-mobile-backdrop${mobileDrawerOpen ? " active" : ""}`}
        onClick={() => setMobileDrawerOpen(false)}
        aria-label="Close dashboard"
        tabIndex={mobileDrawerOpen ? 0 : -1}
      />

      <aside id="dashboard-panel" className={`panel messenger-sidebar${mobileDrawerOpen ? " open" : ""}`}>
        <div className="messenger-sidebar-header">
          <Avatar name={auth?.profile.displayName ?? "Me"} avatarUrl={auth?.profile.avatarUrl} size={42} />
          <div>
            <h1 className="messenger-title">Dashboard</h1>
            <p className="muted messenger-subtitle">Socket: {socketStatus}</p>
          </div>
          <button
            className="secondary messenger-sidebar-close"
            onClick={() => setMobileDrawerOpen(false)}
            type="button"
          >
            Close
          </button>
        </div>

        <div className="messenger-nav">
          <button
            className={dashboardTab === "main" ? "" : "secondary"}
            onClick={() => setDashboardTab("main")}
            type="button"
          >
            Main
          </button>
          <button
            className={dashboardTab === "directory" ? "" : "secondary"}
            onClick={() => setDashboardTab("directory")}
            type="button"
          >
            Registry
          </button>
          <button
            className={dashboardTab === "settings" ? "" : "secondary"}
            onClick={() => setDashboardTab("settings")}
            type="button"
          >
            Settings
          </button>
        </div>

        <div className="messenger-sidebar-body">
          {dashboardTab === "main" ? (
            <div className="messenger-panel-stack">
              <p className="muted">{status}</p>
              <label htmlFor="peer-select">Active Chat</label>
              <select
                id="peer-select"
                value={selectedPeerId ?? ""}
                onChange={(event) => switchPeer(event.target.value as UserId)}
              >
                <option value="" disabled>
                  {peers.length ? "Select a user" : "No users available"}
                </option>
                {peers.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {displayNameForUser(entry.id)}
                  </option>
                ))}
              </select>

              <label htmlFor="nickname-input">Nickname For Current Chat</label>
              <div className="chat-nickname-row" style={{ display: "flex", gap: "0.45rem" }}>
                <input
                  id="nickname-input"
                  value={nicknameDraft}
                  onChange={(event) => setNicknameDraft(event.target.value)}
                  placeholder="Set custom name"
                  disabled={!selectedPeerId}
                />
                <button className="secondary" onClick={() => void saveNickname()} disabled={!selectedPeerId}>
                  Save
                </button>
              </div>
            </div>
          ) : null}

          {dashboardTab === "directory" ? (
            <div className="messenger-panel-stack">
              {peers.length ? (
                peers.map((entry) => {
                  const selected = entry.id === selectedPeerId;
                  return (
                    <button
                      key={entry.id}
                      className={selected ? "" : "secondary"}
                      type="button"
                      onClick={() => switchPeer(entry.id)}
                    >
                      {displayNameForUser(entry.id)}
                    </button>
                  );
                })
              ) : (
                <p className="muted">No users available yet.</p>
              )}
            </div>
          ) : null}

          {dashboardTab === "settings" ? (
            <div className="messenger-panel-stack">
              <label htmlFor="profile-display-name">Display Name</label>
              <input
                id="profile-display-name"
                value={profileDisplayName}
                onChange={(event) => setProfileDisplayName(event.target.value)}
                placeholder="Your display name"
              />

              <label htmlFor="profile-avatar-url">Avatar URL</label>
              <input
                id="profile-avatar-url"
                value={profileAvatarUrl}
                onChange={(event) => setProfileAvatarUrl(event.target.value)}
                placeholder="https://example.com/avatar.jpg"
              />

              <label style={{ display: "grid", gap: "0.35rem" }}>
                <span>Avatar Image File</span>
                <input
                  type="file"
                  accept="image/*"
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (file) {
                      void fileToDataUrl(file).then((dataUrl) => {
                        setProfileAvatarUrl(dataUrl);
                      });
                    }
                    event.currentTarget.value = "";
                  }}
                />
              </label>

              <label htmlFor="chat-background-url">Chat Background URL</label>
              <input
                id="chat-background-url"
                value={chatBackgroundDraft}
                onChange={(event) => setChatBackgroundDraft(event.target.value)}
                placeholder="https://example.com/bg.jpg"
              />

              <label style={{ display: "grid", gap: "0.35rem" }}>
                <span>Background Image File</span>
                <input
                  type="file"
                  accept="image/*"
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (file) {
                      void onBackgroundFilePick(file);
                    }
                    event.currentTarget.value = "";
                  }}
                />
              </label>

              <button onClick={() => void saveProfile()} disabled={profileSaving}>
                Save Settings
              </button>
              <button className="secondary" onClick={() => void saveChatBackground()} type="button">
                Save Background
              </button>
              <button className="secondary" onClick={() => void clearCurrentChat()} disabled={!selectedPeerId || clearingChat}>
                {clearingChat ? "Clearing..." : "Clear Current Chat"}
              </button>
              <button className="secondary" onClick={() => void saveHourlyBackupSnapshot()} type="button">
                Backup Now
              </button>
              <button className="secondary" onClick={() => void restoreHourlyBackupSnapshot()} type="button">
                Restore Backup
              </button>
              {hourlyBackupStatus ? <p className="muted">{hourlyBackupStatus}</p> : null}
              <button className="warn" onClick={() => void handleLogout()} type="button">
                Logout
              </button>
              <button className="warn" onClick={() => void deleteMyAccount()} disabled={deletingAccount} type="button">
                {deletingAccount ? "Deleting..." : "Delete Account"}
              </button>
            </div>
          ) : null}
        </div>
      </aside>

      <section className="panel messenger-chat" style={chatPanelStyle}>
        <header className="messenger-chat-header">
          <div className="messenger-chat-peer">
            <Avatar
              name={selectedPeer ? displayNameForUser(selectedPeer.id) : "Chat"}
              avatarUrl={selectedPeer?.avatarUrl}
              size={38}
            />
            <div style={{ minWidth: 0 }}>
              <h2>{heading}</h2>
              <p className="muted">
                {selectedPeerId ? "Secure chat ready" : "Choose a user from dashboard registry"}
              </p>
            </div>
          </div>
          <div className="messenger-chat-actions">
            <button
              className="secondary messenger-drawer-toggle"
              onClick={() => setMobileDrawerOpen((open) => !open)}
              type="button"
              aria-controls="dashboard-panel"
              aria-expanded={mobileDrawerOpen}
            >
              {mobileDrawerOpen ? "Close" : "Dashboard"}
            </button>
            <button
              className="secondary"
              onClick={() => void startCall("audio")}
              disabled={!selectedPeerId || !!activeCall || !!outgoingCall}
              type="button"
            >
              Audio
            </button>
            <button
              className="secondary"
              onClick={() => void startCall("video")}
              disabled={!selectedPeerId || !!activeCall || !!outgoingCall}
              type="button"
            >
              Video
            </button>
          </div>
        </header>

        {incomingCall ? (
          <div className="messenger-call-banner">
            <strong>Incoming {incomingCall.callType} call from {displayNameForUser(incomingCall.from)}</strong>
            <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
              <button onClick={() => void acceptIncomingCall()} type="button">Accept</button>
              <button className="warn" onClick={declineIncomingCall} type="button">Decline</button>
            </div>
          </div>
        ) : null}

        {outgoingCall ? (
          <div className="messenger-call-banner">Calling {displayNameForUser(outgoingCall.peerId)}...</div>
        ) : null}

        {activeCall ? (
          <div className="messenger-call-banner messenger-call-active">
            <div className="messenger-call-line">
              <strong>
                In call with {displayNameForUser(activeCall.peerId)} ({activeCall.callType})
              </strong>
              <div className="messenger-call-actions">
                {activeMeetUrl ? (
                  <button className="secondary" onClick={openMeetLink} type="button">
                    Open Meet
                  </button>
                ) : null}
                <button className="warn" onClick={() => void terminateCall(true)} type="button">
                  End Call
                </button>
              </div>
            </div>
            {callError ? <p className="muted">{callError}</p> : null}
            <div
              ref={remoteTracksHostRef}
              className={`messenger-call-media${remoteVideoTracks > 0 ? " has-video" : ""}`}
            />
            {remoteVideoTracks === 0 ? <p className="muted">Waiting for remote media...</p> : null}
          </div>
        ) : null}

        {videoRecording ? (
          <div className="messenger-call-banner">
            <p style={{ marginTop: 0, marginBottom: "0.4rem" }}>Recording video note...</p>
            <video
              ref={videoPreviewRef}
              playsInline
              muted
              style={{ width: "100%", borderRadius: "12px", maxHeight: "220px", objectFit: "cover" }}
            />
            <button className="warn" style={{ marginTop: "0.6rem" }} onClick={() => void stopVideoNote()} type="button">
              Stop Video
            </button>
          </div>
        ) : null}

        <div ref={threadRef} className="messenger-thread">
          {messages.map((message) => {
            const own = auth?.userId === message.sender;
            const mediaPreview = message.media ? mediaPreviews[message.media.mediaId] : null;
            return (
              <article
                key={`${message.clientMessageId}-${message.serverId ?? "local"}`}
                className={`messenger-message-row${own ? " own" : " peer"}`}
              >
                <div className={`chat-bubble${own ? " own" : " peer"}`}>
                  <small className="muted" style={{ display: "block", marginBottom: "0.35rem" }}>
                    {displayNameForUser(message.sender)} | {formatTime(message.createdAt)} | {message.status}
                  </small>

                  {message.text ? (
                    message.viewOnce && !own && !message.viewedAt ? (
                      <button
                        className="secondary"
                        type="button"
                        style={{ width: "100%" }}
                        onClick={() => revealViewOnceMessage(message)}
                      >
                        View Once Message
                      </button>
                    ) : (
                      <div style={{ whiteSpace: "pre-wrap" }}>
                        {message.text}
                        {message.viewOnce ? (
                          <small className="muted" style={{ display: "block", marginTop: "0.35rem" }}>
                            {message.viewedAt ? "View-once opened" : "View-once pending"}
                          </small>
                        ) : null}
                      </div>
                    )
                  ) : null}

                  {message.media ? (
                    <div>
                      <p style={{ marginTop: "0.2rem", marginBottom: "0.5rem" }}>
                        {message.type.toUpperCase()}: {message.media.fileName}
                      </p>

                      {mediaPreview && isInlineMedia(mediaPreview.mimeType) ? (
                        <div style={{ marginBottom: "0.5rem" }}>
                          {mediaPreview.mimeType.startsWith("audio/") ? (
                            <audio controls src={mediaPreview.objectUrl} style={{ width: "100%" }} />
                          ) : null}
                          {mediaPreview.mimeType.startsWith("video/") ? (
                            <video
                              controls
                              playsInline
                              src={mediaPreview.objectUrl}
                              style={{ width: "100%", borderRadius: "10px" }}
                            />
                          ) : null}
                          {mediaPreview.mimeType.startsWith("image/") ? (
                            <img
                              src={mediaPreview.objectUrl}
                              alt={message.media.fileName}
                              style={{ width: "100%", borderRadius: "10px" }}
                            />
                          ) : null}
                        </div>
                      ) : null}

                      <div style={{ display: "flex", gap: "0.45rem", flexWrap: "wrap" }}>
                        {!mediaPreview ? (
                          <button className="secondary" onClick={() => void openInlineMedia(message)}>
                            Open
                          </button>
                        ) : null}
                        <button className="secondary" onClick={() => void downloadMediaMessage(message)}>
                          Save
                        </button>
                        <button className="secondary" onClick={() => void deleteMessage(message)} type="button">
                          Delete
                        </button>
                      </div>
                    </div>
                  ) : null}

                  {!message.media ? (
                    <div style={{ marginTop: "0.45rem", display: "flex", justifyContent: "flex-end" }}>
                      <button className="secondary" onClick={() => void deleteMessage(message)} type="button">
                        Delete
                      </button>
                    </div>
                  ) : null}
                </div>
              </article>
            );
          })}

          {peerTyping && selectedPeerId ? <p className="muted">{displayNameForUser(selectedPeerId)} is typing...</p> : null}
        </div>

        <footer className="messenger-compose">
          <div className={`messenger-compose-bar${composeActionMode !== "idle" ? " engaged" : ""}`}>
            <label className="messenger-compose-upload">
              <input
                type="file"
                style={{ display: "none" }}
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) {
                    void sendMediaFile(file);
                  }
                  event.currentTarget.value = "";
                }}
                disabled={!selectedPeerId}
              />
              <button
                type="button"
                className="secondary"
                onClick={(event) => {
                  const label = event.currentTarget.parentElement;
                  const input = label?.querySelector("input[type=file]") as HTMLInputElement | null;
                  input?.click();
                }}
                disabled={!selectedPeerId}
                aria-label="Upload file"
              >
                +
              </button>
            </label>

            <textarea
              ref={draftInputRef}
              rows={1}
              className="messenger-compose-input"
              placeholder={selectedPeerId ? "Type encrypted message..." : "Select a user first..."}
              value={draft}
              onChange={(event) => {
                onDraftChange(event.target.value);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  void sendText();
                }
              }}
              disabled={!selectedPeerId}
            />

            <button
              type="button"
              className={`secondary compose-mode-button${sendViewOnce ? " active" : ""}`}
              onClick={() => setSendViewOnce((current) => !current)}
              disabled={!selectedPeerId || !draft.trim()}
              aria-pressed={sendViewOnce}
              aria-label="Toggle view once mode"
            >
              1x
            </button>

            <button
              type="button"
              className={composeActionClassName}
              style={{ transform: `translateY(${Math.min(0, -composeDragOffset * 0.2)}px)` }}
              onPointerDown={onComposeActionPointerDown}
              onPointerMove={onComposeActionPointerMove}
              onPointerUp={onComposeActionPointerUp}
              onPointerCancel={onComposeActionPointerCancel}
              onClick={onComposeActionClick}
              disabled={!selectedPeerId}
              aria-label="Send, hold for voice, drag up for video"
            >
              {composeActionLabel}
            </button>
          </div>
          <p className="muted messenger-compose-hint">{composeHint}</p>
        </footer>
      </section>
    </main>
  );
}
