import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  CODE_LENGTH,
  isLoopback,
  shouldAdvertiseLan,
  formatCode,
  iceServersFor,
  isCarrierNat,
  isPairingCode,
  isHostedDeployment,
  modeFor,
  newPairingCode,
  normaliseIp,
  pickLanAddresses,
  rewriteMdnsCandidates,
  sanitiseName,
} from './drops.ts'

const MDNS = 'a1b2c3d4-1111-2222-3333-444455556666.local'

describe('drops', () => {
  describe('rewriteMdnsCandidates', () => {
    it('swaps an obfuscated host candidate for the observed LAN address', () => {
      const candidate = `candidate:576629615 1 udp 2113937151 ${MDNS} 64266 typ host generation 0 ufrag XriM network-cost 999`
      const rewritten = rewriteMdnsCandidates(candidate, '192.168.68.104')

      assert.ok(rewritten.includes('192.168.68.104 64266 typ host'))
      assert.ok(!rewritten.includes('.local'))
      // Everything else must survive untouched, or the candidate stops parsing.
      assert.equal(rewritten.replace('192.168.68.104', MDNS), candidate)
    })

    it('rewrites every occurrence inside a full session description', () => {
      const sdp = [
        'v=0',
        `a=candidate:1 1 udp 2113937151 ${MDNS} 50000 typ host`,
        `a=candidate:2 1 udp 2113937151 ${MDNS} 50001 typ host`,
        'a=end-of-candidates',
      ].join('\r\n')

      const rewritten = rewriteMdnsCandidates(sdp, '10.0.0.9')
      assert.equal(rewritten.match(/10\.0\.0\.9/g)?.length, 2)
      assert.ok(!rewritten.includes('.local'))
    })

    it('leaves candidates alone when no address was observed', () => {
      const candidate = `candidate:1 1 udp 1 ${MDNS} 5 typ host`
      assert.equal(rewriteMdnsCandidates(candidate, null), candidate)
    })

    it('refuses to substitute an address that is not private', () => {
      // A public or CGNAT address would send connectivity checks off the LAN.
      const candidate = `candidate:1 1 udp 1 ${MDNS} 5 typ host`
      assert.equal(rewriteMdnsCandidates(candidate, '203.0.113.7'), candidate)
      assert.equal(rewriteMdnsCandidates(candidate, '100.127.100.1'), candidate)
      assert.equal(rewriteMdnsCandidates(candidate, 'not-an-ip'), candidate)
    })

    it('does not touch already-numeric candidates', () => {
      const candidate = 'candidate:1 1 udp 1 192.168.1.5 5 typ host'
      assert.equal(rewriteMdnsCandidates(candidate, '192.168.1.9'), candidate)
    })

    it('ignores an unrelated .local hostname', () => {
      // Only Chrome's uuid-shaped mDNS names are substituted.
      const candidate = 'candidate:1 1 udp 1 my-laptop.local 5 typ host'
      assert.equal(rewriteMdnsCandidates(candidate, '192.168.1.9'), candidate)
    })
  })

  describe('pairing codes', () => {
    const never = () => false

    it('mints codes of the advertised shape', () => {
      for (let i = 0; i < 200; i += 1) {
        const code = newPairingCode(never)!
        assert.equal(code.length, CODE_LENGTH)
        assert.match(code, /^\d{6}$/)
        assert.ok(isPairingCode(code))
      }
    })

    it('can produce a code with leading zeros', () => {
      // padStart matters: without it the space would silently shrink and codes
      // would never start with 0.
      const codes = new Set<string>()
      for (let i = 0; i < 4000; i += 1) codes.add(newPairingCode(never)!)
      assert.ok([...codes].some((code) => code.startsWith('0')), 'expected some 0-prefixed codes')
    })

    it('skips codes already in use', () => {
      const taken = new Set<string>()
      for (let i = 0; i < 50; i += 1) {
        const code = newPairingCode((candidate) => taken.has(candidate))!
        assert.ok(!taken.has(code))
        taken.add(code)
      }
      assert.equal(taken.size, 50)
    })

    it('gives up rather than looping forever when the space is full', () => {
      assert.equal(newPairingCode(() => true), null)
    })

    it('rejects anything that is not a six-digit code', () => {
      assert.equal(isPairingCode('12345'), false)
      assert.equal(isPairingCode('1234567'), false)
      assert.equal(isPairingCode('12a456'), false)
      assert.equal(isPairingCode(' 123456'), false)
      assert.equal(isPairingCode(123456), false)
      assert.equal(isPairingCode(undefined), false)
      assert.equal(isPairingCode(null), false)
    })

    it('formats for reading aloud without altering the value', () => {
      assert.equal(formatCode('012345'), '012 345')
      assert.equal(formatCode('012345').replace(' ', ''), '012345')
    })
  })

  describe('hosted deployment', () => {
    it('is detected from RENDER or DROP_HOSTED', () => {
      assert.equal(isHostedDeployment({ RENDER: 'true' }), true)
      assert.equal(isHostedDeployment({ DROP_HOSTED: '1' }), true)
      assert.equal(isHostedDeployment({}), false)
    })

    it('is always internet mode, even when the proxy in front has a private address', () => {
      // The bug this guards: Render's proxies are 10.x, which looked like a LAN
      // client, so the server advertised its own unreachable container address.
      assert.equal(modeFor('10.25.147.215', true), 'internet')
      assert.equal(modeFor('192.168.1.5', true), 'internet')
      assert.equal(modeFor('127.0.0.1', true), 'internet')
      assert.equal(shouldAdvertiseLan(modeFor('10.25.147.215', true)), false)
    })
  })

  describe('deployment mode', () => {
    it('is LAN when the peer arrives from a private address', () => {
      assert.equal(modeFor('192.168.1.5'), 'lan')
      assert.equal(modeFor('10.1.2.3'), 'lan')
    })

    it('is internet when only a public address is visible', () => {
      assert.equal(modeFor('49.36.183.22'), 'internet')
      assert.equal(modeFor('2405:201::1'), 'internet')
      assert.equal(modeFor(undefined), 'internet')
    })

    it('treats loopback as its own mode, not as the internet', () => {
      // Reaching the server on localhost — or through the Vite dev proxy —
      // used to classify as 'internet', so the page advertised its own
      // `localhost` origin in the QR and no phone could reach it.
      assert.equal(modeFor('127.0.0.1'), 'loopback')
      assert.equal(modeFor('::1'), 'loopback')
      assert.equal(modeFor('::ffff:127.0.0.1'), 'loopback')
      assert.equal(isLoopback('127.0.0.53'), true)
      assert.equal(isLoopback('192.168.1.5'), false)
      assert.equal(isLoopback('49.36.183.22'), false)
    })

    it('advertises the server’s own addresses on the same machine or network', () => {
      assert.equal(shouldAdvertiseLan('lan'), true)
      assert.equal(shouldAdvertiseLan('loopback'), true)
      // Hosted: a container's 10.x address passes an RFC1918 test but is
      // useless to the user, so offering it is worse than offering nothing.
      assert.equal(shouldAdvertiseLan('internet'), false)
    })

    it('never offers STUN, in either mode', () => {
      // This is the mechanism that confines transfers to one WiFi network:
      // with only host candidates available, a device on mobile data has no
      // address the other side can route to. STUN would re-enable exactly the
      // cross-network transfers we are excluding.
      assert.deepEqual(iceServersFor('lan'), [])
      assert.deepEqual(iceServersFor('internet'), [])
    })
  })

  describe('isCarrierNat', () => {
    it('recognises the RFC 6598 range mobile networks use', () => {
      assert.equal(isCarrierNat('100.64.0.1'), true)
      assert.equal(isCarrierNat('100.127.100.1'), true)
      assert.equal(isCarrierNat('100.127.255.255'), true)
      assert.equal(isCarrierNat('::ffff:100.70.1.1'), true)
    })

    it('does not catch addresses just outside it', () => {
      // 100.0–63.x and 100.128+.x are ordinary public space.
      assert.equal(isCarrierNat('100.63.255.255'), false)
      assert.equal(isCarrierNat('100.128.0.1'), false)
      assert.equal(isCarrierNat('49.36.183.22'), false)
      assert.equal(isCarrierNat('192.168.1.5'), false)
      assert.equal(isCarrierNat(undefined), false)
    })
  })

  describe('normaliseIp', () => {
    it('unwraps IPv4-mapped IPv6 addresses', () => {
      assert.equal(normaliseIp('::ffff:192.168.1.5'), '192.168.1.5')
      assert.equal(normaliseIp('192.168.1.5'), '192.168.1.5')
    })

    it('rejects anything not on a private network', () => {
      assert.equal(normaliseIp('::1'), null)
      assert.equal(normaliseIp('127.0.0.1'), null)
      assert.equal(normaliseIp('100.127.100.1'), null)
      assert.equal(normaliseIp('8.8.8.8'), null)
      assert.equal(normaliseIp(undefined), null)
    })
  })

  describe('sanitiseName', () => {
    it('strips control characters and separators', () => {
      assert.ok(!sanitiseName("Anurag\r\n's / phone").includes('\n'))
      assert.ok(!sanitiseName('a/b\\c').includes('/'))
    })

    it('never returns empty, and caps length', () => {
      assert.equal(sanitiseName(''), 'device')
      assert.equal(sanitiseName('   '), 'device')
      assert.equal(sanitiseName('x'.repeat(200)).length, 40)
    })

    it('keeps ordinary names and unicode', () => {
      assert.equal(sanitiseName("Anurag's iPhone"), "Anurag's iPhone")
      assert.equal(sanitiseName('Lenovo — работа'), 'Lenovo — работа')
    })
  })

  describe('pickLanAddresses', () => {
    const iface = (address: string, extra: Record<string, unknown> = {}) => ({
      family: 'IPv4',
      internal: false,
      address,
      ...extra,
    })

    it('offers only addresses the other device could reach', () => {
      const addresses = pickLanAddresses({
        lo0: [iface('127.0.0.1', { internal: true })],
        en0: [iface('192.168.68.104')],
        // A VPN hands out a carrier-grade-NAT address that looks plausible in
        // a list but is not "the same WiFi".
        utun4: [iface('100.127.100.1')],
        en5: [iface('169.254.10.2')],
        ppp0: [iface('203.0.113.9')],
        en1: [{ family: 'IPv6', internal: false, address: 'fe80::1' }],
      })
      assert.deepEqual(addresses, ['192.168.68.104'])
    })

    it('returns bare addresses, not URLs — the UI owns the port', () => {
      // The UI is served from a different port than this backend, so a URL
      // built here would point the QR code at the API instead of the page.
      const [address] = pickLanAddresses({ en0: [iface('192.168.1.7')] })
      assert.equal(address, '192.168.1.7')
      assert.ok(!address!.includes(':'))
    })

    it('ranks home-router ranges first', () => {
      const addresses = pickLanAddresses({
        a: [iface('10.0.0.5')],
        b: [iface('172.20.1.9')],
        c: [iface('192.168.1.7')],
      })
      assert.deepEqual(addresses, ['192.168.1.7', '10.0.0.5', '172.20.1.9'])
    })

    it('excludes 172.x outside the private block', () => {
      assert.deepEqual(pickLanAddresses({ a: [iface('172.15.0.1')], b: [iface('172.32.0.1')] }), [])
    })

    it('returns nothing when the machine is offline', () => {
      assert.deepEqual(pickLanAddresses({ lo0: [iface('127.0.0.1', { internal: true })] }), [])
    })
  })
})
