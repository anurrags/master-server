import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { isAllowedOrigin, normaliseOrigin, parseAllowedOrigins } from './origins.ts'

describe('origins', () => {
  describe('parseAllowedOrigins', () => {
    it('is unconfigured when empty', () => {
      assert.equal(parseAllowedOrigins(undefined), null)
      assert.equal(parseAllowedOrigins(''), null)
      assert.equal(parseAllowedOrigins('   '), null)
    })

    it('parses a comma-separated list, normalising each entry', () => {
      const allowed = parseAllowedOrigins(' https://Anurag.dev/ , https://www.anurag.dev ')
      assert.ok(allowed instanceof Set)
      assert.deepEqual([...allowed].sort(), ['https://anurag.dev', 'https://www.anurag.dev'])
    })

    it('treats * as allow-any', () => {
      assert.equal(parseAllowedOrigins('*'), 'any')
    })

    it('drops entries that are not origins', () => {
      const allowed = parseAllowedOrigins('https://ok.dev,not a url,ftp://files.dev')
      assert.deepEqual([...(allowed as Set<string>)], ['https://ok.dev'])
    })
  })

  describe('normaliseOrigin', () => {
    it('reduces a URL to scheme, host and port, lower-cased', () => {
      assert.equal(normaliseOrigin('HTTPS://Example.COM/path?q=1'), 'https://example.com')
      assert.equal(normaliseOrigin('http://localhost:8080/'), 'http://localhost:8080')
    })
  })

  describe('isAllowedOrigin — configured', () => {
    const allowed = parseAllowedOrigins('https://anurag.dev')

    it('allows an exact match', () => {
      assert.equal(isAllowedOrigin('https://anurag.dev', allowed), true)
    })

    it('rejects anything else, including near misses', () => {
      assert.equal(isAllowedOrigin('https://evil.dev', allowed), false)
      // A different scheme or port is a different origin.
      assert.equal(isAllowedOrigin('http://anurag.dev', allowed), false)
      assert.equal(isAllowedOrigin('https://anurag.dev:8443', allowed), false)
      // A lookalike subdomain must not pass a naive suffix check.
      assert.equal(isAllowedOrigin('https://anurag.dev.evil.dev', allowed), false)
      assert.equal(isAllowedOrigin('https://notanurag.dev', allowed), false)
    })

    it('rejects local origins once a list is configured', () => {
      // Production must not stay open to localhost just because dev uses it.
      assert.equal(isAllowedOrigin('http://localhost:5173', allowed), false)
    })
  })

  describe('isAllowedOrigin — unconfigured (local development)', () => {
    it('allows this machine and private networks', () => {
      for (const origin of [
        'http://localhost:8080',
        'http://127.0.0.1:5173',
        'http://192.168.68.101:8080',
        'http://10.0.0.5:3000',
        'http://172.20.1.9:8080',
        'http://[::1]:8080',
      ]) {
        assert.equal(isAllowedOrigin(origin, null), true, origin)
      }
    })

    it('refuses any public site — a safe default if the variable is forgotten', () => {
      for (const origin of [
        'https://anurag.dev',
        'https://evil.dev',
        'http://172.32.0.1',
        'http://100.64.0.1',
        'http://8.8.8.8',
      ]) {
        assert.equal(isAllowedOrigin(origin, null), false, origin)
      }
    })
  })

  describe('isAllowedOrigin — no Origin header', () => {
    it('is allowed: not a browser, and the header could be forged anyway', () => {
      assert.equal(isAllowedOrigin(undefined, parseAllowedOrigins('https://anurag.dev')), true)
      assert.equal(isAllowedOrigin(undefined, null), true)
    })
  })

  it('rejects a malformed Origin', () => {
    assert.equal(isAllowedOrigin('null', null), false)
    assert.equal(isAllowedOrigin('not-a-url', parseAllowedOrigins('*')), true)
    assert.equal(isAllowedOrigin('not-a-url', parseAllowedOrigins('https://a.dev')), false)
  })
})
