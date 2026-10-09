import { Router, type NextFunction, type Request, type Response } from 'express'
import { hashPassword } from './auth.ts'
import { createRoom, getRoom, roomCount } from './rooms.ts'
import { clientIp } from './clientIp.ts'

/**
 * The language is an opaque tag as far as the server is concerned — the client
 * owns the language registry. Validating the shape (rather than the value)
 * keeps the two from drifting out of sync.
 */
const LANGUAGE_PATTERN = /^[a-z0-9+#._-]{1,32}$/

const MAX_PASSWORD_LENGTH = 200

// Room creation is the only unauthenticated write, so it is the only thing
// that can flood the in-memory registry.
const RATE_WINDOW_MS = 60 * 60 * 1000
const RATE_MAX_ROOMS = 40
const buckets = new Map<string, { count: number; resetAt: number }>()

function rateLimitRoomCreation(req: Request, res: Response, next: NextFunction): void {
  const now = Date.now()
  const key = clientIp(req) || 'unknown'

  // Opportunistically drop expired buckets so the Map doesn't grow unbounded.
  if (buckets.size > 10_000) {
    for (const [ip, bucket] of buckets) if (bucket.resetAt <= now) buckets.delete(ip)
  }

  const bucket = buckets.get(key)
  if (!bucket || bucket.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + RATE_WINDOW_MS })
    next()
    return
  }

  if (bucket.count >= RATE_MAX_ROOMS) {
    res.status(429).json({
      error: 'Too many documents created. Try again later.',
      retryAfterMs: bucket.resetAt - now,
    })
    return
  }

  bucket.count += 1
  next()
}

export const api = Router()

api.post('/rooms', rateLimitRoomCreation, async (req, res) => {
  const body = (req.body ?? {}) as { language?: unknown; password?: unknown }

  const language =
    typeof body.language === 'string' && LANGUAGE_PATTERN.test(body.language)
      ? body.language
      : 'plaintext'

  let passwordHash: string | undefined
  if (typeof body.password === 'string' && body.password.length > 0) {
    if (body.password.length > MAX_PASSWORD_LENGTH) {
      res.status(400).json({ error: 'Password is too long.' })
      return
    }
    passwordHash = await hashPassword(body.password)
  }

  const room = createRoom({ language, passwordHash })

  res.status(201).json({
    roomId: room.id,
    language: room.language,
    requiresPassword: Boolean(room.passwordHash),
  })
})

api.get('/rooms/:roomId', (req, res) => {
  const room = getRoom(req.params.roomId)
  if (!room) {
    res.status(404).json({ exists: false })
    return
  }
  // Deliberately no passwordHash.
  res.json({
    exists: true,
    requiresPassword: Boolean(room.passwordHash),
    language: room.language,
  })
})

api.get('/stats', (_req, res) => {
  res.json({ rooms: roomCount(), uptimeSeconds: Math.round(process.uptime()) })
})
