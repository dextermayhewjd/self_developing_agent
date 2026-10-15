import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createBackend } from '../../tools/codex_workflow/backend.mjs'

const schema = { type: 'object', required: ['answer'], properties: { answer: { type: 'integer' } } }
const fixture = fileURLToPath(new URL('./fixtures/fake-codex.mjs', import.meta.url))

async function setup(t) {
  const dir = await mkdtemp(join(tmpdir(), 'codex workflow '))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const backend = createBackend({ root: dir, logDir: dir, executable: process.execPath, executableArgs: [fixture] })
  return { dir, backend }
}

test('backend executes with argument arrays, stdin and a dedicated structured result file', async t => {
  const { dir, backend } = await setup(t)
  const capture = join(dir, 'captured.json')
  const result = await backend(`TEST:${JSON.stringify({ result: { answer: 42 }, capture })}`, { schema, model: 'haiku', effort: 'low', label: '测试' })
  assert.deepEqual(result, { answer: 42 })
  const recorded = JSON.parse(await readFile(capture, 'utf8'))
  assert.ok(recorded.input.includes('TEST:'))
  assert.ok(recorded.args.includes('--approve-for-me'))
  assert.ok(!recorded.args.includes('haiku'))
  assert.ok(!recorded.args.some(x => x.includes('TEST:')))
})

test('process failures stop immediately while bad JSON has only one repair attempt', async t => {
  const { dir, backend } = await setup(t)
  const counter = join(dir, 'counter')
  await assert.rejects(backend(`TEST:${JSON.stringify({ exit: 7, counter })}`, { schema, label: 'fail' }), /fail.*7/)
  assert.equal((await readFile(counter, 'utf8')).trim().split('\n').length, 1)
  await assert.rejects(backend(`TEST:${JSON.stringify({ malformed: true, counter })}`, { schema, label: 'bad-json' }), /bad-json/)
  assert.equal((await readFile(counter, 'utf8')).trim().split('\n').length, 3)
})

test('missing output is a failure and interruption terminates a running process', async t => {
  const { backend } = await setup(t)
  await assert.rejects(backend('TEST:{"noResult":true}', { schema, label: 'missing' }), /missing/)
  const control = new AbortController()
  const promise = backend('TEST:{"wait":30000}', { schema, label: 'slow' }, control.signal)
  setTimeout(() => control.abort(new Error('cancelled')), 30)
  await assert.rejects(promise, /cancelled/)
})
