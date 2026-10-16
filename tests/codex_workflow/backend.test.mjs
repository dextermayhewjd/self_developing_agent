import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createBackend } from '../../tools/codex_workflow/backend.mjs'
import { createProcessRegistry } from '../../tools/codex_workflow/state.mjs'
import { setTimeout as delay } from 'node:timers/promises'

const schema = { type: 'object', required: ['answer'], properties: { answer: { type: 'integer' } } }
const fixture = fileURLToPath(new URL('./fixtures/fake-codex.mjs', import.meta.url))
const executionConfig = { version: 1, codexVersion: 'test',
  defaults: { model: 'test-model', effort: 'high' }, overrides: {}, stageConfig: {}, sources: {},
  models: [{ model: 'test-model', defaultReasoningEffort: 'high', supportedReasoningEfforts: ['low', 'high'] }], catalogAvailable: true }

async function setup(t) {
  const dir = await mkdtemp(join(tmpdir(), 'codex workflow '))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const backend = createBackend({ root: dir, logDir: dir, executable: process.execPath, executableArgs: [fixture], executionConfig })
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

test('actual backend process groups are registered before execution and removed on exit', async t => {
  const { dir } = await setup(t)
  const registry = createProcessRegistry(dir)
  const backend = createBackend({ root: dir, logDir: dir, executable: process.execPath, executableArgs: [fixture], processRegistry: registry, executionConfig })
  const control = new AbortController()
  const run = backend('TEST:{"wait":30000}', { schema, label: 'registered' }, control.signal)
  const checked = assert.rejects(run, /cancelled/)
  let groups = []
  for (let tries = 0; tries < 100 && !groups.length; tries++) {
    await delay(5)
    try { groups = JSON.parse(await readFile(registry.path, 'utf8')).groups } catch {}
  }
  assert.equal(groups.length, 1)
  control.abort(new Error('cancelled'))
  await checked
  assert.deepEqual(JSON.parse(await readFile(registry.path, 'utf8')).groups, [])
})

test('workers receive explicit effective settings and save only safe execution metadata', async t => {
  const { dir } = await setup(t)
  const events = []
  const backend = createBackend({ root: dir, logDir: dir, executable: process.execPath,
    executableArgs: [fixture], executionConfig, emit: e => events.push(e) })
  const capture = join(dir, 'capture.json')
  await backend(`TEST:${JSON.stringify({ result: { answer: 42 }, capture })}`, { schema, label: '成稿' })
  const recorded = JSON.parse(await readFile(capture, 'utf8'))
  assert.equal(recorded.args[recorded.args.indexOf('--model') + 1], 'test-model')
  assert.ok(recorded.args.includes('model_reasoning_effort="high"'))
  const started = events.find(e => e.type === 'agent.started')
  assert.equal(started.execution.model, 'test-model')
  const metadata = JSON.parse(await readFile(join(started.directory, 'execution.json'), 'utf8'))
  assert.equal(metadata.codexVersion, 'test')
  assert.equal(metadata.model, 'test-model')
  assert.equal(metadata.effort, 'high')
  assert.ok(!JSON.stringify(metadata).includes('api_key'))
})
