# portfolio-backend

The backend for two pages that live in the portfolio site (`portfolio-main`):

- **`/editor`** — multi-person code editor. Real-time sync runs over a WebSocket
  at `/collab` (Yjs + Hocuspocus); rooms are created through `/api/rooms`.
- **`/drop`** — WiFi file sharing. This backend only does pairing and WebRTC
  signalling (`/api/drop`, Server-Sent Events). **File bytes never pass through
  it** — they go device to device over the local network.

The UI is not here. It is built and deployed with the portfolio; this project is
API-only.

## Run locally

```bash
npm ci
npm start          # http://localhost:1234
npm test           # unit tests
```

Node 22.12+ (TypeScript runs directly via Node's type stripping, no build step).

The portfolio UI, run locally, finds this backend on port 1234 of whatever host
the page was opened on — so `localhost:1234` from the laptop and
`192.168.x.x:1234` from a phone on the same WiFi, with no configuration.

## Deploy on Render

1. Push this folder to its own Git repository.
2. Render → **New → Blueprint** → pick the repo. `render.yaml` defines the service.
3. When prompted, set **`ALLOWED_ORIGINS`** to the portfolio's public URL(s),
   comma-separated, e.g. `https://anurag.dev,https://www.anurag.dev`.
4. Copy the service URL (e.g. `https://portfolio-backend.onrender.com`) into the
   portfolio's `VITE_API_URL` on Vercel and redeploy the portfolio.

Check it with `curl https://<service>.onrender.com/healthz` → `{"ok":true}`.

## Environment

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `1234` | Render sets this itself. |
| `ALLOWED_ORIGINS` | *(unset)* | Comma-separated origins allowed to call the API and open the WebSocket. Unset → only `localhost` and private-network pages (safe for local dev, closed in production). `*` → anyone. |
| `TRUST_PROXY` | `1` | Reverse-proxy hops in front of the app, so client IPs (used for rate limiting and drop pairing) are read from `X-Forwarded-For`. Render's load balancer is one hop. |

Disallowed origins get `403` on REST, SSE and the WebSocket upgrade alike.

## Things to know

- **One instance only.** Documents, pairing codes and connected peers live in
  this process's memory. Two instances would split users into groups that can't
  see each other. Don't scale horizontally.
- **Everything is ephemeral.** A restart or redeploy wipes every editor document.
  A room is dropped once nobody has been connected to it for 30 minutes.
- **Free tier sleeps.** After ~15 minutes idle Render stops the service; the next
  visitor waits ~30–60 s for a cold start, and any open documents are gone.
- **Drop on a hosted backend.** When the backend is on the public internet it
  can't see devices' private LAN addresses, so peers find each other through the
  browser's `.local` mDNS names. That works on most home WiFi; networks that
  block multicast (some office/guest WiFi) won't connect. Running the backend on
  the same LAN avoids this.

## Layout

```
src/
  index.ts       HTTP server, origin policy, WebSocket upgrade
  origins.ts     ALLOWED_ORIGINS parsing + CORS/origin enforcement
  api.ts         /api/rooms
  collab.ts      Hocuspocus (editor sync)
  rooms.ts       in-memory room registry + sweeper
  auth.ts        optional room passwords (scrypt)
  dropSignal.ts  /api/drop pairing + signalling (SSE)
  drops.ts       LAN address discovery
```
