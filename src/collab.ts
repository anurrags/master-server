import { Hocuspocus } from '@hocuspocus/server'
import { getRoom, touchRoom } from './rooms.ts'
import { verifyPassword } from './auth.ts'

/** What the client puts in the provider's `token` field, JSON-encoded. */
type Credentials = {
  password?: string
}

function parseCredentials(token: string): Credentials {
  try {
    const parsed = JSON.parse(token)
    return typeof parsed === 'object' && parsed !== null ? (parsed as Credentials) : {}
  } catch {
    return {}
  }
}

export const hocuspocus = new Hocuspocus({
  /**
   * Access is all-or-nothing: holding the link (plus the password, if the room
   * has one) grants full read-write. There is no viewer role — every connection
   * that gets past this hook can edit and delete freely.
   */
  async onAuthenticate({ documentName, token }) {
    const room = getRoom(documentName)
    if (!room) throw new Error('Unknown or expired document')

    if (room.passwordHash) {
      const supplied = parseCredentials(token).password ?? ''
      if (!(await verifyPassword(supplied, room.passwordHash))) {
        throw new Error('Incorrect password')
      }
    }

    touchRoom(documentName)
  },

  /**
   * Seed the shared language server-side. Doing this on the client would mean
   * every joining peer writes it again.
   */
  async onLoadDocument({ documentName, document }) {
    const room = getRoom(documentName)
    if (room && document.isEmpty('meta')) {
      document.getMap('meta').set('language', room.language)
    }
    return document
  },

  async onConnect({ documentName }) {
    touchRoom(documentName)
  },

  async onDisconnect({ documentName }) {
    touchRoom(documentName)
  },
})

/** Live connection count for a room, straight from Hocuspocus. */
export function connectionCount(roomId: string): number {
  return hocuspocus.documents.get(roomId)?.connections.size ?? 0
}
