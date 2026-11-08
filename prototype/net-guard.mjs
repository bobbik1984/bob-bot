// Keeps the agent and the owner-entered endpoints away from this machine's own services and private networks.
import dns from 'node:dns/promises'
import net from 'node:net'

const isPrivateIp = ip => {
  if (net.isIPv6(ip)) {
    const low = ip.toLowerCase()
    if (low.startsWith('::ffff:')) return isPrivateIp(low.slice(7))
    return low === '::1' || low === '::' || /^f[cd]/.test(low) || /^fe[89ab]/.test(low)
  }
  const [a, b] = ip.split('.').map(Number)
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)
}

/** Allows only public http(s) targets. Returns the normalised address. */
export async function assertPublicUrl(raw) {
  let url
  try { url = new URL(raw) } catch { throw new Error(`Invalid URL: ${raw}`) }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Only http and https pages are allowed')
  const host = url.hostname.replace(/^\[|\]$/g, '')
  const addresses = net.isIP(host) ? [host] : (await dns.lookup(host, { all: true })).map(a => a.address)
  if (addresses.some(isPrivateIp)) throw new Error('Local and private network addresses are blocked')
  return url.href
}
