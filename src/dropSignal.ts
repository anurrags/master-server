import express, { Router, type NextFunction, type Request, type Response } from 'express'

import {
  formatCode,
  iceServersFor,
  shouldAdvertiseLan,
  isCarrierNat,
  isPairingCode,
  lanAddresses,
  modeFor,
  newPairingCode,
  normaliseIp,
  rewriteMdnsCandidates,
  sanitiseName,
  type DropMode,
} from './drops.ts'
import { clientIp } from './clientIp.ts'

/**
 * Signalling only.
 *
 * This relays the handshake two browsers need in order to find each other —
 * session descriptions and ICE candidates, a few kilobytes — and nothing else.
 * File contents never reach this process; once connected, peers talk directly
 * over a WebRTC data channel.
 *
 * Devices find each other with a short pairing code, so you only ever see the
 * device you deliberately paired with.
 */

type Peer = {
  id: string
  /** Stable per browser profile, so tabs of one browser can be recognised. */
  deviceId: string
  name: string
  kind: string
  /** Private address, when visible. Null in a hosted deployment. */
  privateIp: string | null
  stream: Response
  joinedAt: number
}

type Room = {
  code: string
  peers: Map<string, Peer>
  createdAt: number
  lastActiveAt: number
}

const rooms = new Map<string, Room>()

/** A code with nobody on it is dropped after this long. */
const ROOM_IDLE_MS = 30 * 60 * 1000
const SWEEP_INTERVAL_MS = 60 * 1000

// Six digits is only a million possibilities, so cap how fast anyone can work
// through them. A transfer still requires being on the same WiFi, but a guessed
// code would otherwise expose a device name.
const RATE_WINDOW_MS = 10 * 60 * 1000
const MAX_CREATES = 30
const MAX_FAILED_JOINS = 40
const buckets = new Map<string, { creates: number; failures: number; resetAt: number }>()

function bucketFor(ip: string) {
  const now = Date.now()
  const existing = buckets.get(ip)
  if (existing && existing.resetAt > now) return existing
  if (buckets.size > 5_000) {
    for (const [key, value] of buckets) if (value.resetAt <= now) buckets.delete(key)
  }
  const fresh = { creates: 0, failures: 0, resetAt: now + RATE_WINDOW_MS }
  buckets.set(ip, fresh)
  return fresh
}

type Context = {
  privateIp: string | null
  rawIp: string
  mode: DropMode
  cellular: boolean
}

function context(req: Request): Context {
  const rawIp = clientIp(req)
  return {
    privateIp: normaliseIp(rawIp),
    rawIp,
    mode: modeFor(rawIp),
    cellular: isCarrierNat(rawIp),
  }
}

/** A cellular device can never complete a transfer; say so up front. */
function rejectCellular(req: Request, res: Response, next: NextFunction): void {
  if (context(req).cellular) {
    res.status(403).json({
      error: 'This looks like a mobile connection. Join a WiFi network to use the drop.',
      refusal: 'cellular',
    })
    return
  }
  next()
}

export const dropSignal = Router()

// Session descriptions run to a few kilobytes, past the app-wide 16kb cap.
dropSignal.use(express.json({ limit: '256kb' }))
dropSignal.use(rejectCellular)

dropSignal.get('/session', (req, res) => {
  const { privateIp, rawIp, mode } = context(req)
  res.json({
    ok: true,
    mode,
    refusal: null,
    iceServers: iceServersFor(mode),
    // Bare addresses — the UI is on its own port, so it builds the URL. Sent for
    // loopback too: that is exactly when the page is on localhost and needs a
    // reachable address to put in the QR instead.
    lanAddresses: shouldAdvertiseLan(mode) ? lanAddresses() : [],
    yourIp: privateIp,
    yourRawIp: shouldAdvertiseLan(mode) ? rawIp : null,
  })
})

/** Mint a code for this device to share. */
dropSignal.post('/rooms', (req, res) => {
  const bucket = bucketFor(context(req).rawIp)
  if (bucket.creates >= MAX_CREATES) {
    res.status(429).json({ error: 'Too many codes created. Try again later.' })
    return
  }
  bucket.creates += 1

  const code = newPairingCode((candidate) => rooms.has(candidate))
  if (!code) {
    res.status(503).json({ error: 'Could not allocate a code. Try again.' })
    return
  }

  const now = Date.now()
  rooms.set(code, { code, peers: new Map(), createdAt: now, lastActiveAt: now })
  res.status(201).json({ code, pretty: formatCode(code) })
})

/** Does this code exist? Lets a joining device fail fast and clearly. */
dropSignal.get('/rooms/:code', (req, res) => {
  const code = req.params.code
  if (!isPairingCode(code) || !rooms.has(code)) {
    bucketFor(context(req).rawIp).failures += 1
    res.status(404).json({ exists: false })
    return
  }
  res.json({ exists: true, pretty: formatCode(code) })
})

/**
 * The peer's inbox. Server-sent events rather than a WebSocket: the stream only
 * flows one way, `EventSource` reconnects itself when a phone wakes, and it
 * needs no secure context — which matters in LAN mode, served over plain HTTP.
 */
dropSignal.get('/signal', (req, res) => {
  const id = String(req.query.peer ?? '').slice(0, 40)
  const deviceId = String(req.query.device ?? '').slice(0, 40)
  const code = String(req.query.code ?? '')
  const { privateIp, rawIp, mode } = context(req)

  if (!/^[A-Za-z0-9_-]{8,40}$/.test(id) || !/^[A-Za-z0-9_-]{8,40}$/.test(deviceId)) {
    res.status(400).json({ error: 'Bad peer id' })
    return
  }

  const bucket = bucketFor(rawIp)
  if (bucket.failures >= MAX_FAILED_JOINS) {
    res.status(429).json({ error: 'Too many attempts. Try again later.' })
    return
  }

  const room = isPairingCode(code) ? rooms.get(code) : undefined
  if (!room) {
    bucket.failures += 1
    res.status(404).json({ error: 'That code is not active.' })
    return
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  })

  const name = sanitiseName(String(req.query.name ?? 'device'))
  const kind = sanitiseName(String(req.query.kind ?? '')).slice(0, 20)

  // A reconnecting EventSource reuses its peer id, so replace any stale entry.
  room.peers.get(id)?.stream.end()
  room.peers.set(id, { id, deviceId, name, kind, privateIp, stream: res, joinedAt: Date.now() })
  room.lastActiveAt = Date.now()
  console.log(`[drop] ${name} joined ${formatCode(code)} (${mode}) from ${rawIp}`)

  send(res, { type: 'welcome', self: id, mode, code, yourIp: privateIp, yourRawIp: rawIp })
  broadcastRoster(code)

  const heartbeat = setInterval(() => res.write(': ping\n\n'), 25_000)
  heartbeat.unref()

  req.on('close', () => {
    clearInterval(heartbeat)
    if (room.peers.get(id)?.stream === res) room.peers.delete(id)
    room.lastActiveAt = Date.now()
    broadcastRoster(code)
  })
})

/**
 * Relay one handshake message to a peer sharing the same code.
 *
 * In LAN mode, candidates are rewritten on the way through using the address
 * the sender's own connection came from — see `rewriteMdnsCandidates`. Hosted,
 * that is skipped: the only address visible is the household's public one,
 * which cannot reach a device inside the LAN. There, peers must resolve each
 * other's mDNS names themselves — there is no STUN fallback, by design.
 */
dropSignal.post('/signal', (req, res) => {
  const { privateIp } = context(req)
  const body = req.body as { code?: unknown; from?: unknown; to?: unknown; payload?: unknown }

  const room = isPairingCode(body.code) ? rooms.get(body.code) : undefined
  if (!room) {
    res.status(404).json({ error: 'That code is not active.' })
    return
  }

  const from = typeof body.from === 'string' ? body.from : ''
  const to = typeof body.to === 'string' ? body.to : ''

  // Both peers must hold the same code — this is what stops anyone else
  // signalling into your pairing.
  const sender = room.peers.get(from)
  const target = room.peers.get(to)
  if (!sender || !target) {
    res.status(409).json({ error: 'That device is no longer connected.' })
    return
  }

  const payload = body.payload as { kind?: string; sdp?: string; candidate?: string } | undefined
  if (!payload || typeof payload.kind !== 'string') {
    res.status(400).json({ error: 'Malformed signal' })
    return
  }

  const senderIp = sender.privateIp ?? privateIp
  const relayed: Record<string, unknown> = { ...payload }
  if (typeof payload.sdp === 'string') {
    relayed.sdp = rewriteMdnsCandidates(payload.sdp, senderIp)
  }
  if (typeof payload.candidate === 'string') {
    relayed.candidate = rewriteMdnsCandidates(payload.candidate, senderIp)
  }

  room.lastActiveAt = Date.now()
  send(target.stream, { type: 'signal', from, name: sender.name, payload: relayed })
  res.json({ delivered: true })
})

// -------------------------------------------------------------- helpers

/**
 * Rosters carry no IP addresses — `deviceId` does the job instead. Tabs of one
 * browser share it, so the UI can label them "this browser" without publishing
 * anyone's address.
 */
function roster(room: Room) {
  return [...room.peers.values()]
    .sort((a, b) => a.joinedAt - b.joinedAt)
    .map((peer) => ({ id: peer.id, deviceId: peer.deviceId, name: peer.name, kind: peer.kind }))
}

function send(res: Response, data: unknown): void {
  res.write(`data: ${JSON.stringify(data)}\n\n`)
}

function broadcastRoster(code: string): void {
  const room = rooms.get(code)
  if (!room) return
  const message = { type: 'roster', peers: roster(room) }
  for (const peer of room.peers.values()) {
    try {
      send(peer.stream, message)
    } catch {
      room.peers.delete(peer.id)
    }
  }
}

/** Retire codes nobody is using, so the space stays available. */
export function startCodeSweeper(): NodeJS.Timeout {
  const timer = setInterval(() => {
    const now = Date.now()
    for (const [code, room] of rooms) {
      if (room.peers.size > 0) {
        room.lastActiveAt = now
        continue
      }
      if (now - room.lastActiveAt > ROOM_IDLE_MS) {
        rooms.delete(code)
        console.log(`[drop] code ${formatCode(code)} expired`)
      }
    }
  }, SWEEP_INTERVAL_MS)
  timer.unref()
  return timer
}

/** Close every stream so the process can exit promptly. */
export function closeDropStreams(): void {
  for (const room of rooms.values()) {
    for (const peer of room.peers.values()) peer.stream.end()
  }
  rooms.clear()
}
