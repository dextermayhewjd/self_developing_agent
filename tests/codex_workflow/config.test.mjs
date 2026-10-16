import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveExecutionConfig, resolveStageSettings, readStageConfig, probeCodexConfig } from '../../tools/codex_workflow/config.mjs'

const catalog = [
  { model: 'codex-main', isDefault: true, defaultReasoningEffort: 'high', supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }, { reasoningEffort: 'xhigh' }] },
  { model: 'codex-fast', isDefault: false, defaultReasoningEffort: 'minimal', supportedReasoningEfforts: [{ reasoningEffort: 'none' }, { reasoningEffort: 'minimal' }, { reasoningEffort: 'max' }, { reasoningEffort: 'ultra' }] },
]
const fixture = (patch = {}) => ({
  codexVersion: 'codex_cli_rs/0.162.1',
  config: { model: 'codex-main', model_reasoning_effort: 'xhigh', model_provider: 'openai', api_key: 'SECRET' },
  origins: { model: { name: { type: 'user', file: '/home/test/.codex/config.toml' }, version: 'SECRET-HASH' }, model_reasoning_effort: { name: { type: 'project', path: '/repo/config.toml' }, version: 'SECRET-HASH' } },
  models: structuredClone(catalog), catalogAvailable: true, ...patch,
})
const resolve = (options = {}, patch = {}) => resolveExecutionConfig({ root: '/repo', ...options, probe: async () => fixture(patch) })

test('freezes effective defaults, catalog and only allowlisted provenance without secrets', async () => {
  const raw = fixture()
  const snapshot = await resolveExecutionConfig({ root: '/repo', probe: async () => raw })
  assert.deepEqual(snapshot.defaults, { model: 'codex-main', effort: 'xhigh', modelProvider: 'openai' })
  assert.equal(snapshot.codexVersion, 'codex_cli_rs/0.162.1')
  assert.deepEqual(snapshot.sources.model, { type: 'user', file: '/home/test/.codex/config.toml' })
  assert.equal(JSON.stringify(snapshot).includes('SECRET'), false)
  raw.config.model = 'changed'
  raw.models[0].defaultReasoningEffort = 'low'
  assert.equal(resolveStageSettings(JSON.parse(JSON.stringify(snapshot)), { label: '成稿', model: 'sonnet' }).model, 'codex-main')
  assert.equal(resolveStageSettings(snapshot, { label: '成稿' }).effort, 'xhigh')
})

test('explicit settings override retired models and unsupported efforts in unused defaults', async () => {
  for (const config of [{ model: 'retired-model', model_reasoning_effort: 'high' },
    { model: 'codex-main', model_reasoning_effort: 'unsupported-old-effort' }]) {
    const snapshot = await resolve({ model: 'codex-main', effort: 'low' }, { config })
    assert.equal(resolveStageSettings(snapshot, { label: '成稿' }).model, 'codex-main')
    assert.equal(resolveStageSettings(snapshot, { label: '成稿' }).effort, 'low')
  }
})

test('default provider is explicitly frozen even when config omits it', async () => {
  const snapshot = await resolve({}, { config: { model: 'codex-main', model_reasoning_effort: 'high' } })
  assert.equal(resolveStageSettings(snapshot, { label: '成稿' }).modelProvider, 'openai')
})

test('CLI overrides win over exact, prefix, shared and file defaults', async () => {
  const stageConfig = { default: { effort: 'low' }, stages: { 挖掘: { effort: 'high' }, '挖掘:竞争': { effort: 'xhigh' } } }
  const snapshot = await resolve({ model: 'codex-main', effort: 'low', stageConfig })
  assert.deepEqual(resolveStageSettings(snapshot, { label: '挖掘:竞争', effort: 'high', model: 'sonnet' }), {
    model: 'codex-main', effort: 'low', modelProvider: 'openai', sources: { model: 'cli', effort: 'cli', modelProvider: 'effective-config' },
  })
  const configured = await resolve({ stageConfig })
  assert.equal(resolveStageSettings(configured, { label: '挖掘:竞争', effort: 'low' }).effort, 'xhigh')
  assert.equal(resolveStageSettings(configured, { label: '挖掘:产业', effort: 'low' }).effort, 'high')
  assert.equal(resolveStageSettings(configured, { label: '成稿', effort: 'high' }).effort, 'high')
  assert.equal(resolveStageSettings(configured, { label: '成稿' }).effort, 'low')
})

test('other model gets its own catalog default and supported efforts are catalog driven', async () => {
  const snapshot = await resolve({ stageConfig: { stages: { 成稿: { model: 'codex-fast' } } } })
  assert.equal(resolveStageSettings(snapshot, { label: '成稿' }).effort, 'minimal')
  assert.equal(resolveStageSettings(snapshot, { label: '成稿', effort: 'ultra' }).effort, 'ultra')
  assert.throws(() => resolveStageSettings(snapshot, { label: '成稿', effort: 'high' }), /unsupported.*effort/i)
  await assert.rejects(resolve({ effort: 'nonsense' }), /unsupported.*effort/i)
  await assert.rejects(resolve({ model: 'missing' }), /unknown.*model/i)
})

test('Claude aliases in every configuration layer resolve to the concrete Codex default', async () => {
  for (const model of ['haiku', 'sonnet', 'opus']) {
    const snapshot = await resolve({ model, stageConfig: { default: { model: 'opus' }, stages: { 成稿: { model: 'haiku' } } } })
    assert.equal(resolveStageSettings(snapshot, { label: '成稿', model: 'sonnet' }).model, 'codex-main')
  }
})

test('model directory fills missing defaults and missing settings fail without guessing', async () => {
  const snapshot = await resolve({}, { config: {}, origins: {} })
  assert.deepEqual(snapshot.defaults, { model: 'codex-main', effort: 'high', modelProvider: 'openai' })
  await assert.rejects(resolve({}, { config: {}, models: [], catalogAvailable: false }), /model/i)
  await assert.rejects(resolve({}, { config: { model: 'codex-main' }, models: [], catalogAvailable: false }), /effort/i)
  const explicit = await resolve({}, { models: [], catalogAvailable: false })
  assert.equal(explicit.catalogAvailable, false)
  assert.equal(resolveStageSettings(explicit, { label: '成稿' }).effort, 'xhigh')
  assert.throws(() => resolveStageSettings(explicit, { label: '成稿', model: 'other' }), /effort|catalog/i)
})

test('readStageConfig validates structures, all stage keys and numeric review routing', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'stage-config-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const path = join(dir, 'stages.json')
  const stageConfig = { default: { model: 'codex-main' }, stages: { 成稿审查: { effort: 'high' }, 修订成稿: { effort: 'low' }, '核查:财务排雷': { effort: 'xhigh' } } }
  await writeFile(path, JSON.stringify(stageConfig))
  assert.deepEqual(await readStageConfig(path), stageConfig)
  const snapshot = await resolve({ stageConfig })
  assert.equal(resolveStageSettings(snapshot, { label: '成稿审查:0' }).effort, 'high')
  assert.equal(resolveStageSettings(snapshot, { label: '修订成稿:1' }).effort, 'low')
  for (const bad of [{ extra: {} }, { stages: { typo: {} } }, { stages: { '挖掘:typo': {} } }, { stages: { '成稿审查:0': {} } }, { stages: [] }, { default: { model: 2 } }, { default: { effort: ' ' } }, { default: { extra: 1 } }, null]) {
    await writeFile(path, JSON.stringify(bad))
    await assert.rejects(readStageConfig(path), /stage|config|model|effort/i)
  }
})

async function rpcFixture(t, mode) {
  const dir = await mkdtemp(join(tmpdir(), 'config-rpc-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const script = join(dir, 'rpc.mjs')
  const transcript = join(dir, 'transcript.jsonl')
  await writeFile(script, `import {createInterface} from 'node:readline'; import {appendFileSync} from 'node:fs';
const send = (id,result) => process.stdout.write(JSON.stringify({id,result})+'\\n');
createInterface({input:process.stdin}).on('line', line => {
 const m=JSON.parse(line); appendFileSync(${JSON.stringify(transcript)}, line+'\\n');
 if (m.method==='initialize') { if (${JSON.stringify(mode)}==='timeout') return; send(m.id,{userAgent:'codex_cli_rs/0.162.1'}); }
 if (m.method==='config/read') { if (${JSON.stringify(mode)}==='exit') { process.stderr.write('SECRET-CREDENTIAL'); process.exit(3); } send(m.id, ${JSON.stringify({ config: fixture().config, origins: fixture().origins })}); }
 if (m.method==='model/list') {
  if (${JSON.stringify(mode)}==='catalog-error') { process.stdout.write(JSON.stringify({id:m.id,error:{message:'SECRET-CREDENTIAL'}})+'\\n'); return; }
  send(m.id,{data:m.params.cursor?[${JSON.stringify(catalog[1])}]:[${JSON.stringify(catalog[0])}],nextCursor:m.params.cursor?null:'page-2'});
 }
});`)
  return { dir, script, transcript }
}

test('RPC probe initializes, reads effective settings, paginates models and redacts the result', async t => {
  const { dir, script, transcript } = await rpcFixture(t, 'success')
  const result = await probeCodexConfig({ root: dir, executable: process.execPath, executableArgs: [script], timeoutMs: 1500 })
  assert.equal(result.models.length, 2)
  assert.equal(result.config.model, 'codex-main')
  assert.equal(result.codexVersion, '0.162.1')
  assert.equal(JSON.stringify(result).includes('SECRET'), false)
  const messages = (await readFile(transcript, 'utf8')).trim().split('\n').map(JSON.parse)
  assert.deepEqual(messages.map(x => x.method), ['initialize', 'initialized', 'config/read', 'model/list', 'model/list'])
  assert.deepEqual(messages[2].params, { cwd: dir, includeLayers: false })
  assert.equal(messages[3].params.includeHidden, true)
  assert.equal(messages[4].params.cursor, 'page-2')
})

test('RPC catalog failure preserves explicit defaults without exposing server errors', async t => {
  const { dir, script } = await rpcFixture(t, 'catalog-error')
  const result = await probeCodexConfig({ root: dir, executable: process.execPath, executableArgs: [script], timeoutMs: 1500 })
  assert.equal(result.catalogAvailable, false)
  assert.equal(result.config.model_reasoning_effort, 'xhigh')
  assert.equal(JSON.stringify(result).includes('SECRET'), false)
})

test('RPC timeout and early exit reject promptly without exposing stderr', async t => {
  for (const mode of ['timeout', 'exit']) {
    const { dir, script } = await rpcFixture(t, mode)
    await assert.rejects(probeCodexConfig({ root: dir, executable: process.execPath, executableArgs: [script], timeoutMs: 200 }), error => {
      assert.match(error.message, /timeout|exit/i)
      assert.equal(error.message.includes('SECRET'), false)
      return true
    })
  }
})

test('cannot use an effort from an unrelated model when the effective model changes', async () => {
  const snapshot = await resolve({ model: 'codex-fast' })
  assert.equal(resolveStageSettings(snapshot, { label: '成稿' }).effort, 'minimal')
  const fileDefault = await resolve({ stageConfig: { default: { model: 'codex-fast' } } })
  assert.equal(resolveStageSettings(fileDefault, { label: '成稿' }).effort, 'minimal')
  const shared = await resolve()
  assert.equal(resolveStageSettings(shared, { label: '成稿', model: 'codex-fast' }).effort, 'minimal')
})

test('runtime numeric short review labels route to the configured review and revision stages', async () => {
  const snapshot = await resolve({ stageConfig: { stages: { 成稿审查: { effort: 'high' }, 修订成稿: { effort: 'low' } } } })
  assert.equal(resolveStageSettings(snapshot, { label: '审查:0' }).effort, 'high')
  assert.equal(resolveStageSettings(snapshot, { label: '修订:1' }).effort, 'low')
})

test('explicit CLI model and effort freeze successfully without effective defaults or a catalog', async () => {
  const snapshot = await resolve({ model: 'custom-codex', effort: 'ultra' }, { config: {}, models: [], catalogAvailable: false })
  assert.deepEqual(snapshot.defaults, { model: 'custom-codex', effort: 'ultra', modelProvider: 'openai' })
  assert.equal(resolveStageSettings(snapshot, { label: '成稿' }).model, 'custom-codex')
  assert.equal(resolveStageSettings(snapshot, { label: '成稿' }).effort, 'ultra')
})

test('execution snapshots require an explicit version instead of persisting unknown', async () => {
  await assert.rejects(resolve({}, { codexVersion: undefined }), /version/i)
  const snapshot = await resolve({}, { codexVersion: 'test-version' })
  assert.equal(snapshot.codexVersion, 'test-version')
})

test('real RPC probe rejects a user agent without a Codex semantic version', async t => {
  const { dir, script } = await rpcFixture(t, 'success')
  await writeFile(script, (await readFile(script, 'utf8')).replace('codex_cli_rs/0.162.1', 'thesis-workflow/unknown (Ubuntu 24.4.0)'))
  await assert.rejects(probeCodexConfig({ root: dir, executable: process.execPath, executableArgs: [script], timeoutMs: 1500 }), /version/i)
})

test('RPC catalog failure can be resolved using explicit CLI settings when config is empty', async t => {
  const { dir, script } = await rpcFixture(t, 'catalog-error')
  await writeFile(script, (await readFile(script, 'utf8')).replace(JSON.stringify(fixture().config), '{}'))
  const snapshot = await resolveExecutionConfig({ root: dir, model: 'custom-codex', effort: 'ultra',
    probe: options => probeCodexConfig({ ...options, executable: process.execPath, executableArgs: [script], timeoutMs: 1500 }) })
  assert.deepEqual(snapshot.defaults, { model: 'custom-codex', effort: 'ultra', modelProvider: 'openai' })
  assert.equal(snapshot.catalogAvailable, false)
})
