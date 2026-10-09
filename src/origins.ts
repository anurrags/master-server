import type { NextFunction, Request, Response } from 'express'

/**
 * Which web pages may use this backend.
 *
 * The UI is served from a different origin (the portfolio on Vercel) than this
 * API (Render), so browsers enforce CORS on it. But CORS alone is not enough:
 *
 *   - it only governs whether a page may *read* a response, not whether the
 *     request happens — and a plain `EventSource` GET is a "simple" request
 *     with no preflight, so a foreign page could still join a drop room;
 *   - WebSocket handshakes are not subject to CORS at all.
 *
 * So the same rule is enforced explicitly on every HTTP request *and* on the
 * WebSocket upgrade. Requests with no Origin header (curl, Render's health
 * check) are allowed: they aren't browsers, and a non-browser client can forge
 * any Origin anyway, so blocking them would protect nothing.
 */

/** `null` means unconfigured — fall back to the local-development rule. */
export type AllowedOrigins = Set<string> | 'any' | null

/**
 * Parse `ALLOWED_ORIGINS`: a comma-separated list of exact origins, e.g.
 * `https://anurag.dev,https://www.anurag.dev`. `*` allows any origin.
 */
export function parseAllowedOrigins(raw: string | undefined): AllowedOrigins {
  const value = raw?.trim()
  if (!value) return null
  if (value === '*') return 'any'
  const entries = value
    .split(',')
    .map((entry) => normaliseOrigin(entry))
    .filter((entry): entry is string => entry !== null)
  return new Set(entries)
}

/** Lower-cased `scheme://host[:port]`, or null if it isn't an origin. */
export function normaliseOrigin(raw: string): string | null {
  try {
    const url = new URL(raw.trim())
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    return url.origin.toLowerCase()
  } catch {
    return null
  }
}

export function isAllowedOrigin(origin: string | undefined, allowed: AllowedOrigins): boolean {
  if (!origin) return true
  if (allowed === 'any') return true

  const normalised = normaliseOrigin(origin)
  if (!normalised) return false

  if (allowed) return allowed.has(normalised)

  // Unconfigured: local development only. A page on this machine or on a
  // private network may connect; any public site may not. This is a safe
  // default if ALLOWED_ORIGINS is forgotten in production — the deployed UI
  // simply won't work until it is set, rather than the backend being open.
  return isLocalHostname(new URL(normalised).hostname)
}

function isLocalHostname(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '')
  if (host === 'localhost' || host === '::1' || host.endsWith('.localhost')) return true
  const parts = host.split('.').map(Number)
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false
  const [a, b] = parts as [number, number, number, number]
  return a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31)
}

/**
 * CORS headers for allowed origins, and an outright 403 for disallowed ones —
 * rejecting rather than merely withholding headers, so the request has no side
 * effects either.
 */
export function originPolicy(allowed: AllowedOrigins) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const origin = req.get('origin')

    if (!isAllowedOrigin(origin, allowed)) {
      res.status(403).json({ error: 'Origin not allowed' })
      return
    }

    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin)
      res.setHeader('Vary', 'Origin')
    }

    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
      res.setHeader('Access-Control-Allow-Headers', 'content-type')
      res.setHeader('Access-Control-Max-Age', '600')
      res.sendStatus(204)
      return
    }

    next()
  }
}
