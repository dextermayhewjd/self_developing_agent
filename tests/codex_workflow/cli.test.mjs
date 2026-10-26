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
import { establishInitialCandidate } from '../../tools/codex_workflow/thesis.mjs'
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
  assert.match(parseArguments(['calibrate-equity-thesis']).args.date, /^\d{8}$/)
})

test('review upgrade flags are explicit mutually exclusive thesis operations', () => {
  const args = ['equity-thesis', '--symbol', '00700', '--date', '20261019']
  assert.ok(parseArguments([...args, '--review-upgrade', '/tmp/baseline.json']).reviewUpgrade)
  assert.ok(parseArguments([...args, '--capture-review-baseline', '/tmp/baseline.json']).captureReviewBaseline)
  for (const suffix of [['--reset'], ['--check'], ['--capture-review-baseline', '/tmp/other.json']]) {
    assert.throws(() => parseArguments([...args, '--review-upgrade', '/tmp/baseline.json', ...suffix]), /Review baseline\/upgrade/)
  }
  assert.throws(() => parseArguments(['peer-comparability', '--review-upgrade', '/tmp/baseline.json']), /Review baseline\/upgrade/)
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
  await mkdir(join(root, '.codex/workflows'), { recursive: true })
  const sourceRoot = fileURLToPath(new URL('../../.codex/workflows/', import.meta.url))
  for (const name of ['equity-thesis', 'peer-comparability', 'calibrate-equity-thesis']) {
    await copyFile(join(sourceRoot, `${name}.mjs`), join(root, `.codex/workflows/${name}.mjs`))
    const summary = await inspectWorkflow({ root, name, args: { symbol: '00700', date: '20261015', variety: '钨', archetype: '耗竭资源型', root } })
    assert.ok(summary.stages.length >= 3, name)
    if (name === 'calibrate-equity-thesis') for (const label of ['方法对撞', '抽查', '校准报告']) assert.ok(summary.stages.some(s => s.label === label), label)
    if (name === 'equity-thesis') for(const label of ['成稿审查','问题修订','修订成稿','证据转录'])assert.ok(summary.stages.some(s=>s.label===label))
    if (name === 'peer-comparability') assert.ok(summary.stages.some(s => s.label.startsWith('判定:')), 'check must exercise candidate verdict schema')
  }
  assert.deepEqual(await readdir(root), ['.codex'])
})

test('startup computes the actual source fingerprint before saving resumable state', async t => {
  const root = await mkdtemp(join(tmpdir(), 'workflow-start-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const { workflowFingerprint } = await import('../../tools/run_codex_workflow.mjs')
  assert.equal(typeof workflowFingerprint, 'function')
  await mkdir(join(root, '.codex/workflows'), { recursive: true })
  await mkdir(join(root, '.codex/skills/example'), { recursive: true })
  await writeFile(join(root, '.codex/workflows/peer-comparability.mjs'), 'return {}')
  const guide = join(root, '.codex/skills/example/SKILL.md')
  await writeFile(guide, 'v1')
  const first = await workflowFingerprint(root, 'peer-comparability', { variety: '钨' }, {})
  assert.match(first, /^[a-f0-9]{64}$/)
  const state = await openState({ dir: join(root, '.codex-workflow'), artifactRoots: [root], fingerprint: async () => first })
  assert.equal(state.data.fingerprint, first)
  await state.close()
  await writeFile(guide, 'v2')
  assert.notEqual(await workflowFingerprint(root, 'peer-comparability', { variety: '钨' }, {}), first)
  await mkdir(join(root, 'data/00700/annual_pdf'), { recursive: true })
  await writeFile(join(root, '.codex/workflows/equity-thesis.mjs'), 'return {}')
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
  for (const dir of ['.codex/workflows', '.codex/skills/example', 'bin']) await mkdir(join(root, dir), { recursive: true })
  const workflow = `return await agent('fixture', {label:'fixture', schema:{type:'object',required:['written_file'],properties:{written_file:{type:'string'}}}})`
  await writeFile(join(root, '.codex/workflows/peer-comparability.mjs'), workflow)
  const guide = join(root, '.codex/skills/example/SKILL.md')
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
  const workflow = await loadWorkflow(new URL('../../.codex/workflows/equity-thesis.mjs', import.meta.url))
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
      file = join(layout.run, '初稿.md')
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
  assert.match(await readFile(join(layout.run, '初稿.md'), 'utf8'), /round 2/)
})

test('hard-gate model workers have no canonical delivery or evidence artifact ownership',()=>{
 const layout=workflowLocations({root:'/tmp/ownership',name:'equity-thesis',args:{symbol:'00700',date:'20261015'}})
 assert.deepEqual(layout.artifactsFor('修复硬门:1'),[])
 const stage=join(layout.run,'.codex-workflow/delivery/tx/position.md')
 assert.deepEqual(layout.artifactsFor('更新档案','输出路径：'+stage),[stage])
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
  await mkdir(join(root, '.codex/workflows'), { recursive: true })
  await mkdir(join(root, '.codex/skills'), { recursive: true })
  await writeFile(join(root, '.codex/workflows/peer-comparability.mjs'), 'return {}')
  const { workflowFingerprint } = await import('../../tools/run_codex_workflow.mjs')
  const a = await workflowFingerprint(root, 'peer-comparability', {}, { executionConfig: { defaults: { model: 'a', effort: 'high' } } })
  const b = await workflowFingerprint(root, 'peer-comparability', {}, { executionConfig: { defaults: { model: 'b', effort: 'high' } } })
  assert.notEqual(a, b)
})

test('stage ownership covers draft while review Store owns canonical review and report; reset lists canonical outputs', () => {
  const root = '/tmp/thesis-layout'
  const layout = workflowLocations({ root, name: 'equity-thesis', args: { symbol: '00700', date: '20261015' } })
  const labels = ['成稿', '成稿审查:0', '修订成稿:1', '成稿审查:1', '更新档案', '更新档案:硬门1']
  assert.ok(layout.resetArtifacts.includes(join(layout.run, '成稿审查.json')))
  assert.deepEqual(layout.artifactsFor('成稿'), [join(layout.run, '初稿.md')])
  assert.deepEqual(layout.artifactsFor('成稿审查:0'), [])
  assert.deepEqual(layout.artifactsFor('修订成稿:1'), [])
  assert.deepEqual(layout.artifactsFor('更新档案:硬门1'), [])
  assert.ok(layout.dependents('挖掘:产业', labels).includes('成稿审查:0'))
  assert.ok(layout.dependents('成稿', labels).includes('成稿审查:1'))
})

test('legacy preflight refuses before preparation, registry creation or state recovery and preserves fingerprint',async t=>{
  const root=await mkdtemp(join(tmpdir(),'legacy-preflight-'));t.after(()=>rm(root,{recursive:true,force:true}))
  const run=join(root,'reports/00700_thesis_20261016'), control=join(run,'.codex-workflow')
  await mkdir(control,{recursive:true})
  const file=join(control,'state.json'),body=JSON.stringify({version:1,fingerprint:'old',stages:{broken:{status:'failed',backups:[]}}})
  await writeFile(file,body)
  const cli=fileURLToPath(new URL('../../tools/run_codex_workflow.mjs',import.meta.url))
  await assert.rejects(promisify(execFile)(process.execPath,[cli,'equity-thesis','--root',root,'--symbol','00700','--date','20261016']),/Legacy thesis state.*origin.*round/)
  assert.equal(await readFile(file,'utf8'),body)
  assert.deepEqual(await readdir(control),['state.json'])
})

test('host initial candidate creation never overwrites a Store-owned report',async t=>{
  const root=await mkdtemp(join(tmpdir(),'draft-materialize-'));t.after(()=>rm(root,{recursive:true,force:true}))
  await writeFile(join(root,'初稿.md'),'draft')
  assert.equal(await establishInitialCandidate(root),true)
  await mkdir(join(root,'.codex-workflow/review'),{recursive:true})
  await writeFile(join(root,'.codex-workflow/review/HEAD.json'),'host head')
  await writeFile(join(root,'report.md'),'committed candidate')
  await writeFile(join(root,'初稿.md'),'new draft')
  assert.equal(await establishInitialCandidate(root),false)
  assert.equal(await readFile(join(root,'report.md'),'utf8'),'committed candidate')
})

test('real equity runner registers producer paths, resumes research, and refuses stale derived evidence even with Store HEAD',async t=>{
  const root=await mkdtemp(join(tmpdir(),'thesis-provenance-cli-'));t.after(()=>rm(root,{recursive:true,force:true}))
  const put=async(path,body,mode)=>{await mkdir(join(path,'..'),{recursive:true});await writeFile(path,body,mode?{mode}:undefined)}
  const run=join(root,'reports/00700_thesis_20261016'),control=join(run,'.codex-workflow')
  await put(join(root,'data/00700/aggregate.json'),'{}')
  await put(join(root,'.codex/skills/example/SKILL.md'),'method')
  await put(join(root,'.codex/workflows/equity-thesis.mjs'),`await agent('generate board',{label:'板块基准',schema:{type:'object',required:['written_file'],properties:{written_file:{type:'string'}}}}); throw new Error('fixture completed research boundary')`)
  await put(join(root,'.venv/bin/python'),`#!/usr/bin/env node
require('node:fs').appendFileSync(${JSON.stringify(join(root,'preparation-calls'))},'validate\\n'); if(process.env.FIXTURE_RESET_RAW)require('node:fs').writeFileSync(${JSON.stringify(join(root,'data/00700/aggregate.json'))},process.env.FIXTURE_RESET_RAW); process.exit(0)
`,0o755)
  await put(join(root,'bin/codex'),`#!/usr/bin/env node
const fs=require('node:fs'),path=require('node:path'),a=process.argv.slice(2);
if(a[0]==='--version')console.log('codex-cli 1.0.0');
else if(a[0]==='app-server')require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
const m=JSON.parse(line);let result={};
if(m.method==='initialize')result={userAgent:'thesis-workflow/1.0.0'};
if(m.method==='config/read')result={config:{model:'test-model',model_reasoning_effort:'low'},origins:{}};
if(m.method==='model/list')result={data:[{model:'test-model',isDefault:true,defaultReasoningEffort:'low',supportedReasoningEfforts:[{reasoningEffort:'low'}]}]};
if(m.id)process.stdout.write(JSON.stringify({id:m.id,result})+'\\n');
});else{const input=fs.readFileSync(0,'utf8');const root=a[a.indexOf('--cd')+1],run=path.join(root,'reports/00700_thesis_'+(process.env.FIXTURE_REPORT_DATE||'20261016'));
fs.mkdirSync(path.join(run,'参照系'),{recursive:true});fs.writeFileSync(path.join(run,'参照系/板块基准.md'),'board findings');
// Follow the host's directory; absent guidance reproduces the real worker's path choice.
const evidenceDir=input.match(/^辅助资料目录：(.+)$/m)?.[1]||path.join(root,'data/00700/peer_benchmark_20261016');
fs.mkdirSync(evidenceDir,{recursive:true});fs.writeFileSync(path.join(evidenceDir,'computed.json'),'generated peers');
fs.appendFileSync(path.join(root,'workers-called'),'board\\n');fs.writeFileSync(a[a.indexOf('--output-last-message')+1],JSON.stringify({written_file:path.join(run,'参照系/板块基准.md')}));}
`,0o755)
  const cli=fileURLToPath(new URL('../../tools/run_codex_workflow.mjs',import.meta.url)),argv=[cli,'equity-thesis','--root',root,'--symbol','00700','--date','20261016','--no-pdf']
  const call=(date='20261016',reset=false)=>promisify(execFile)(process.execPath,[...argv.map(value=>value==='20261016'?date:value),...(reset?['--reset']:[])],{env:{...process.env,FIXTURE_REPORT_DATE:date,...(reset?{FIXTURE_RESET_RAW:'reset raw input'}:{}),PATH:join(root,'bin')+':'+process.env.PATH}})
  const {acquireRunLock}=await import('../../tools/codex_workflow/state.mjs')
  for(const lock of [join(root,'positions/.codex-workflow/00700'),control]) {
    const unlock=await acquireRunLock(lock)
    try { await assert.rejects(call(),/already running/);await assert.rejects(readFile(join(control,'input-manifest.json')),{code:'ENOENT'});await assert.rejects(readFile(join(root,'preparation-calls')),{code:'ENOENT'}) } finally {await unlock()}
  }
  await assert.rejects(call(),/fixture completed research boundary/)
  const manifest=JSON.parse(await readFile(join(control,'input-manifest.json'),'utf8'))
  assert.deepEqual(manifest.derived.map(e=>[e.path,e.stage]),[['benchmark_peers/computed.json','板块基准']])
  const initial=JSON.parse(await readFile(join(control,'state.json'),'utf8')).fingerprint
  await assert.rejects(call(),/fixture completed research boundary/)
  assert.equal(JSON.parse(await readFile(join(control,'state.json'),'utf8')).fingerprint,initial)
  const priorManifest=await readFile(join(control,'input-manifest.json'))
  await assert.rejects(call('20261017'),/fixture completed research boundary/)
  assert.deepEqual(await readFile(join(control,'input-manifest.json')),priorManifest)
  const nextManifest=JSON.parse(await readFile(join(root,'reports/00700_thesis_20261017/.codex-workflow/input-manifest.json')))
  assert.equal(nextManifest.derived[0].provenance.run,join(root,'reports/00700_thesis_20261017'))
  await put(join(control,'review/HEAD.json'),'host-owned head')
  await put(join(run,'report.md'),'host committed candidate')
  const stateBytes=await readFile(join(control,'state.json')),manifestBytes=await readFile(join(control,'input-manifest.json'))
  await put(join(root,'data/00700/benchmark_peers/computed.json'),'external change')
  await assert.rejects(call(),/Derived inputs require stage reconciliation.*板块基准.*computed/u)
  assert.deepEqual(await readFile(join(control,'state.json')),stateBytes)
  assert.deepEqual(await readFile(join(control,'input-manifest.json')),manifestBytes)
  assert.equal(await readFile(join(run,'report.md'),'utf8'),'host committed candidate')
  await put(join(root,'data/00700/benchmark_peers/computed.json'),'generated peers')
  await put(join(root,'data/00700/unclassified.txt'),'unknown')
  await assert.rejects(call(),/Unclassified.*unclassified.txt/u)
  await (await import('node:fs/promises')).unlink(join(root,'data/00700/unclassified.txt'))
  const preparations=await readFile(join(root,'preparation-calls'),'utf8')
  assert.equal(preparations,'validate\nvalidate\n')
  await (await import('node:fs/promises')).unlink(join(root,'data/00700/aggregate.json'))
  await assert.rejects(call(),/original inputs changed or missing/u)
  assert.equal(await readFile(join(root,'preparation-calls'),'utf8'),preparations)
  assert.deepEqual(await readFile(join(control,'state.json')),stateBytes)
  await put(join(root,'data/00700/aggregate.json'),'{}')
  await put(join(root,'.codex/skills/example/SKILL.md'),'changed method')
  await assert.rejects(call(),/changed.*reset/u)
  assert.deepEqual(await readFile(join(control,'state.json')),stateBytes)
  assert.equal(await readFile(join(root,'workers-called'),'utf8'),'board\nboard\n')
  await assert.rejects(call('20261016',true),/fixture completed research boundary/)
  assert.equal(await readFile(join(root,'data/00700/aggregate.json'),'utf8'),'reset raw input')
})

test('review quota is explicit host configuration with default two and bounded absolute integers',()=>{
 const base=['equity-thesis','--symbol','00700']
 const normal=parseArguments(base);assert.equal(normal.reviewMaxRounds,2);assert.equal(normal.provided['review-max-rounds'],false)
 for(const n of ['1','10']) {const p=parseArguments([...base,'--review-max-rounds',n]);assert.equal(p.reviewMaxRounds,Number(n));assert.equal(p.provided['review-max-rounds'],true);assert.equal(p.args.reviewMaxRounds,undefined)}
 for(const n of ['0','11','1.5'])assert.throws(()=>parseArguments([...base,'--review-max-rounds',n]),/review-max-rounds/)
})
