import assert from 'node:assert/strict'
import { beforeEach, describe, it } from 'node:test'

import {
  ROOM_ID_LENGTH,
  clearRooms,
  createRoom,
  getRoom,
  sweepRooms,
  touchRoom,
} from './rooms.ts'

const MINUTE = 60 * 1000
const noConnections = () => 0

describe('rooms', () => {
  beforeEach(() => clearRooms())

  it('issues distinct ids of the configured length', () => {
    const a = createRoom({ language: 'python' })
    const b = createRoom({ language: 'python' })

    assert.notEqual(a.id, b.id)
    assert.equal(a.id.length, ROOM_ID_LENGTH)
  })

  it('exposes no separate credential — the id is the whole capability', () => {
    const room = createRoom({ language: 'python' })
    assert.deepEqual(
      Object.keys(room).sort(),
      ['createdAt', 'id', 'language', 'lastActiveAt', 'passwordHash'],
    )
  })

  it('keeps room ids short and URL-safe', () => {
    const room = createRoom({ language: 'plaintext' })
    assert.equal(room.id.length, 6)
    assert.match(room.id, /^[0-9A-Za-z]{6}$/)
    assert.equal(encodeURIComponent(room.id), room.id, 'must need no escaping in a URL path')
  })

  it('never hands out an id that is already in use', () => {
    // Exercise the collision guard for real: many draws from the same keyspace,
    // all of which must be distinct and none of which may replace a live room.
    const ids = new Set<string>()
    for (let i = 0; i < 500; i += 1) ids.add(createRoom({ language: 'plaintext' }).id)

    assert.equal(ids.size, 500, 'every created room must have its own id')
    for (const id of ids) assert.ok(getRoom(id), `room ${id} was overwritten`)
  })

  it('looks rooms up by id', () => {
    const room = createRoom({ language: 'sql' })
    assert.equal(getRoom(room.id)?.language, 'sql')
    assert.equal(getRoom('nonexistent'), undefined)
  })

  describe('sweeping', () => {
    it('evicts a room once it has been idle past the TTL', () => {
      const room = createRoom({ language: 'plaintext' })
      const later = Date.now() + 31 * MINUTE

      assert.equal(sweepRooms(noConnections, later, 30 * MINUTE), 1)
      assert.equal(getRoom(room.id), undefined)
    })

    it('keeps a room that is idle but still within the TTL', () => {
      const room = createRoom({ language: 'plaintext' })
      const later = Date.now() + 5 * MINUTE

      assert.equal(sweepRooms(noConnections, later, 30 * MINUTE), 0)
      assert.ok(getRoom(room.id))
    })

    it('never evicts a room that still has someone connected', () => {
      const room = createRoom({ language: 'plaintext' })
      const muchLater = Date.now() + 10 * 24 * 60 * MINUTE

      assert.equal(sweepRooms(() => 1, muchLater, 30 * MINUTE), 0)
      assert.ok(getRoom(room.id), 'a document in use must not be pulled out from under its users')
    })

    it('restarts the idle clock when the last person leaves', () => {
      const room = createRoom({ language: 'plaintext' })
      const start = Date.now()

      // Someone is connected well past the TTL — the sweep keeps it alive and
      // refreshes lastActiveAt.
      sweepRooms(() => 1, start + 60 * MINUTE, 30 * MINUTE)
      // They leave. Ten minutes later it is still inside the TTL.
      assert.equal(sweepRooms(noConnections, start + 70 * MINUTE, 30 * MINUTE), 0)
      assert.ok(getRoom(room.id))
      // Forty minutes after they left, it goes.
      assert.equal(sweepRooms(noConnections, start + 101 * MINUTE, 30 * MINUTE), 1)
      assert.equal(getRoom(room.id), undefined)
    })

    it('touchRoom defers eviction', () => {
      const room = createRoom({ language: 'plaintext' })
      touchRoom(room.id)

      assert.equal(sweepRooms(noConnections, Date.now() + 5 * MINUTE, 30 * MINUTE), 0)
      assert.ok(getRoom(room.id))
    })
  })
})
