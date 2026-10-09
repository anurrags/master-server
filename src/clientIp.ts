import { isHostedDeployment } from './drops.ts'

/**
 * The address of the person making the request, for rate limiting and for
 * telling a phone on mobile data from one on WiFi.
 *
 * Locally, Express's `req.ip` is right: at most one proxy (the portfolio's dev
 * server) sits in front, and TRUST_PROXY=1 accounts for it.
 *
 * Hosted on Render it is not: several internal proxies sit in front, so
 * `req.ip` is one of Render's own 10.x addresses — the same for every visitor,
 * which would put everyone in one rate-limit bucket. Render puts the real
 * client first in X-Forwarded-For, so that is used instead. A client can
 * prepend a fake entry; the cost is only that it can dodge its own rate limit,
 * and pairing still can't move a file off the WiFi.
 */

type RequestLike = {
  ip?: string
  headers: Record<string, string | string[] | undefined>
  socket: { remoteAddress?: string }
}

/** First address in an X-Forwarded-For header, if it has one. */
export function firstForwarded(header: string | string[] | undefined): string | null {
  const value = Array.isArray(header) ? header[0] : header
  const first = value?.split(',')[0]?.trim()
  return first ? first : null
}

export function clientIp(req: RequestLike, hosted: boolean = isHostedDeployment()): string {
  if (hosted) {
    const forwarded = firstForwarded(req.headers['x-forwarded-for'])
    if (forwarded) return forwarded
  }
  return req.ip ?? req.socket.remoteAddress ?? ''
}
