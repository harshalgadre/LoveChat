"use client";

import { fromBase64Url, type ClientEvent, type MessageRecord, type MessageType, type UserId } from "@love-chat/shared";
import type { SessionState } from "@love-chat/shared";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import { jsonRequest } from "../../lib/api";
import { fetchSession, logout, updateIdentityPublicKey } from "../../lib/auth";
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
import { getLastServerId, getMessages, setLastServerId, setMessages } from "../../lib/storage";
import type { AuthSession, MediaDescriptor, UiMessage } from "../../lib/types";
import { ChatSocket, makeClientEvent } from "../../lib/wsClient";

type CallState = {
  roomName: string;
  callType: "audio" | "video";
};

type IncomingCall = {
  from: UserId;
  roomName: string;
  callType: "audio" | "video";
};

export default function ChatPage() {
  const router = useRouter();

  const [auth, setAuth] = useState<AuthSession | null>(null);
  const [messages, setMessagesState] = useState<UiMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [status, setStatus] = useState("Initializing...");
  const [socketStatus, setSocketStatus] = useState<"connecting" | "connected" | "disconnected">("disconnected");
  const [peerTyping, setPeerTyping] = useState(false);
  const [incomingCall, setIncomingCall] = useState<IncomingCall | null>(null);
  const [activeCall, setActiveCall] = useState<CallState | null>(null);
  const [recording, setRecording] = useState(false);

  const authRef = useRef<AuthSession | null>(null);
  const sharedSecretRef = useRef<string | null>(null);
  const sessionRef = useRef<SessionState | null>(null);
  const socketRef = useRef<ChatSocket | null>(null);
  const typingSentRef = useRef(false);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const callRef = useRef<ActiveCall | null>(null);
  const remoteMediaContainerRef = useRef<HTMLDivElement | null>(null);

  const persistMessages = useCallback(async (nextMessages: UiMessage[]) => {
    const userId = authRef.current?.userId;
    if (!userId) {
      return;
    }

    await setMessages(userId, nextMessages);
    const maxServerId = nextMessages.reduce((acc, item) => {
      if (item.serverId && item.serverId > acc) {
        return item.serverId;
      }
      return acc;
    }, 0);
    await setLastServerId(userId, maxServerId);
  }, []);

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
    const sharedSecret = sharedSecretRef.current;
    if (!sharedSecret) {
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
      const currentAuth = authRef.current;
      if (notifyPeer && currentAuth && activeCall) {
        sendClientEvent(
          makeClientEvent("call:end", {
            to: currentAuth.peerId,
            roomName: activeCall.roomName
          })
        );
      }

      await endLiveKitConnection(callRef.current);
      callRef.current = null;
      setIncomingCall(null);
      setActiveCall(null);
      if (remoteMediaContainerRef.current) {
        remoteMediaContainerRef.current.innerHTML = "";
      }
    },
    [activeCall, sendClientEvent]
  );

  const handleSocketEvent = useCallback(
    async (event: any) => {
      switch (event.type) {
        case "message:recv": {
          const ui = await decryptServerRecord(event.payload);
          if (ui) {
            await mergeMessage(ui);
          }
          return;
        }
        case "message:ack": {
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
          setPeerTyping(true);
          return;
        case "typing:stop":
          setPeerTyping(false);
          return;
        case "sync:batch":
          await applyServerRecords(event.payload.messages);
          return;
        case "call:start":
          setIncomingCall({
            from: event.payload.to,
            roomName: event.payload.roomName,
            callType: event.payload.callType
          });
          return;
        case "call:decline":
          setStatus("Call declined");
          await terminateCall(false);
          return;
        case "call:end":
          setStatus("Call ended");
          await terminateCall(false);
          return;
        default:
          return;
      }
    },
    [applyServerRecords, decryptServerRecord, mergeMessage, persistMessages, terminateCall]
  );

  const bootstrap = useCallback(async () => {
    const session = await fetchSession();
    authRef.current = session;
    setAuth(session);

    const localMessages = await getMessages(session.userId);
    setMessagesState(localMessages);

    const identity = await ensureIdentityKey(session.userId);
    if (!session.selfIdentityPublicKey || session.selfIdentityPublicKey !== identity.publicKey) {
      await updateIdentityPublicKey(identity.publicKey);
    }

    if (!session.peerIdentityPublicKey) {
      setStatus("Peer identity key not available. Ask peer to register/login first.");
    } else {
      const context = await ensureConversationCrypto(session.userId, session.peerIdentityPublicKey);
      sharedSecretRef.current = context.sharedSecret;
      sessionRef.current = context.session;

      const lastId = await getLastServerId(session.userId);
      const history = await jsonRequest<{ messages: MessageRecord[] }>(`/messages?after=${lastId}`);
      await applyServerRecords(history.messages);
      setStatus("Secure channel ready");
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
  }, [applyServerRecords, handleSocketEvent]);

  useEffect(() => {
    bootstrap().catch(() => {
      router.replace("/login");
    });

    return () => {
      socketRef.current?.close();
      void terminateCall(false);
    };
  }, [bootstrap, router, terminateCall]);

  const sendText = useCallback(async () => {
    const currentAuth = authRef.current;
    const sessionState = sessionRef.current;

    if (!currentAuth || !sessionState || !draft.trim()) {
      return;
    }

    const createdAt = Date.now();
    const clientMessageId = crypto.randomUUID();

    const encrypted = await encryptTextWithSession(currentAuth.userId, sessionState, draft.trim(), {
      sender: currentAuth.userId,
      recipient: currentAuth.peerId,
      messageId: clientMessageId,
      timestamp: createdAt,
      type: "text"
    });
    sessionRef.current = encrypted.session;

    sendClientEvent(
      makeClientEvent("message:send", {
        to: currentAuth.peerId,
        type: "text",
        encryptedPayload: encrypted.payload,
        clientMessageId
      }, createdAt)
    );

    await mergeMessage({
      localId: clientMessageId,
      clientMessageId,
      sender: currentAuth.userId,
      recipient: currentAuth.peerId,
      type: "text",
      text: draft.trim(),
      createdAt,
      status: "sending"
    });

    setDraft("");
    if (typingSentRef.current) {
      sendClientEvent(makeClientEvent("typing:stop", { to: currentAuth.peerId }));
      typingSentRef.current = false;
    }
  }, [draft, mergeMessage, sendClientEvent]);

  const sendMediaFile = useCallback(
    async (file: File, forcedType?: Extract<MessageType, "image" | "video" | "audio" | "document">) => {
      const currentAuth = authRef.current;
      const sessionState = sessionRef.current;
      if (!currentAuth || !sessionState) {
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

      const encryptedFile = await encryptBytesWithSession(currentAuth.userId, sessionState, fileBytes, {
        sender: currentAuth.userId,
        recipient: currentAuth.peerId,
        messageId: fileMetaMessageId,
        timestamp: fileMetaTimestamp,
        type: messageType
      });
      sessionRef.current = encryptedFile.session;

      const upload = await uploadEncryptedMedia({
        recipient: currentAuth.peerId,
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
        sessionRef.current,
        JSON.stringify(descriptor),
        {
          sender: currentAuth.userId,
          recipient: currentAuth.peerId,
          messageId: clientMessageId,
          timestamp: createdAt,
          type: messageType
        }
      );
      sessionRef.current = encryptedDescriptor.session;

      sendClientEvent(
        makeClientEvent("message:send", {
          to: currentAuth.peerId,
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
        recipient: currentAuth.peerId,
        type: messageType,
        media: descriptor,
        createdAt,
        status: "sending"
      });
    },
    [mergeMessage, sendClientEvent]
  );

  const startRecording = useCallback(async () => {
    if (recording) {
      return;
    }

    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const chunks: BlobPart[] = [];
    const recorder = new MediaRecorder(stream);

    recorderRef.current = recorder;

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
      setRecording(false);
      recorderRef.current = null;
    };

    recorder.start();
    setRecording(true);
  }, [recording, sendMediaFile]);

  const stopRecording = useCallback(() => {
    recorderRef.current?.stop();
  }, []);

  const onDraftChange = useCallback(
    (value: string) => {
      setDraft(value);
      const currentAuth = authRef.current;
      if (!currentAuth) {
        return;
      }

      if (value.trim() && !typingSentRef.current) {
        sendClientEvent(makeClientEvent("typing:start", { to: currentAuth.peerId }));
        typingSentRef.current = true;
      }

      if (!value.trim() && typingSentRef.current) {
        sendClientEvent(makeClientEvent("typing:stop", { to: currentAuth.peerId }));
        typingSentRef.current = false;
      }
    },
    [sendClientEvent]
  );

  const downloadMediaMessage = useCallback(async (message: UiMessage) => {
    if (!message.media || !sharedSecretRef.current) {
      return;
    }

    const encryptedBytes = await downloadEncryptedMedia(message.media.mediaId);
    const decrypted = await decryptBinaryPayload(sharedSecretRef.current, message.media.fileEncryptionPayload, {
      sender: message.sender,
      recipient: message.recipient,
      messageId: message.media.fileMetaMessageId,
      timestamp: message.media.fileMetaTimestamp,
      type: message.media.fileType
    });

    const mediaBuffer = decrypted.buffer.slice(
      decrypted.byteOffset,
      decrypted.byteOffset + decrypted.byteLength
    ) as ArrayBuffer;
    const blob = new Blob([mediaBuffer], { type: message.media.mimeType });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = message.media.fileName;
    link.click();
    URL.revokeObjectURL(link.href);

    await ackMedia(message.media.mediaId);
  }, []);

  const startCall = useCallback(
    async (callType: "audio" | "video") => {
      const currentAuth = authRef.current;
      if (!currentAuth) {
        return;
      }

      const roomName = `lovechat-${Date.now()}`;
      sendClientEvent(
        makeClientEvent("call:start", {
          to: currentAuth.peerId,
          roomName,
          callType
        })
      );

      const call = await createLiveKitConnection(roomName, callType);
      callRef.current = call;
      setActiveCall({ roomName, callType });
      if (remoteMediaContainerRef.current) {
        remoteMediaContainerRef.current.innerHTML = "Call connected. Remote tracks will render automatically.";
      }
    },
    [sendClientEvent]
  );

  const acceptIncomingCall = useCallback(async () => {
    const currentAuth = authRef.current;
    if (!currentAuth || !incomingCall) {
      return;
    }

    sendClientEvent(
      makeClientEvent("call:accept", {
        to: incomingCall.from,
        roomName: incomingCall.roomName,
        callType: incomingCall.callType
      })
    );

    const call = await createLiveKitConnection(incomingCall.roomName, incomingCall.callType);
    callRef.current = call;
    setActiveCall({ roomName: incomingCall.roomName, callType: incomingCall.callType });
    setIncomingCall(null);
  }, [incomingCall, sendClientEvent]);

  const declineIncomingCall = useCallback(() => {
    const currentAuth = authRef.current;
    if (!currentAuth || !incomingCall) {
      return;
    }

    sendClientEvent(
      makeClientEvent("call:decline", {
        to: incomingCall.from,
        roomName: incomingCall.roomName,
        callType: incomingCall.callType
      })
    );
    setIncomingCall(null);
  }, [incomingCall, sendClientEvent]);

  const handleLogout = useCallback(async () => {
    await logout();
    socketRef.current?.close();
    router.replace("/login");
  }, [router]);

  const heading = useMemo(() => {
    if (!auth) {
      return "LoveChat";
    }
    return `${auth.userId} -> ${auth.peerId}`;
  }, [auth]);

  return (
    <main className="shell" style={{ minHeight: "100vh", paddingTop: "1rem", paddingBottom: "1rem" }}>
      <section className="panel" style={{ padding: "1rem", marginBottom: "0.8rem" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "0.8rem", flexWrap: "wrap" }}>
          <div>
            <h1 style={{ margin: 0 }}>{heading}</h1>
            <p className="muted" style={{ marginBottom: 0 }}>
              Socket: {socketStatus} | {status}
            </p>
          </div>
          <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
            <button className="secondary" onClick={() => void startCall("audio")} disabled={!auth || !!activeCall}>
              Audio Call
            </button>
            <button className="secondary" onClick={() => void startCall("video")} disabled={!auth || !!activeCall}>
              Video Call
            </button>
            <button className="warn" onClick={() => void handleLogout()}>
              Logout
            </button>
          </div>
        </div>
      </section>

      {incomingCall ? (
        <section className="panel" style={{ padding: "1rem", marginBottom: "0.8rem" }}>
          <strong>
            Incoming {incomingCall.callType} call from {incomingCall.from}
          </strong>
          <div style={{ marginTop: "0.7rem", display: "flex", gap: "0.6rem" }}>
            <button onClick={() => void acceptIncomingCall()}>Accept</button>
            <button className="warn" onClick={declineIncomingCall}>
              Decline
            </button>
          </div>
        </section>
      ) : null}

      {activeCall ? (
        <section className="panel" style={{ padding: "1rem", marginBottom: "0.8rem" }}>
          <strong>
            In call: {activeCall.callType} ({activeCall.roomName})
          </strong>
          <div ref={remoteMediaContainerRef} style={{ marginTop: "0.8rem" }} />
          <button className="warn" style={{ marginTop: "0.7rem" }} onClick={() => void terminateCall(true)}>
            End Call
          </button>
        </section>
      ) : null}

      <section className="panel" style={{ minHeight: "48vh", maxHeight: "54vh", overflowY: "auto", padding: "1rem" }}>
        {messages.map((message) => {
          const own = auth?.userId === message.sender;
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
                  {message.sender} | {new Date(message.createdAt).toLocaleTimeString()} | {message.status}
                </small>

                {message.text ? <div style={{ whiteSpace: "pre-wrap" }}>{message.text}</div> : null}

                {message.media ? (
                  <div>
                    <p style={{ marginTop: "0.2rem", marginBottom: "0.5rem" }}>
                      {message.type.toUpperCase()}: {message.media.fileName}
                    </p>
                    <button className="secondary" onClick={() => void downloadMediaMessage(message)}>
                      Download
                    </button>
                  </div>
                ) : null}
              </div>
            </article>
          );
        })}

        {peerTyping ? <p className="muted">Peer is typing...</p> : null}
      </section>

      <section className="panel" style={{ padding: "1rem", marginTop: "0.8rem" }}>
        <div style={{ display: "grid", gap: "0.7rem" }}>
          <textarea
            rows={3}
            placeholder="Type encrypted message..."
            value={draft}
            onChange={(event) => {
              onDraftChange(event.target.value);
            }}
          />

          <div style={{ display: "flex", gap: "0.6rem", flexWrap: "wrap" }}>
            <button onClick={() => void sendText()} disabled={!draft.trim()}>
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
              />
              <button
                type="button"
                className="secondary"
                onClick={(event) => {
                  const label = event.currentTarget.parentElement;
                  const input = label?.querySelector("input[type=file]") as HTMLInputElement | null;
                  input?.click();
                }}
              >
                Upload Media
              </button>
            </label>

            {!recording ? (
              <button className="secondary" onClick={() => void startRecording()}>
                Voice Note
              </button>
            ) : (
              <button className="warn" onClick={stopRecording}>
                Stop Recording
              </button>
            )}
          </div>
        </div>
      </section>
    </main>
  );
}
