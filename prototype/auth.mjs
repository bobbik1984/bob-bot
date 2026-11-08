// 4-digit PIN login. The PIN is only ever set on the server (set-pin.mjs).
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const scrypt = promisify(crypto.scrypt)
export const DATA_DIR = path.resolve(process.env.BOBBOT_DATA || fileURLToPath(new URL('./data', import.meta.url)))
fs.mkdirSync(DATA_DIR, { recursive: true })

const PIN_FILE = path.join(DATA_DIR, 'pin.json')
const LOCK_FILE = path.join(DATA_DIR, 'lock.json')
const SECRET_FILE = path.join(DATA_DIR, 'cookie.secret')
const SESSION_MS = 30 * 24 * 3600 * 1000
const MAX_FAILS = 5
const BASE_LOCK_MS = 15 * 60 * 1000
const MAX_LOCK_MS = 24 * 3600 * 1000

const readJson = (file, fallback) => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return fallback }
}
const writePrivate = (file, text) => fs.writeFileSync(file, text, { mode: 0o600 })
const derive = async (pin, salt) =>
  (await scrypt(pin, salt, 32, { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 })).toString('hex')

export async function setPin(pin) {
  if (!/^\d{4}$/.test(pin)) throw new Error('PIN must be exactly 4 digits')
  const salt = crypto.randomBytes(16).toString('hex')
  writePrivate(PIN_FILE, JSON.stringify({ salt, hash: await derive(pin, salt) }))
  fs.rmSync(LOCK_FILE, { force: true }) // changing the PIN on the server also clears any lockout
}

export const hasPin = () => Boolean(readJson(PIN_FILE, null)?.hash)

function cookieSecret() {
  if (!fs.existsSync(SECRET_FILE)) writePrivate(SECRET_FILE, crypto.randomBytes(32).toString('hex'))
  return fs.readFileSync(SECRET_FILE, 'utf8')
}

// The signature covers the PIN hash, so changing the PIN logs every device out.
const sign = exp =>
  crypto.createHmac('sha256', cookieSecret()).update(`${exp}.${readJson(PIN_FILE, {}).hash}`).digest('hex')

export function issueSession() {
  const exp = Date.now() + SESSION_MS
  return { value: `${exp}.${sign(exp)}`, maxAge: SESSION_MS / 1000 }
}

export function validSession(value) {
  if (!value || !hasPin()) return false
  const [exp, sig] = value.split('.')
  if (!sig || Number(exp) < Date.now()) return false
  const expected = Buffer.from(sign(exp))
  const given = Buffer.from(sig)
  return expected.length === given.length && crypto.timingSafeEqual(expected, given)
}

/** @returns {{ok:true}|{ok:false,status:number,error:string,retryAfter?:number}} */
export async function login(pin) {
  const record = readJson(PIN_FILE, null)
  if (!record) return { ok: false, status: 503, error: 'PIN_NOT_SET' }
  const lock = readJson(LOCK_FILE, { fails: 0, lockouts: 0, until: 0 })
  if (lock.until > Date.now()) {
    return { ok: false, status: 429, error: 'LOCKED', retryAfter: Math.ceil((lock.until - Date.now()) / 1000) }
  }
  const actual = Buffer.from(await derive(String(pin), record.salt))
  if (/^\d{4}$/.test(String(pin)) && crypto.timingSafeEqual(actual, Buffer.from(record.hash))) {
    fs.rmSync(LOCK_FILE, { force: true })
    return { ok: true }
  }
  lock.fails += 1
  if (lock.fails >= MAX_FAILS) {
    lock.lockouts += 1
    lock.fails = 0
    lock.until = Date.now() + Math.min(BASE_LOCK_MS * 2 ** (lock.lockouts - 1), MAX_LOCK_MS)
  }
  writePrivate(LOCK_FILE, JSON.stringify(lock))
  return lock.until > Date.now()
    ? { ok: false, status: 429, error: 'LOCKED', retryAfter: Math.ceil((lock.until - Date.now()) / 1000) }
    : { ok: false, status: 401, error: 'WRONG_PIN', remaining: MAX_FAILS - lock.fails }
}
