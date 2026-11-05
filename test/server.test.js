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

async function call(route, { method = 'GET', body, cookie, origin } = {}) {
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(cookie ? { Cookie: cookie } : {}),
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

test('creates meetings and rejects malformed document paths', async () => {
  const meeting = await call('/api/meetings', {
    method: 'POST',
    cookie: adminCookie,
    body: { platform: 'google', title: 'Weekly sync', start: 1000 },
  })
  assert.equal(meeting.response.status, 201)
  assert.equal(meeting.body.meeting.title, 'Weekly sync')
  assert.match(meeting.body.meeting.joinUrl, /^https:\/\/meet\.google\.com\//)

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
    body: { users: [{ id: 'person-1', name: 'Team member', pin: '6789', permissions: ['hr', 'foodics'] }] },
  })
  assert.equal(users.response.status, 200)
  assert.deepEqual(users.body, [{ id: 'person-1', name: 'Team member', permissions: ['hr', 'foodics'] }])

  const login = await call('/api/auth', {
    method: 'POST',
    body: { action: 'login', pin: '6789', remember: false },
  })
  assert.equal(login.response.status, 200)
  assert.deepEqual(login.body.activeUser.permissions, ['hr', 'foodics'])

  const allowed = await call('/api/docs?collection=hr', { cookie: login.cookie })
  assert.equal(allowed.response.status, 200)
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
