import assert from 'node:assert/strict'
import { test } from 'node:test'
import handler, { config } from '../api/[...path].js'
import serverHandler from '../src/server.js'

test('exports a Vercel API handler with request body parsing disabled', () => {
  assert.equal(typeof handler, 'function')
  assert.deepEqual(config, { api: { bodyParser: false } })
})

test('exports a default handler from the backend server module', () => {
  assert.equal(typeof serverHandler, 'function')
})
