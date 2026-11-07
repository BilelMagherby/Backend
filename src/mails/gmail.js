import { createCipheriv, createDecipheriv, createPublicKey, randomBytes, verify as verifySignature } from 'node:crypto'

const GOOGLE_API = 'https://gmail.googleapis.com/gmail/v1/users/me'
const GOOGLE_SCOPES = [
  'openid',
  'email',
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.settings.basic',
]
const accessTokens = new Map()
const ACCESS_TOKEN_SKEW = 60_000
const SYSTEM_LABELS = new Set(['INBOX', 'STARRED', 'SENT', 'DRAFT', 'SPAM', 'TRASH', 'UNREAD', 'IMPORTANT'])
let pubSubKeys

function httpError(status, message) {
  const error = new Error(message)
  error.status = status
  return error
}

function configuration() {
  const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET } = process.env
  const redirectUri =
    process.env.GOOGLE_REDIRECT_URI || 'http://localhost:8889/api/mails/auth/google/callback'
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
    throw httpError(503, 'Gmail is not configured. Set the Google OAuth client ID and secret in Backend/.env.')
  }
  return { clientId: GOOGLE_CLIENT_ID, clientSecret: GOOGLE_CLIENT_SECRET, redirectUri }
}

function encryptionKey() {
  const value = process.env.MAILS_TOKEN_ENCRYPTION_KEY || ''
  let key
  if (/^[A-Fa-f0-9]{64}$/.test(value)) {
    key = Buffer.from(value, 'hex')
  } else {
    key = Buffer.from(value, 'base64')
  }
  if (!value || key.length !== 32) {
    throw httpError(
      503,
      'Gmail token encryption is not configured. Set MAILS_TOKEN_ENCRYPTION_KEY to a random 32-byte base64 key.'
    )
  }
  return key
}

function encryptToken(token) {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv)
  const encrypted = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()])
  return `${iv.toString('base64')}.${cipher.getAuthTag().toString('base64')}.${encrypted.toString('base64')}`
}

function decryptToken(value) {
  try {
    const [iv, tag, encrypted] = value.split('.').map((part) => Buffer.from(part, 'base64'))
    const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), iv)
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8')
  } catch {
    throw httpError(500, 'The saved Gmail connection cannot be decrypted. Check MAILS_TOKEN_ENCRYPTION_KEY.')
  }
}

function accountFor(store, user) {
  return store.documents?.mailAccounts?.[user.id] || null
}

function mailWatchConfiguration() {
  const topic = process.env.MAILS_PUBSUB_TOPIC || ''
  const subscription = process.env.MAILS_PUBSUB_SUBSCRIPTION || ''
  const audience = process.env.MAILS_PUBSUB_AUDIENCE || ''
  const serviceAccount = process.env.MAILS_PUBSUB_SERVICE_ACCOUNT || ''
  if (!topic && !subscription && !audience && !serviceAccount) return null
  if (!topic || !subscription || !audience || !serviceAccount) {
    throw httpError(503, 'Gmail push requires the Pub/Sub topic, subscription, audience, and service account settings.')
  }
  if (
    !/^projects\/[^/]+\/topics\/[^/]+$/.test(topic) ||
    !/^projects\/[^/]+\/subscriptions\/[^/]+$/.test(subscription) ||
    !/^https:\/\//.test(audience) ||
    !serviceAccount.includes('@')
  ) {
    throw httpError(503, 'Gmail Pub/Sub configuration is invalid.')
  }
  return { topic, subscription, audience, serviceAccount }
}

async function ensureMailWatch(userId, account, updateStore, force = false) {
  const push = mailWatchConfiguration()
  if (!push) return null
  const expiration = Date.parse(account.watchExpiresAt || '')
  if (!force && Number.isFinite(expiration) && expiration > Date.now() + 24 * 60 * 60 * 1000) return null
  const watch = await googleRequest(userId, account, '/watch', {
    method: 'POST',
    body: JSON.stringify({
      topicName: push.topic,
      labelIds: ['INBOX'],
      labelFilterBehavior: 'INCLUDE',
    }),
  })
  const watchExpiresAt = new Date(Number(watch.expiration)).toISOString()
  await updateStore((store) => {
    const saved = store.documents?.mailAccounts?.[userId]
    if (saved) {
      saved.historyId = watch.historyId || saved.historyId
      saved.watchExpiresAt = watchExpiresAt
    }
  })
  return watch
}

function appRedirect(result) {
  const target = new URL(process.env.MAILS_APP_URL || 'http://localhost:5173/')
  if (!['http:', 'https:'].includes(target.protocol)) {
    throw httpError(500, 'MAILS_APP_URL must use HTTP or HTTPS.')
  }
  target.searchParams.set('gmail', result)
  return target.toString()
}

function oauthCookieValue(req) {
  const cookie = (req.headers.cookie || '').split(';').map((part) => part.trim())
    .find((part) => part.startsWith('taskflow_gmail_oauth='))
  return cookie?.slice('taskflow_gmail_oauth='.length) || ''
}

function oauthCookie(maxAge) {
  const secure = process.env.NODE_ENV === 'production' || process.env.VERCEL ? '; Secure' : ''
  return `taskflow_gmail_oauth=${maxAge ? 'pending' : ''}; HttpOnly; SameSite=Lax; Path=/api/mails/auth/google/callback; Max-Age=${maxAge}${secure}`
}

function redirect(res, location) {
  res.writeHead(302, {
    Location: location,
    'Cache-Control': 'no-store',
    'Set-Cookie': oauthCookie(0),
  })
  res.end()
}

async function exchangeCode(code) {
  const config = configuration()
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      redirect_uri: config.redirectUri,
      grant_type: 'authorization_code',
    }),
    signal: AbortSignal.timeout(15_000),
  })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw httpError(502, body.error_description || 'Google could not complete Gmail authorization.')
  return body
}

async function refreshAccessToken(userId, account) {
  const cached = accessTokens.get(userId)
  if (cached && cached.expiresAt > Date.now() + ACCESS_TOKEN_SKEW) return cached.value

  const config = configuration()
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      refresh_token: decryptToken(account.encryptedRefreshToken),
      grant_type: 'refresh_token',
    }),
    signal: AbortSignal.timeout(15_000),
  })
  const body = await response.json().catch(() => ({}))
  if (!response.ok || !body.access_token) {
    if (body.error === 'invalid_grant') {
      accessTokens.delete(userId)
      throw httpError(401, 'The Gmail authorization expired. Disconnect and reconnect this account.')
    }
    throw httpError(502, body.error_description || 'Google could not refresh Gmail access.')
  }
  accessTokens.set(userId, {
    value: body.access_token,
    expiresAt: Date.now() + Math.max(60, Number(body.expires_in) || 3600) * 1000,
  })
  return body.access_token
}

async function googleRequest(userId, account, endpoint, options = {}, retried = false, attempt = 0) {
  const token = await refreshAccessToken(userId, account)
  let response
  try {
    response = await fetch(`${GOOGLE_API}${endpoint}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...options.headers,
      },
      signal: AbortSignal.timeout(20_000),
    })
  } catch (error) {
    if (attempt < 2) {
      await new Promise((resolve) => setTimeout(resolve, 250 * (2 ** attempt)))
      return googleRequest(userId, account, endpoint, options, retried, attempt + 1)
    }
    if (error.name === 'TimeoutError') throw httpError(504, 'Google did not respond in time. Try again.')
    throw httpError(502, 'Google could not be reached. Check the server connection and try again.')
  }
  if (response.status === 401 && !retried) {
    accessTokens.delete(userId)
    return googleRequest(userId, account, endpoint, options, true, attempt)
  }
  if ((response.status === 429 || response.status >= 500) && attempt < 2) {
    const retryAfter = Number(response.headers.get('retry-after'))
    const delay = Number.isFinite(retryAfter) && retryAfter > 0
      ? Math.min(retryAfter * 1000, 5000)
      : 250 * (2 ** attempt)
    await new Promise((resolve) => setTimeout(resolve, delay))
    return googleRequest(userId, account, endpoint, options, retried, attempt + 1)
  }
  const body = response.status === 204 ? {} : await response.json().catch(() => ({}))
  if (!response.ok) {
    const message = body.error?.message
    if (response.status === 429) throw httpError(503, 'Gmail rate limit reached. Wait briefly and try again.')
    if (response.status === 404) throw httpError(404, 'This Gmail message or attachment no longer exists.')
    if (response.status === 401) throw httpError(401, 'Gmail access expired. Reconnect this account.')
    if (response.status === 403 && /insufficient authentication scopes|insufficientPermissions/i.test(message || '')) {
      throw httpError(403, 'Gmail needs additional permissions. Disconnect and reconnect this account to grant send-as access.')
    }
    throw httpError(502, message || 'The Gmail request failed.')
  }
  return body
}

function decodeHeader(value = '') {
  return value.replace(/=\?([^?]+)\?([bq])\?([^?]*)\?=/gi, (_match, charset, encoding, content) => {
    try {
      if (encoding.toLowerCase() === 'b') return Buffer.from(content, 'base64').toString(charset.toLowerCase())
      return content
        .replace(/_/g, ' ')
        .replace(/=([A-Fa-f0-9]{2})/g, (_hex, code) => String.fromCharCode(parseInt(code, 16)))
    } catch {
      return content
    }
  })
}

function headersOf(message) {
  const result = {}
  for (const header of message.payload?.headers || []) {
    result[header.name.toLowerCase()] = decodeHeader(header.value || '')
  }
  return result
}

function partsOf(part, result = []) {
  if (!part) return result
  if (part.filename && part.body?.attachmentId) {
    result.push({
      id: part.body.attachmentId,
      filename: part.filename,
      mimeType: part.mimeType || 'application/octet-stream',
      size: Number(part.body.size || 0),
    })
  }
  if (part.parts) for (const child of part.parts) partsOf(child, result)
  return result
}

function bodyParts(part, result = { plain: '', html: '' }) {
  if (!part) return result
  const data = part.body?.data
  if (data) {
    const content = Buffer.from(data, 'base64url').toString('utf8')
    if (part.mimeType === 'text/plain' && !result.plain) result.plain = content
    if (part.mimeType === 'text/html' && !result.html) result.html = content
  }
  if (part.parts) for (const child of part.parts) bodyParts(child, result)
  return result
}

function htmlToText(html) {
  return html
    .replace(/<(script|style|head)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|li|tr|h[1-6])\s*>/gi, '\n')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_match, code) => {
      const point = Number(code)
      return point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff) ? String.fromCodePoint(point) : ' '
    })
    .replace(/\n[ \t]+/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
}

function publicMessage(message, includeBody = false) {
  const headers = headersOf(message)
  const result = {
    id: message.id,
    threadId: message.threadId,
    subject: headers.subject || '(no subject)',
    from: headers.from || '',
    to: headers.to || '',
    date: headers.date || '',
    messageId: headers['message-id'] || '',
    references: headers.references || '',
    snippet: message.snippet || '',
    labelIds: message.labelIds || [],
    unread: (message.labelIds || []).includes('UNREAD'),
    attachments: partsOf(message.payload),
  }
  if (includeBody) {
    const content = bodyParts(message.payload)
    result.body = content.plain || htmlToText(content.html) || message.snippet || ''
  }
  return result
}

async function listMessages(userId, account, url) {
  const query = (url.searchParams.get('q') || '').trim()
  if (query.length > 300) throw httpError(400, 'Search queries must be 300 characters or fewer.')
  const requestedLabel = url.searchParams.get('label') || 'INBOX'
  const labels = await googleRequest(userId, account, '/labels')
  const label = (labels.labels || []).find((item) => item.id === requestedLabel)
  if (!label || (!SYSTEM_LABELS.has(requestedLabel) && label.type !== 'user')) {
    throw httpError(400, 'Choose a valid Gmail label.')
  }
  const maxResults = Math.min(25, Math.max(1, Number(url.searchParams.get('maxResults')) || 25))
  const params = new URLSearchParams({ labelIds: requestedLabel, maxResults: String(maxResults) })
  if (query) params.set('q', query)
  const pageToken = url.searchParams.get('pageToken')
  if (pageToken) params.set('pageToken', pageToken)
  const listed = await googleRequest(userId, account, `/messages?${params}`)
  const ids = (listed.messages || []).map((message) => message.id)
  const messages = []
  for (let index = 0; index < ids.length; index += 5) {
    const batch = await Promise.all(
      ids.slice(index, index + 5).map((id) =>
        googleRequest(userId, account, `/messages/${encodeURIComponent(id)}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date`)
      )
    )
    messages.push(...batch.map((message) => publicMessage(message)))
  }
  return {
    messages,
    nextPageToken: listed.nextPageToken || null,
    resultSizeEstimate: Number(listed.resultSizeEstimate || 0),
  }
}

async function verifyPubSubToken(req) {
  const config = mailWatchConfiguration()
  if (!config) throw httpError(503, 'Gmail push notifications are not configured.')
  const authorization = req.headers.authorization || ''
  const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : ''
  const parts = token.split('.')
  if (parts.length !== 3 || token.length > 12_000) throw httpError(401, 'Invalid Pub/Sub authorization token.')
  let header
  let claims
  try {
    header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'))
    claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
  } catch {
    throw httpError(401, 'Invalid Pub/Sub authorization token.')
  }
  const now = Math.floor(Date.now() / 1000)
  if (
    header.alg !== 'RS256' ||
    !header.kid ||
    !['accounts.google.com', 'https://accounts.google.com'].includes(claims.iss) ||
    !(claims.aud === config.audience || (Array.isArray(claims.aud) && claims.aud.includes(config.audience))) ||
    claims.email !== config.serviceAccount ||
    claims.email_verified !== true ||
    !Number.isFinite(claims.exp) ||
    claims.exp <= now ||
    !Number.isFinite(claims.iat) ||
    claims.iat > now + 60
  ) {
    throw httpError(401, 'Pub/Sub authorization token is not valid for this endpoint.')
  }

  if (!pubSubKeys || pubSubKeys.expiresAt <= Date.now()) {
    const response = await fetch('https://www.googleapis.com/oauth2/v3/certs', {
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) throw httpError(503, 'Google signing keys could not be retrieved.')
    const result = await response.json()
    const cacheControl = response.headers.get('cache-control') || ''
    const maxAge = Number(cacheControl.match(/max-age=(\d+)/)?.[1] || 3600)
    pubSubKeys = { keys: result.keys || [], expiresAt: Date.now() + Math.min(maxAge, 21_600) * 1000 }
  }
  const jwk = pubSubKeys.keys.find((key) => key.kid === header.kid && key.kty === 'RSA')
  if (!jwk) throw httpError(401, 'Pub/Sub signing key is not recognized.')
  let validSignature = false
  try {
    validSignature = verifySignature(
      'RSA-SHA256',
      Buffer.from(`${parts[0]}.${parts[1]}`),
      createPublicKey({ key: jwk, format: 'jwk' }),
      Buffer.from(parts[2], 'base64url')
    )
  } catch {
    validSignature = false
  }
  if (!validSignature) throw httpError(401, 'Pub/Sub authorization signature is invalid.')
}

export async function handleMailPush(req, res, { readStore, updateStore }) {
  await verifyPubSubToken(req)
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > 64 * 1024) throw httpError(413, 'Pub/Sub notification is too large.')
    chunks.push(chunk)
  }
  let envelope
  try {
    envelope = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw httpError(400, 'Invalid Pub/Sub notification.')
  }
  if (envelope.subscription !== mailWatchConfiguration().subscription) {
    throw httpError(401, 'Pub/Sub notification came from an unrecognized subscription.')
  }
  const encoded = envelope?.message?.data
  if (typeof encoded !== 'string' || encoded.length > 20_000) {
    throw httpError(400, 'Pub/Sub notification has no valid Gmail event.')
  }
  let notification
  try {
    notification = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'))
  } catch {
    throw httpError(400, 'Pub/Sub Gmail event is invalid.')
  }
  if (typeof notification.emailAddress !== 'string' || !notification.historyId) {
    throw httpError(400, 'Pub/Sub Gmail event is missing its account or history checkpoint.')
  }

  const store = await readStore()
  const accounts = Object.entries(store.documents?.mailAccounts || {}).filter(
    ([, account]) => account.email?.toLowerCase() === notification.emailAddress.toLowerCase()
  )
  for (const [userId, account] of accounts) {
    let historyId = account.historyId
    try {
      if (historyId) {
        const history = await googleRequest(
          userId,
          account,
          `/history?startHistoryId=${encodeURIComponent(historyId)}&maxResults=500`
        )
        historyId = history.historyId || notification.historyId
      } else {
        historyId = notification.historyId
      }
    } catch (error) {
      if (error.status !== 404) throw error
      const profile = await googleRequest(userId, account, '/profile')
      historyId = profile.historyId || notification.historyId
    }
    const lastSyncAt = new Date().toISOString()
    await updateStore((current) => {
      const saved = current.documents?.mailAccounts?.[userId]
      if (saved) {
        saved.historyId = historyId
        saved.lastSyncAt = lastSyncAt
      }
    })
  }
  res.writeHead(204, { 'Cache-Control': 'no-store' })
  res.end()
}

export async function renewMailWatches({ readStore, updateStore }) {
  if (!mailWatchConfiguration()) return { configured: false, renewed: 0, failed: 0 }
  const store = await readStore()
  let renewed = 0
  let failed = 0
  for (const [userId, account] of Object.entries(store.documents?.mailAccounts || {})) {
    try {
      await ensureMailWatch(userId, account, updateStore)
      renewed += 1
    } catch (error) {
      failed += 1
      console.error('[taskflow-api] Gmail Pub/Sub watch renewal failed:', error.message)
    }
  }
  return { configured: true, renewed, failed }
}

export function scheduleMailWatchRenewal(dependencies) {
  let running = false
  const renew = async () => {
    if (running) return
    running = true
    try {
      await renewMailWatches(dependencies)
    } catch (error) {
      console.error('[taskflow-api] Gmail Pub/Sub watch renewal failed:', error.message)
    } finally {
      running = false
    }
  }
  void renew()
  const timer = setInterval(renew, 24 * 60 * 60 * 1000)
  timer.unref()
  return () => clearInterval(timer)
}

async function handleOAuthCallback(req, res, url, { readStore, updateStore }) {
  const state = url.searchParams.get('state')
  const store = await readStore()
  const pending = state ? store.documents?.mailOAuthStates?.[state] : null
  if (state && pending) {
    await updateStore((current) => {
      delete current.documents?.mailOAuthStates?.[state]
    })
  }
  if (!pending || pending.expiresAt <= Date.now() || oauthCookieValue(req) !== state) {
    return redirect(res, appRedirect('error'))
  }
  if (url.searchParams.has('error')) return redirect(res, appRedirect('error'))

  try {
    if (!url.searchParams.get('code')) throw httpError(400, 'Google did not return an authorization code.')
    const tokens = await exchangeCode(url.searchParams.get('code'))
    if (!tokens.refresh_token || !tokens.access_token) {
      throw httpError(502, 'Google did not return a refresh token. Reconnect and approve offline access.')
    }
    const temporaryAccount = { encryptedRefreshToken: encryptToken(tokens.refresh_token) }
    const [profile, userProfile] = await Promise.all([
      googleRequest(pending.userId, temporaryAccount, '/profile'),
      fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
        headers: { Authorization: `Bearer ${tokens.access_token}` },
        signal: AbortSignal.timeout(15_000),
      }).then(async (response) => {
        const body = await response.json().catch(() => ({}))
        if (!response.ok || !body.email) throw httpError(502, 'Google did not return an email address.')
        return body
      }),
    ])
    const account = {
      email: userProfile.email,
      googleSubject: userProfile.id || '',
      encryptedRefreshToken: temporaryAccount.encryptedRefreshToken,
      historyId: profile.historyId || '',
      connectedAt: new Date().toISOString(),
      lastSyncAt: '',
    }
    await updateStore((store) => {
      store.documents.mailAccounts ||= {}
      store.documents.mailAccounts[pending.userId] = account
    })
    accessTokens.set(pending.userId, {
      value: tokens.access_token,
      expiresAt: Date.now() + Math.max(60, Number(tokens.expires_in) || 3600) * 1000,
    })
    try {
      await ensureMailWatch(pending.userId, account, updateStore)
    } catch (error) {
      console.error('[taskflow-api] Gmail Pub/Sub watch could not be created:', error.message)
    }
    return redirect(res, appRedirect('connected'))
  } catch (error) {
    console.error('[taskflow-api] Gmail OAuth callback failed:', error.message)
    return redirect(res, appRedirect('error'))
  }
}

export async function handleMailRequest(req, res, url, user, { json, jsonBody, readStore, updateStore }) {
  const pathname = url.pathname
  if (pathname === '/api/mails/auth/google/callback' && req.method === 'GET') {
    return handleOAuthCallback(req, res, url, { readStore, updateStore })
  }
  if (!user.isAdmin && !(user.permissions || []).includes('mails')) {
    return json(res, 403, { error: 'Your account does not have access to Mails.' })
  }
  if (req.method === 'GET' && pathname === '/api/mails/status') {
    const account = accountFor(await readStore(), user)
    return json(res, 200, {
      connected: Boolean(account),
      email: account?.email || '',
      connectedAt: account?.connectedAt || '',
      lastSyncAt: account?.lastSyncAt || '',
    })
  }
  if (req.method === 'GET' && pathname === '/api/mails/summary') {
    const summaryAccount = accountFor(await readStore(), user)
    if (!summaryAccount) return json(res, 200, { connected: false, email: '', unreadCount: 0, messages: [] })
    const [inbox, unread] = await Promise.all([
      listMessages(user.id, summaryAccount, new URL('http://localhost/api/mails/messages?label=INBOX&maxResults=5')),
      listMessages(user.id, summaryAccount, new URL('http://localhost/api/mails/messages?label=INBOX&q=is%3Aunread&maxResults=1')),
    ])
    return json(res, 200, {
      connected: true,
      email: summaryAccount.email,
      unreadCount: unread.resultSizeEstimate,
      messages: inbox.messages.slice(0, 5),
    })
  }
  if (req.method === 'GET' && pathname === '/api/mails/auth/google') {
    const config = configuration()
    encryptionKey()
    const currentStore = await readStore()
    const pendingStates = Object.values(currentStore.documents?.mailOAuthStates || {})
      .filter((entry) => entry.expiresAt > Date.now())
    if (pendingStates.length >= 1000) throw httpError(503, 'Too many Gmail authorization attempts. Try again shortly.')
    const state = randomBytes(32).toString('hex')
    await updateStore((store) => {
      store.documents.mailOAuthStates ||= {}
      for (const [key, value] of Object.entries(store.documents.mailOAuthStates)) {
        if (value.expiresAt <= Date.now()) delete store.documents.mailOAuthStates[key]
      }
      store.documents.mailOAuthStates[state] = { userId: user.id, expiresAt: Date.now() + 10 * 60 * 1000 }
    })
    const authorization = new URL('https://accounts.google.com/o/oauth2/v2/auth')
    authorization.search = new URLSearchParams({
      client_id: config.clientId,
      redirect_uri: config.redirectUri,
      response_type: 'code',
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: 'true',
      scope: GOOGLE_SCOPES.join(' '),
      state,
    }).toString()
    const cookie = `taskflow_gmail_oauth=${state}; HttpOnly; SameSite=Lax; Path=/api/mails/auth/google/callback; Max-Age=600${process.env.NODE_ENV === 'production' || process.env.VERCEL ? '; Secure' : ''}`
    return json(res, 200, { url: authorization.toString() }, { 'Set-Cookie': cookie })
  }
  if (!pathname.startsWith('/api/mails/')) return json(res, 404, { error: 'Mails API route not found.' })

  const account = accountFor(await readStore(), user)
  if (req.method === 'POST' && pathname === '/api/mails/disconnect') {
    if (account) {
      let revokeFailed = false
      try {
        const token = decryptToken(account.encryptedRefreshToken)
        const response = await fetch('https://oauth2.googleapis.com/revoke', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ token }),
          signal: AbortSignal.timeout(10_000),
        })
        revokeFailed = !response.ok
      } catch {
        revokeFailed = true
      }
      accessTokens.delete(user.id)
      await updateStore((store) => {
        delete store.documents?.mailAccounts?.[user.id]
      })
      return json(res, 200, { disconnected: true, revokeFailed })
    }
    return json(res, 200, { disconnected: true, revokeFailed: false })
  }
  if (!account) return json(res, 409, { error: 'Connect a Gmail account to use this feature.' })

  if (req.method === 'GET' && pathname === '/api/mails/labels') {
    const data = await googleRequest(user.id, account, '/labels')
    return json(
      res,
      200,
      (data.labels || [])
        .filter((label) => SYSTEM_LABELS.has(label.id) || label.type === 'user')
        .map(({ id, name, type }) => ({ id, name, type }))
    )
  }
  if (req.method === 'GET' && pathname === '/api/mails/senders') {
    const data = await googleRequest(user.id, account, '/settings/sendAs')
    const preferred = (process.env.MAILS_SEND_AS_EMAIL || 'bilel.m@natheelco.com').toLowerCase()
    const senders = (data.sendAs || [])
      .filter((sender) => sender.verificationStatus === 'accepted')
      .map((sender) => ({
        email: sender.sendAsEmail,
        name: sender.displayName || sender.sendAsEmail,
        primary: Boolean(sender.isPrimary),
      }))
    return json(res, 200, {
      senders,
      defaultEmail: senders.find((sender) => sender.email.toLowerCase() === preferred)?.email ||
        senders.find((sender) => sender.primary)?.email ||
        senders[0]?.email ||
        '',
      requestedEmail: preferred,
    })
  }
  if (req.method === 'GET' && pathname === '/api/mails/messages') {
    return json(res, 200, await listMessages(user.id, account, url))
  }
  if (req.method === 'GET' && pathname.startsWith('/api/mails/threads/')) {
    const threadId = pathname.slice('/api/mails/threads/'.length)
    if (!threadId || threadId.length > 200) return json(res, 400, { error: 'Invalid Gmail thread.' })
    const thread = await googleRequest(user.id, account, `/threads/${encodeURIComponent(threadId)}?format=full`)
    return json(res, 200, { messages: (thread.messages || []).map((message) => publicMessage(message, true)) })
  }
  if (req.method === 'POST' && pathname === '/api/mails/sync') {
    let startHistoryId = account.historyId
    let changes = 0
    let reset = false
    try {
      if (startHistoryId) {
        const history = await googleRequest(
          user.id,
          account,
          `/history?startHistoryId=${encodeURIComponent(startHistoryId)}&maxResults=500`
        )
        changes = (history.history || []).length
        startHistoryId = history.historyId || startHistoryId
      } else {
        reset = true
      }
    } catch (error) {
      if (error.status !== 404) throw error
      reset = true
    }
    if (reset) {
      const profile = await googleRequest(user.id, account, '/profile')
      startHistoryId = profile.historyId || ''
    }
    const lastSyncAt = new Date().toISOString()
    await updateStore((store) => {
      const current = accountFor(store, user)
      if (current) {
        current.historyId = startHistoryId
        current.lastSyncAt = lastSyncAt
      }
    })
    try {
      await ensureMailWatch(user.id, account, updateStore)
    } catch (error) {
      console.error('[taskflow-api] Gmail Pub/Sub watch renewal failed:', error.message)
    }
    return json(res, 200, { changes, reset, lastSyncAt })
  }
  if (req.method === 'POST' && pathname === '/api/mails/send') {
    const body = await jsonBody(req)
    if ([body.to, body.cc, body.bcc].some((value) => Array.isArray(value) && value.some((email) => typeof email !== 'string'))) {
      return json(res, 400, { error: 'Recipients must be email address strings.' })
    }
    const recipientList = (value) => (Array.isArray(value) ? value : String(value || '').split(','))
      .map((value) => value.trim())
      .filter(Boolean)
    const toRecipients = recipientList(body.to)
    const recipients = [body.to, body.cc, body.bcc].flatMap(recipientList)
    if (
      !toRecipients.length ||
      recipients.length > 25 ||
      recipients.some((email) => !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email))
    ) {
      return json(res, 400, { error: 'Enter between 1 and 25 valid recipient email addresses.' })
    }
    const subject = String(body.subject || '')
    const text = String(body.body || '')
    if (subject.length > 998 || /[\r\n]/.test(subject)) {
      return json(res, 400, { error: 'The subject must be 998 characters or fewer and cannot contain line breaks.' })
    }
    if (!text.trim() || text.length > 1_000_000) {
      return json(res, 400, { error: 'Enter a message of up to 1 MB.' })
    }
    const sendAs = await googleRequest(user.id, account, '/settings/sendAs')
    const requestedFrom = typeof body.from === 'string' ? body.from.trim() : ''
    const preferred = (process.env.MAILS_SEND_AS_EMAIL || 'bilel.m@natheelco.com').toLowerCase()
    const verifiedSenders = (sendAs.sendAs || []).filter((sender) => sender.verificationStatus === 'accepted')
    const selectedSender = requestedFrom
      ? verifiedSenders.find((sender) => sender.sendAsEmail.toLowerCase() === requestedFrom.toLowerCase())
      : verifiedSenders.find((sender) => sender.sendAsEmail.toLowerCase() === preferred) ||
        verifiedSenders.find((sender) => sender.isPrimary) ||
        verifiedSenders[0]
    if (!selectedSender) {
      return json(res, 400, {
        error: requestedFrom
          ? 'That From address is not a verified send-as address in the connected Gmail account.'
          : `Add and verify ${preferred} in Gmail Settings > Accounts > Send mail as, then reconnect Gmail in TaskFlow.`,
      })
    }
    const encodeHeader = (value) => `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`
    const wrapBase64 = (value) => value.match(/.{1,76}/g)?.join('\r\n') || ''
    const headers = [`To: ${toRecipients.join(', ')}`]
    headers.push(`From: ${selectedSender.sendAsEmail}`)
    for (const [name, value] of [['Cc', body.cc], ['Bcc', body.bcc]]) {
      const list = recipientList(value)
      if (list.length) headers.push(`${name}: ${list.join(', ')}`)
    }
    if (typeof body.inReplyTo === 'string' && body.inReplyTo.length <= 998 && !/[\r\n]/.test(body.inReplyTo)) {
      headers.push(`In-Reply-To: ${body.inReplyTo}`)
    }
    if (typeof body.references === 'string' && body.references.length <= 2000 && !/[\r\n]/.test(body.references)) {
      headers.push(`References: ${body.references}`)
    }
    headers.push(
      `Subject: ${encodeHeader(subject)}`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
      '',
      wrapBase64(Buffer.from(text, 'utf8').toString('base64'))
    )
    const raw = Buffer.from(headers.join('\r\n'), 'utf8').toString('base64url')
    const sendBody = { raw }
    if (typeof body.threadId === 'string' && body.threadId.length <= 200) sendBody.threadId = body.threadId
    const sent = await googleRequest(user.id, account, '/messages/send', {
      method: 'POST',
      body: JSON.stringify(sendBody),
    })
    return json(res, 200, { id: sent.id, threadId: sent.threadId })
  }
  if (req.method === 'POST' && pathname.startsWith('/api/mails/messages/') && pathname.endsWith('/actions')) {
    const messageId = pathname.slice('/api/mails/messages/'.length, -'/actions'.length)
    if (!messageId || messageId.includes('/')) return json(res, 400, { error: 'Invalid Gmail message.' })
    const body = await jsonBody(req)
    if (body.action === 'trash' || body.action === 'untrash' || body.action === 'delete') {
      await googleRequest(user.id, account, `/messages/${encodeURIComponent(messageId)}${body.action === 'delete' ? '' : `/${body.action}`}`, {
        method: body.action === 'delete' ? 'DELETE' : 'POST',
      })
      return json(res, 200, { updated: true })
    }
    const operations = {
      read: { removeLabelIds: ['UNREAD'] },
      unread: { addLabelIds: ['UNREAD'] },
      star: { addLabelIds: ['STARRED'] },
      unstar: { removeLabelIds: ['STARRED'] },
      archive: { removeLabelIds: ['INBOX'] },
      inbox: { addLabelIds: ['INBOX'] },
      spam: { addLabelIds: ['SPAM'], removeLabelIds: ['INBOX'] },
      notSpam: { removeLabelIds: ['SPAM'], addLabelIds: ['INBOX'] },
    }
    const operation = operations[body.action]
    if (!operation) return json(res, 400, { error: 'Unsupported Gmail action.' })
    await googleRequest(user.id, account, `/messages/${encodeURIComponent(messageId)}/modify`, {
      method: 'POST',
      body: JSON.stringify(operation),
    })
    return json(res, 200, { updated: true })
  }
  const attachmentMatch = pathname.match(/^\/api\/mails\/messages\/([^/]+)\/attachments\/([^/]+)$/)
  if (req.method === 'GET' && attachmentMatch) {
    const [, messageId, attachmentId] = attachmentMatch
    const attachment = await googleRequest(
      user.id,
      account,
      `/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`
    )
    const content = Buffer.from(attachment.data || '', 'base64url')
    if (content.length > 25 * 1024 * 1024) return json(res, 413, { error: 'This attachment exceeds the 25 MB download limit.' })
    const filename = String(url.searchParams.get('filename') || 'attachment')
      .replace(/[\r\n"]/g, '_')
      .slice(0, 180)
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': content.length,
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store',
    })
    return res.end(content)
  }
  if (req.method !== 'GET' && req.method !== 'POST') {
    return json(res, 405, { error: 'Method not allowed.' }, { Allow: 'GET, POST' })
  }
  return json(res, 404, { error: 'Mails API route not found.' })
}

export async function handleMailOAuthCallback(req, res, url, dependencies) {
  return handleOAuthCallback(req, res, url, dependencies)
}
