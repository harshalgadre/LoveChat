import type { ClientEvent, ServerEvent } from "@love-chat/shared";

import { wsServerUrl } from "./config";

const INITIAL_RECONNECT_MS = 1_000;
const MAX_RECONNECT_MS = 12_000;
const MAX_PENDING_EVENTS = 200;

interface ChatSocketOptions {
  refreshToken?: () => Promise<string | null>;
  onAuthExpired?: () => void;
}

export class ChatSocket {
  private socket: WebSocket | null = null;

  private reconnectTimer: number | null = null;

  private reconnectAttempt = 0;

  private pendingFrames: string[] = [];

  private refreshPromise: Promise<boolean> | null = null;

  private connectionId = 0;

  private isClosed = false;

  private wsToken: string;

  constructor(
    wsToken: string,
    private readonly onEvent: (event: ServerEvent) => void,
    private readonly onStatus: (status: "connecting" | "connected" | "disconnected") => void,
    private readonly options: ChatSocketOptions = {}
  ) {
    this.wsToken = wsToken;
  }

  connect() {
    this.isClosed = false;
    void this.openSocket();
  }

  close() {
    this.isClosed = true;
    if (this.reconnectTimer) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.pendingFrames = [];
    this.socket?.close();
    this.socket = null;
  }

  send(event: ClientEvent): void {
    const serialized = JSON.stringify(event);
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      this.pendingFrames.push(serialized);
      if (this.pendingFrames.length > MAX_PENDING_EVENTS) {
        this.pendingFrames.shift();
      }
      return;
    }

    this.socket.send(serialized);
  }

  private async openSocket() {
    if (this.isClosed) {
      return;
    }
    if (this.socket && (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING)) {
      return;
    }

    this.onStatus("connecting");
    const socket = new WebSocket(wsServerUrl(this.wsToken));
    this.socket = socket;
    const currentConnectionId = ++this.connectionId;

    socket.addEventListener("open", () => {
      if (currentConnectionId !== this.connectionId) {
        return;
      }
      this.reconnectAttempt = 0;
      this.onStatus("connected");
      this.flushPendingFrames();
    });

    socket.addEventListener("message", (event) => {
      try {
        const parsed = JSON.parse(event.data) as ServerEvent;
        if (parsed && typeof parsed === "object" && "type" in parsed) {
          this.onEvent(parsed);
        }
      } catch {
        // Ignore malformed frames.
      }
    });

    socket.addEventListener("close", (event) => {
      if (currentConnectionId !== this.connectionId) {
        return;
      }
      this.socket = null;
      this.onStatus("disconnected");
      if (this.isClosed) {
        return;
      }

      if (event.code === 1008) {
        void this.refreshTokenAndReconnect();
        return;
      }

      this.scheduleReconnect();
    });

    socket.addEventListener("error", () => {
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
        socket.close();
      }
    });
  }

  private async refreshTokenAndReconnect() {
    if (!this.options.refreshToken) {
      this.scheduleReconnect();
      return;
    }

    if (!this.refreshPromise) {
      this.refreshPromise = (async () => {
        try {
          const nextToken = await this.options.refreshToken?.();
          if (!nextToken) {
            this.isClosed = true;
            this.options.onAuthExpired?.();
            return false;
          }
          this.wsToken = nextToken;
          return true;
        } catch {
          return false;
        } finally {
          this.refreshPromise = null;
        }
      })();
    }

    const refreshed = await this.refreshPromise;
    if (this.isClosed) {
      return;
    }
    this.scheduleReconnect(refreshed ? 200 : undefined);
  }

  private flushPendingFrames() {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN || this.pendingFrames.length === 0) {
      return;
    }

    for (const frame of this.pendingFrames) {
      if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
        break;
      }
      this.socket.send(frame);
    }
    this.pendingFrames = [];
  }

  private scheduleReconnect(delayMs?: number) {
    if (this.isClosed || this.reconnectTimer) {
      return;
    }

    const timeout = delayMs ?? this.nextReconnectDelay();
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      void this.openSocket();
    }, timeout);
  }

  private nextReconnectDelay(): number {
    const exponential = Math.min(INITIAL_RECONNECT_MS * 2 ** this.reconnectAttempt, MAX_RECONNECT_MS);
    this.reconnectAttempt = Math.min(this.reconnectAttempt + 1, 12);
    const jitter = Math.floor(Math.random() * 300);
    return exponential + jitter;
  }
}

export function makeClientEvent(type: ClientEvent["type"], payload: unknown, timestamp = Date.now()): ClientEvent {
  return {
    v: 1,
    type,
    payload,
    messageId: crypto.randomUUID(),
    timestamp
  };
}
