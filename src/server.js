import { createServer } from 'node:http'
import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises'
import { Readable } from 'node:stream'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { del as deleteBlob, get as getBlob, head as getBlobMetadata } from '@vercel/blob'
import { handleUpload as handleBlobUpload } from '@vercel/blob/client'
import postgres from 'postgres'
import { buildCeoDashboard } from './ceo-dashboard.js'
import {
  handleMailOAuthCallback,
  handleMailPush,
  handleMailRequest,
  renewMailWatches,
  scheduleMailWatchRenewal,
} from './mails/gmail.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DATA_DIR = process.env.DATA_DIR ? path.resolve(ROOT, process.env.DATA_DIR) : path.join(ROOT, 'data')
const UPLOAD_DIR = process.env.UPLOAD_DIR ? path.resolve(ROOT, process.env.UPLOAD_DIR) : path.join(ROOT, 'uploads')
const DATABASE_FILE = path.join(DATA_DIR, 'taskflow.sqlite')
const LEGACY_STORE_FILE = path.join(DATA_DIR, 'store.json')
const SESSION_TTL = 30 * 24 * 60 * 60 * 1000
const JSON_LIMIT = 12 * 1024 * 1024
const UPLOAD_LIMIT = 100 * 1024 * 1024
const SAFE_ID = /^[A-Za-z0-9._:-]{1,160}$/
const SAFE_COLLECTION = /^[A-Za-z0-9_-]{1,80}$/
const PIN_LOOKUP_SECRET = process.env.PIN_LOOKUP_SECRET || ''
const sessions = new Map()
const loginAttempts = new Map()
let writeQueue = Promise.resolve()
let database
let databaseReady
let postgresClient
let clickupCache
let clickupCachedAt = 0
let clickupPending

function emptyStore() {
  return { auth: { adminPin: null, users: [] }, documents: {}, uploads: {} }
}

async function openDatabase() {
  if (process.env.VERCEL && !process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL must be configured for persistent Vercel storage.')
  }
  if (process.env.VERCEL && !process.env.BLOB_READ_WRITE_TOKEN) {
    throw new Error('BLOB_READ_WRITE_TOKEN must be configured for private Vercel file storage.')
  }
  if (process.env.DATABASE_URL) {
    if (!databaseReady) {
      databaseReady = (async () => {
        postgresClient = postgres(process.env.DATABASE_URL, {
          max: 1,
          idle_timeout: 20,
          connect_timeout: 10,
          prepare: false,
        })
        await postgresClient`CREATE TABLE IF NOT EXISTS app_state (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            store_json JSONB NOT NULL,
            updated_at TIMESTAMPTZ NOT NULL
          )`
        await postgresClient`CREATE TABLE IF NOT EXISTS audit_events (
            id BIGSERIAL PRIMARY KEY,
            created_at TIMESTAMPTZ NOT NULL,
            actor_id TEXT NOT NULL,
            actor_name TEXT NOT NULL,
            action TEXT NOT NULL,
            collection TEXT NOT NULL,
            document_id TEXT NOT NULL,
            details_json JSONB NOT NULL
          )`
        await postgresClient`CREATE INDEX IF NOT EXISTS audit_events_created_at ON audit_events(created_at DESC)`
        await postgresClient`CREATE TABLE IF NOT EXISTS auth_sessions (
            session_id TEXT PRIMARY KEY,
            user_json JSONB NOT NULL,
            expires_at TIMESTAMPTZ NOT NULL
          )`
        await postgresClient`CREATE TABLE IF NOT EXISTS login_attempts (
            remote_address TEXT PRIMARY KEY,
            attempt_count INTEGER NOT NULL,
            reset_at BIGINT NOT NULL
          )`
        await postgresClient`
          INSERT INTO app_state (id, store_json, updated_at)
          VALUES (1, ${JSON.stringify(emptyStore())}::jsonb, NOW())
          ON CONFLICT (id) DO NOTHING
        `
        return postgresClient
      })()
    }
    return databaseReady
  }

  if (!databaseReady) {
    databaseReady = (async () => {
      await mkdir(DATA_DIR, { recursive: true })
      database = new DatabaseSync(DATABASE_FILE)
      database.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = FULL;
        PRAGMA foreign_keys = ON;
        CREATE TABLE IF NOT EXISTS app_state (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          store_json TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS audit_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          created_at TEXT NOT NULL,
          actor_id TEXT NOT NULL,
          actor_name TEXT NOT NULL,
          action TEXT NOT NULL,
          collection TEXT NOT NULL,
          document_id TEXT NOT NULL,
          details_json TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS audit_events_created_at ON audit_events(created_at DESC);
      `)

      const current = database.prepare('SELECT id FROM app_state WHERE id = 1').get()
      if (!current) {
        let initialStore = emptyStore()
        try {
          const previousStore = JSON.parse(await readFile(LEGACY_STORE_FILE, 'utf8'))
          if (!previousStore || typeof previousStore !== 'object' || !previousStore.auth || !previousStore.documents) {
            throw new Error('The previous backend data file has an invalid format.')
          }
          initialStore = { ...previousStore, uploads: previousStore.uploads || {} }
          console.info('[taskflow-api] Imported existing store.json into SQLite.')
        } catch (error) {
          if (error.code !== 'ENOENT') throw error
        }
        database.prepare(
          'INSERT INTO app_state (id, store_json, updated_at) VALUES (1, ?, ?)'
        ).run(JSON.stringify(initialStore), new Date().toISOString())
      }
      return database
    })()
  }
  return databaseReady
}

function parseJsonValue(value, fallback = null) {
  if (value === null || value === undefined) return fallback
  let parsed = typeof value === 'string' ? JSON.parse(value) : value
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed)
    } catch {}
  }
  return parsed ?? fallback
}

function parseStoreJson(value) {
  let store = parseJsonValue(value, null)
  if (!store || typeof store !== 'object') {
    store = emptyStore()
  }
  if (!store.auth || typeof store.auth !== 'object') {
    store.auth = { adminPin: null, users: [] }
  }
  if (!Array.isArray(store.auth.users)) {
    store.auth.users = []
  }
  if (!store.documents || typeof store.documents !== 'object') {
    store.documents = {}
  }
  if (!store.uploads || typeof store.uploads !== 'object') {
    store.uploads = {}
  }
  return store
}

async function readStore() {
  const db = await openDatabase()
  const row = process.env.DATABASE_URL
    ? (await db`SELECT store_json FROM app_state WHERE id = 1`)[0]
    : db.prepare('SELECT store_json FROM app_state WHERE id = 1').get()
  if (!row) throw new Error('TaskFlow database is missing its application state.')
  try {
    return parseStoreJson(row.store_json)
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error('The TaskFlow database contains invalid application data.')
    throw error
  }
}

function updateStore(update, audit) {
  const operation = writeQueue.then(async () => {
    const db = await openDatabase()
    if (process.env.DATABASE_URL) {
      return db.begin(async (transaction) => {
        await transaction`SELECT pg_advisory_xact_lock(731904126)`
        const [row] = await transaction`SELECT store_json FROM app_state WHERE id = 1 FOR UPDATE`
        if (!row) throw new Error('TaskFlow database is missing its application state.')
        const store = parseStoreJson(row.store_json)
        const result = update(store)
        const updatedAt = new Date().toISOString()
        await transaction`
          UPDATE app_state SET store_json = ${JSON.stringify(store)}::jsonb, updated_at = ${updatedAt}
          WHERE id = 1
        `
        if (audit) {
          await transaction`
            INSERT INTO audit_events
              (created_at, actor_id, actor_name, action, collection, document_id, details_json)
            VALUES (
              ${updatedAt},
              ${String(audit.actorId || 'system')},
              ${String(audit.actorName || 'System')},
              ${String(audit.action)},
              ${String(audit.collection || '')},
              ${String(audit.documentId || '')},
              ${JSON.stringify(audit.details || {})}::jsonb
            )
          `
        }
        return result
      })
    }
    db.exec('BEGIN IMMEDIATE')
    try {
      const row = db.prepare('SELECT store_json FROM app_state WHERE id = 1').get()
      const store = parseStoreJson(row.store_json)
      const result = update(store)
      db.prepare('UPDATE app_state SET store_json = ?, updated_at = ? WHERE id = 1')
        .run(JSON.stringify(store), new Date().toISOString())
      if (audit) {
        db.prepare(`
          INSERT INTO audit_events
            (created_at, actor_id, actor_name, action, collection, document_id, details_json)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(
          new Date().toISOString(),
          String(audit.actorId || 'system'),
          String(audit.actorName || 'System'),
          String(audit.action),
          String(audit.collection || ''),
          String(audit.documentId || ''),
          JSON.stringify(audit.details || {})
        )
      }
      db.exec('COMMIT')
      return result
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  })
  writeQueue = operation.catch(() => {})
  return operation
}

function pinHash(pin, salt = randomBytes(16).toString('hex')) {
  return { salt, hash: scryptSync(pin, salt, 64).toString('hex') }
}

function pinLookup(pin) {
  return PIN_LOOKUP_SECRET ? createHmac('sha256', PIN_LOOKUP_SECRET).update(pin).digest('hex') : null
}

function verifyPin(pin, record) {
  if (!record?.salt || !record?.hash) return false
  const expected = Buffer.from(record.hash, 'hex')
  const actual = scryptSync(pin, record.salt, 64)
  return expected.length === actual.length && timingSafeEqual(expected, actual)
}

function publicUser(user) {
  return { id: user.id, name: user.name, permissions: user.permissions }
}

function json(res, status, body, headers = {}) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  })
  res.end(JSON.stringify(body))
}

function setSessionCookie(req, res, token, maxAge) {
  const crossOrigin = req.headers.origin && !sameHostOrigin(req)
  const secure = process.env.NODE_ENV === 'production' || process.env.VERCEL || crossOrigin ? '; Secure' : ''
  const sameSite = crossOrigin ? 'None' : 'Strict'
  res.setHeader(
    'Set-Cookie',
    `taskflow_session=${token}; HttpOnly; SameSite=${sameSite}; Path=/; Max-Age=${maxAge}${secure}`
  )
}

function clearCookie(req, res) {
  const crossOrigin = req.headers.origin && !sameHostOrigin(req)
  const secure = process.env.NODE_ENV === 'production' || process.env.VERCEL || crossOrigin ? '; Secure' : ''
  const sameSite = crossOrigin ? 'None' : 'Strict'
  res.setHeader('Set-Cookie', `taskflow_session=; HttpOnly; SameSite=${sameSite}; Path=/; Max-Age=0${secure}`)
}

function cookieValue(req, key) {
  const cookie = req.headers.cookie || ''
  const match = cookie.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${key}=`))
  return match ? decodeURIComponent(match.slice(key.length + 1)) : ''
}

async function sessionUser(req) {
  const token = (req.headers.authorization || '').match(/^Bearer\s+(.+)$/i)?.[1] ||
    cookieValue(req, 'taskflow_session')
  if (!token) return null
  if (process.env.DATABASE_URL) {
    const db = await openDatabase()
    const [session] = await db`
      SELECT user_json FROM auth_sessions
      WHERE session_id = ${token} AND expires_at > NOW()
    `
    if (!session) return null
    const user = parseJsonValue(session.user_json, null)
    return user ? { ...user, token } : null
  }
  const session = sessions.get(token)
  if (!session) return null
  if (session.expiresAt <= Date.now()) {
    sessions.delete(token)
    return null
  }
  return { ...session.user, token }
}

function canAccess(user, collection, method, data) {
  if (user.isAdmin) return true
  if (collection === 'kpiNotes' || collection === 'kpiReviews') return false
  const permissions = new Set(user.permissions || [])
  if (collection === 'roles' || collection === 'users') return false
  if (collection.toLowerCase().startsWith('cashbank')) return permissions.has('cashbank')
  if (collection === 'config') return method === 'GET' || method === 'HEAD'
  if (collection === 'hr') return permissions.has('hr')
  if (collection === 'foodics' || collection === 'foodics-settings') return permissions.has('foodics')
  if (collection === 'gulf') return permissions.has('gulf')
  if (collection === 'preferences') return user.isAdmin || Boolean(user.id)
  if (collection === 'integrations') return ['dash', 'clickup'].some((permission) => permissions.has(permission))
  if (collection === 'meetings') return ['notices', 'meet', 'zoom', 'cal'].some((permission) => permissions.has(permission))
  if (collection === 'history' || collection === 'tasks' || collection === 'clickup') {
    return ['dash', 'notices', 'tasks', 'day', 'kpi', 'team', 'projects', 'cal'].some((permission) =>
      permissions.has(permission)
    )
  }
  return false
}

async function requestBody(req, limit = JSON_LIMIT) {
  if (req.body !== undefined) {
    const raw = Buffer.isBuffer(req.body)
      ? req.body
      : Buffer.from(typeof req.body === 'string' ? req.body : JSON.stringify(req.body))
    if (raw.length > limit) {
      const error = new Error(`Request body exceeds the ${Math.round(limit / 1024 / 1024)} MB limit.`)
      error.status = 413
      throw error
    }
    return raw
  }
  const chunks = []
  let length = 0
  for await (const chunk of req) {
    length += chunk.length
    if (length > limit) {
      const error = new Error(`Request body exceeds the ${Math.round(limit / 1024 / 1024)} MB limit.`)
      error.status = 413
      throw error
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

async function jsonBody(req) {
  const raw = await requestBody(req)
  if (!raw.length) return {}
  try {
    const body = JSON.parse(raw.toString('utf8'))
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Expected a JSON object.')
    return body
  } catch (error) {
    error.status = 400
    throw error
  }
}

function getPath(query) {
  const value = query.get('path') || ''
  const parts = value.split('/')
  if (parts.length !== 2 || !SAFE_COLLECTION.test(parts[0]) || !SAFE_ID.test(parts[1])) return null
  return { collection: parts[0], id: parts[1] }
}

async function taskflowSession(user, remember) {
  const token = randomBytes(32).toString('base64url')
  const expiresAt = Date.now() + (remember ? SESSION_TTL : 12 * 60 * 60 * 1000)
  if (process.env.DATABASE_URL) {
    const db = await openDatabase()
    await db`
      INSERT INTO auth_sessions (session_id, user_json, expires_at)
      VALUES (${token}, ${JSON.stringify(user)}::jsonb, ${new Date(expiresAt).toISOString()})
    `
  } else {
    sessions.set(token, { user, expiresAt })
  }
  return token
}

async function deleteSession(token) {
  if (process.env.DATABASE_URL) {
    const db = await openDatabase()
    await db`DELETE FROM auth_sessions WHERE session_id = ${token}`
    return
  }
  sessions.delete(token)
}

async function tooManyAttempts(key) {
  const now = Date.now()
  if (process.env.DATABASE_URL) {
    const db = await openDatabase()
    const [attempt] = await db`
      INSERT INTO login_attempts (remote_address, attempt_count, reset_at)
      VALUES (${key}, 1, ${now + 15 * 60 * 1000})
      ON CONFLICT (remote_address) DO UPDATE SET
        attempt_count = CASE
          WHEN login_attempts.reset_at <= ${now} THEN 1
          ELSE login_attempts.attempt_count + 1
        END,
        reset_at = CASE
          WHEN login_attempts.reset_at <= ${now} THEN ${now + 15 * 60 * 1000}
          ELSE login_attempts.reset_at
        END
      RETURNING attempt_count
    `
    return attempt.attempt_count > 10
  }
  const existing = loginAttempts.get(key) || { count: 0, resetAt: now + 15 * 60 * 1000 }
  if (existing.resetAt <= now) {
    loginAttempts.set(key, { count: 1, resetAt: now + 15 * 60 * 1000 })
    return false
  }
  existing.count += 1
  loginAttempts.set(key, existing)
  return existing.count > 10
}

function sameHostOrigin(req) {
  const origin = req.headers.origin
  if (!origin) return true
  try {
    const originHost = new URL(origin).hostname
    const requestHost = (req.headers.host || '').split(':')[0].replace(/^\[|\]$/g, '')
    return originHost === requestHost
  } catch {
    return false
  }
}

const DEFAULT_FRONTEND_ORIGINS = [
  'https://www.natheelcoo.com',
  'https://natheelcoo.com',
  'https://frontend-coral-ten-91.vercel.app',
]

function allowedOrigin(req) {
  const origin = req.headers.origin
  if (!origin) return true
  if (sameHostOrigin(req)) return true
  const configuredOrigins = (process.env.FRONTEND_ORIGINS || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
  const allowedOrigins = [...new Set([...DEFAULT_FRONTEND_ORIGINS, ...configuredOrigins])]
  return allowedOrigins.includes(origin)
}

function applyCors(req, res) {
  const origin = req.headers.origin
  if (!origin || !allowedOrigin(req)) return false
  res.setHeader('Access-Control-Allow-Origin', origin)
  res.setHeader('Access-Control-Allow-Credentials', 'true')
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Vercel-Blob-Client-Payload, X-Vercel-Blob-Client-Token')
  res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition, Content-Length')
  res.setHeader('Access-Control-Max-Age', '600')
  res.setHeader('Vary', 'Origin')
  return true
}

async function handleAuth(req, res, url) {
  const store = await readStore()
  const user = await sessionUser(req)
  if (req.method === 'GET') {
    return json(res, 200, {
      configured: Boolean(store.auth.adminPin),
      authed: Boolean(user),
      ...(user?.token ? { token: user.token } : {}),
      ...(user ? { activeUser: user.isAdmin ? { id: 'admin', name: 'Admin', isAdmin: true } : publicUser(user) } : {}),
    })
  }
  if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed.' }, { Allow: 'GET, POST' })
  if (!allowedOrigin(req)) return json(res, 403, { error: 'Request origin is not allowed.' })
  const body = await jsonBody(req)
  if (body.action === 'logout') {
    const token = user?.token
    if (token) await deleteSession(token)
    if (user) {
      await updateStore(
        () => {},
        { actorId: user.id, actorName: user.name, action: 'auth.logout' }
      )
    }
    clearCookie(req, res)
    return json(res, 200, { ok: true })
  }
  if (body.action === 'change') {
    if (!user?.isAdmin) return json(res, 401, { error: 'Sign in as the dashboard admin first.' })
    if (!/^\d{4,8}$/.test(body.pin || '')) return json(res, 400, { error: 'PIN must contain 4–8 digits.' })
    if (!verifyPin(body.current || '', store.auth.adminPin)) return json(res, 401, { error: 'Current PIN is incorrect.' })
    const newLookup = pinLookup(body.pin)
    if (
      store.auth.users.some(
        (candidate) =>
          (newLookup && candidate.pinLookup === newLookup) || verifyPin(body.pin, candidate.pin)
      )
    ) {
      return json(res, 400, { error: 'The admin PIN must be different from every user PIN.' })
    }
    const record = pinHash(body.pin)
    await updateStore(
      (current) => {
        current.auth.adminPin = record
        current.auth.adminPinLookup = pinLookup(body.pin)
      },
      { actorId: user.id, actorName: user.name, action: 'auth.pin.change' }
    )
    return json(res, 200, { ok: true })
  }
  const key = req.headers['x-vercel-forwarded-for'] || req.headers['x-real-ip'] || req.socket.remoteAddress || 'unknown'
  if (await tooManyAttempts(String(key).split(',')[0].trim())) return json(res, 429, { error: 'Too many PIN attempts. Wait 15 minutes and try again.' })
  if (body.action === 'setup') {
    if (store.auth.adminPin) return json(res, 409, { error: 'The dashboard PIN has already been configured.' })
    if (!/^\d{4,8}$/.test(body.pin || '')) return json(res, 400, { error: 'PIN must contain 4–8 digits.' })
    await updateStore(
      (current) => {
        if (current.auth.adminPin) {
          const error = new Error('The dashboard PIN has already been configured.')
          error.status = 409
          throw error
        }
        current.auth.adminPin = pinHash(body.pin)
        current.auth.adminPinLookup = pinLookup(body.pin)
      },
      { actorId: 'admin', actorName: 'Admin', action: 'auth.pin.setup' }
    )
    const admin = { id: 'admin', name: 'Admin', isAdmin: true, permissions: [] }
    const token = await taskflowSession(admin, body.remember !== false)
    setSessionCookie(req, res, token, body.remember !== false ? SESSION_TTL / 1000 : 12 * 60 * 60)
    return json(res, 200, { ok: true, activeUser: admin, token })
  }
  if (body.action !== 'login' || !/^\d{4,8}$/.test(body.pin || '')) {
    return json(res, 400, { error: 'Enter a valid 4–8 digit PIN.' })
  }
  let activeUser
  const submittedLookup = pinLookup(body.pin)
  if (
    (submittedLookup && store.auth.adminPinLookup === submittedLookup) ||
    verifyPin(body.pin, store.auth.adminPin)
  ) {
    activeUser = { id: 'admin', name: 'Admin', isAdmin: true, permissions: [] }
  } else {
    const role =
      store.auth.users.find((candidate) => submittedLookup && candidate.pinLookup === submittedLookup) ||
      store.auth.users.find((candidate) => verifyPin(body.pin, candidate.pin))
    if (role && verifyPin(body.pin, role.pin)) activeUser = { ...publicUser(role), isAdmin: false }
  }
  if (!activeUser) return json(res, 401, { error: 'Incorrect PIN.' })
  const remember = body.remember !== false
  await updateStore(
    () => {},
    { actorId: activeUser.id, actorName: activeUser.name, action: 'auth.login' }
  )
  const token = await taskflowSession(activeUser, remember)
  setSessionCookie(req, res, token, remember ? SESSION_TTL / 1000 : 12 * 60 * 60)
  return json(res, 200, { ok: true, activeUser, token })
}

async function handleUsers(req, res, user) {
  if (!user?.isAdmin) return json(res, 401, { error: 'Admin access is required.' })
  if (req.method === 'GET') {
    const store = await readStore()
    return json(res, 200, store.auth.users.map(publicUser))
  }
  if (req.method !== 'PUT') return json(res, 405, { error: 'Method not allowed.' }, { Allow: 'GET, PUT' })
  const body = await jsonBody(req)
  if (!Array.isArray(body.users) || body.users.length > 500) {
    return json(res, 400, { error: 'Users must be an array of at most 500 entries.' })
  }
  const oldStore = await readStore()
  const oldById = new Map(oldStore.auth.users.map((item) => [item.id, item]))
  const ids = new Set()
  const prepared = []
  for (const candidate of body.users) {
    if (
      !candidate ||
      typeof candidate.id !== 'string' ||
      !SAFE_ID.test(candidate.id) ||
      typeof candidate.name !== 'string' ||
      !candidate.name.trim() ||
      candidate.name.length > 70 ||
      !Array.isArray(candidate.permissions) ||
      candidate.permissions.some((permission) => typeof permission !== 'string')
    ) {
      return json(res, 400, { error: 'A user record is invalid.' })
    }
    if (ids.has(candidate.id)) return json(res, 400, { error: 'User IDs must be unique.' })
    ids.add(candidate.id)
    const previous = oldById.get(candidate.id)
    let pin = previous?.pin
    let lookup = previous?.pinLookup
    if (candidate.pin !== undefined && candidate.pin !== '') {
      if (!/^\d{4}$/.test(candidate.pin)) return json(res, 400, { error: 'User PINs must be exactly 4 digits.' })
      const candidateLookup = pinLookup(candidate.pin)
      if ((candidateLookup && oldStore.auth.adminPinLookup === candidateLookup) || verifyPin(candidate.pin, oldStore.auth.adminPin)) {
        return json(res, 400, { error: 'A user PIN cannot match the admin PIN.' })
      }
      if (
        oldStore.auth.users.some(
          (other) =>
            other.id !== candidate.id &&
            ((candidateLookup && other.pinLookup === candidateLookup) || verifyPin(candidate.pin, other.pin))
        ) ||
        prepared.some(
          (other) =>
            (candidateLookup && other.pinLookup === candidateLookup) || verifyPin(candidate.pin, other.pin)
        )
      ) {
        return json(res, 400, { error: 'User PINs must be unique.' })
      }
      pin = pinHash(candidate.pin)
      lookup = candidateLookup
    }
    if (!pin) return json(res, 400, { error: 'New users must have a 4-digit PIN.' })
    prepared.push({
      id: candidate.id,
      name: candidate.name.trim(),
      pin,
      pinLookup: lookup,
      permissions: [...new Set(candidate.permissions.filter((permission) =>
        ['dash', 'notices', 'mails', 'meet', 'zoom', 'cal', 'kpi', 'day', 'tasks', 'clickup', 'projects', 'team', 'hr', 'foodics', 'gulf', 'cashbank'].includes(permission)
      ))],
    })
  }
  await updateStore(
    (current) => {
      current.auth.users = prepared
    },
    {
      actorId: user.id,
      actorName: user.name,
      action: 'users.save',
      collection: 'users',
      details: { count: prepared.length },
    }
  )
  const updatedById = new Map(prepared.map((candidate) => [candidate.id, candidate]))
  for (const [token, activeSession] of sessions) {
    if (activeSession.user.isAdmin) continue
    const updatedUser = updatedById.get(activeSession.user.id)
    if (
      !updatedUser ||
      oldById.get(activeSession.user.id)?.pin.hash !== updatedUser.pin.hash ||
      updatedUser.name !== activeSession.user.name ||
      updatedUser.permissions.join(',') !== (activeSession.user.permissions || []).join(',')
    ) {
      sessions.delete(token)
    }
  }
  return json(res, 200, prepared.map(publicUser))
}

async function handleDocs(req, res, url, user) {
  const pathValue = getPath(url.searchParams)
  if (url.searchParams.has('path') && !pathValue) return json(res, 400, { error: 'Invalid document path.' })
  const collectionValue = url.searchParams.get('collection') || ''
  const collection = pathValue?.collection || collectionValue
  if (collection && !SAFE_COLLECTION.test(collection)) return json(res, 400, { error: 'Invalid collection name.' })
  const method = req.method
  const canAccessDocument = (target) =>
    target.collection === 'preferences'
      ? user.isAdmin || target.id === user.id
      : canAccess(user, target.collection, method)
  if (pathValue && !canAccessDocument(pathValue)) {
    return json(res, 403, { error: 'Your account does not have access to this data.' })
  }
  if (!pathValue && collection === 'preferences' && !user.isAdmin) {
    return json(res, 403, { error: 'Request your own preference document by ID.' })
  }
  if (!pathValue && collection && !canAccess(user, collection, method)) {
    return json(res, 403, { error: 'Your account does not have access to this data.' })
  }

  if (method === 'GET') {
    if (pathValue) {
      const store = await readStore()
      const entry = store.documents[pathValue.collection]?.[pathValue.id]
      return json(res, 200, entry ? { exists: true, data: entry.data } : { exists: false, data: null })
    }
    if (!collection) return json(res, 400, { error: 'Specify a document path or collection.' })
    const store = await readStore()
    return json(
      res,
      200,
      Object.entries(store.documents[collection] || {}).map(([id, entry]) => ({ id, data: entry.data }))
    )
  }

  if (method === 'PUT' || method === 'PATCH') {
    const body = await jsonBody(req)
    const target = getPath(new URLSearchParams({ path: String(body.path || '') }))
    if (!target || !canAccessDocument(target)) {
      return json(res, target ? 403 : 400, { error: target ? 'Your account does not have access to this data.' : 'Invalid document path.' })
    }
    if (!Object.hasOwn(body, 'data') || !body.data || typeof body.data !== 'object' || Array.isArray(body.data)) {
      return json(res, 400, { error: 'Document data must be a JSON object.' })
    }
    if (target.collection === 'kpiReviews') {
      const categories = ['communication', 'targets', 'delivery', 'teamwork', 'development']
      const scoreEntries = Object.entries(body.data.scores || {})
      const date = body.data.date
      const validDate =
        typeof date === 'string' &&
        /^\d{4}-\d{2}-\d{2}$/.test(date) &&
        !Number.isNaN(Date.parse(`${date}T00:00:00Z`)) &&
        new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) === date
      if (
        typeof body.data.employee !== 'string' ||
        !body.data.employee.trim() ||
        body.data.employee.length > 70 ||
        !validDate ||
        scoreEntries.length !== categories.length ||
        scoreEntries.some(
          ([category, score]) =>
            !categories.includes(category) || !Number.isInteger(score) || score < 0 || score > 10
        )
      ) {
        return json(res, 400, { error: 'Employee ratings must include a valid employee, date, and five scores from 0 to 10.' })
      }
    }
    const saved = await updateStore(
      (store) => {
        store.documents[target.collection] ||= {}
        const current = store.documents[target.collection][target.id]?.data || {}
        let data = method === 'PATCH' ? { ...current, ...body.data } : body.data
        if (method === 'PATCH' && target.collection.toLowerCase() === 'cashbankaccounting' && target.id === 'main') {
          const mergeById = (existing, incoming, timestamp) => {
            const merged = new Map((Array.isArray(existing) ? existing : []).map((item) => [item.id, item]))
            for (const item of Array.isArray(incoming) ? incoming : []) {
              const previous = merged.get(item.id)
              if (!previous || Date.parse(item[timestamp] || item.createdAt || '') >= Date.parse(previous[timestamp] || previous.createdAt || '')) {
                merged.set(item.id, item)
              }
            }
            return [...merged.values()]
          }
          const sequences = { ...(current.sequences || {}), ...(body.data.sequences || {}) }
          for (const [key, sequence] of Object.entries(body.data.sequences || {})) {
            sequences[key] = Math.max(Number(current.sequences?.[key]) || 0, Number(sequence) || 0)
          }
          const events = new Map()
          for (const event of [...(current.audit || []), ...(body.data.audit || [])]) {
            const key = `${event.documentId || ''}:${event.action || ''}:${event.at || ''}`
            events.set(key, event)
          }
          data = {
            ...data,
            sequences,
            notes: mergeById(current.notes, body.data.notes, 'updatedAt'),
            audit: [...events.values()],
          }
        }
        if (method === 'PATCH' && target.collection === 'gulf' && target.id === 'main') {
          for (const key of ['nodes', 'assets', 'contacts']) {
            if (!Array.isArray(body.data[key])) continue
            const keyFor = key === 'contacts' ? (item) => item.email?.toLowerCase() : (item) => item.id
            const merged = new Map(
              (Array.isArray(current[key]) ? current[key] : [])
                .filter((item) => item && typeof keyFor(item) === 'string')
                .map((item) => [keyFor(item), item])
            )
            for (const item of body.data[key]) {
              const itemKey = item && typeof keyFor(item) === 'string' ? keyFor(item) : null
              if (itemKey) merged.set(itemKey, item)
            }
            data[key] = [...merged.values()]
          }
        }
        store.documents[target.collection][target.id] = { data, updatedAt: new Date().toISOString() }
        return data
      },
      {
        actorId: user.id,
        actorName: user.name,
        action: `${method.toLowerCase()}`,
        collection: target.collection,
        documentId: target.id,
      }
    )
    return json(res, method === 'PUT' ? 201 : 200, { id: target.id, data: saved })
  }

  if (method === 'POST') {
    const body = await jsonBody(req)
    const targetCollection = collection || (typeof body.collection === 'string' ? body.collection : '')
    if (!targetCollection || !SAFE_COLLECTION.test(targetCollection)) {
      return json(res, 400, { error: 'Specify a collection.' })
    }
    if (!canAccess(user, targetCollection, method)) {
      return json(res, 403, { error: 'Your account does not have access to this data.' })
    }
    if (!Array.isArray(body.items) || body.items.length > 500) {
      return json(res, 400, { error: 'Items must be an array of at most 500 documents.' })
    }
    for (const item of body.items) {
      if (!item || typeof item.id !== 'string' || !SAFE_ID.test(item.id) || !item.data || typeof item.data !== 'object' || Array.isArray(item.data)) {
        return json(res, 400, { error: 'A document in the batch is invalid.' })
      }
    }
    await updateStore(
      (store) => {
        store.documents[targetCollection] ||= {}
        for (const item of body.items) {
          store.documents[targetCollection][item.id] = { data: item.data, updatedAt: new Date().toISOString() }
        }
      },
      { actorId: user.id, actorName: user.name, action: 'batch.create', collection: targetCollection, details: { count: body.items.length } }
    )
    return json(res, 200, { saved: body.items.length })
  }

  if (method === 'DELETE') {
    if (!collection && !pathValue) return json(res, 400, { error: 'Specify a document path or collection.' })
    if (!canAccess(user, collection, method)) return json(res, 403, { error: 'Your account does not have access to this data.' })
    await updateStore(
      (store) => {
        if (pathValue) delete store.documents[pathValue.collection]?.[pathValue.id]
        else delete store.documents[collection]
      },
      {
        actorId: user.id,
        actorName: user.name,
        action: pathValue ? 'delete' : 'collection.clear',
        collection,
        documentId: pathValue?.id || '',
      }
    )
    return json(res, 200, { ok: true })
  }

  return json(res, 405, { error: 'Method not allowed.' }, { Allow: 'GET, PUT, PATCH, POST, DELETE' })
}

async function handleCashBankSequence(req, res, user) {
  if (!user.isAdmin && !user.permissions?.includes('cashbank')) {
    return json(res, 403, { error: 'Your account does not have access to Cash & Bank.' })
  }
  if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed.' }, { Allow: 'POST' })
  const body = await jsonBody(req)
  if (
    !['credit', 'debit'].includes(body.kind) ||
    typeof body.year !== 'string' ||
    !/^\d{4}$/.test(body.year) ||
    !Number.isInteger(body.count) ||
    body.count < 1 ||
    body.count > 100
  ) {
    return json(res, 400, { error: 'A valid adjustment kind, year, and count from 1 to 100 are required.' })
  }
  const sequenceKey = `${body.kind}-${body.year}`
  const result = await updateStore(
    (store) => {
      store.documents.cashbankAccounting ||= {}
      const current = store.documents.cashbankAccounting.main?.data || { notes: [], sequences: {}, audit: [] }
      const first = (Number(current.sequences?.[sequenceKey]) || 0) + 1
      const last = first + body.count - 1
      const data = {
        ...current,
        sequences: { ...(current.sequences || {}), [sequenceKey]: last },
      }
      store.documents.cashbankAccounting.main = { data, updatedAt: new Date().toISOString() }
      return { sequenceKey, first, last }
    },
    {
      actorId: user.id,
      actorName: user.name,
      action: 'cashbank.sequence.reserve',
      collection: 'cashbankAccounting',
      documentId: 'main',
      details: { kind: body.kind, year: body.year, count: body.count },
    }
  )
  return json(res, 200, result)
}

async function handleFileUpload(req, res, user, scope) {
  if (process.env.DATABASE_URL) {
    const body = await jsonBody(req)
    const result = await handleBlobUpload({
      body,
      request: req,
      onBeforeGenerateToken: async (pathname, clientPayload) => {
        let payload
        try {
          payload = JSON.parse(clientPayload || '{}')
        } catch {
          throw new Error('Invalid upload metadata.')
        }
        if (
          !/^[a-f0-9]{36}$/.test(pathname) ||
          payload.id !== pathname ||
          payload.scope !== scope ||
          typeof payload.name !== 'string' ||
          !payload.name.trim() ||
          payload.name.length > 255 ||
          !['config', 'foodics', 'gulf', 'hr', 'cashbank'].includes(scope) ||
          !user ||
          !canAccess(user, scope, 'POST')
        ) {
          throw new Error('Invalid file upload.')
        }
        return {
          addRandomSuffix: false,
          maximumSizeInBytes: UPLOAD_LIMIT,
          tokenPayload: JSON.stringify({
            id: pathname,
            name: path.basename(payload.name).slice(0, 255),
            scope,
            owner: user.id,
            ownerName: user.name,
          }),
        }
      },
      onUploadCompleted: async ({ blob, tokenPayload }) => {
        const metadata = JSON.parse(tokenPayload)
        const storedBlob = await getBlobMetadata(blob.pathname, { access: 'private' })
        await updateStore(
          (store) => {
            store.uploads ||= {}
            store.uploads[metadata.id] = {
              name: metadata.name,
              scope: metadata.scope,
              size: storedBlob.size,
              owner: metadata.owner,
              pathname: blob.pathname,
            }
          },
          {
            actorId: metadata.owner,
            actorName: metadata.ownerName,
            action: 'file.upload',
            collection: metadata.scope,
            documentId: metadata.id,
            details: { name: metadata.name, size: storedBlob.size },
          }
        )
      },
    })
    return json(res, 200, result)
  }
  if (!['config', 'foodics', 'gulf', 'hr', 'cashbank'].includes(scope)) {
    return json(res, 400, { error: 'Choose a supported file collection.' })
  }
  if (!canAccess(user, scope, 'POST')) return json(res, 403, { error: 'Your account does not have access to upload here.' })
  const contentType = req.headers['content-type'] || ''
  const boundary = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i)?.slice(1).find(Boolean)
  if (!boundary) return json(res, 400, { error: 'A multipart file upload is required.' })
  const body = await requestBody(req, UPLOAD_LIMIT + 1024 * 1024)
  const boundaryBuffer = Buffer.from(`--${boundary}`)
  const parts = []
  let cursor = body.indexOf(boundaryBuffer) + boundaryBuffer.length
  while (cursor >= boundaryBuffer.length) {
    if (body.subarray(cursor, cursor + 2).equals(Buffer.from('--'))) break
    if (body.subarray(cursor, cursor + 2).equals(Buffer.from('\r\n'))) cursor += 2
    const next = body.indexOf(boundaryBuffer, cursor)
    if (next < 0) break
    const part = body.subarray(cursor, next - 2)
    const headerEnd = part.indexOf(Buffer.from('\r\n\r\n'))
    if (headerEnd >= 0) {
      const headers = part.subarray(0, headerEnd).toString('utf8')
      const disposition = headers.match(/content-disposition:\s*form-data;[^\r\n]*/i)?.[0] || ''
      const filename = disposition.match(/filename="([^"]*)"/i)?.[1]
      if (filename) parts.push({ filename, data: part.subarray(headerEnd + 4), headers })
    }
    cursor = next + boundaryBuffer.length
  }
  const file = parts[0]
  if (!file || !file.data.length) return json(res, 400, { error: 'Choose a non-empty file to upload.' })
  if (file.data.length > UPLOAD_LIMIT) return json(res, 413, { error: 'Files must be 100 MB or smaller.' })
  const originalName = path.basename(file.filename).slice(0, 255)
  const extension = path.extname(originalName).slice(0, 16).replace(/[^A-Za-z0-9.]/g, '')
  const id = randomBytes(18).toString('hex')
  await mkdir(UPLOAD_DIR, { recursive: true })
  await writeFile(path.join(UPLOAD_DIR, id), file.data, { flag: 'wx', mode: 0o600 })
  await updateStore(
    (store) => {
      store.uploads ||= {}
      store.uploads[id] = { name: originalName, scope, size: file.data.length, owner: user.id }
    },
    { actorId: user.id, actorName: user.name, action: 'file.upload', collection: scope, documentId: id, details: { name: originalName, size: file.data.length } }
  )
  return json(res, 201, { id, url: `/api/files/${id}`, name: originalName, size: file.data.length })
}

async function handleFile(req, res, pathname, user) {
  const id = pathname.slice('/api/files/'.length)
  if (!/^[a-f0-9]{36}$/.test(id)) return json(res, 404, { error: 'File not found.' })
  const store = await readStore()
  const metadata = store.uploads?.[id]
  if (!metadata || !canAccess(user, metadata.scope, 'GET')) return json(res, 404, { error: 'File not found.' })
  if (process.env.DATABASE_URL) {
    const blob = req.method === 'HEAD'
      ? await getBlobMetadata(metadata.pathname, { access: 'private' })
      : await getBlob(metadata.pathname, { access: 'private' })
    if (!blob || (req.method !== 'HEAD' && blob.statusCode !== 200)) return json(res, 404, { error: 'File not found.' })
    const safeName = metadata.name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\\r\n]/g, '_')
    const encodedName = encodeURIComponent(metadata.name).replace(/['()*]/g, (char) =>
      `%${char.charCodeAt(0).toString(16).toUpperCase()}`
    )
    res.writeHead(200, {
      'Content-Type': blob.blob.contentType || 'application/octet-stream',
      'Content-Length': String(blob.blob.size),
      'Content-Disposition': `attachment; filename="${safeName}"; filename*=UTF-8''${encodedName}`,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, no-store',
    })
    if (req.method === 'HEAD') return res.end()
    return Readable.fromWeb(blob.stream).pipe(res)
  }
  const filePath = path.join(UPLOAD_DIR, id)
  const fileInfo = await stat(filePath)
  const safeName = metadata.name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\\r\n]/g, '_')
  const encodedName = encodeURIComponent(metadata.name).replace(/['()*]/g, (char) =>
    `%${char.charCodeAt(0).toString(16).toUpperCase()}`
  )
  res.writeHead(200, {
    'Content-Type': 'application/octet-stream',
    'Content-Length': fileInfo.size,
    'Content-Disposition': `attachment; filename="${safeName}"; filename*=UTF-8''${encodedName}`,
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'private, no-store',
  })
  if (req.method === 'HEAD') return res.end()
  const stream = createReadStream(filePath)
  stream.on('error', (error) => res.destroy(error))
  return stream.pipe(res)
}

async function removeFile(req, res, pathname, user) {
  const id = pathname.slice('/api/files/'.length)
  if (!/^[a-f0-9]{36}$/.test(id)) return json(res, 404, { error: 'File not found.' })
  const store = await readStore()
  const metadata = store.uploads?.[id]
  if (!metadata || !canAccess(user, metadata.scope, 'DELETE')) return json(res, 404, { error: 'File not found.' })
  if (process.env.DATABASE_URL) {
    await deleteBlob(metadata.pathname, { access: 'private' })
  } else {
    await unlink(path.join(UPLOAD_DIR, id)).catch((error) => {
      if (error.code !== 'ENOENT') throw error
    })
  }
  await updateStore(
    (current) => {
      delete current.uploads[id]
    },
    { actorId: user.id, actorName: user.name, action: 'file.delete', collection: metadata.scope, documentId: id }
  )
  return json(res, 200, { ok: true })
}

async function handleMeetings(req, res, parsedBody, user) {
  if (req.method === 'GET') return json(res, 200, { google: false, zoom: false, timezone: 'Asia/Riyadh' })
  if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed.' }, { Allow: 'GET, POST' })
  const body = parsedBody || (await jsonBody(req))
  if (!['google', 'zoom'].includes(body.platform)) return json(res, 400, { error: 'Choose Google Meet or Zoom.' })
  if (body.title !== undefined && (typeof body.title !== 'string' || !body.title.trim() || body.title.length > 200)) {
    return json(res, 400, { error: 'Meeting title must be between 1 and 200 characters.' })
  }
  const id = `meeting-${randomBytes(12).toString('hex')}`
  const meeting = {
    ...body,
    id,
    status: 'scheduled',
    createdAt: new Date().toISOString(),
  }
  await updateStore(
    (store) => {
      store.documents.meetings ||= {}
      store.documents.meetings[id] = { data: meeting, updatedAt: new Date().toISOString() }
    },
    { actorId: user.id, actorName: user.name, action: 'meeting.create', collection: 'meetings', documentId: id }
  )
  return json(res, 201, { meeting, warning: 'The meeting record was saved. Add provider credentials to create a live meeting link.' })
}

async function handleSummarize(req, res) {
  if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed.' }, { Allow: 'POST' })
  const body = await jsonBody(req)
  if (typeof body.notes !== 'string' || !body.notes.trim()) return json(res, 400, { error: 'Add meeting notes first.' })
  const sentences = body.notes.split(/(?<=[.!?])\s+/).filter(Boolean)
  const summary = sentences.slice(0, 3).join(' ').slice(0, 1200)
  const actions = body.notes
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^(?:[-*]\s*)?(?:action|todo|to-do|task)\s*:/i.test(line))
    .map((line) => ({ text: line.replace(/^(?:[-*]\s*)?(?:action|todo|to-do|task)\s*:\s*/i, '') }))
    .slice(0, 30)
  return json(res, 200, { summary, decisions: [], actions })
}

async function clickupGet(pathname, token) {
  let response
  try {
    response = await fetch(`https://api.clickup.com/api/v2${pathname}`, {
      headers: { Accept: 'application/json', Authorization: token },
      signal: AbortSignal.timeout(12_000),
    })
  } catch {
    const error = new Error('Could not connect to ClickUp. Try again shortly.')
    error.status = 502
    throw error
  }
  let data
  try {
    data = await response.json()
  } catch {
    const error = new Error('ClickUp returned an invalid response.')
    error.status = 502
    throw error
  }
  if (!response.ok) {
    const error = new Error(
      response.status === 401 || response.status === 403
        ? 'ClickUp rejected the configured token. Check CLICKUP_API_TOKEN.'
        : response.status === 429
          ? 'ClickUp rate limit reached. Wait briefly, then sync again.'
          : `ClickUp request failed (${response.status}).`
    )
    error.status = response.status === 429 ? 503 : 502
    throw error
  }
  return data
}

async function loadClickup(token) {
  const { teams = [] } = await clickupGet('/team', token)
  if (!Array.isArray(teams)) {
    const error = new Error('ClickUp returned an invalid workspace list.')
    error.status = 502
    throw error
  }
  const members = new Map()
  const tasks = new Map()
  let truncated = false
  const workspaces = teams.map((team) => ({
    id: String(team.id),
    name: team.name || 'ClickUp workspace',
    url: `https://app.clickup.com/${encodeURIComponent(team.id)}`,
  }))
  const addMember = (raw) => {
    const member = raw.user || raw
    const id = String(member.id || member.username || member.email || '')
    const name = member.username || member.email || member.name || id
    if (id && name && !members.has(id)) {
      members.set(id, { id, name, username: member.username || name, profilePicture: member.profilePicture || '' })
    }
  }
  for (const team of teams) {
    for (const member of team.members || []) addMember(member)
    for (let page = 0; page < 10; page += 1) {
      const result = await clickupGet(
        `/team/${encodeURIComponent(team.id)}/task?include_closed=true&page=${page}`,
        token
      )
      const rows = Array.isArray(result.tasks) ? result.tasks : []
      for (const task of rows) {
        if (tasks.size >= 1000) {
          truncated = true
          break
        }
        if (task.id) tasks.set(String(task.id), task)
        for (const member of task.assignees || []) addMember(member)
      }
      if (tasks.size >= 1000) break
      if (result.last_page || rows.length < 100) break
      if (page === 9) truncated = true
    }
    if (tasks.size >= 1000) break
  }
  const taskRows = [...tasks.values()]
  const spaces = [...new Map(
    taskRows
      .filter((task) => task.space?.id && task.space?.name)
      .map((task) => [String(task.space.id), { id: String(task.space.id), name: task.space.name }])
  ).values()]
  return {
    configured: true,
    tasks: taskRows,
    members: [...members.values()],
    workspaces,
    spaces,
    truncated,
  }
}

async function handleClickup(req, res, url, user) {
  res.setHeader('Cache-Control', 'private, no-store')
  if (req.method !== 'GET') return json(res, 405, { error: 'Method not allowed.' }, { Allow: 'GET' })
  const token = process.env.CLICKUP_API_TOKEN
  if (!token) {
    const store = await readStore()
    const snapshot = store.documents.integrations?.clickup?.data
    return json(
      res,
      200,
      snapshot
        ? { ...snapshot, configured: false, stale: true }
        : { configured: false, tasks: [], members: [], workspaces: [], spaces: [] }
    )
  }
  const force = url.searchParams.get('force') === '1'
  if (!force && clickupCache && Date.now() - clickupCachedAt < 20_000) {
    return json(res, 200, clickupCache)
  }
  if (!clickupPending) {
    clickupPending = loadClickup(token)
  }
  const pending = clickupPending
  try {
    const data = await pending
    if (clickupPending === pending) {
      clickupCache = data
      clickupCachedAt = Date.now()
      await updateStore(
        (store) => {
          store.documents.integrations ||= {}
          store.documents.integrations.clickup = { data, updatedAt: new Date().toISOString() }
        },
        {
          actorId: user.id,
          actorName: user.name,
          action: 'integration.sync',
          collection: 'integrations',
          documentId: 'clickup',
          details: { tasks: data.tasks.length, members: data.members.length },
        }
      )
    }
    return json(res, 200, data)
  } catch (error) {
    return json(res, error.status || 502, { error: error.message || 'ClickUp sync failed.' })
  } finally {
    if (clickupPending === pending) clickupPending = null
  }
}

async function handleCeoDashboard(req, res, url, user) {
  if (req.method !== 'GET') return json(res, 405, { error: 'Method not allowed.' }, { Allow: 'GET' })
  if (!user.isAdmin && !user.permissions?.includes('dash')) {
    return json(res, 403, { error: 'Your account does not have access to the CEO dashboard.' })
  }
  const projectId = url.searchParams.get('project') || ''
  const assignee = url.searchParams.get('assignee') || ''
  const status = url.searchParams.get('status') || ''
  if (projectId.length > 160 || assignee.length > 70) {
    return json(res, 400, { error: 'Dashboard filters exceed the allowed length.' })
  }
  if (!['', 'To Do', 'In Progress', 'Review', 'Done', 'Overdue'].includes(status)) {
    return json(res, 400, { error: 'Dashboard status filter is invalid.' })
  }
  const store = await readStore()
  return json(res, 200, buildCeoDashboard(store, { projectId, assignee, status }))
}

async function handleRequest(req, res) {
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Referrer-Policy', 'same-origin')
  res.setHeader('X-Frame-Options', 'DENY')
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
  const pathname = url.pathname
  if (req.headers.origin && !allowedOrigin(req)) {
    return json(res, 403, { error: 'Request origin is not allowed.' })
  }
  applyCors(req, res)
  if (req.method === 'OPTIONS' && pathname.startsWith('/api/')) {
    res.writeHead(204)
    return res.end()
  }
  if (pathname === '/api/health') {
    if (req.method !== 'GET') return json(res, 405, { error: 'Method not allowed.' }, { Allow: 'GET' })
    await openDatabase()
    return json(res, 200, { status: 'ok', service: 'taskflow-api' })
  }
  if (pathname.startsWith('/api/')) {
    if (process.env.DATABASE_URL && pathname === '/api/files' && req.method === 'POST') {
      const body = await jsonBody(req)
      req.body = body
      if (body.type === 'blob.upload-completed') {
        return await handleFileUpload(req, res, null, url.searchParams.get('scope') || '')
      }
    }
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) && !allowedOrigin(req)) {
      return json(res, 403, { error: 'Request origin is not allowed.' })
    }
    if (pathname === '/api/cron/gmail-watch') {
      if (req.method !== 'GET') return json(res, 405, { error: 'Method not allowed.' }, { Allow: 'GET' })
      if (!process.env.MAILS_PUBSUB_TOPIC) return json(res, 200, { configured: false, skipped: true })
      const expected = process.env.CRON_SECRET || ''
      const provided = (req.headers.authorization || '').replace(/^Bearer\s+/i, '')
      const expectedBuffer = Buffer.from(expected)
      const providedBuffer = Buffer.from(provided)
      if (!expected || expectedBuffer.length !== providedBuffer.length || !timingSafeEqual(expectedBuffer, providedBuffer)) {
        return json(res, 401, { error: 'Cron authorization is invalid.' })
      }
      return json(res, 200, await renewMailWatches({ readStore, updateStore }))
    }
    if (pathname === '/api/auth') return await handleAuth(req, res, url)
    if (pathname === '/api/mails/pubsub' && req.method === 'POST') {
      return await handleMailPush(req, res, { readStore, updateStore })
    }
    if (pathname === '/api/mails/auth/google/callback' && req.method === 'GET') {
      return await handleMailOAuthCallback(req, res, url, { readStore, updateStore })
    }
    const user = await sessionUser(req)
    if (!user) return json(res, 401, { error: 'Sign in to access the dashboard.' })
    if (pathname.startsWith('/api/mails/')) {
      return await handleMailRequest(req, res, url, user, { json, jsonBody, readStore, updateStore })
    }
    if (pathname === '/api/users') return await handleUsers(req, res, user)
    if (pathname === '/api/cashbank/sequences') return await handleCashBankSequence(req, res, user)
    if (pathname === '/api/docs') return await handleDocs(req, res, url, user)
    if (pathname === '/api/dashboard/ceo') return await handleCeoDashboard(req, res, url, user)
    if (pathname === '/api/audit') {
      if (!user.isAdmin) return json(res, 403, { error: 'Admin access is required to view the activity log.' })
      if (req.method !== 'GET') return json(res, 405, { error: 'Method not allowed.' }, { Allow: 'GET' })
      const requestedLimit = Number(url.searchParams.get('limit') || 200)
      const limit = Number.isInteger(requestedLimit) ? Math.min(Math.max(requestedLimit, 1), 500) : 200
      const db = await openDatabase()
      const events = process.env.DATABASE_URL
        ? await db`
            SELECT id, created_at, actor_id, actor_name, action, collection, document_id, details_json
            FROM audit_events ORDER BY id DESC LIMIT ${limit}
          `
        : db.prepare(`
            SELECT id, created_at, actor_id, actor_name, action, collection, document_id, details_json
            FROM audit_events
            ORDER BY id DESC
            LIMIT ?
          `).all(limit)
      return json(
        res,
        200,
        events.map((event) => ({
          id: event.id,
          createdAt: event.created_at,
          actorId: event.actor_id,
          actorName: event.actor_name,
          action: event.action,
          collection: event.collection,
          documentId: event.document_id,
          details: typeof event.details_json === 'string' ? JSON.parse(event.details_json) : event.details_json,
        }))
      )
    }
    if (pathname === '/api/meetings') {
      const body = req.method === 'POST' ? await jsonBody(req) : null
      if (!canAccess(user, 'meetings', req.method, body)) {
        return json(res, 403, { error: 'Your account does not have access to meetings.' })
      }
      return await handleMeetings(req, res, body, user)
    }
    if (pathname === '/api/summarize') {
      if (!user.isAdmin && !['meet', 'zoom', 'cal'].some((permission) => user.permissions?.includes(permission))) {
        return json(res, 403, { error: 'Your account does not have access to meeting notes.' })
      }
      return await handleSummarize(req, res)
    }
    if (pathname === '/api/clickup') {
      if (!canAccess(user, 'clickup', req.method)) return json(res, 403, { error: 'Your account does not have access to ClickUp data.' })
      if (req.method !== 'GET') return json(res, 405, { error: 'Method not allowed.' }, { Allow: 'GET' })
      return await handleClickup(req, res, url, user)
    }
    if ((pathname === '/api/upload' || pathname === '/api/files') && req.method === 'POST') {
      const scope = pathname === '/api/upload' ? 'config' : url.searchParams.get('scope') || ''
      if (scope === 'config' && !user.isAdmin) return json(res, 403, { error: 'Admin access is required to upload a logo.' })
      return await handleFileUpload(req, res, user, scope)
    }
    if (pathname.startsWith('/api/files/')) {
      if (req.method === 'DELETE') return await removeFile(req, res, pathname, user)
      if (['GET', 'HEAD'].includes(req.method)) return await handleFile(req, res, pathname, user)
      return json(res, 405, { error: 'Method not allowed.' }, { Allow: 'GET, HEAD, DELETE' })
    }
    return json(res, 404, { error: 'API route not found.' })
  }
  return json(res, 404, { error: 'Not found.' })
}

export async function handleVercelRequest(req, res) {
  try {
    await handleRequest(req, res)
  } catch (error) {
    console.error('[taskflow-api]', error)
    if (res.headersSent) return res.destroy(error)
    json(res, error.status || 500, {
      error: error.message || 'The server could not complete the request.',
    })
  }
}

export default handleVercelRequest

export function createAppServer() {
  let stopMailWatchRenewal
  const server = createServer((req, res) => {
    handleVercelRequest(req, res)
  })
  server.on('listening', () => {
    stopMailWatchRenewal = scheduleMailWatchRenewal({ readStore, updateStore })
  })
  server.on('close', () => {
    stopMailWatchRenewal?.()
    if (database) {
      database.close()
      database = undefined
      databaseReady = undefined
    }
  })
  return server
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 8889)
  const host = process.env.HOST || '127.0.0.1'
  const server = createAppServer()
  server.listen(port, host, () => {
    console.log(`TaskFlow API listening on http://${host}:${port}`)
  })
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => server.close(() => process.exit(0)))
  }
}
