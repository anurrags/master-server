import { createServer } from 'node:http'

import express from 'express'
import crossws from 'crossws/adapters/node'
import type { Hocuspocus, WebSocketLike } from '@hocuspocus/server'

import { api } from './api.ts'
import { connectionCount, hocuspocus } from './collab.ts'
import { closeDropStreams, dropSignal, startCodeSweeper } from './dropSignal.ts'
import { lanAddresses } from './drops.ts'
import { isAllowedOrigin, originPolicy, parseAllowedOrigins } from './origins.ts'
import { startSweeper } from './rooms.ts'

/**
 * Backend for the portfolio's two services — the collaborative code editor and
 * the WiFi file drop. API only: the UI is a static build deployed with the
 * portfolio, on a different origin, and talks to this over CORS.
 */

const PORT = Number(process.env.PORT ?? 1234)
const HOST = process.env.HOST ?? '0.0.0.0'
/** WebSocket endpoint for the editor's real-time sync. */
const COLLAB_PATH = '/collab'

/**
 * Hops of reverse proxy in front of us. Render's load balancer is one; this is
 * what makes `req.ip` the real client address rather than the proxy's, which
 * the rate limiters and the file drop's network detection depend on.
 */
const TRUST_PROXY = Number(process.env.TRUST_PROXY ?? 1)

const allowedOrigins = parseAllowedOrigins(process.env.ALLOWED_ORIGINS)

// ---------------------------------------------------------------- HTTP

const app = express()
app.disable('x-powered-by')
app.set('trust proxy', TRUST_PROXY)

app.get('/healthz', (_req, res) => {
  res.json({ ok: true })
})

// Before everything else, so a disallowed origin is turned away before any
// handler runs — including the SSE inbox, which has side effects on GET.
app.use(originPolicy(allowedOrigins))

// Mounted ahead of the app-wide JSON parser so its own, larger body limit
// applies to session descriptions. Carries the WebRTC handshake only — file
// contents go straight between devices and never reach this process.
app.use('/api/drop', dropSignal)

app.use(express.json({ limit: '16kb' }))
app.use('/api', api)

app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' })
})

const server = createServer(app)

// ---------------------------------------------------------- WebSocket

type ClientConnection = ReturnType<Hocuspocus['handleConnection']>
const connections = new WeakMap<object, ClientConnection>()

const ws = crossws({
  hooks: {
    open(peer) {
      connections.set(
        peer,
        hocuspocus.handleConnection(peer.websocket as WebSocketLike, peer.request),
      )
    },
    message(peer, message) {
      connections.get(peer)?.handleMessage(message.uint8Array())
    },
    close(peer, details) {
      connections.get(peer)?.handleClose({
        code: details.code,
        reason: details.reason,
      } as CloseEvent)
      connections.delete(peer)
    },
    error(peer, error) {
      console.error('[ws] peer error', error)
      connections.get(peer)?.handleClose({ code: 1011, reason: 'error' } as CloseEvent)
      connections.delete(peer)
    },
  },
})

server.on('upgrade', (req, socket, head) => {
  const pathname = new URL(req.url ?? '/', 'http://localhost').pathname
  if (pathname !== COLLAB_PATH) {
    socket.destroy()
    return
  }
  // WebSocket handshakes aren't subject to CORS, so the origin check has to be
  // made here explicitly or any web page could open a sync session.
  if (!isAllowedOrigin(req.headers.origin, allowedOrigins)) {
    socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
    socket.destroy()
    return
  }
  ws.handleUpgrade(req, socket, head)
})

// ------------------------------------------------------------- start

startSweeper(connectionCount)
startCodeSweeper()

server.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`\n  Port ${PORT} is already in use — is another copy of this server running?`)
    console.error(`  Stop it, or pick another port: PORT=1235 npm start\n`)
    process.exit(1)
  }
  throw error
})

server.listen(PORT, HOST, () => {
  const [lan] = lanAddresses()
  console.log('')
  console.log(`  backend     http://localhost:${PORT}`)
  if (lan) console.log(`  on the LAN  http://${lan}:${PORT}`)
  console.log(`  websocket   ${COLLAB_PATH}`)
  console.log(
    `  origins     ${
      allowedOrigins === null
        ? 'localhost and private-network pages only (ALLOWED_ORIGINS not set)'
        : allowedOrigins === 'any'
          ? 'ANY (ALLOWED_ORIGINS=*)'
          : [...allowedOrigins].join(', ')
    }`,
  )
  console.log('')
})

let shuttingDown = false
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    if (shuttingDown) return
    shuttingDown = true
    console.log(`\n  ${signal} — shutting down`)
    hocuspocus.closeConnections()
    closeDropStreams()
    server.close(() => process.exit(0))
    // Documents are ephemeral, so there is nothing to flush; don't hang on
    // sockets that refuse to close.
    setTimeout(() => process.exit(0), 3000).unref()
  })
}
