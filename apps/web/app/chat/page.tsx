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
  const [profileOpen, setProfileOpen] = useState(false);
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

  const displayNameForUser = useCallback(
    (userId: UserId) => {
      const nickname = nicknames[userId];
      if (nickname) {
        return nickname;
      }
      const directoryUser = authRef.current?.users.find((entry) => entry.id === userId);
      return directoryUser?.displayName ?? userId;
    },
    [nicknames]
  );

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

  useEffect(() => {
    outgoingCallRef.current = outgoingCall;
  }, [outgoingCall]);

  useEffect(() => {
    incomingCallRef.current = incomingCall;
  }, [incomingCall]);

  useEffect(() => {
    mediaPreviewsRef.current = mediaPreviews;
  }, [mediaPreviews]);

  useEffect(() => {
    if (!selectedPeerId) {
      setNicknameDraft("");
      return;
    }
    setNicknameDraft(nicknames[selectedPeerId] ?? "");
  }, [nicknames, selectedPeerId]);

  const mergeMessage = useCallback(
    async (message: UiMessage) => {
      setMessagesState((current) => {
        const index = current.findIndex((entry) => {
          if (message.serverId && entry.serverId) {
            return message.serverId === entry.serverId;
          }
          return message.clientMessageId === entry.clientMessageId;
        });

        let next = [...current];
        if (index >= 0) {
          next[index] = {
            ...next[index],
            ...message
          };
        } else {
          next.push(message);
          next.sort((a, b) => a.createdAt - b.createdAt);
        }

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
      for (const record of records) {
        const ui = await decryptServerRecord(record);
        if (ui) {
          await mergeMessage(ui);
        }
      }
    },
    [decryptServerRecord, mergeMessage]
  );

  const sendClientEvent = useCallback((event: ClientEvent) => {
    socketRef.current?.send(event);
  }, []);

  const terminateCall = useCallback(
    async (notifyPeer: boolean) => {
      if (notifyPeer && activeCall) {
        sendClientEvent(
          makeClientEvent("call:end", {
            to: activeCall.peerId,
            roomName: activeCall.roomName
          })
        );
      }

      clearCallTimeout();

      if (activeCall?.roomName) {
        await cancelCallNotification(activeCall.roomName);
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
    },
    [activeCall, clearCallTimeout, sendClientEvent]
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
          if (activeCall || outgoingCallRef.current || incomingCallRef.current) {
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
      activeCall,
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

  const loadConversationForPeer = useCallback(
    async (peerId: UserId, sourceSession?: AuthSession) => {
      const currentSession = sourceSession ?? authRef.current;
      if (!currentSession) {
        return;
      }

      selectedPeerRef.current = peerId;
      const localMessages = await getMessages(currentSession.userId, peerId);
      setMessagesState(localMessages);
      setPeerTyping(false);

      const peer = currentSession.users.find((item) => item.id === peerId);
      if (!peer?.identityPublicKey) {
        sharedSecretRef.current = null;
        sessionRef.current = null;
        setStatus(`"${peerId}" has no identity key yet. Ask them to login once.`);
        return;
      }

      const context = await ensureConversationCrypto(currentSession.userId, peerId, peer.identityPublicKey);
      sharedSecretRef.current = context.sharedSecret;
      sessionRef.current = context.session;

      const history = await jsonRequest<{ messages: MessageRecord[] }>("/messages?after=0");
      await applyServerRecords(history.messages);
      setStatus(`Secure channel ready with ${displayNameForUser(peerId)}`);
    },
    [applyServerRecords, displayNameForUser]
  );

  const bootstrap = useCallback(async () => {
    const session = await fetchSession();
    authRef.current = session;
    setAuth(session);
    setProfileDisplayName(session.profile.displayName);
    setProfileAvatarUrl(session.profile.avatarUrl ?? "");

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
      await loadConversationForPeer(defaultPeerId, session);
    } else {
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
      }
    );

    socket.connect();
    socketRef.current = socket;
  }, [handleSocketEvent, loadConversationForPeer]);

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
    if (!auth || !selectedPeerId) {
      return;
    }

    void loadConversationForPeer(selectedPeerId, auth);
  }, [auth, loadConversationForPeer, selectedPeerId]);

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
  }, [draft, mergeMessage, sendClientEvent]);

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
    },
    [mergeMessage, sendClientEvent]
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
      setProfileOpen(false);
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

  const heading = useMemo(() => {
    if (!auth) {
      return "LoveChat";
    }
    const selfName = auth.profile.displayName || auth.userId;
    if (!selectedPeerId) {
      return selfName;
    }
    return `${selfName} -> ${displayNameForUser(selectedPeerId)}`;
  }, [auth, displayNameForUser, selectedPeerId]);

  return (
    <main className="shell chat-shell" style={{ minHeight: "100vh", paddingTop: "0.75rem", paddingBottom: "0.75rem" }}>
      <section className="panel" style={{ padding: "1rem", marginBottom: "0.8rem" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "0.8rem", flexWrap: "wrap" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "0.6rem" }}>
            <Avatar
              name={auth?.profile.displayName ?? "Me"}
              avatarUrl={auth?.profile.avatarUrl}
              size={36}
            />
            {selectedPeer ? (
              <>
                <span style={{ opacity: 0.7 }}>→</span>
                <Avatar
                  name={displayNameForUser(selectedPeer.id)}
                  avatarUrl={selectedPeer.avatarUrl}
                  size={36}
                />
              </>
            ) : null}
            <div>
            <h1 style={{ margin: 0 }}>{heading}</h1>
            <p className="muted" style={{ marginBottom: 0 }}>
              Socket: {socketStatus} | {status}
            </p>
            </div>
          </div>
          <div style={{ display: "flex", gap: "0.45rem", flexWrap: "wrap" }}>
            <button
              className="secondary"
              onClick={() => void startCall("audio")}
              disabled={!selectedPeerId || !!activeCall || !!outgoingCall}
            >
              📞 Audio
            </button>
            <button
              className="secondary"
              onClick={() => void startCall("video")}
              disabled={!selectedPeerId || !!activeCall || !!outgoingCall}
            >
              🎥 Video
            </button>
            <button className="secondary" onClick={() => setProfileOpen((current) => !current)}>
              ⚙️ Profile
            </button>
            <button className="warn" onClick={() => void handleLogout()}>
              Logout
            </button>
          </div>
        </div>

        <div
          style={{
            marginTop: "0.8rem",
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
            gap: "0.7rem"
          }}
        >
          <div>
            <label htmlFor="peer-select" style={{ display: "block", marginBottom: "0.4rem" }}>
              Chat With
            </label>
            <select
              id="peer-select"
              value={selectedPeerId ?? ""}
              onChange={(event) => {
                const nextPeer = event.target.value as UserId;
                if (!nextPeer) {
                  return;
                }
                if (typingSentRef.current && selectedPeerRef.current) {
                  sendClientEvent(makeClientEvent("typing:stop", { to: selectedPeerRef.current }));
                  typingSentRef.current = false;
                }
                setDraft("");
                setSelectedPeerId(nextPeer);
              }}
            >
              <option value="" disabled>
                {peers.length ? "Select a user" : "No users available"}
              </option>
              {peers.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {displayNameForUser(entry.id)} ({entry.id})
                </option>
              ))}
            </select>
          </div>

          <div>
            <label htmlFor="nickname-input" style={{ display: "block", marginBottom: "0.4rem" }}>
              Nickname For This Chat
            </label>
            <div style={{ display: "flex", gap: "0.45rem" }}>
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
        </div>
      </section>

      {incomingCall ? (
        <section className="panel" style={{ padding: "1rem", marginBottom: "0.8rem" }}>
          <strong>
            Incoming {incomingCall.callType} call from {displayNameForUser(incomingCall.from)}
          </strong>
          <div style={{ marginTop: "0.7rem", display: "flex", gap: "0.6rem" }}>
            <button onClick={() => void acceptIncomingCall()}>Accept</button>
            <button className="warn" onClick={declineIncomingCall}>
              Decline
            </button>
          </div>
        </section>
      ) : null}

      {outgoingCall ? (
        <section className="panel" style={{ padding: "0.8rem", marginBottom: "0.8rem" }}>
          Calling {displayNameForUser(outgoingCall.peerId)} ({outgoingCall.callType})...
        </section>
      ) : null}

      {activeCall ? (
        <section className="panel" style={{ padding: "1rem", marginBottom: "0.8rem" }}>
          <strong>
            In call with {displayNameForUser(activeCall.peerId)}: {activeCall.callType}
          </strong>
          <p className="muted" style={{ marginBottom: "0.6rem" }}>
            Room: {activeCall.roomName}
          </p>
          <button className="warn" style={{ marginTop: "0.7rem" }} onClick={() => void terminateCall(true)}>
            End Call
          </button>
        </section>
      ) : null}

      {videoRecording ? (
        <section className="panel" style={{ padding: "0.8rem", marginBottom: "0.8rem" }}>
          <p style={{ marginTop: 0, marginBottom: "0.45rem" }}>Recording video note...</p>
          <video
            ref={videoPreviewRef}
            playsInline
            muted
            style={{ width: "100%", borderRadius: "12px", maxHeight: "220px", objectFit: "cover" }}
          />
          <button className="warn" style={{ marginTop: "0.65rem" }} onClick={stopVideoNote}>
            Stop Video Note
          </button>
        </section>
      ) : null}

      <section className="panel" style={{ minHeight: "48vh", maxHeight: "54vh", overflowY: "auto", padding: "1rem" }}>
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
      </section>

      <section className="panel" style={{ padding: "1rem", marginTop: "0.8rem" }}>
        <div style={{ display: "grid", gap: "0.7rem" }}>
          <textarea
            rows={3}
            placeholder={selectedPeerId ? "Type encrypted message..." : "Select a user first..."}
            value={draft}
            onChange={(event) => {
              onDraftChange(event.target.value);
            }}
            disabled={!selectedPeerId}
          />

          <div style={{ display: "flex", gap: "0.6rem", flexWrap: "wrap" }}>
            <button onClick={() => void sendText()} disabled={!selectedPeerId || !draft.trim()}>
              ➤ Send
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
                📎 Upload
              </button>
            </label>

            {!audioRecording ? (
              <button
                className="secondary"
                onClick={() => void startAudioNote()}
                disabled={!selectedPeerId || videoRecording}
              >
                🎙️ Voice Note
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
                🎬 Video Note
              </button>
            ) : null}
          </div>
        </div>
      </section>

      {profileOpen ? (
        <section className="panel" style={{ padding: "1rem", marginTop: "0.8rem" }}>
          <h2 style={{ marginTop: 0 }}>Account</h2>
          <label htmlFor="profile-display-name" style={{ display: "block", marginBottom: "0.35rem" }}>
            Display Name
          </label>
          <input
            id="profile-display-name"
            value={profileDisplayName}
            onChange={(event) => setProfileDisplayName(event.target.value)}
            placeholder="Your display name"
          />

          <label htmlFor="profile-avatar-url" style={{ display: "block", marginTop: "0.75rem", marginBottom: "0.35rem" }}>
            Avatar URL
          </label>
          <input
            id="profile-avatar-url"
            value={profileAvatarUrl}
            onChange={(event) => setProfileAvatarUrl(event.target.value)}
            placeholder="https://example.com/avatar.jpg"
          />

          <div style={{ marginTop: "0.85rem", display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
            <button onClick={() => void saveProfile()} disabled={profileSaving}>
              Save Profile
            </button>
            <button className="secondary" onClick={() => setProfileOpen(false)} disabled={profileSaving}>
              Close
            </button>
          </div>
        </section>
      ) : null}
    </main>
  );
}
