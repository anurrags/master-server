import { customAlphabet } from 'nanoid'

// Ambiguous glyphs (0/O, 1/l/I) removed — these ids get read aloud and retyped.
const ALPHABET = '23456789abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ'

/**
 * The room id is the whole capability: anyone holding it gets full read-write
 * access (subject to the room password, if set). 6 characters over this 56-glyph
 * alphabet is ~31 billion combinations, kept short enough to read aloud.
 */
export const ROOM_ID_LENGTH = 6
const newRoomId = customAlphabet(ALPHABET, ROOM_ID_LENGTH)

export type Room = {
  id: string
  passwordHash?: string
  language: string
  createdAt: number
  lastActiveAt: number
}

const rooms = new Map<string, Room>()

/** Rooms with nobody connected are dropped after this long. */
export const IDLE_TTL_MS = 30 * 60 * 1000
const SWEEP_INTERVAL_MS = 5 * 60 * 1000

/**
 * Draw an id that is not already taken.
 *
 * A collision is very unlikely, but the consequence is bad enough to be worth
 * three lines: `rooms.set` would silently replace a live room, dropping someone
 * else's document and handing its link to the new creator.
 */
function allocateRoomId(): string {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const id = newRoomId()
    if (!rooms.has(id)) return id
  }
  // Ten straight collisions means the keyspace is effectively full; failing
  // loudly beats handing back a hijacked room.
  throw new Error('Could not allocate a free document id')
}

export function createRoom(options: { language: string; passwordHash?: string }): Room {
  const now = Date.now()
  const room: Room = {
    id: allocateRoomId(),
    passwordHash: options.passwordHash,
    language: options.language,
    createdAt: now,
    lastActiveAt: now,
  }
  rooms.set(room.id, room)
  return room
}

export function getRoom(id: string): Room | undefined {
  return rooms.get(id)
}

export function touchRoom(id: string): void {
  const room = rooms.get(id)
  if (room) room.lastActiveAt = Date.now()
}

export function roomCount(): number {
  return rooms.size
}

/**
 * Evict rooms nobody is using, returning how many went.
 *
 * Rooms with a live connection are never evicted — pulling a document out from
 * under someone who still has it open would be worse than holding the memory.
 * An abandoned tab keeps its room alive, which is the intended trade: Hocuspocus
 * drops genuinely dead sockets on its own, and the room follows on the next pass.
 *
 * `liveConnectionCount` is supplied by the caller rather than tracked here:
 * Hocuspocus already knows the real number, and mirroring it with our own
 * increment/decrement counters would drift on abnormal disconnects.
 *
 * `now` and `idleTtlMs` are injectable so this is testable without waiting.
 */
export function sweepRooms(
  liveConnectionCount: (roomId: string) => number,
  now: number = Date.now(),
  idleTtlMs: number = IDLE_TTL_MS,
): number {
  let evicted = 0
  for (const [id, room] of rooms) {
    if (liveConnectionCount(id) > 0) {
      room.lastActiveAt = now
      continue
    }
    const idleFor = now - room.lastActiveAt
    if (idleFor > idleTtlMs) {
      rooms.delete(id)
      evicted += 1
      console.log(`[rooms] evicted ${id} (idle ${Math.round(idleFor / 1000)}s)`)
    }
  }
  return evicted
}

/**
 * Documents are ephemeral and this process is long-lived, so without a periodic
 * sweep the Map grows for the life of the server.
 */
export function startSweeper(liveConnectionCount: (roomId: string) => number): NodeJS.Timeout {
  const timer = setInterval(() => sweepRooms(liveConnectionCount), SWEEP_INTERVAL_MS)
  timer.unref()
  return timer
}

/** Test seam: drop all rooms. */
export function clearRooms(): void {
  rooms.clear()
}
