"use client";

import { fromBase64Url, type ClientEvent, type MessageRecord, type MessageType, type UserId } from "@love-chat/shared";
import type { SessionState } from "@love-chat/shared";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import { jsonRequest } from "../../lib/api";
import { fetchSession, logout, updateIdentityPublicKey, updateProfile } from "../../lib/auth";
import { fileToBytes } from "../../lib/bytes";
import { createLiveKitConnection, endLiveKitConnection, type ActiveCall } from "../../lib/calls";
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
  getLastServerId,
  getMessages,
  getNicknames,
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
  const [profileDisplayName, setProfileDisplayName] = useState("");
  const [profileAvatarUrl, setProfileAvatarUrl] = useState("");
  const [profileSaving, setProfileSaving] = useState(false);

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
  const videoStreamRef = useRef<MediaStream | null>(null);
  const callRef = useRef<ActiveCall | null>(null);
  const mediaPreviewsRef = useRef<Record<string, MediaPreview>>({});
  const threadRef = useRef<HTMLDivElement | null>(null);
  const activeCallRef = useRef<CallState | null>(null);
  const nicknamesRef = useRef<Record<string, string>>({});
  const conversationLoadRef = useRef(0);

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
    mediaPreviewsRef.current = mediaPreviews;
  }, [mediaPreviews]);

  useEffect(() => {
    nicknamesRef.current = nicknames;
  }, [nicknames]);

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
        const text = await decryptTextPayload(sharedSecret, record.encryptedPayload, metadata);
        return {
          localId: `srv-${record.id}`,
          serverId: record.id,
          clientMessageId: record.clientMessageId,
          sender: record.sender,
          recipient: record.recipient,
          type: record.type,
          text,
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
            const call = await createLiveKitConnection(pending.roomName, pending.callType);
            callRef.current = call;
            setActiveCall({
              peerId: pending.peerId,
              roomName: pending.roomName,
              callType: pending.callType
            });
            setStatus(`Connected with ${displayNameForUser(pending.peerId)}`);
          }
          return;
        case "call:decline":
          if (outgoingCallRef.current && outgoingCallRef.current.peerId === event.payload.to) {
            clearCallTimeout();
            setOutgoingCall(null);
            outgoingCallRef.current = null;
          }
          setStatus(`${displayNameForUser(event.payload.to)} declined the call`);
          await terminateCall(false);
          return;
        case "call:end":
          clearCallTimeout();
          setOutgoingCall(null);
          outgoingCallRef.current = null;
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

    return () => {
      clearCallTimeout();
      socketRef.current?.close();
      void terminateCall(false);
      const stream = videoStreamRef.current;
      if (stream) {
        stream.getTracks().forEach((track) => track.stop());
      }
      Object.values(mediaPreviewsRef.current).forEach((entry) => {
        URL.revokeObjectURL(entry.objectUrl);
      });
    };
  }, [bootstrap, clearCallTimeout, router, terminateCall]);

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

    if (!currentAuth || !peerId || !sessionState || !draft.trim()) {
      return;
    }

    const createdAt = Date.now();
    const clientMessageId = crypto.randomUUID();

    const encrypted = await encryptTextWithSession(currentAuth.userId, peerId, sessionState, draft.trim(), {
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
      text: draft.trim(),
      createdAt,
      status: "sending"
    });

    setDraft("");
    if (typingSentRef.current) {
      sendClientEvent(makeClientEvent("typing:stop", { to: peerId }));
      typingSentRef.current = false;
    }
    scrollThreadToBottom("smooth");
  }, [draft, mergeMessage, scrollThreadToBottom, sendClientEvent]);

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
    if (audioRecording || videoRecording) {
      return;
    }

    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const chunks: BlobPart[] = [];
    const recorder = new MediaRecorder(stream);

    audioRecorderRef.current = recorder;

    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) {
        chunks.push(event.data);
      }
    };

    recorder.onstop = () => {
      const blob = new Blob(chunks, { type: "audio/webm" });
      const file = new File([blob], `voice-${Date.now()}.webm`, { type: "audio/webm" });
      void sendMediaFile(file, "audio");
      stream.getTracks().forEach((track) => track.stop());
      setAudioRecording(false);
      audioRecorderRef.current = null;
    };

    recorder.start();
    setAudioRecording(true);
  }, [audioRecording, sendMediaFile, videoRecording]);

  const stopAudioNote = useCallback(() => {
    audioRecorderRef.current?.stop();
  }, []);

  const startVideoNote = useCallback(async () => {
    if (audioRecording || videoRecording) {
      return;
    }

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

    videoRecorderRef.current = recorder;
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) {
        chunks.push(event.data);
      }
    };

    recorder.onstop = () => {
      const blob = new Blob(chunks, { type: mimeType ?? "video/webm" });
      const file = new File([blob], `video-note-${Date.now()}.webm`, { type: mimeType ?? "video/webm" });
      void sendMediaFile(file, "video");
      stopVideoCaptureStream();
      setVideoRecording(false);
      videoRecorderRef.current = null;
    };

    recorder.start();
    setVideoRecording(true);
  }, [audioRecording, sendMediaFile, stopVideoCaptureStream, videoRecording]);

  const stopVideoNote = useCallback(() => {
    videoRecorderRef.current?.stop();
  }, []);

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

    const call = await createLiveKitConnection(currentIncoming.roomName, currentIncoming.callType);
    callRef.current = call;
    setActiveCall({
      peerId: currentIncoming.from,
      roomName: currentIncoming.roomName,
      callType: currentIncoming.callType
    });
    setIncomingCall(null);
    incomingCallRef.current = null;
    setStatus(`Connected with ${displayNameForUser(currentIncoming.from)}`);
  }, [displayNameForUser, sendClientEvent]);

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
      setSelectedPeerId(nextPeer);
      setDashboardTab("main");
    },
    [sendClientEvent]
  );

  const heading = useMemo(
    () => (selectedPeerId ? displayNameForUser(selectedPeerId) : "Choose a chat"),
    [displayNameForUser, selectedPeerId]
  );

  return (
    <main className="messenger-layout">
      <aside className="panel messenger-sidebar">
        <div className="messenger-sidebar-header">
          <Avatar name={auth?.profile.displayName ?? "Me"} avatarUrl={auth?.profile.avatarUrl} size={42} />
          <div>
            <h1 className="messenger-title">Dashboard</h1>
            <p className="muted messenger-subtitle">Socket: {socketStatus}</p>
          </div>
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

              <button onClick={() => void saveProfile()} disabled={profileSaving}>
                Save Settings
              </button>
              <button className="warn" onClick={() => void handleLogout()} type="button">
                Logout
              </button>
            </div>
          ) : null}
        </div>
      </aside>

      <section className="panel messenger-chat">
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
          <div className="messenger-call-banner">
            In call with {displayNameForUser(activeCall.peerId)} ({activeCall.callType})
            <button className="warn" onClick={() => void terminateCall(true)} type="button">
              End Call
            </button>
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
            <button className="warn" style={{ marginTop: "0.6rem" }} onClick={stopVideoNote} type="button">
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
                style={{
                  marginBottom: "0.75rem",
                  display: "flex",
                  justifyContent: own ? "flex-end" : "flex-start"
                }}
              >
                <div
                  className="chat-bubble"
                  style={{
                    width: "min(85%, 460px)",
                    borderRadius: "12px",
                    padding: "0.65rem 0.75rem",
                    background: own ? "rgba(38, 198, 165, 0.2)" : "rgba(255, 255, 255, 0.08)",
                    border: "1px solid rgba(159, 195, 209, 0.2)"
                  }}
                >
                  <small className="muted" style={{ display: "block", marginBottom: "0.35rem" }}>
                    {displayNameForUser(message.sender)} | {formatTime(message.createdAt)} | {message.status}
                  </small>

                  {message.text ? <div style={{ whiteSpace: "pre-wrap" }}>{message.text}</div> : null}

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
                      </div>
                    </div>
                  ) : null}
                </div>
              </article>
            );
          })}

          {peerTyping && selectedPeerId ? <p className="muted">{displayNameForUser(selectedPeerId)} is typing...</p> : null}
        </div>

        <footer className="messenger-compose">
          <textarea
            rows={3}
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

          <div className="chat-compose-actions" style={{ display: "flex", gap: "0.6rem", flexWrap: "wrap" }}>
            <button onClick={() => void sendText()} disabled={!selectedPeerId || !draft.trim()}>
              Send
            </button>

            <label style={{ display: "inline-flex", alignItems: "center", gap: "0.4rem" }}>
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
              >
                Upload
              </button>
            </label>

            {!audioRecording ? (
              <button
                className="secondary"
                onClick={() => void startAudioNote()}
                disabled={!selectedPeerId || videoRecording}
              >
                Voice
              </button>
            ) : (
              <button className="warn" onClick={stopAudioNote}>
                Stop Voice
              </button>
            )}

            {!videoRecording ? (
              <button
                className="secondary"
                onClick={() => void startVideoNote()}
                disabled={!selectedPeerId || audioRecording}
              >
                Video Note
              </button>
            ) : null}
          </div>
        </footer>
      </section>
    </main>
  );
}
