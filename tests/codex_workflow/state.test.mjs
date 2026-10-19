import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile, unlink, rm, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { openState, acquireRunLock } from '../../tools/codex_workflow/state.mjs'

async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), 'workflow-state-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const output = join(root, 'result.md')
  const config = { dir: join(root, '.codex-workflow'), fingerprint: 'v1', artifactRoots: [root],
    artifactsFor: () => [output] }
  return { root, output, config }
}

test('lock excludes concurrent runs and release permits the next run', async t => {
  const { config } = await setup(t)
  const state = await openState(config)
  await assert.rejects(openState(config), /already running/i)
  await state.close()
  await (await openState(config)).close()
})

test('validated success replays across sessions, missing artifact forces recomputation', async t => {
  const { config, output } = await setup(t)
  let calls = 0
  const runner = async () => { calls++; await writeFile(output, 'complete'); return { written_file: output } }
  let state = await openState(config)
  await state.run('prompt', { label: 'stage' }, runner)
  await state.close()
  state = await openState(config)
  assert.deepEqual(await state.run('prompt', { label: 'stage' }, runner), { written_file: output })
  assert.equal(calls, 1)
  await unlink(output)
  await state.run('prompt', { label: 'stage' }, runner)
  assert.equal(calls, 2)
  await state.close()
})

test('failed or interrupted output is quarantined before inventory can treat it as complete', async t => {
  const { config, output } = await setup(t)
  let state = await openState(config)
  await assert.rejects(state.run('prompt', { label: 'stage' }, async () => {
    await writeFile(output, 'partial'.repeat(100))
    throw new Error('interrupted')
  }), /interrupted/)
  await state.close()
  state = await openState(config)
  await assert.rejects(readFile(output), { code: 'ENOENT' })
  await state.close()
})

test('changed workflow fingerprint requires explicit reset', async t => {
  const { config, output } = await setup(t)
  let state = await openState(config)
  await state.run('prompt', { label: 'stage' }, async () => {
    await writeFile(output, 'complete')
    return { written_file: output }
  })
  await state.close()
  await assert.rejects(openState({ ...config, fingerprint: 'v2' }), /changed.*reset/i)
  state = await openState({ ...config, fingerprint: 'v2', reset: true })
  await assert.rejects(readFile(output), { code: 'ENOENT' })
  await state.close()
})

test('output claims cannot escape artifact roots through paths or symlinks', async t => {
  const { config, root } = await setup(t)
  const outside = await mkdtemp(join(tmpdir(), 'outside-workflow-'))
  t.after(() => rm(outside, { recursive: true, force: true }))
  await writeFile(join(outside, 'out.md'), 'outside')
  await symlink(outside, join(root, 'link'))
  const state = await openState({ ...config, artifactsFor: () => [] })
  await assert.rejects(state.run('x', { label: 'bad' }, async () => ({ written_file: join(root, 'link/out.md') })), /outside.*artifact/i)
  await state.close()
})

test('explicit reset archives legacy artifacts and records invocation for reproducible resume', async t => {
  const { config, output } = await setup(t)
  await writeFile(output, 'legacy Claude output')
  const invocation = { name: 'equity-thesis', args: { symbol: '00700', date: '20261015' }, noPdf: true }
  let state = await openState({ ...config, invocation })
  await state.close()
  state = await openState({ ...config, invocation, reset: true, resetArtifacts: [output] })
  await assert.rejects(readFile(output), { code: 'ENOENT' })
  assert.deepEqual(state.data.invocation, invocation)
  await state.close()
})

test('failed position update restores the previous persistent file', async t => {
  const { root } = await setup(t)
  const run = join(root, 'report')
  const position = join(root, 'position.md')
  await writeFile(position, 'previous complete position')
  const state = await openState({ dir: join(run, '.codex-workflow'), fingerprint: 'v1',
    artifactRoots: [run, position], artifactsFor: () => [position] })
  await assert.rejects(state.run('update', { label: '更新档案' }, async () => {
    await writeFile(position, '最近更新: 2026-10-15\npartial')
    throw new Error('worker interrupted')
  }), /interrupted/)
  assert.equal(await readFile(position, 'utf8'), 'previous complete position')
  assert.equal(state.canReuse(), false)
  await state.close()
})

test('missing upstream output invalidates and removes downstream artifacts before inventory', async t => {
  const { root, config } = await setup(t)
  const paths = { dig: join(root, 'find.md'), check: join(root, 'check.md'), report: join(root, 'report.md') }
  const settings = { ...config, artifactsFor: label => [paths[label]],
    dependents: label => ({ dig: ['check', 'report'], check: ['report'] }[label] ?? []) }
  let state = await openState(settings)
  for (const label of ['dig', 'check', 'report']) await state.run(label, { label }, async () => {
    await writeFile(paths[label], 'round 1'); return { written_file: paths[label] }
  })
  await state.close()
  await unlink(paths.dig)
  state = await openState(settings)
  await assert.rejects(readFile(paths.check), { code: 'ENOENT' })
  await assert.rejects(readFile(paths.report), { code: 'ENOENT' })
  assert.equal(state.canReuse(), false)
  await state.close()
})

test('dead parent lock is not reclaimed while a registered detached worker survives', async t => {
  const { root } = await setup(t)
  const module = new URL('../../tools/codex_workflow/state.mjs', import.meta.url).href
  const code = `import {spawn} from 'node:child_process'; import {acquireRunLock,createProcessRegistry} from ${JSON.stringify(module)};
const registry=createProcessRegistry(${JSON.stringify(root)}); await acquireRunLock(${JSON.stringify(root)},{processesFile:registry.path});
const child=spawn(process.execPath,['-e','setTimeout(()=>{},30000)'],{detached:true,stdio:'ignore'});registry.started(child.pid);console.log(child.pid);process.exit(0);`
  const result = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', code])
  const pid = Number(result.stdout.trim())
  t.after(() => { try { process.kill(-pid, 'SIGKILL') } catch {} })
  await assert.rejects(acquireRunLock(root), /worker.*running/i)
})

test('stage cache keys and records include the effective execution settings', async t => {
  const { config, output } = await setup(t)
  const state = await openState(config)
  t.after(() => state.close())
  let calls = 0
  const run = async () => { calls++; await writeFile(output, 'complete'); return { written_file: output } }
  const first = { model: 'model-a', effort: 'high', sources: { model: 'config', effort: 'config' } }
  const second = { ...first, model: 'model-b' }
  await state.run('prompt', { label: 'stage', execution: first }, run)
  assert.deepEqual(state.data.stages.stage.execution, first)
  await state.run('prompt', { label: 'stage', execution: first }, run)
  assert.equal(calls, 1)
  await state.run('prompt', { label: 'stage', execution: second }, run)
  assert.equal(calls, 2)
  assert.equal(state.data.stages.stage.execution.model, 'model-b')
})

test('content review, revision and position synchronization do not reuse stale file inputs', async t => {
  const { config, output } = await setup(t)
  const state = await openState(config)
  t.after(() => state.close())
  let calls = 0
  const run = async () => { calls++; await writeFile(output, 'complete'); return { written_file: output } }
  for (const label of ['成稿审查:0', '修订成稿:1', '更新档案']) {
    await state.run('prompt', { label }, run)
    await state.run('prompt', { label }, run)
  }
  assert.equal(calls, 6)
})


test('readonly contracts keep judgments and logs without claiming model written_file or filesystem artifacts', async t => {
  const { config, root, output } = await setup(t)
  const state=await openState(config)
  t.after(()=>state.close())
  for(const contract of ['proposal','review','evidence_extract']) {
    const result=await state.run('readonly',{label:contract,contract,isolation:'strict-readonly'},async()=>({written_file:join(root,'absent.md'),value:contract}))
    assert.equal(result.value,contract)
    assert.deepEqual(state.data.stages[contract].artifacts,[])
  }
  await assert.rejects(readFile(output),{code:'ENOENT'})
})

test('stage cache includes contract isolation images and dependency digests',async t=>{
  const {config,output}=await setup(t)
  const state=await openState(config); t.after(()=>state.close())
  let calls=0
  const execute=async()=>{calls++;await writeFile(output,'ok');return {written_file:output}}
  const base={label:'stage',contract:'writer',isolation:'workspace-write',images:['a'],dependencyDigests:'one'}
  await state.run('same',base,execute)
  await state.run('same',base,execute)
  for(const changes of [{contract:'other'},{isolation:'different'},{images:['b']},{dependencyDigests:'two'}]) await state.run('same',{...base,...changes},execute)
  assert.equal(calls,5)
})

test('generic recovery and invalidation never restore or quarantine Store-owned canonical paths; reset archives whole Store',async t=>{
  const {root,config}=await setup(t)
  const {mkdir,readdir}=await import('node:fs/promises')
  const report=join(root,'report.md'), review=join(root,'成稿审查.json'), store=join(config.dir,'review')
  await mkdir(store,{recursive:true});await writeFile(join(store,'HEAD.json'),'host HEAD')
  await writeFile(report,'committed report');await writeFile(review,'committed review')
  const backup=join(config.dir,'old-report');await writeFile(backup,'stale draft')
  await writeFile(join(config.dir,'state.json'),JSON.stringify({version:1,fingerprint:'v1',stages:{legacy:{status:'failed',artifacts:[report,review],backups:[{path:report,backup},{path:review,backup}]}}}))
  let state=await openState({...config,artifactsFor:()=>[report,review]})
  assert.equal(await readFile(report,'utf8'),'committed report')
  assert.equal(await readFile(review,'utf8'),'committed review')
  await state.close()
  state=await openState({...config,reset:true,resetArtifacts:[report,review]})
  await assert.rejects(readFile(join(store,'HEAD.json')),{code:'ENOENT'})
  const archives=await readdir(join(config.dir,'quarantine'),{recursive:true})
  assert.ok(archives.some(p=>p.endsWith('review/HEAD.json')))
  await state.close()
})

test('reset archives input manifest with Store and preserves persistent position inputs',async t=>{
  const {root}=await setup(t)
  const {mkdir,readdir}=await import('node:fs/promises')
  const run=join(root,'run'),dir=join(run,'.codex-workflow'),position=join(root,'position.md')
  await mkdir(join(dir,'review'),{recursive:true})
  await writeFile(join(dir,'review/HEAD.json'),'host head')
  await writeFile(join(dir,'input-manifest.json'),'old manifest')
  await writeFile(position,'human maintained position')
  await writeFile(join(dir,'state.json'),JSON.stringify({version:1,fingerprint:'v1',stages:{position:{status:'succeeded',artifacts:[position]}}}))
  const state=await openState({dir,fingerprint:'v2',artifactRoots:[run,position],reset:true})
  await state.close()
  assert.equal(await readFile(position,'utf8'),'human maintained position')
  const entries=await readdir(join(dir,'quarantine'),{recursive:true})
  assert.ok(entries.some(p=>p.endsWith('input-manifest.json')))
  assert.ok(entries.some(p=>p.endsWith('review/HEAD.json')))
})

test('Store ownership also protects physical report aliases from failed generic stage restoration',async t=>{
  const {root,config}=await setup(t)
  const {mkdir}=await import('node:fs/promises')
  const store=join(config.dir,'review'),report=join(root,'report.md'),alias=join(root,'report-link.md')
  await mkdir(store,{recursive:true});await writeFile(join(store,'HEAD.json'),'host head')
  await writeFile(report,'host candidate');await symlink(report,alias)
  const state=await openState({...config,artifactsFor:()=>[alias]})
  await assert.rejects(state.run('unsafe generic worker',{label:'writer'},async()=>{throw new Error('interrupted')}),/interrupted/)
  assert.equal(await readFile(report,'utf8'),'host candidate')
  assert.deepEqual(state.data.stages.writer.artifacts,[])
  await state.close()
})
