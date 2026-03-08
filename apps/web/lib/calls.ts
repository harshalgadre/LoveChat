import { Room, RoomEvent } from "livekit-client";

import { jsonRequest } from "./api";

export interface ActiveCall {
  room: Room;
  roomName: string;
}

export async function createLiveKitConnection(
  roomName: string,
  callType: "audio" | "video"
): Promise<ActiveCall> {
  const tokenPayload = await jsonRequest<{
    token: string;
    livekitUrl: string;
    roomName: string;
  }>("/calls/token", {
    method: "POST",
    body: {
      roomName,
      callType
    }
  });

  const room = new Room();
  await room.connect(tokenPayload.livekitUrl, tokenPayload.token);
  await room.localParticipant.setMicrophoneEnabled(true);
  if (callType === "video") {
    await room.localParticipant.setCameraEnabled(true);
  }

  return {
    room,
    roomName
  };
}

export function bindRemoteTrack(
  room: Room,
  onTrack: (element: HTMLMediaElement) => void
): () => void {
  const handler = (_track: any, _publication: any, participant: any) => {
    const tracks = participant.getTrackPublications();
    for (const pub of tracks) {
      if (pub.track) {
        const element = pub.track.attach() as HTMLMediaElement;
        onTrack(element);
      }
    }
  };

  room.on(RoomEvent.TrackSubscribed, handler);
  return () => {
    room.off(RoomEvent.TrackSubscribed, handler);
  };
}

export async function endLiveKitConnection(call: ActiveCall | null): Promise<void> {
  if (!call) {
    return;
  }

  await call.room.localParticipant.setCameraEnabled(false);
  await call.room.localParticipant.setMicrophoneEnabled(false);
  call.room.disconnect();
}