import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'

const scryptAsync = promisify(scrypt) as (
  password: string,
  salt: Buffer,
  keylen: number,
) => Promise<Buffer>

const KEY_LENGTH = 32
const SALT_LENGTH = 16

/** Hash a room password as `salt.key`, both base64url. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH)
  const key = await scryptAsync(password, salt, KEY_LENGTH)
  return `${salt.toString('base64url')}.${key.toString('base64url')}`
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [saltPart, keyPart] = stored.split('.')
  if (!saltPart || !keyPart) return false

  const salt = Buffer.from(saltPart, 'base64url')
  const expected = Buffer.from(keyPart, 'base64url')
  const actual = await scryptAsync(password, salt, expected.length)

  return expected.length === actual.length && timingSafeEqual(expected, actual)
}
