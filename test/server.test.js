import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import os from 'node:os'
import path from 'node:path'

let server
let baseUrl
let dataDir
let uploadDir
let adminCookie
let createAppServer

async function call(route, { method = 'GET', body, cookie, token, origin } = {}) {
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(cookie ? { Cookie: cookie } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(origin ? { Origin: origin } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await response.text()
  return {
    response,
    body: text ? JSON.parse(text) : null,
    cookie: response.headers.get('set-cookie')?.split(';')[0],
  }
}

before(async () => {
  dataDir = await mkdtemp(path.join(os.tmpdir(), 'taskflow-data-'))
  uploadDir = await mkdtemp(path.join(os.tmpdir(), 'taskflow-uploads-'))
  await writeFile(
    path.join(dataDir, 'store.json'),
    JSON.stringify({
      auth: { adminPin: null, users: [] },
      documents: { tasks: { migrated: { data: { title: 'Imported from previous backend' } } } },
      uploads: {},
    })
  )
  process.env.DATA_DIR = dataDir
  process.env.UPLOAD_DIR = uploadDir
  process.env.FRONTEND_ORIGINS = 'https://frontend.example'
  ;({ createAppServer } = await import('../src/server.js'))
  server = createAppServer()
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  baseUrl = `http://127.0.0.1:${server.address().port}`
})

after(async () => {
  await new Promise((resolve) => server.close(resolve))
  await rm(dataDir, { recursive: true, force: true })
  await rm(uploadDir, { recursive: true, force: true })
  delete process.env.DATA_DIR
  delete process.env.UPLOAD_DIR
  delete process.env.FRONTEND_ORIGINS
})

test('requires authentication and configures the admin PIN once', async () => {
  const crossOrigin = await call('/api/auth', {
    method: 'POST',
    origin: 'https://untrusted.example',
    body: { action: 'setup', pin: '123456' },
  })
  assert.equal(crossOrigin.response.status, 403)

  const protectedResponse = await call('/api/docs?collection=tasks')
  assert.equal(protectedResponse.response.status, 401)

  const setup = await call('/api/auth', {
    method: 'POST',
    body: { action: 'setup', pin: '123456', remember: false },
  })
  assert.equal(setup.response.status, 200)
  adminCookie = setup.cookie
  assert.ok(adminCookie?.startsWith('taskflow_session='))

  const duplicateSetup = await call('/api/auth', {
    method: 'POST',
    body: { action: 'setup', pin: '654321' },
  })
  assert.equal(duplicateSetup.response.status, 409)
  const preservedLegacyFile = JSON.parse(await readFile(path.join(dataDir, 'store.json'), 'utf8'))
  assert.equal(preservedLegacyFile.documents.tasks.migrated.data.title, 'Imported from previous backend')
})

test('allows authenticated API requests from the configured frontend origin', async () => {
  const login = await call('/api/auth', {
    method: 'POST',
    origin: 'https://frontend.example',
    body: { action: 'login', pin: '123456', remember: false },
  })
  assert.equal(login.response.status, 200)
  assert.equal(login.response.headers.get('access-control-allow-origin'), 'https://frontend.example')
  assert.match(login.response.headers.get('set-cookie'), /SameSite=None;.*Secure/)
  assert.ok(login.body.token)

  const protectedResponse = await call('/api/docs?collection=tasks', {
    origin: 'https://frontend.example',
    token: login.body.token,
  })
  assert.equal(protectedResponse.response.status, 200)

  const preflight = await fetch(`${baseUrl}/api/docs`, {
    method: 'OPTIONS',
    headers: {
      Origin: 'https://frontend.example',
      'Access-Control-Request-Method': 'PATCH',
      'Access-Control-Request-Headers': 'authorization,content-type',
    },
  })
  assert.equal(preflight.status, 204)
  assert.equal(preflight.headers.get('access-control-allow-origin'), 'https://frontend.example')

  const denied = await call('/api/auth', { origin: 'https://untrusted.example' })
  assert.equal(denied.response.status, 403)
})

test('reserves Cash & Bank adjustment numbers atomically', async () => {
  const first = await call('/api/cashbank/sequences', {
    method: 'POST',
    cookie: adminCookie,
    body: { kind: 'credit', year: '2026', count: 2 },
  })
  const second = await call('/api/cashbank/sequences', {
    method: 'POST',
    cookie: adminCookie,
    body: { kind: 'credit', year: '2026', count: 1 },
  })
  assert.equal(first.response.status, 200)
  assert.deepEqual(first.body, { sequenceKey: 'credit-2026', first: 1, last: 2 })
  assert.deepEqual(second.body, { sequenceKey: 'credit-2026', first: 3, last: 3 })
})

test('merges concurrent Cash & Bank and Natheel Gulf additions', async () => {
  const firstNote = {
    id: 'CN-2026-0001',
    kind: 'credit',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  }
  await call('/api/docs', {
    method: 'PUT',
    cookie: adminCookie,
    body: {
      path: 'cashbankAccounting/main',
      data: { notes: [firstNote], sequences: { 'credit-2026': 3 }, audit: [] },
    },
  })
  const secondNote = {
    id: 'CN-2026-0002',
    kind: 'credit',
    createdAt: '2026-01-02T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
  }
  await call('/api/docs', {
    method: 'PATCH',
    cookie: adminCookie,
    body: {
      path: 'cashbankAccounting/main',
      data: { notes: [firstNote, secondNote], sequences: { 'credit-2026': 1 }, audit: [] },
    },
  })
  const accounting = await call('/api/docs?path=cashbankAccounting%2Fmain', { cookie: adminCookie })
  assert.equal(accounting.body.data.notes.length, 2)
  assert.equal(accounting.body.data.sequences['credit-2026'], 3)

  await call('/api/docs', {
    method: 'PUT',
    cookie: adminCookie,
    body: {
      path: 'gulf/main',
      data: { nodes: [], assets: [{ id: 'asset-1' }], contacts: [{ name: 'First', email: 'first@example.com' }] },
    },
  })
  await call('/api/docs', {
    method: 'PATCH',
    cookie: adminCookie,
    body: {
      path: 'gulf/main',
      data: {
        assets: [{ id: 'asset-1' }, { id: 'asset-2' }],
        contacts: [{ name: 'First', email: 'first@example.com' }, { name: 'Second', email: 'second@example.com' }],
      },
    },
  })
  await call('/api/docs', {
    method: 'PATCH',
    cookie: adminCookie,
    body: {
      path: 'gulf/main',
      data: {
        assets: [{ id: 'asset-1' }, { id: 'asset-3' }],
        contacts: [
          { name: 'First', email: 'first@example.com' },
          { name: 'Third', email: 'third@example.com' },
        ],
      },
    },
  })
  const gulf = await call('/api/docs?path=gulf%2Fmain', { cookie: adminCookie })
  assert.deepEqual(gulf.body.data.assets.map((asset) => asset.id).sort(), ['asset-1', 'asset-2', 'asset-3'])
  assert.deepEqual(
    gulf.body.data.contacts.map((contact) => contact.email).sort(),
    ['first@example.com', 'second@example.com', 'third@example.com']
  )
})

test('keeps Gmail account state authenticated and binds OAuth state to the browser', async () => {
  const unauthenticated = await call('/api/mails/status')
  assert.equal(unauthenticated.response.status, 401)

  const status = await call('/api/mails/status', { cookie: adminCookie })
  assert.equal(status.response.status, 200)
  assert.deepEqual(status.body, { connected: false, email: '', connectedAt: '', lastSyncAt: '' })
  const anonymousSummary = await call('/api/mails/summary')
  assert.equal(anonymousSummary.response.status, 401)
  const disconnectedSummary = await call('/api/mails/summary', { cookie: adminCookie })
  assert.deepEqual(disconnectedSummary.body, {
    connected: false,
    email: '',
    unreadCount: 0,
    messages: [],
  })

  const saved = {
    clientId: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    redirectUri: process.env.GOOGLE_REDIRECT_URI,
    encryptionKey: process.env.MAILS_TOKEN_ENCRYPTION_KEY,
  }
  try {
    process.env.GOOGLE_CLIENT_ID = 'test-client-id'
    process.env.GOOGLE_CLIENT_SECRET = 'test-client-secret'
    process.env.GOOGLE_REDIRECT_URI = 'http://localhost:8889/api/mails/auth/google/callback'
    process.env.MAILS_TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64')
    const authorization = await call('/api/mails/auth/google', { cookie: adminCookie })
    assert.equal(authorization.response.status, 200)
    const authorizationUrl = new URL(authorization.body.url)
    assert.equal(authorizationUrl.hostname, 'accounts.google.com')
    assert.equal(authorizationUrl.searchParams.get('redirect_uri'), 'http://localhost:8889/api/mails/auth/google/callback')
    assert.equal(authorizationUrl.searchParams.get('access_type'), 'offline')
    const state = authorizationUrl.searchParams.get('state')
    assert.ok(state)

    const callbackWithoutBrowserCookie = await fetch(
      `${baseUrl}/api/mails/auth/google/callback?state=${encodeURIComponent(state)}&code=unused`,
      { redirect: 'manual' }
    )
    assert.equal(callbackWithoutBrowserCookie.status, 302)
    assert.match(callbackWithoutBrowserCookie.headers.get('location'), /gmail=error/)
    assert.match(callbackWithoutBrowserCookie.headers.get('set-cookie'), /taskflow_gmail_oauth=;/)
  } finally {
    if (saved.clientId === undefined) delete process.env.GOOGLE_CLIENT_ID
    else process.env.GOOGLE_CLIENT_ID = saved.clientId
    if (saved.clientSecret === undefined) delete process.env.GOOGLE_CLIENT_SECRET
    else process.env.GOOGLE_CLIENT_SECRET = saved.clientSecret
    if (saved.redirectUri === undefined) delete process.env.GOOGLE_REDIRECT_URI
    else process.env.GOOGLE_REDIRECT_URI = saved.redirectUri
    if (saved.encryptionKey === undefined) delete process.env.MAILS_TOKEN_ENCRYPTION_KEY
    else process.env.MAILS_TOKEN_ENCRYPTION_KEY = saved.encryptionKey
  }
})

test('rejects unauthenticated Gmail Pub/Sub notifications before processing payloads', async () => {
  const names = [
    'MAILS_PUBSUB_TOPIC',
    'MAILS_PUBSUB_SUBSCRIPTION',
    'MAILS_PUBSUB_AUDIENCE',
    'MAILS_PUBSUB_SERVICE_ACCOUNT',
  ]
  const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]))
  try {
    process.env.MAILS_PUBSUB_TOPIC = 'projects/taskflow-test/topics/gmail'
    process.env.MAILS_PUBSUB_SUBSCRIPTION = 'projects/taskflow-test/subscriptions/gmail-push'
    process.env.MAILS_PUBSUB_AUDIENCE = 'https://api.example.test/api/mails/pubsub'
    process.env.MAILS_PUBSUB_SERVICE_ACCOUNT = 'gmail-push@example.test'
    const response = await call('/api/mails/pubsub', {
      method: 'POST',
      body: { message: { data: 'e30=' } },
    })
    assert.equal(response.response.status, 401)
  } finally {
    for (const name of names) {
      if (saved[name] === undefined) delete process.env[name]
      else process.env[name] = saved[name]
    }
  }
})

test('persists document CRUD and bulk imports', async () => {
  const created = await call('/api/docs', {
    method: 'PUT',
    cookie: adminCookie,
    body: { path: 'tasks/task-1', data: { title: 'Initial', status: 'To Do' } },
  })
  assert.equal(created.response.status, 201)

  const patched = await call('/api/docs', {
    method: 'PATCH',
    cookie: adminCookie,
    body: { path: 'tasks/task-1', data: { status: 'Done' } },
  })
  assert.deepEqual(patched.body.data, { title: 'Initial', status: 'Done' })

  await call('/api/docs?collection=history', {
    method: 'POST',
    cookie: adminCookie,
    body: { items: [{ id: 'old-1', data: { title: 'Imported' } }] },
  })
  const listed = await call('/api/docs?collection=tasks', { cookie: adminCookie })
  assert.ok(listed.body.some((row) => row.id === 'task-1' && row.data.status === 'Done'))
  assert.ok(listed.body.some((row) => row.id === 'migrated'))

  const employeeReview = await call('/api/docs', {
    method: 'PUT',
    cookie: adminCookie,
    body: {
      path: 'kpiReviews/review-employee-1',
      data: {
        employee: 'Team member',
        date: '2026-11-05',
        scores: { communication: 8, targets: 7, delivery: 9, teamwork: 8, development: 10 },
      },
    },
  })
  assert.equal(employeeReview.response.status, 201)
  const employeeReviews = await call('/api/docs?collection=kpiReviews', { cookie: adminCookie })
  assert.ok(employeeReviews.body.some((row) => row.id === 'review-employee-1'))
  const invalidEmployeeReview = await call('/api/docs', {
    method: 'PUT',
    cookie: adminCookie,
    body: {
      path: 'kpiReviews/review-invalid',
      data: {
        employee: 'Team member',
        date: '2026-11-05',
        scores: { communication: 11, targets: 7, delivery: 9, teamwork: 8, development: 10 },
      },
    },
  })
  assert.equal(invalidEmployeeReview.response.status, 400)

  const preferences = await call('/api/docs', {
    method: 'PUT',
    cookie: adminCookie,
    body: { path: 'preferences/admin', data: { page: 'tasks', taskMode: 'board' } },
  })
  assert.equal(preferences.response.status, 201)
  const persistentStore = new DatabaseSync(path.join(dataDir, 'taskflow.sqlite'))
  const savedState = JSON.parse(persistentStore.prepare('SELECT store_json FROM app_state WHERE id = 1').get().store_json)
  assert.equal(savedState.documents.tasks['task-1'].data.status, 'Done')
  assert.equal(savedState.documents.preferences.admin.data.taskMode, 'board')
  assert.ok(persistentStore.prepare('SELECT count(*) AS count FROM audit_events').get().count >= 3)
  persistentStore.close()
})

test('serves a filtered CEO dashboard aggregate only to CEO dashboard users', async () => {
  const unauthenticated = await call('/api/dashboard/ceo')
  assert.equal(unauthenticated.response.status, 401)

  const config = await call('/api/docs', {
    method: 'PUT',
    cookie: adminCookie,
    body: {
      path: 'config/main',
      data: {
        projects: [
          { id: 'root', name: 'Root', color: '#000000', parent: '' },
          { id: 'alpha', name: 'Alpha', color: '#111111', parent: 'root' },
          { id: 'beta', name: 'Beta', color: '#222222', parent: 'root' },
        ],
        target: 1,
        w: { ontime: 35, target: 20, overdue: 15, volume: 30 },
      },
    },
  })
  assert.equal(config.response.status, 201)

  const localTask = await call('/api/docs', {
    method: 'PUT',
    cookie: adminCookie,
    body: {
      path: 'tasks/local-task',
      data: {
        title: 'Local task',
        project: 'beta',
        assignee: 'Local Owner',
        status: 'To Do',
        due: '2099-01-01',
        updated: 3,
      },
    },
  })
  assert.equal(localTask.response.status, 201)

  const clickupSnapshot = await call('/api/docs', {
    method: 'PUT',
    cookie: adminCookie,
    body: {
      path: 'integrations/clickup',
      data: {
        configured: true,
        members: [{ id: 'clickup-owner', name: 'ClickUp Owner' }],
        tasks: [
          {
            id: 'clickup-done',
            name: 'Completed ClickUp task',
            status: { status: 'complete', type: 'done' },
            assignees: [{ id: 'clickup-owner' }],
            list: { name: 'Alpha' },
            due_date: String(Date.parse('2020-06-02T23:59:59Z')),
            date_closed: Date.parse('2020-06-02T12:00:00Z'),
            date_updated: '2',
          },
          {
            id: 'clickup-overdue',
            name: 'Overdue ClickUp task',
            status: { status: 'in progress', type: 'custom' },
            assignees: [{ id: 'clickup-owner' }],
            list: { name: 'Alpha' },
            due_date: String(Date.parse('2020-06-03T23:59:59Z')),
            date_updated: '1',
          },
        ],
        truncated: false,
      },
    },
  })
  assert.equal(clickupSnapshot.response.status, 201)

  const users = await call('/api/users', {
    method: 'PUT',
    cookie: adminCookie,
    body: {
      users: [
        { id: 'ceo-viewer', name: 'CEO Viewer', pin: '4321', permissions: ['dash'] },
        { id: 'limited-viewer', name: 'Limited Viewer', pin: '8765', permissions: ['hr'] },
      ],
    },
  })
  assert.equal(users.response.status, 200)

  const ceoLogin = await call('/api/auth', {
    method: 'POST',
    body: { action: 'login', pin: '4321', remember: false },
  })
  assert.equal(ceoLogin.response.status, 200)

  const summary = await call('/api/dashboard/ceo?project=root', { cookie: ceoLogin.cookie })
  assert.equal(summary.response.status, 200)
  assert.deepEqual(summary.body.filters, { project: 'root', assignee: '', status: '' })
  const { teamKpiScore, ...totals } = summary.body.totals
  assert.deepEqual(totals, {
    tasks: 3,
    completed: 1,
    open: 2,
    onTime: 1,
    onTimeRate: 100,
    overdue: 1,
    employeeCount: 2,
  })
  assert.ok(Number.isInteger(teamKpiScore))
  assert.equal(summary.body.statusCounts['To Do'], 1)
  assert.equal(summary.body.statusCounts['In Progress'], 1)
  assert.equal(summary.body.statusCounts.Done, 1)
  assert.deepEqual(
    summary.body.projectProgress.map(({ id, tasks, done }) => ({ id, tasks, done })),
    [
      { id: 'alpha', tasks: 2, done: 1 },
      { id: 'beta', tasks: 1, done: 0 },
    ]
  )
  assert.ok(summary.body.sources.taskflowTasks >= 1)
  assert.equal(summary.body.sources.clickup.tasks, 2)

  const filtered = await call('/api/dashboard/ceo?project=alpha&status=Overdue', { cookie: ceoLogin.cookie })
  assert.equal(filtered.response.status, 200)
  assert.equal(filtered.body.totals.tasks, 1)
  assert.equal(filtered.body.totals.overdue, 1)
  assert.equal(filtered.body.statusCounts['In Progress'], 1)

  const invalidFilter = await call('/api/dashboard/ceo?status=unknown', { cookie: ceoLogin.cookie })
  assert.equal(invalidFilter.response.status, 400)

  const limitedLogin = await call('/api/auth', {
    method: 'POST',
    body: { action: 'login', pin: '8765', remember: false },
  })
  const denied = await call('/api/dashboard/ceo', { cookie: limitedLogin.cookie })
  assert.equal(denied.response.status, 403)

  await call('/api/users', { method: 'PUT', cookie: adminCookie, body: { users: [] } })
})

test('creates meetings without fabricated join links and rejects malformed document paths', async () => {
  const meeting = await call('/api/meetings', {
    method: 'POST',
    cookie: adminCookie,
    body: { platform: 'google', title: 'Weekly sync', start: 1000 },
  })
  assert.equal(meeting.response.status, 201)
  assert.equal(meeting.body.meeting.title, 'Weekly sync')
  assert.equal(meeting.body.meeting.joinUrl, undefined)

  const invalidPath = await call('/api/docs?path=../../store.json', {
    method: 'DELETE',
    cookie: adminCookie,
  })
  assert.equal(invalidPath.response.status, 400)
})

test('stores uploaded files behind authenticated routes', async () => {
  const form = new FormData()
  form.append('file', new Blob(['taskflow upload test'], { type: 'text/plain' }), 'ملاحظات.txt')
  const uploadResponse = await fetch(`${baseUrl}/api/files?scope=foodics`, {
    method: 'POST',
    headers: { Cookie: adminCookie },
    body: form,
  })
  const uploaded = await uploadResponse.json()
  assert.equal(uploadResponse.status, 201)
  assert.equal(uploaded.name, 'ملاحظات.txt')

  const download = await fetch(`${baseUrl}${uploaded.url}`, { headers: { Cookie: adminCookie } })
  assert.equal(download.status, 200)
  assert.match(download.headers.get('content-disposition'), /filename\*=UTF-8''/)
  assert.equal(await download.text(), 'taskflow upload test')

  const deleted = await call(uploaded.url, { method: 'DELETE', cookie: adminCookie })
  assert.equal(deleted.response.status, 200)
})

test('creates role accounts whose section permissions are enforced server-side', async () => {
  const users = await call('/api/users', {
    method: 'PUT',
    cookie: adminCookie,
    body: { users: [{ id: 'person-1', name: 'Team member', pin: '6789', permissions: ['hr', 'foodics', 'cashbank', 'mails'] }] },
  })
  assert.equal(users.response.status, 200)
  assert.deepEqual(users.body, [{ id: 'person-1', name: 'Team member', permissions: ['hr', 'foodics', 'cashbank', 'mails'] }])

  const login = await call('/api/auth', {
    method: 'POST',
    body: { action: 'login', pin: '6789', remember: false },
  })
  assert.equal(login.response.status, 200)
  assert.deepEqual(login.body.activeUser.permissions, ['hr', 'foodics', 'cashbank', 'mails'])

  const allowed = await call('/api/docs?collection=hr', { cookie: login.cookie })
  assert.equal(allowed.response.status, 200)
  assert.equal((await call('/api/docs?collection=cashbankPurchases', { cookie: login.cookie })).response.status, 200)
  assert.equal((await call('/api/mails/status', { cookie: login.cookie })).response.status, 200)
  const statementFile = new FormData()
  statementFile.append('file', new Blob(['bank statement']), 'statement.csv')
  const statementUpload = await fetch(`${baseUrl}/api/files?scope=cashbank`, {
    method: 'POST',
    headers: { Cookie: login.cookie },
    body: statementFile,
  })
  assert.equal(statementUpload.status, 201)
  const uploadedStatement = await statementUpload.json()
  assert.equal((await fetch(`${baseUrl}${uploadedStatement.url}`, { headers: { Cookie: login.cookie } })).status, 200)
  assert.equal((await call(uploadedStatement.url, { method: 'DELETE', cookie: login.cookie })).response.status, 200)
  const hrForm = new FormData()
  hrForm.append('file', new Blob(['private HR document']), 'employee-contract.txt')
  const hrUpload = await fetch(`${baseUrl}/api/files?scope=hr`, {
    method: 'POST',
    headers: { Cookie: login.cookie },
    body: hrForm,
  })
  assert.equal(hrUpload.status, 201)
  const uploadedHrFile = await hrUpload.json()
  assert.equal((await fetch(`${baseUrl}${uploadedHrFile.url}`, { headers: { Cookie: login.cookie } })).status, 200)
  const removedHrFile = await call(uploadedHrFile.url, { method: 'DELETE', cookie: login.cookie })
  assert.equal(removedHrFile.response.status, 200)
  const settings = await call('/api/docs?path=foodics-settings%2Fproject-one', { cookie: login.cookie })
  assert.equal(settings.response.status, 200)
  const ownPreferences = await call('/api/docs', {
    method: 'PUT',
    cookie: login.cookie,
    body: { path: 'preferences/person-1', data: { page: 'hr' } },
  })
  assert.equal(ownPreferences.response.status, 201)
  const otherPreferences = await call('/api/docs?path=preferences%2Fadmin', { cookie: login.cookie })
  assert.equal(otherPreferences.response.status, 403)
  const denied = await call('/api/docs?collection=tasks', { cookie: login.cookie })
  assert.equal(denied.response.status, 403)
  const deniedAudit = await call('/api/audit', { cookie: login.cookie })
  assert.equal(deniedAudit.response.status, 403)
  const deniedEmployeeReviews = await call('/api/docs?collection=kpiReviews', { cookie: login.cookie })
  assert.equal(deniedEmployeeReviews.response.status, 403)
  const deniedEmployeeReviewWrite = await call('/api/docs', {
    method: 'PUT',
    cookie: login.cookie,
    body: { path: 'kpiReviews/review-employee-2', data: { employee: 'Team member', scores: {} } },
  })
  assert.equal(deniedEmployeeReviewWrite.response.status, 403)

  const removed = await call('/api/users', {
    method: 'PUT',
    cookie: adminCookie,
    body: { users: [] },
  })
  assert.equal(removed.response.status, 200)
  const revoked = await call('/api/docs?collection=hr', { cookie: login.cookie })
  assert.equal(revoked.response.status, 401)

  const adminAudit = await call('/api/audit?limit=20', { cookie: adminCookie })
  assert.equal(adminAudit.response.status, 200)
  assert.ok(adminAudit.body.some((event) => event.action === 'users.save'))
})

test('notices permission exposes operational task and meeting notices without HR access', async () => {
  const users = await call('/api/users', {
    method: 'PUT',
    cookie: adminCookie,
    body: { users: [{ id: 'notice-viewer', name: 'Notice viewer', pin: '2468', permissions: ['notices'] }] },
  })
  assert.equal(users.response.status, 200)
  assert.deepEqual(users.body, [{ id: 'notice-viewer', name: 'Notice viewer', permissions: ['notices'] }])

  const login = await call('/api/auth', {
    method: 'POST',
    body: { action: 'login', pin: '2468', remember: false },
  })
  assert.equal(login.response.status, 200)
  assert.equal((await call('/api/docs?collection=tasks', { cookie: login.cookie })).response.status, 200)
  assert.equal((await call('/api/docs?collection=meetings', { cookie: login.cookie })).response.status, 200)
  assert.equal((await call('/api/docs?collection=hr', { cookie: login.cookie })).response.status, 403)
  assert.equal((await call('/api/docs?collection=cashbankPurchases', { cookie: login.cookie })).response.status, 403)
})

test('keeps records and the audit log after restarting the backend', async () => {
  await new Promise((resolve) => server.close(resolve))
  server = createAppServer()
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  baseUrl = `http://127.0.0.1:${server.address().port}`

  const login = await call('/api/auth', {
    method: 'POST',
    body: { action: 'login', pin: '123456', remember: false },
  })
  assert.equal(login.response.status, 200)
  adminCookie = login.cookie

  const task = await call('/api/docs?path=tasks%2Ftask-1', { cookie: adminCookie })
  assert.deepEqual(task.body, { exists: true, data: { title: 'Initial', status: 'Done' } })
  const audit = await call('/api/audit?limit=100', { cookie: adminCookie })
  assert.equal(audit.response.status, 200)
  assert.ok(audit.body.some((event) => event.action === 'auth.login'))
})

test('provides complete HR employee CRUD, duplicate serial prevention, and batch import', async () => {
  // 1. Create employee
  const created = await call('/api/hr/employees', {
    method: 'POST',
    cookie: adminCookie,
    body: {
      firstName: 'Ahmed',
      lastName: 'Al-Mansour',
      serialNumber: 'EMP-001',
      dob: '1990-05-15',
      email: 'ahmed.mansour@natheelco.com',
      phone: '+966501234567',
      nationality: 'Saudi',
      position: 'Senior Operations Manager',
      department: 'Operations',
      monthlySalary: 15000,
      annualSalary: 180000,
      status: 'Active',
      company: 'Natheelco',
      branch: 'Riyadh HQ',
    },
  })
  assert.equal(created.response.status, 201)
  assert.equal(created.body.employee.data.name, 'Ahmed Al-Mansour')
  assert.equal(created.body.employee.data.serialNumber, 'EMP-001')
  const employeeId = created.body.employee.id

  // 2. Reject duplicate serial number
  const duplicate = await call('/api/hr/employees', {
    method: 'POST',
    cookie: adminCookie,
    body: {
      firstName: 'Sara',
      lastName: 'Hassan',
      serialNumber: 'EMP-001', // duplicate!
      dob: '1995-02-10',
      email: 'sara.hassan@natheelco.com',
    },
  })
  assert.equal(duplicate.response.status, 400)
  assert.match(duplicate.body.error, /already in use/i)

  // 3. Search and fetch employees
  const list = await call('/api/hr/employees?search=Ahmed', { cookie: adminCookie })
  assert.equal(list.response.status, 200)
  assert.equal(list.body.employees.length, 1)
  assert.equal(list.body.stats.active, 1)

  // 4. Update employee
  const updated = await call(`/api/hr/employees/${employeeId}`, {
    method: 'PUT',
    cookie: adminCookie,
    body: {
      position: 'Director of Operations',
      monthlySalary: 18000,
      annualSalary: 216000,
    },
  })
  assert.equal(updated.response.status, 200)
  assert.equal(updated.body.employee.data.position, 'Director of Operations')

  // 5. Add document metadata
  const docAdded = await call(`/api/hr/employees/${employeeId}/documents`, {
    method: 'POST',
    cookie: adminCookie,
    body: {
      fileId: '0123456789abcdef0123456789abcdef0123',
      name: 'Passport_Copy.pdf',
      category: 'Passport',
      size: 1048576,
      type: 'application/pdf',
    },
  })
  assert.equal(docAdded.response.status, 201)
  assert.equal(docAdded.body.document.name, 'Passport_Copy.pdf')
  const docId = docAdded.body.document.id

  // 6. Delete document metadata
  const docRemoved = await call(`/api/hr/employees/${employeeId}/documents/${docId}`, {
    method: 'DELETE',
    cookie: adminCookie,
  })
  assert.equal(docRemoved.response.status, 200)

  // 7. Batch import
  const batchImport = await call('/api/hr/employees/import', {
    method: 'POST',
    cookie: adminCookie,
    body: {
      employees: [
        {
          firstName: 'Fatima',
          lastName: 'Zahra',
          serialNumber: 'EMP-002',
          dob: '1992-08-20',
          email: 'fatima@natheelco.com',
          monthlySalary: 12000,
          status: 'Active',
        },
        {
          firstName: 'Invalid',
          lastName: 'Duplicate',
          serialNumber: 'EMP-001', // duplicate with Ahmed
          dob: '1990-01-01',
          email: 'invalid@natheelco.com',
        },
      ],
    },
  })
  assert.equal(batchImport.response.status, 200)
  assert.equal(batchImport.body.importedCount, 1)
  assert.equal(batchImport.body.failedCount, 1)

  // 8. Delete employee
  const deleted = await call(`/api/hr/employees/${employeeId}`, {
    method: 'DELETE',
    cookie: adminCookie,
  })
  assert.equal(deleted.response.status, 200)
})
