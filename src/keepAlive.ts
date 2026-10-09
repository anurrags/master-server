/**
 * Keep the service awake on Render's free plan.
 *
 * Render stops a free web service after 15 minutes without inbound traffic,
 * and the next visitor waits through a cold start — which also wipes every
 * editor document and pairing code, since they live in memory. Requesting our
 * own public URL every few minutes is inbound traffic as far as Render is
 * concerned (it leaves and re-enters through Render's edge), so the service
 * never goes idle.
 *
 * It can only keep an awake service awake: if the process is ever stopped
 * (a crash, a deploy, a platform restart), the first real visit wakes it and
 * the pinging resumes from there. An external pinger hitting /ping covers that
 * gap too, if wanted.
 *
 * Mind the free plan's monthly instance hours: one always-on service uses
 * about 744 of them.
 */

export const PING_PATH = '/ping'
/** Lets the /ping log tell our own keep-alive apart from external pingers. */
export const KEEP_ALIVE_USER_AGENT = 'portfolio-backend keep-alive'

/** `3725` → `1h 2m 5s`, for the ping log. */
export function formatUptime(totalSeconds: number): string {
  const days = Math.floor(totalSeconds / 86_400)
  const hours = Math.floor((totalSeconds % 86_400) / 3_600)
  const minutes = Math.floor((totalSeconds % 3_600) / 60)
  const seconds = totalSeconds % 60
  return [days && `${days}d`, (days || hours) && `${hours}h`, (days || hours || minutes) && `${minutes}m`, `${seconds}s`]
    .filter(Boolean)
    .join(' ')
}

export type KeepAliveConfig = { url: string; intervalMs: number } | null

/**
 * KEEP_ALIVE_URL wins; otherwise RENDER_EXTERNAL_URL, which Render sets on
 * every web service. Neither (local runs) → off. KEEP_ALIVE=0 turns it off.
 */
export function keepAliveConfig(env: NodeJS.ProcessEnv = process.env): KeepAliveConfig {
  if (env.KEEP_ALIVE === '0') return null
  const base = (env.KEEP_ALIVE_URL ?? env.RENDER_EXTERNAL_URL)?.trim().replace(/\/+$/, '')
  if (!base || !/^https?:\/\//.test(base)) return null
  const minutes = Number(env.KEEP_ALIVE_INTERVAL_MIN ?? 5)
  // Under 1 minute is pointless load; over 14 would let Render's 15-minute
  // idle timer win.
  const clamped = Number.isFinite(minutes) ? Math.min(Math.max(minutes, 1), 14) : 5
  return { url: `${base}${PING_PATH}`, intervalMs: clamped * 60_000 }
}

export function startKeepAlive(config: KeepAliveConfig = keepAliveConfig()): NodeJS.Timeout | null {
  if (!config) return null
  let failing = false
  const timer = setInterval(async () => {
    try {
      const response = await fetch(config.url, {
        headers: { 'User-Agent': KEEP_ALIVE_USER_AGENT },
        signal: AbortSignal.timeout(30_000),
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      if (failing) console.log('[keep-alive] ping succeeding again')
      failing = false
    } catch (error) {
      // Log the first failure of a run, not every five minutes.
      if (!failing) console.warn(`[keep-alive] ping to ${config.url} failed:`, (error as Error).message)
      failing = true
    }
  }, config.intervalMs)
  // Never the reason the process stays up.
  timer.unref()
  return timer
}
