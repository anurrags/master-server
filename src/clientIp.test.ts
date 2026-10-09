import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { clientIp, firstForwarded } from './clientIp.ts'

const request = (forwarded: string | undefined, ip = '10.25.0.9') => ({
  ip,
  headers: { 'x-forwarded-for': forwarded },
  socket: { remoteAddress: ip },
})

describe('clientIp', () => {
  it('takes the first X-Forwarded-For entry when hosted', () => {
    assert.equal(clientIp(request('49.36.183.22, 172.68.1.1, 10.25.0.9'), true), '49.36.183.22')
  })

  it('gives different visitors different addresses when hosted', () => {
    // Behind Render every req.ip is the same internal proxy.
    assert.notEqual(clientIp(request('49.36.183.22'), true), clientIp(request('103.21.5.7'), true))
  })

  it('falls back to req.ip when hosted without the header', () => {
    assert.equal(clientIp(request(undefined), true), '10.25.0.9')
  })

  it('uses req.ip locally, ignoring the header', () => {
    assert.equal(clientIp(request('8.8.8.8', '192.168.68.104'), false), '192.168.68.104')
  })
})

describe('firstForwarded', () => {
  it('handles single, list, array and empty forms', () => {
    assert.equal(firstForwarded('1.2.3.4'), '1.2.3.4')
    assert.equal(firstForwarded(' 1.2.3.4 , 5.6.7.8'), '1.2.3.4')
    assert.equal(firstForwarded(['1.2.3.4, 5.6.7.8']), '1.2.3.4')
    assert.equal(firstForwarded(''), null)
    assert.equal(firstForwarded(undefined), null)
  })
})
