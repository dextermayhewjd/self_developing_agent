import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, copyFile, readdir, rm, writeFile, readFile, access } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRuntime, loadWorkflow } from '../../tools/codex_workflow/runtime.mjs'
import { parseArguments, inspectWorkflow, workflowLocations } from '../../tools/run_codex_workflow.mjs'
import { openState, acquireRunLock } from '../../tools/codex_workflow/state.mjs'
import { reportFixture, writeReviewFixture } from './fixtures/review-fixture.mjs'

test('CLI preserves HK leading zeros and rejects unsafe inputs and impossible dates', () => {
  const p = parseArguments(['equity-thesis', '--symbol', '00700.HK', '--date', '20261015'])
  assert.equal(p.args.symbol, '00700')
  assert.equal(p.args.date, '20261015')
  for (const date of ['20260230', '20261301', '2026101']) {
    assert.throws(() => parseArguments(['equity-thesis', '--symbol', '00700', '--date', date]), /date/i)
  }
  assert.throws(() => parseArguments(['equity-thesis', '--symbol', '../00700']), /symbol/i)
  assert.throws(() => parseArguments(['equity-thesis', '--symbol', '00700', '--jobs', '0']), /jobs/i)
  assert.equal(parseArguments(['calibrate-equity-thesis']).args.date, undefined)
})

test('report dates serialize through the same symbol lock and peer paths support spaces', async t => {
  const root = await mkdtemp(join(tmpdir(), 'space root '))
  t.after(() => rm(root, { recursive: true, force: true }))
  const first = workflowLocations({ root, name: 'equity-thesis', args: { symbol: '00700', date: '20261015' } })
  const second = workflowLocations({ root, name: 'equity-thesis', args: { symbol: '00700', date: '20261016' } })
  const release = await acquireRunLock(first.sharedLock)
  await assert.rejects(acquireRunLock(second.sharedLock), /already running/)
  await release()
  const peer = workflowLocations({ root, name: 'peer-comparability', args: { variety: '钨 矿', archetype: '耗竭资源型' } })
  const target = join(peer.run, '判定/600549.md')
  assert.deepEqual(peer.artifactsFor('判定:公司', `Read guide. 把结论写到 ${target}（先 mkdir -p）`), [target])
})

test('all three real workflows can be checked without writing business artifacts', async t => {
  const root = await mkdtemp(join(tmpdir(), 'workflow-check-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, '.claude/workflows'), { recursive: true })
  const sourceRoot = fileURLToPath(new URL('../../.claude/workflows/', import.meta.url))
  for (const name of ['equity-thesis', 'peer-comparability', 'calibrate-equity-thesis']) {
    await copyFile(join(sourceRoot, `${name}.mjs`), join(root, `.claude/workflows/${name}.mjs`))
    const summary = await inspectWorkflow({ root, name, args: { symbol: '00700', date: '20261015', variety: '钨', archetype: '耗竭资源型', root } })
    assert.ok(summary.stages.length >= 3, name)
    if (name === 'peer-comparability') assert.ok(summary.stages.some(s => s.label.startsWith('判定:')), 'check must exercise candidate verdict schema')
  }
  assert.deepEqual(await readdir(root), ['.claude'])
})

test('startup computes the actual source fingerprint before saving resumable state', async t => {
  const root = await mkdtemp(join(tmpdir(), 'workflow-start-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const { workflowFingerprint } = await import('../../tools/run_codex_workflow.mjs')
  assert.equal(typeof workflowFingerprint, 'function')
  await mkdir(join(root, '.claude/workflows'), { recursive: true })
  await mkdir(join(root, '.claude/skills/example'), { recursive: true })
  await writeFile(join(root, '.claude/workflows/peer-comparability.mjs'), 'return {}')
  const guide = join(root, '.claude/skills/example/SKILL.md')
  await writeFile(guide, 'v1')
  const first = await workflowFingerprint(root, 'peer-comparability', { variety: '钨' }, {})
  assert.match(first, /^[a-f0-9]{64}$/)
  const state = await openState({ dir: join(root, '.codex-workflow'), artifactRoots: [root], fingerprint: async () => first })
  assert.equal(state.data.fingerprint, first)
  await state.close()
  await writeFile(guide, 'v2')
  assert.notEqual(await workflowFingerprint(root, 'peer-comparability', { variety: '钨' }, {}), first)
  await mkdir(join(root, 'data/00700/annual_pdf'), { recursive: true })
  await writeFile(join(root, '.claude/workflows/equity-thesis.mjs'), 'return {}')
  await writeFile(join(root, 'data/00700/aggregate.json'), '{}')
  const pdf = join(root, 'data/00700/annual_pdf/latest.pdf')
  await writeFile(pdf, 'original PDF')
  const pdfHash = await workflowFingerprint(root, 'equity-thesis', { symbol: '00700' }, {})
  await writeFile(pdf, 'corrected PDF')
  assert.notEqual(await workflowFingerprint(root, 'equity-thesis', { symbol: '00700' }, {}), pdfHash)
})

test('real CLI launches its backend, reuses success, rejects stale inputs and resets explicitly', async t => {
  const root = await mkdtemp(join(tmpdir(), 'codex cli integration '))
  t.after(() => rm(root, { recursive: true, force: true }))
  for (const dir of ['.claude/workflows', '.claude/skills/example', 'bin']) await mkdir(join(root, dir), { recursive: true })
  const workflow = `return await agent('fixture', {label:'fixture', schema:{type:'object',required:['written_file'],properties:{written_file:{type:'string'}}}})`
  await writeFile(join(root, '.claude/workflows/peer-comparability.mjs'), workflow)
  const guide = join(root, '.claude/skills/example/SKILL.md')
  await writeFile(guide, 'guide-v1')
  const params = join(root, 'args.json')
  await writeFile(params, JSON.stringify({ variety: '钨', archetype: '耗竭资源型' }))
  await writeFile(join(root, 'bin/codex'), `#!/usr/bin/env node
const fs = require('node:fs'); const path = require('node:path'); const a=process.argv.slice(2);
if (a[0] === '--version') { console.log('codex-cli 1.0.0'); }
else if (a[0] === 'app-server') {
  const readline = require('node:readline');
  readline.createInterface({input:process.stdin}).on('line', line => {
    const msg=JSON.parse(line); let result;
    if(msg.method==='initialize') result={userAgent:'thesis-workflow/1.0.0'};
    if(msg.method==='config/read') result={config:{model:'test-model',model_reasoning_effort:'high'},origins:{}};
    if(msg.method==='model/list') result={data:[{model:'test-model',isDefault:true,defaultReasoningEffort:'high',supportedReasoningEfforts:[{reasoningEffort:'high'}]}]};
    if(msg.id) process.stdout.write(JSON.stringify({id:msg.id,result})+'\\n');
  });
} else {
fs.readFileSync(0); const root=a[a.indexOf('--cd')+1]; const out=path.join(root,'data/_peers/钨/fixture.md');
fs.writeFileSync(out,'valid fixture'); fs.appendFileSync(path.join(root,'counter'),'called\\n');
fs.writeFileSync(a[a.indexOf('--output-last-message')+1],JSON.stringify({written_file:out}));
}
`, { mode: 0o755 })
  const cli = fileURLToPath(new URL('../../tools/run_codex_workflow.mjs', import.meta.url))
  const argv = [cli, 'peer-comparability', '--root', root, '--args-file', params]
  const options = { env: { ...process.env, PATH: `${join(root, 'bin')}:${process.env.PATH}` } }
  const call = () => promisify(execFile)(process.execPath, argv, options)
  const first = JSON.parse((await call()).stdout)
  assert.equal(first.workflow, 'peer-comparability')
  await call()
  assert.equal((await readFile(join(root, 'counter'), 'utf8')).trim(), 'called')
  await writeFile(guide, 'guide-v2')
  await assert.rejects(call(), /changed.*reset/)
  await promisify(execFile)(process.execPath, [...argv, '--reset'], options)
  assert.equal((await readFile(join(root, 'counter'), 'utf8')).trim(), 'called\ncalled')
  await assert.rejects(access(join(root, 'data/_peers/钨/.codex-workflow/run.lock')), { code: 'ENOENT' })
})

test('real equity workflow rechecks and rewrites after a missing finding is regenerated', async t => {
  const root = await mkdtemp(join(tmpdir(), 'real-workflow-resume-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const args = { root, symbol: '00700', date: '20261015' }
  const layout = workflowLocations({ root, name: 'equity-thesis', args })
  const workflow = await loadWorkflow(new URL('../../.claude/workflows/equity-thesis.mjs', import.meta.url))
  const names = ['财务排雷', '尽调', '产业', '竞争', '战略驱动']
  const make = async (file, text) => { await mkdir(join(file, '..'), { recursive: true }); await writeFile(file, text.repeat(50)) }
  const present = async path => { try { await access(path); return true } catch { return false } }
  const called = []
  let round = 1
  async function execute(prompt, { label }) {
    called.push(label)
    if (label.startsWith('成稿审查:')) return writeReviewFixture(layout.run)
    if (label === '盘点') {
      const find = [], checked = []
      for (const n of names) {
        if (await present(join(layout.run, `findings/${n}.md`))) find.push(n)
        if (await present(join(layout.run, `核查/${n}.md`))) checked.push(n)
      }
      return { has_doubt: await present(join(layout.run, '疑惑.md')), findings_done: find, checked_done: checked,
        bench_done: await present(join(layout.run, '参照系/板块基准.md')) ? ['板块基准'] : [] }
    }
    let file
    if (label === '立疑') file = join(layout.run, '疑惑.md')
    if (label.startsWith('挖掘:')) file = join(layout.run, `findings/${label.slice(3)}.md`)
    if (label.startsWith('核查:')) file = join(layout.run, `核查/${label.slice(3)}.md`)
    if (label === '板块基准') file = join(layout.run, '参照系/板块基准.md')
    if (label === '补参照系') return { items: [] }
    if (label === '成稿') {
      file = join(layout.run, 'report.md')
      await writeFile(file, reportFixture(await readFile(join(layout.run, 'findings/产业.md'), 'utf8')))
    } else await make(file, `round ${round}: ${label}\n`)
    return { written_file: file, archetype: '成长渗透型', doubts: [], checked: [], items: [] }
  }
  async function run() {
    const state = await openState({ dir: join(layout.run, '.codex-workflow'), fingerprint: 'fixture',
      artifactRoots: layout.roots, artifactsFor: layout.artifactsFor, dependents: layout.dependents })
    const runtime = createRuntime({ runAgent: (p, o, s) => state.run(p, o, execute, s) })
    try { await workflow(args, runtime); await state.complete() } finally { await state.close() }
  }
  await run()
  await (await import('node:fs/promises')).unlink(join(layout.run, 'findings/产业.md'))
  called.length = 0; round = 2
  await run()
  assert.ok(called.includes('核查:产业'))
  assert.ok(called.includes('成稿'))
  assert.match(await readFile(join(layout.run, 'report.md'), 'utf8'), /round 2/)
})

test('a failed repair restores every research file it is allowed to edit', async t => {
  const root = await mkdtemp(join(tmpdir(), 'repair-rollback-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const layout = workflowLocations({ root, name: 'equity-thesis', args: { symbol: '00700', date: '20261015' } })
  const label = '修复硬门:1'
  const paths = layout.artifactsFor(label).map(p => typeof p === 'string' ? p : p.path)
  for (const file of paths) { await mkdir(join(file, '..'), { recursive: true }); await writeFile(file, 'previous complete content') }
  const state = await openState({ dir: join(layout.run, '.codex-workflow'), fingerprint: 'fixture', artifactRoots: layout.roots, artifactsFor: layout.artifactsFor })
  await assert.rejects(state.run('fix', { label }, async () => {
    for (const file of paths) await writeFile(file, 'truncated repair')
    throw new Error('repair interrupted')
  }), /interrupted/)
  for (const file of paths) assert.equal(await readFile(file, 'utf8'), 'previous complete content')
  await state.close()
})

test('CLI exposes per-stage configuration and accepts catalog-defined reasoning levels', () => {
  const parsed = parseArguments(['equity-thesis', '--symbol', '301248', '--stage-config', '/tmp/stages.json', '--effort', 'ultra'])
  assert.equal(parsed.stageConfigPath, '/tmp/stages.json')
  assert.equal(parsed.effort, 'ultra')
})

test('resume freezes resolved settings and preserves invocation options despite changed user defaults', async t => {
  const root = await mkdtemp(join(tmpdir(), 'frozen-execution-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const run = join(root, 'run')
  await mkdir(join(run, '.codex-workflow'), { recursive: true })
  const old = { version: 1, codexVersion: '1.0', defaults: { model: 'old-model', effort: 'high' }, overrides: {}, stageConfig: {}, models: [], sources: {} }
  await writeFile(join(run, '.codex-workflow/state.json'), JSON.stringify({ invocation: { executionConfig: old, jobs: 2, noPdf: true } }))
  const { resolveRunExecutionConfig } = await import('../../tools/run_codex_workflow.mjs')
  assert.equal(typeof resolveRunExecutionConfig, 'function')
  const parsed = parseArguments(['equity-thesis', '--symbol', '301248'])
  const fresh = { ...old, defaults: { model: 'new-user-default', effort: 'low' } }
  const locked = await resolveRunExecutionConfig(parsed, run, { readVersion: async () => '1.0', resolveConfig: async () => { throw new Error('must not resolve current defaults') } })
  assert.deepEqual(locked, old)
  assert.equal(parsed.jobs, 2)
  assert.equal(parsed.noPdf, true)
  await assert.rejects(resolveRunExecutionConfig(parsed, run, { readVersion: async () => '2.0', resolveConfig: async () => fresh }), /version.*reset/i)
})

test('repeating identical explicit settings resumes the frozen snapshot without current defaults', async t => {
  const root = await mkdtemp(join(tmpdir(), 'same-explicit-execution-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const run = join(root, 'run')
  await mkdir(join(run, '.codex-workflow'), { recursive: true })
  const stageFile = join(root, 'stages.json')
  const stageConfig = { stages: { 成稿: { effort: 'high' } } }
  await writeFile(stageFile, JSON.stringify(stageConfig))
  const saved = { version: 1, codexVersion: '1.0', defaults: { model: 'old-model', effort: 'high' }, overrides: { model: 'old-model', effort: 'high' }, stageConfig, models: [], sources: {} }
  await writeFile(join(run, '.codex-workflow/state.json'), JSON.stringify({ invocation: { executionConfig: saved, jobs: 2, noPdf: true } }))
  const { resolveRunExecutionConfig } = await import('../../tools/run_codex_workflow.mjs')
  const parsed = parseArguments(['equity-thesis', '--symbol', '301248', '--model', 'old-model', '--effort', 'high', '--stage-config', stageFile])
  const result = await resolveRunExecutionConfig(parsed, run, { readVersion: async () => '1.0', resolveConfig: async () => { throw new Error('must not resolve current defaults') } })
  assert.deepEqual(result, saved)
})

test('execution configuration is part of the run fingerprint', async t => {
  const root = await mkdtemp(join(tmpdir(), 'execution-fingerprint-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, '.claude/workflows'), { recursive: true })
  await mkdir(join(root, '.claude/skills'), { recursive: true })
  await writeFile(join(root, '.claude/workflows/peer-comparability.mjs'), 'return {}')
  const { workflowFingerprint } = await import('../../tools/run_codex_workflow.mjs')
  const a = await workflowFingerprint(root, 'peer-comparability', {}, { executionConfig: { defaults: { model: 'a', effort: 'high' } } })
  const b = await workflowFingerprint(root, 'peer-comparability', {}, { executionConfig: { defaults: { model: 'b', effort: 'high' } } })
  assert.notEqual(a, b)
})

test('review and revision artifacts follow research invalidation and reset', () => {
  const root = '/tmp/thesis-layout'
  const layout = workflowLocations({ root, name: 'equity-thesis', args: { symbol: '00700', date: '20261015' } })
  const labels = ['成稿', '成稿审查:0', '修订成稿:1', '成稿审查:1', '更新档案', '更新档案:硬门1']
  assert.ok(layout.resetArtifacts.includes(join(layout.run, '成稿审查.json')))
  assert.deepEqual(layout.artifactsFor('成稿审查:0'), [join(layout.run, '成稿审查.json')])
  assert.deepEqual(layout.artifactsFor('修订成稿:1'), [join(layout.run, 'report.md')])
  assert.deepEqual(layout.artifactsFor('更新档案:硬门1'), [join(root, 'positions/00700.md')])
  assert.ok(layout.dependents('挖掘:产业', labels).includes('成稿审查:0'))
  assert.ok(layout.dependents('成稿', labels).includes('成稿审查:1'))
})
