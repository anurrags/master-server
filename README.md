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

You normally don't run this by hand: `npm start` in `portfolio-main` starts it
in the background and serves it behind the portfolio's own port (3000), so the
whole site is one address. If it is already running on 1234, that copy is used.

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
| `DROP_HOSTED` | *(unset)* | `1` = deployed on a public host: `/drop` always uses internet mode and never offers the server's own addresses. Render's `RENDER=true` (set automatically) means the same. |
| `KEEP_ALIVE` | on | `0` turns off the self-ping that keeps the free plan awake. |
| `KEEP_ALIVE_URL` | `RENDER_EXTERNAL_URL` | Public URL to ping. Render sets `RENDER_EXTERNAL_URL` itself, so this is only for a custom domain. |
| `KEEP_ALIVE_INTERVAL_MIN` | `5` | Minutes between pings (1–14). |
| `TRUST_PROXY` | `1` | Reverse-proxy hops in front of the app, so client IPs (used for rate limiting and drop pairing) are read from `X-Forwarded-For`. Render's load balancer is one hop. |

Disallowed origins get `403` on REST, SSE and the WebSocket upgrade alike.

## Things to know

- **One instance only.** Documents, pairing codes and connected peers live in
  this process's memory. Two instances would split users into groups that can't
  see each other. Don't scale horizontally.
- **Everything is ephemeral.** A restart or redeploy wipes every editor document.
  A room is dropped once nobody has been connected to it for 30 minutes.
- **Free tier sleep is prevented.** Render stops a free service after 15 minutes
  without inbound traffic (cold start ~30–60 s, and every open document lost).
  On Render the backend requests its own public `/ping` every 5 minutes, which
  counts as inbound traffic, so it stays up. It can only keep an awake service
  awake: after a crash or redeploy, the first visit wakes it and pinging resumes.
  For belt and braces, point a free external monitor (UptimeRobot, cron-job.org)
  at `https://<service>.onrender.com/ping` every 5 minutes. An always-on free
  service uses ~744 of the plan's monthly instance hours.
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
