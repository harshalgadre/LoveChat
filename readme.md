# LoveChat v1

Private messenger built as a monorepo:

- `apps/web`: Next.js web client + Capacitor Android wrapper
- `apps/server`: Fastify backend (WebAuthn, WebSocket, media APIs, LiveKit token API)
- `packages/shared`: shared schemas, event contracts, crypto helpers

## Implemented features

- Multi-user directory (up to 5 users)
- Register using `username + phone number`
- Passkey auth (WebAuthn register/login)
- Secure session cookie + short-lived WS token
- Realtime 1:1 WebSocket chat with selectable recipient
- Encrypted message + media persistence in MongoDB
- Offline sync (`GET /messages?after=...` + `sync:request`/`sync:batch`)
- Encrypted media upload/download/ack + retention cleanup
- Voice notes + video notes (MediaRecorder -> encrypted media flow)
- Inline media playback (audio/video/image) in chat without mandatory download
- LiveKit Cloud call token endpoint + call signaling events
- Improved call flow (ringing -> accept/decline -> join LiveKit room)
- Native/web local notifications for incoming messages/calls (best-effort while app process is alive)
- Account settings (`displayName`, `avatarUrl`) and per-chat nicknames
- Capacitor Android project scaffold and sync scripts

## Quick start

1. Install dependencies:

```bash
npm install
```

2. Configure env:

- `.env` already exists for local dev defaults.
- Set MongoDB values:
  - `MONGODB_URI`
  - `MONGODB_DB_NAME`
- Optional user cap:
  - `MAX_USERS` (default `5`)
- Update LiveKit values before call testing:
  - `LIVEKIT_URL`
  - `LIVEKIT_API_KEY`
  - `LIVEKIT_API_SECRET`

3. Run backend + web app:

```bash
npm run dev
```

4. Open app:

- Web: `http://localhost:3000/login`
- Register users (username + phone) and create passkeys
- Login and choose a contact from the chat header

## Scripts

```bash
npm run typecheck
npm test
npm run build
```

## Android (Capacitor)

Android platform is already added at `apps/web/android`.

Sync web assets into Android project:

```bash
npm run android:sync
```

Build APK (requires JDK + Android SDK):

```bash
npm run android:build
```

Run on device/emulator:

```bash
npm run android:run
```

If build fails with `JAVA_HOME is not set`, install JDK and set `JAVA_HOME`.

## API surface

- `POST /auth/challenge/register`
- `POST /auth/verify/register`
- `POST /auth/challenge/login`
- `POST /auth/verify/login`
- `GET /auth/me`
- `POST /auth/logout`
- `GET /users`
- `POST /keys/identity`
- `POST /profile`
- `GET /messages?after=...`
- `POST /upload-media`
- `GET /media/:id`
- `POST /media/:id/ack`
- `POST /calls/token`
- `WS /chat?token=...`

## Notes

- WebAuthn requires proper origin/rp settings for non-local deployments.
- For frontend and backend on different domains, use `SESSION_COOKIE_SAMESITE=none` with HTTPS.
- Server stores encrypted message payloads; plaintext is not persisted.
- Media payloads are stored in MongoDB and deleted after both users ACK or when retention expires.
- Uploads are limited to 12MB per file (MongoDB document size safety).
