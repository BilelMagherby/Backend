import assert from 'node:assert/strict'
import { test } from 'node:test'
import handler, { config } from '../api/[...path].js'

test('exports a Vercel API handler with request body parsing disabled', () => {
  assert.equal(typeof handler, 'function')
  assert.deepEqual(config, { api: { bodyParser: false } })
})
