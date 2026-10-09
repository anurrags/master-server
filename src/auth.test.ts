import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { hashPassword, verifyPassword } from './auth.ts'

describe('auth', () => {
  describe('password hashing', () => {
    it('accepts the correct password', async () => {
      const stored = await hashPassword('correct-horse')
      assert.equal(await verifyPassword('correct-horse', stored), true)
    })

    it('rejects a wrong password', async () => {
      const stored = await hashPassword('correct-horse')
      assert.equal(await verifyPassword('wrong-horse', stored), false)
      assert.equal(await verifyPassword('', stored), false)
      assert.equal(await verifyPassword('correct-hors', stored), false)
    })

    it('never stores the password in the clear', async () => {
      const stored = await hashPassword('correct-horse')
      assert.ok(!stored.includes('correct-horse'))
    })

    it('salts, so the same password hashes differently each time', async () => {
      const a = await hashPassword('same')
      const b = await hashPassword('same')
      assert.notEqual(a, b)
      // Both still verify.
      assert.equal(await verifyPassword('same', a), true)
      assert.equal(await verifyPassword('same', b), true)
    })

    it('rejects malformed stored hashes instead of throwing', async () => {
      assert.equal(await verifyPassword('x', ''), false)
      assert.equal(await verifyPassword('x', 'no-separator'), false)
    })
  })
})
