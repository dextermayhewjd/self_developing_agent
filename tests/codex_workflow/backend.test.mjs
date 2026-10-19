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
const executionConfig = { version: 1, codexVersion: 'test', skillCatalogAvailable: true, skillPaths: [],
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

test('blind stages start in a neutral directory with web disabled and no inherited user configuration', async t => {
  const { dir, backend } = await setup(t)
  const capture = join(dir, 'blind-capture.json')
  await backend(`TEST:${JSON.stringify({ result: { answer: 42 }, capture })}`, { schema, label: '盲抽:样本', isolation: 'blind' })
  const recorded = JSON.parse(await readFile(capture, 'utf8'))
  assert.notEqual(recorded.args[recorded.args.indexOf('--cd') + 1], dir)
  assert.match(recorded.args[recorded.args.indexOf('--cd') + 1], /doc-reader-/)
  assert.ok(!recorded.args.includes('--ignore-user-config'))
  assert.ok(recorded.args.includes('features.multi_agent=false'))
  assert.ok(recorded.args.includes('features.multi_agent_v2=false'))
  assert.ok(recorded.args.includes('developer_instructions=""'))
  assert.ok(recorded.args.includes('web_search="disabled"'))
  assert.ok(recorded.args.some(x => x.startsWith('skills.config=')))
  assert.ok(!recorded.input.includes('研究 workflow'))
})

test('failed blind workers clean their neutral workspace', async t => {
  const { dir, backend } = await setup(t)
  const capture = join(dir, 'failed-blind.json')
  await assert.rejects(backend(`TEST:${JSON.stringify({ exit: 7, capture })}`, { schema, label:'盲抽:失败', isolation:'blind' }), /7/)
  const recorded = JSON.parse(await readFile(capture,'utf8'))
  const cwd = recorded.args[recorded.args.indexOf('--cd')+1]
  await assert.rejects(readFile(join(cwd,'missing')), { code:'ENOENT' })
  const { stat } = await import('node:fs/promises')
  await assert.rejects(stat(cwd), { code:'ENOENT' })
})

for (const contract of ['proposal', 'review', 'evidence_extract']) test(`${contract} contract is readonly and context isolated`, async t => {
  const { dir } = await setup(t)
  const events = []
  const backend = createBackend({ root: dir, logDir: dir, executable: process.execPath, executableArgs: [fixture],
    executionConfig: { ...executionConfig, defaults: { ...executionConfig.defaults, modelProvider: 'private' } },
    prelude: 'PROJECT_SECRET_PRELUDE', emit: event => events.push(event) })
  const capture = join(dir, `${contract}.json`)
  await backend(`TEST:${JSON.stringify({ result: { answer: 42 }, capture })}`,
    { schema, label: '问题修订:RT-000001:A-0001', contract, images: ['/host/approved.png'], context_bytes: 123, effort: 'low' })
  const recorded = JSON.parse(await readFile(capture, 'utf8'))
  const args = recorded.args
  assert.equal(args[args.indexOf('--sandbox') + 1], 'read-only')
  assert.equal(args[args.indexOf('--ask-for-approval') + 1], 'never')
  assert.ok(args.indexOf('--ask-for-approval') < args.indexOf('exec'))
  assert.ok(!args.includes('--approve-for-me'))
  assert.notEqual(recorded.cwd, dir)
  assert.equal(args[args.indexOf('--cd') + 1], recorded.cwd)
  for (const setting of ['features.multi_agent=false', 'features.multi_agent_v2=false', 'web_search="disabled"', 'developer_instructions=""', 'project_doc_max_bytes=0', 'model_provider="private"']) assert.ok(args.includes(setting), setting)
  assert.ok(args.some(arg => arg.startsWith('skills.config=')))
  assert.equal(args[args.indexOf('--image') + 1], '/host/approved.png')
  assert.ok(!recorded.input.includes('PROJECT_SECRET_PRELUDE'))
  assert.ok(!recorded.input.includes('按本阶段规定的绝对路径写出全文'))
  assert.ok(recorded.input.includes(contract))
  const { stat } = await import('node:fs/promises')
  await assert.rejects(stat(recorded.cwd), { code: 'ENOENT' })
  const started = events.find(event => event.type === 'agent.started')
  const metadata = JSON.parse(await readFile(join(started.directory, 'execution.json'), 'utf8'))
  assert.equal(metadata.contract, contract)
  assert.deepEqual(metadata.isolation.features, {multi_agent:false,multi_agent_v2:false})
  assert.equal(metadata.sandbox, 'read-only')
  assert.equal(metadata.approval, 'never')
  assert.equal(metadata.model, 'test-model')
  assert.equal(metadata.effort, 'low')
  assert.equal(metadata.context_bytes, 123)
  assert.equal(metadata.prompt_bytes, Buffer.byteLength(recorded.input))
})

test('readonly contracts fail closed and never retry unsupported execution with wider permissions', async t => {
  const { dir, backend } = await setup(t)
  for (const contract of ['typo', '', null, ['proposal']]) await assert.rejects(backend('TEST:{}', { schema, contract }), /contract/i)
  for (const images of [['relative.png'], 'image.png', [3]]) await assert.rejects(backend('TEST:{}', { schema, contract: 'proposal', images }), /image|absolute/i)
  const unavailable = createBackend({ root: dir, logDir: dir, executionConfig: { ...executionConfig, skillCatalogAvailable: false } })
  await assert.rejects(unavailable('TEST:{}', { schema, contract: 'review' }), /skill inventory/i)
  const capture = join(dir, 'unsupported.json'), counter = join(dir, 'unsupported-count')
  await assert.rejects(backend(`TEST:${JSON.stringify({ exit: 2, capture, counter })}`, { schema, contract: 'proposal' }), /2/)
  assert.equal((await readFile(counter, 'utf8')).trim().split('\n').length, 1)
  const { stat } = await import('node:fs/promises')
  await assert.rejects(stat(JSON.parse(await readFile(capture, 'utf8')).cwd), { code: 'ENOENT' })
})

for (const contract of ['proposal', 'review', 'evidence_extract']) test(`${contract} requires affirmative complete skill inventory before spawn`, async t => {
  const { dir } = await setup(t)
  let spawns = 0
  const invalid = [undefined, { ...executionConfig, skillCatalogAvailable: undefined },
    { ...executionConfig, skillCatalogAvailable: false, skillPaths: [] },
    { ...executionConfig, skillCatalogAvailable: true, skillPaths: undefined },
    { ...executionConfig, skillCatalogAvailable: true, skillPaths: null },
    { ...executionConfig, skillCatalogAvailable: true, skillPaths: 'absolute' },
    { ...executionConfig, skillCatalogAvailable: true, skillPaths: ['relative/SKILL.md'] },
    { ...executionConfig, skillCatalogAvailable: true, skillPaths: [42] }]
  for (const config of invalid) {
    const backend = createBackend({ root: dir, logDir: dir, executable: process.execPath, executableArgs: [fixture],
      executionConfig: config, processRegistry: { started: () => spawns++ } })
    await assert.rejects(backend('TEST:{"result":{"answer":42}}', { schema, contract,
      execution: { model: 'test-model', effort: 'low' } }), /complete Codex skill inventory/)
  }
  assert.equal(spawns, 0)
  const backend = createBackend({ root: dir, logDir: dir, executable: process.execPath, executableArgs: [fixture],
    executionConfig: { ...executionConfig, skillCatalogAvailable: true, skillPaths: [] } })
  assert.deepEqual(await backend('TEST:{"result":{"answer":42}}', { schema, contract }), { answer: 42 })
})

test('ordinary and old blind callers retain missing inventory marker compatibility', async t => {
  const { dir } = await setup(t)
  const { skillCatalogAvailable, skillPaths, ...oldConfig } = executionConfig
  const backend = createBackend({ root: dir, logDir: dir, executable: process.execPath, executableArgs: [fixture], executionConfig: oldConfig })
  for (const isolation of [undefined, 'blind']) assert.deepEqual(await backend('TEST:{"result":{"answer":42}}', { schema, isolation }), { answer: 42 })
})
