import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { formatUptime, keepAliveConfig } from './keepAlive.ts'

describe('keepAliveConfig', () => {
  it('pings Render’s own public URL every 5 minutes by default', () => {
    assert.deepEqual(keepAliveConfig({ RENDER_EXTERNAL_URL: 'https://portfolio-backend.onrender.com' }), {
      url: 'https://portfolio-backend.onrender.com/ping',
      intervalMs: 5 * 60_000,
    })
  })

  it('is off when there is no public URL (local runs)', () => {
    assert.equal(keepAliveConfig({}), null)
  })

  it('can be turned off', () => {
    assert.equal(keepAliveConfig({ RENDER_EXTERNAL_URL: 'https://x.onrender.com', KEEP_ALIVE: '0' }), null)
  })

  it('prefers KEEP_ALIVE_URL and strips a trailing slash', () => {
    assert.equal(
      keepAliveConfig({ RENDER_EXTERNAL_URL: 'https://x.onrender.com', KEEP_ALIVE_URL: 'https://api.anurags.in/' })?.url,
      'https://api.anurags.in/ping',
    )
  })

  it('keeps the interval under Render’s 15-minute idle limit', () => {
    const at = (minutes: string) =>
      keepAliveConfig({ RENDER_EXTERNAL_URL: 'https://x.onrender.com', KEEP_ALIVE_INTERVAL_MIN: minutes })?.intervalMs
    assert.equal(at('30'), 14 * 60_000)
    assert.equal(at('0'), 1 * 60_000)
    assert.equal(at('abc'), 5 * 60_000)
  })

  it('ignores a URL without a scheme', () => {
    assert.equal(keepAliveConfig({ KEEP_ALIVE_URL: 'portfolio-backend.onrender.com' }), null)
  })
})

describe('formatUptime', () => {
  it('reads naturally at every scale', () => {
    assert.equal(formatUptime(42), '42s')
    assert.equal(formatUptime(300), '5m 0s')
    assert.equal(formatUptime(3725), '1h 2m 5s')
    assert.equal(formatUptime(90_061), '1d 1h 1m 1s')
  })
})
