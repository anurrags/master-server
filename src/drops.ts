import { randomInt } from 'node:crypto'
import os from 'node:os'

// -------------------------------------------------------- display names

/**
 * Device labels are shown on the other device, so strip anything that isn't
 * plain text. Nothing here reaches a filesystem or a response header — files
 * never touch this server — but a name still gets rendered elsewhere.
 */
export function sanitiseName(raw: string): string {
  const cleaned = (raw || 'device')
    .replace(/[\\/]/g, '_')
    // Control characters, including CR/LF.
    .replace(/[\x00-\x1f\x7f]/g, '')
    .trim()
  return (cleaned || 'device').slice(0, 40)
}

// ------------------------------------------------------ pairing codes
//
// Devices are paired by a short code rather than by the address they arrive
// from. Grouping on a shared public IP was workable but too coarse: two flats
// behind one landlord's router landed in the same group, and carrier NAT put
// thousands of strangers together. A code is explicit — you only ever see the
// device you deliberately paired with.
//
// The code governs *discovery* only. Whether a transfer can actually happen is
// still decided by the transport: with no STUN or TURN (see `iceServersFor`)
// the two devices must be on the same WiFi.

/**
 * How the client reached this server, which decides what URL to advertise.
 *
 *   lan       — from a private address: same network, candidates can be rewritten
 *   loopback  — from 127.0.0.1/::1: the server is on *this* machine, so its own
 *               LAN addresses are exactly what the other device needs
 *   internet  — from a public address: hosted, so the page's own origin is the
 *               shareable URL and the machine's interfaces are irrelevant
 */
export type DropMode = 'lan' | 'loopback' | 'internet'

/** Six digits: fast to type on a phone, and the QR carries it anyway. */
export const CODE_LENGTH = 6

export function newPairingCode(taken: (code: string) => boolean): string | null {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    // randomInt is uniform; Math.random would bias the low digits.
    const code = String(randomInt(0, 10 ** CODE_LENGTH)).padStart(CODE_LENGTH, '0')
    if (!taken(code)) return code
  }
  return null
}

export function isPairingCode(value: unknown): value is string {
  return typeof value === 'string' && new RegExp(`^\\d{${CODE_LENGTH}}$`).test(value)
}

/** `123456` → `123 456`, purely for reading aloud. */
export function formatCode(code: string): string {
  return `${code.slice(0, 3)} ${code.slice(3)}`
}

export function isLoopback(rawIp: string | undefined): boolean {
  if (!rawIp) return false
  const address = rawIp.replace(/^::ffff:/i, '').split('%')[0]!
  return address === '::1' || /^127\./.test(address)
}

export function modeFor(rawIp: string | undefined): DropMode {
  if (normaliseIp(rawIp)) return 'lan'
  // Loopback is not "the internet": the server is on this very machine, and it
  // knows LAN addresses the other device can actually reach.
  if (isLoopback(rawIp)) return 'loopback'
  return 'internet'
}

/**
 * Whether this server's own interface addresses are worth advertising.
 *
 * True when the client is on the same network or the same machine. False when
 * hosted — a container's private address (10.x, say) passes an RFC1918 test but
 * is unreachable for the user, so offering it would be worse than offering
 * nothing.
 */
export function shouldAdvertiseLan(mode: DropMode): boolean {
  return mode === 'lan' || mode === 'loopback'
}

/**
 * ICE servers to hand the client: deliberately none, in either mode.
 *
 * This is what restricts transfers to WiFi, and it is enforcement rather than a
 * check. Browsers will not say whether you are on WiFi or cellular —
 * `navigator.connection` exposes only a speed bucket (`effectiveType`), which
 * reports "4g" on fast WiFi, and iOS Safari does not expose it at all — so no
 * client-side test could be trusted.
 *
 * With no STUN and no TURN, the only candidates either peer can offer are host
 * candidates: addresses on their own network interfaces. Two devices on the
 * same WiFi pair those directly. A device on mobile data has no address the
 * other can route to, so no candidate pair can ever succeed. Adding STUN would
 * hand out server-reflexive candidates and make exactly the cross-network
 * transfers we do not want possible.
 */
export function iceServersFor(_mode: DropMode): { urls: string }[] {
  return []
}

/**
 * Carrier-grade NAT, RFC 6598 — what mobile networks hand out.
 *
 * A cellular device could never complete a transfer anyway (no STUN, so no
 * routable candidate), but refusing early turns an endless "connecting…" into
 * a clear "join a WiFi network". Some home ISPs also use CGNAT, hence the
 * `DROP_ALLOW_CGNAT=1` override.
 */
export function isCarrierNat(rawIp: string | undefined): boolean {
  if (!rawIp) return false
  if (process.env.DROP_ALLOW_CGNAT === '1') return false
  const address = rawIp.replace(/^::ffff:/i, '').split('%')[0]!
  const parts = address.split('.')
  if (parts.length !== 4) return false
  const [a, b] = parts.map(Number)
  if (Number.isNaN(a) || Number.isNaN(b)) return false
  return a === 100 && b! >= 64 && b! <= 127
}

// ------------------------------------------------- mDNS candidate rewrite

const MDNS_HOSTNAME = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.local\b/gi

/** Normalise what Node reports, e.g. `::ffff:192.168.1.5`. */
export function normaliseIp(raw: string | undefined): string | null {
  if (!raw) return null
  const stripped = raw.replace(/^::ffff:/i, '')
  return isPrivateIpv4(stripped) ? stripped : null
}

export function isPrivateIpv4(address: string): boolean {
  return privateRank(address) !== null
}

/**
 * Replace Chrome's mDNS-obfuscated host candidates with the peer's real LAN
 * address, which the server observes from that peer's own connection.
 *
 * This is what makes peer-to-peer work here at all. Chrome hides local IPs
 * behind a random `<uuid>.local` name for privacy, and resolving that name needs
 * working multicast DNS — unavailable in some browsers and blocked on plenty of
 * networks. With no internet there is also no STUN to fall back on, so an
 * unresolvable candidate means no connection whatsoever: ICE never leaves the
 * `new` state. Substituting the observed address gives the far side something it
 * can actually send connectivity checks to.
 *
 * The substitute is only ever a private IPv4 address this server saw on that
 * peer's own socket — never a value either peer supplied.
 */
export function rewriteMdnsCandidates(sdpOrCandidate: string, peerIp: string | null): string {
  if (!peerIp || !isPrivateIpv4(peerIp)) return sdpOrCandidate
  return sdpOrCandidate.replace(MDNS_HOSTNAME, peerIp)
}

// -------------------------------------------------------- LAN addresses

/**
 * This machine's addresses that another device on the same network can reach.
 *
 * Addresses, not URLs: the UI is served from a different port (and, deployed,
 * a different host) than this backend, so only the UI knows the URL to put in
 * a QR code. It combines these with its own port.
 *
 * Only RFC1918 ranges are offered. A machine on a VPN typically also has a
 * carrier-grade-NAT address (Tailscale hands out 100.64/10, for instance) which
 * looks plausible in a list but is not "the same WiFi" — offering it sends
 * people to a URL their phone cannot open.
 */
export function lanAddresses(): string[] {
  return pickLanAddresses(os.networkInterfaces())
}

/** The selection logic, split out from `os` so it can be tested directly. */
export function pickLanAddresses(
  interfaces: Record<string, { family?: string; internal?: boolean; address: string }[] | undefined>,
): string[] {
  const ranked: { address: string; rank: number }[] = []

  for (const addresses of Object.values(interfaces)) {
    for (const entry of addresses ?? []) {
      if (entry.family !== 'IPv4' || entry.internal) continue
      const rank = privateRank(entry.address)
      if (rank === null) continue
      ranked.push({ address: entry.address, rank })
    }
  }

  ranked.sort((a, b) => a.rank - b.rank || a.address.localeCompare(b.address))
  return ranked.map((entry) => entry.address)
}

function privateRank(address: string): number | null {
  const parts = address.split('.')
  if (parts.length !== 4) return null
  const numbers = parts.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : NaN))
  if (numbers.some((n) => Number.isNaN(n) || n > 255)) return null
  const [a, b] = numbers as [number, number, number, number]

  // Home WiFi almost always looks like this, so try it first.
  if (a === 192 && b === 168) return 0
  if (a === 10) return 1
  if (a === 172 && b >= 16 && b <= 31) return 2
  return null // link-local, CGNAT/VPN, and public addresses are not offered
}
