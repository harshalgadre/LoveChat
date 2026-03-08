# LoveChat v1

Private two-user messenger built as a monorepo:

- `apps/web`: Next.js web client + Capacitor Android wrapper
- `apps/server`: Fastify backend (WebAuthn, WebSocket, media APIs, LiveKit token API)
- `packages/shared`: shared schemas, event contracts, crypto helpers

## Implemented features

- Fixed users: `userA` and `userB`
- Passkey auth (WebAuthn register/login)
- Secure session cookie + short-lived WS token
- Realtime 1:1 WebSocket chat
- Encrypted message + media persistence in MongoDB
- Offline sync (`GET /messages?after=...` + `sync:request`/`sync:batch`)
- Encrypted media upload/download/ack + retention cleanup
- Voice notes (MediaRecorder -> encrypted media flow)
- LiveKit Cloud call token endpoint + call signaling events
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
  - `MONGODB_DB_NAME`
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
- Register passkeys once for `userA` and `userB`
- Login from each side and start chat

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
- `POST /keys/identity`
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
