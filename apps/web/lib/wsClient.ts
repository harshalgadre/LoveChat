import type { ClientEvent, ServerEvent } from "@love-chat/shared";

import { wsServerUrl } from "./config";

export class ChatSocket {
  private socket: WebSocket | null = null;

  private reconnectTimer: number | null = null;

  private isClosed = false;

  constructor(
    private readonly wsToken: string,
    private readonly onEvent: (event: ServerEvent) => void,
    private readonly onStatus: (status: "connecting" | "connected" | "disconnected") => void
  ) {}

  connect() {
    this.isClosed = false;
    this.onStatus("connecting");
    this.socket = new WebSocket(wsServerUrl(this.wsToken));

    this.socket.addEventListener("open", () => {
      this.onStatus("connected");
    });

    this.socket.addEventListener("message", (event) => {
      try {
        const parsed = JSON.parse(event.data) as ServerEvent;
        if (parsed && typeof parsed === "object" && "type" in parsed) {
          this.onEvent(parsed);
        }
      } catch {
        // Ignore malformed frames.
      }
    });

    this.socket.addEventListener("close", () => {
      this.onStatus("disconnected");
      if (!this.isClosed) {
        this.scheduleReconnect();
      }
    });

    this.socket.addEventListener("error", () => {
      this.socket?.close();
    });
  }

  close() {
    this.isClosed = true;
    if (this.reconnectTimer) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    this.socket?.close();
    this.socket = null;
  }

  send(event: ClientEvent): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return;
    }

    this.socket.send(JSON.stringify(event));
  }

  private scheduleReconnect() {
    if (this.reconnectTimer) {
      return;
    }

    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, 1500);
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
