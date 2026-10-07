import { BlockList, isIP } from 'node:net'

/** Where Rawr may send a request on somebody else's say-so: a webhook endpoint, an
 *  automation step, an integration's pasted URL, a client's metadata document.
 *
 *  A signature says a payload came from us; it says nothing about who read it on
 *  the way, so plaintext is refused. Loopback, the private ranges, link-local (the
 *  cloud metadata service lives there), CGNAT, multicast and reserved space are
 *  refused because an address pointing at the network Rawr runs on turns "add a
 *  URL" into a request forgery anyone with the setting can aim wherever they like.
 *
 *  The one list lives here. `checkOutboundUrl` reads a URL as written, and the web
 *  app's `outboundRequest` applies `refusedAddress` to what a name resolves to at
 *  the moment of connecting, which is the only check a rebinding name cannot beat. */

const refused = new BlockList()
for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  refused.addSubnet(network, prefix, 'ipv4')
}
// An IPv4-mapped IPv6 address (::ffff:a.b.c.d) is matched against the IPv4 rules by
// BlockList itself. These cover the other ways IPv6 carries or names a host.
for (const [network, prefix] of [
  ['::', 96],
  ['64:ff9b::', 96],
  ['100::', 64],
  ['2001::', 32],
  ['2002::', 16],
  ['fc00::', 7],
  ['fe80::', 10],
  ['fec0::', 10],
  ['ff00::', 8],
] as const) {
  refused.addSubnet(network, prefix, 'ipv6')
}

const loopback = new BlockList()
loopback.addSubnet('127.0.0.0', 8, 'ipv4')
loopback.addAddress('::1', 'ipv6')

/** A receiver written on a laptop listens on loopback over http, so development
 *  can ask for exactly that: loopback, and http, never anything else on the
 *  network. Off unless `RAWR_DEV_OUTBOUND=1`, and never in production, read at
 *  call time so a test can flip it. */
export const devOutbound = (): boolean =>
  process.env.RAWR_DEV_OUTBOUND === '1' && process.env.NODE_ENV !== 'production'

/** Fails closed: a string that is not an address is refused, and a zone id
 *  (`fe80::1%eth0`) is dropped because BlockList does not read past it. */
export const refusedAddress = (address: string): boolean => {
  const bare = address.split('%')[0] ?? ''
  const family = isIP(bare)
  if (family === 0) return true
  const name = family === 6 ? 'ipv6' : 'ipv4'
  if (devOutbound() && loopback.check(bare, name)) return false
  return refused.check(bare, name)
}

/** https, and a host that is not obviously inside. A name is judged by what it
 *  says here and by what it resolves to when the request is made; this half is
 *  what lets a save fail with a sentence instead of a dead letter later. */
export const checkOutboundUrl = (raw: string): string => {
  let parsed: URL
  try {
    parsed = new URL(raw.trim())
  } catch {
    throw new Error(`"${raw}" is not a URL.`)
  }
  if (parsed.protocol !== 'https:' && !(devOutbound() && parsed.protocol === 'http:')) {
    throw new Error('An address has to be https. A record on the wire in plaintext is readable by anyone on the path.')
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '')
  const inside = isIP(host)
    ? refusedAddress(host)
    : /\.(local|internal|localdomain)$/.test(host) ||
      (!devOutbound() && (host === 'localhost' || host.endsWith('.localhost')))
  if (inside) {
    throw new Error(`${parsed.hostname} is on a private network. An address has to be somewhere Rawr can reach from the outside.`)
  }
  return parsed.toString()
}
