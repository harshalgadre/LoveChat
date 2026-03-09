import { type RemoteParticipant, type RemoteTrack, type RemoteTrackPublication, Room, RoomEvent } from "livekit-client";

import { jsonRequest } from "./api";

export interface ActiveCall {
  room: Room;
  roomName: string;
  livekitUrl: string;
  meetUrl: string;
}

function buildMeetUrl(livekitUrl: string, token: string): string {
  const params = new URLSearchParams({
    tab: "custom",
    url: livekitUrl,
    liveKitUrl: livekitUrl,
    token
  });
  return `https://meet.livekit.io/?${params.toString()}`;
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
  } else {
    await room.localParticipant.setCameraEnabled(false);
  }

  return {
    room,
    roomName,
    livekitUrl: tokenPayload.livekitUrl,
    meetUrl: buildMeetUrl(tokenPayload.livekitUrl, tokenPayload.token)
  };
}

export function bindRemoteTrack(
  room: Room,
  onTrack: (trackId: string, kind: "audio" | "video", element: HTMLMediaElement) => void,
  onTrackRemoved?: (trackId: string, kind: "audio" | "video") => void
): () => void {
  const attachedElements = new Map<
    string,
    {
      kind: "audio" | "video";
      element: HTMLMediaElement;
      track: RemoteTrack;
    }
  >();

  const trackKey = (publication: RemoteTrackPublication, participant: RemoteParticipant, track: RemoteTrack): string =>
    publication.trackSid ?? `${participant.identity}-${publication.source}-${track.sid}`;

  const handleTrackSubscribed = (
    track: RemoteTrack,
    publication: RemoteTrackPublication,
    participant: RemoteParticipant
  ) => {
    if (track.kind !== "audio" && track.kind !== "video") {
      return;
    }

    const key = trackKey(publication, participant, track);
    if (attachedElements.has(key)) {
      return;
    }

    const element = track.attach() as HTMLMediaElement;
    element.autoplay = true;
    element.setAttribute("playsinline", "true");
    attachedElements.set(key, {
      kind: track.kind,
      element,
      track
    });
    onTrack(key, track.kind, element);
  };

  const handleTrackUnsubscribed = (
    track: RemoteTrack,
    publication: RemoteTrackPublication,
    participant: RemoteParticipant
  ) => {
    const key = trackKey(publication, participant, track);
    const existing = attachedElements.get(key);
    if (!existing) {
      return;
    }

    existing.track.detach(existing.element);
    existing.element.remove();
    attachedElements.delete(key);
    onTrackRemoved?.(key, existing.kind);
  };

  const attachExistingTracks = (participant: RemoteParticipant) => {
    for (const publication of participant.getTrackPublications().values()) {
      const remotePublication = publication as RemoteTrackPublication;
      if (remotePublication.track) {
        handleTrackSubscribed(remotePublication.track as RemoteTrack, remotePublication, participant);
      }
    }
  };

  room.on(RoomEvent.TrackSubscribed, handleTrackSubscribed);
  room.on(RoomEvent.TrackUnsubscribed, handleTrackUnsubscribed);

  for (const participant of room.remoteParticipants.values()) {
    attachExistingTracks(participant);
  }

  return () => {
    room.off(RoomEvent.TrackSubscribed, handleTrackSubscribed);
    room.off(RoomEvent.TrackUnsubscribed, handleTrackUnsubscribed);

    for (const [trackId, entry] of attachedElements.entries()) {
      entry.track.detach(entry.element);
      entry.element.remove();
      onTrackRemoved?.(trackId, entry.kind);
    }
    attachedElements.clear();
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
