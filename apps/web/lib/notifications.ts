import { Capacitor } from "@capacitor/core";

type NotificationKind = "message" | "call";

export interface NotificationActionPayload {
  kind: NotificationKind;
  from: string;
  callType?: "audio" | "video";
  roomName?: string;
}

let initialized = false;
let nextNotificationId = 1000;
const callNotificationIds = new Map<string, number>();

function allocNotificationId(): number {
  nextNotificationId += 1;
  return nextNotificationId;
}

function canUseWebNotifications(): boolean {
  return typeof window !== "undefined" && "Notification" in window;
}

function shouldSuppressForegroundNotification(): boolean {
  if (typeof document === "undefined") {
    return false;
  }
  return document.visibilityState === "visible" && document.hasFocus();
}

async function requestWebNotificationPermission(): Promise<void> {
  if (!canUseWebNotifications()) {
    return;
  }
  if (Notification.permission === "default") {
    await Notification.requestPermission();
  }
}

async function showWebNotification(
  title: string,
  body: string,
  tag: string,
  payload: NotificationActionPayload
): Promise<void> {
  if (!canUseWebNotifications()) {
    return;
  }
  if (Notification.permission !== "granted") {
    return;
  }

  const notification = new Notification(title, {
    body,
    tag,
    data: payload
  });

  notification.onclick = () => {
    window.focus();
  };
}

async function requestNativeNotificationPermission(): Promise<void> {
  const { LocalNotifications } = await import("@capacitor/local-notifications");
  const current = await LocalNotifications.checkPermissions();
  if (current.display !== "granted") {
    await LocalNotifications.requestPermissions();
  }
}

export async function initializeNotifications(
  onAction?: (payload: NotificationActionPayload, actionId: string) => void
): Promise<void> {
  if (initialized) {
    return;
  }

  await requestWebNotificationPermission();

  if (Capacitor.isNativePlatform()) {
    const { LocalNotifications } = await import("@capacitor/local-notifications");
    await requestNativeNotificationPermission();

    await LocalNotifications.registerActionTypes({
      types: [
        {
          id: "incoming-call",
          actions: [
            { id: "accept", title: "Accept" },
            { id: "decline", title: "Decline" }
          ]
        }
      ]
    });

    if (onAction) {
      LocalNotifications.addListener("localNotificationActionPerformed", (event) => {
        const payload = (event.notification.extra ?? {}) as NotificationActionPayload;
        onAction(payload, event.actionId ?? "tap");
      });
    }
  }

  initialized = true;
}

export async function cancelCallNotification(roomName: string): Promise<void> {
  if (!Capacitor.isNativePlatform()) {
    return;
  }
  const id = callNotificationIds.get(roomName);
  if (!id) {
    return;
  }

  const { LocalNotifications } = await import("@capacitor/local-notifications");
  await LocalNotifications.cancel({
    notifications: [{ id }]
  });
  callNotificationIds.delete(roomName);
}

export async function notifyIncomingMessage(from: string, textPreview: string): Promise<void> {
  if (shouldSuppressForegroundNotification()) {
    return;
  }

  const payload: NotificationActionPayload = {
    kind: "message",
    from
  };

  if (!Capacitor.isNativePlatform()) {
    await showWebNotification("New Message", `${from}: ${textPreview}`, `msg:${from}`, payload);
    return;
  }

  const { LocalNotifications } = await import("@capacitor/local-notifications");
  const id = allocNotificationId();
  await LocalNotifications.schedule({
    notifications: [
      {
        id,
        title: "New Message",
        body: `${from}: ${textPreview}`,
        smallIcon: "ic_launcher_foreground",
        extra: payload,
        schedule: { at: new Date(Date.now() + 100) }
      }
    ]
  });
}

export async function notifyIncomingCall(input: {
  from: string;
  callType: "audio" | "video";
  roomName: string;
}): Promise<void> {
  if (shouldSuppressForegroundNotification()) {
    return;
  }

  const payload: NotificationActionPayload = {
    kind: "call",
    from: input.from,
    callType: input.callType,
    roomName: input.roomName
  };

  if (!Capacitor.isNativePlatform()) {
    await showWebNotification(
      "Incoming Call",
      `${input.from} is calling (${input.callType})`,
      `call:${input.roomName}`,
      payload
    );
    return;
  }

  const { LocalNotifications } = await import("@capacitor/local-notifications");
  const id = allocNotificationId();
  callNotificationIds.set(input.roomName, id);

  await LocalNotifications.schedule({
    notifications: [
      {
        id,
        title: "Incoming Call",
        body: `${input.from} is calling (${input.callType})`,
        actionTypeId: "incoming-call",
        ongoing: true,
        smallIcon: "ic_launcher_foreground",
        extra: payload,
        schedule: { at: new Date(Date.now() + 100) }
      }
    ]
  });
}
