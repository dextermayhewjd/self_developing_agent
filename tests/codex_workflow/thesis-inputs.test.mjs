import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm, unlink, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { resolveThesisInputManifest, diagnoseLegacyReviewState, createThesisInputTracker } from '../../tools/codex_workflow/thesis-inputs.mjs'
import { workflowFingerprint } from '../../tools/run_codex_workflow.mjs'

async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), 'thesis-inputs-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const symbol = '00700', runDir = join(root, 'reports/00700_thesis_20261016')
  async function put(path, bytes) { await mkdir(join(path, '..'), { recursive: true }); await writeFile(path, bytes) }
  await put(join(root, '.codex/workflows/equity-thesis.mjs'), 'return {}')
  await mkdir(join(root, '.codex/skills'), { recursive: true })
  await put(join(root, 'data', symbol, 'aggregate.json'), '{}')
  await put(join(root, 'data', symbol, 'annual_pdf/hk_2025.pdf'), 'pdf')
  return { root, symbol, runDir, put, data: join(root, 'data', symbol) }
}

test('original byte identity includes aggregate, annual PDFs, new originals and method; operational review_only is excluded', async t => {
  const {root,symbol,data,put}=await setup(t)
  const fingerprint = () => workflowFingerprint(root,'equity-thesis',{symbol}, {})
  const initial = await fingerprint()
  assert.equal(await workflowFingerprint(root,'equity-thesis',{symbol,review_only:true},{}),initial)
  for (const path of ['aggregate.json','annual_pdf/hk_2025.pdf','ccass.json']) {
    const before = await fingerprint()
    await put(join(data,path), 'changed')
    assert.notEqual(await fingerprint(),before,path)
  }
  const current=await fingerprint()
  await put(join(root,'.codex/skills/SKILL.md'),'changed methodology')
  assert.notEqual(await fingerprint(),current)
})

test('exact registered derived files do not alter identity; dependency mutation/deletion refuses reuse', async t => {
  const {root,symbol,runDir,data,put}=await setup(t)
  const tracker=await createThesisInputTracker({root,symbol,runDir})
  const original=await workflowFingerprint(root,'equity-thesis',{symbol},{},{inputManifest:tracker.manifest})
  const before=await tracker.beforeStage('板块基准')
  for (const path of ['peers_curated.json','benchmark_peers/computed.json','peer_financials_benchmark.json']) await put(join(data,path),'generated')
  await tracker.afterStage('板块基准',before)
  const checkBefore=await tracker.beforeStage('核查:产业')
  await put(join(data,'check_sources/产业/source.txt'),'source')
  await tracker.afterStage('核查:产业',checkBefore)
  await tracker.assertCurrent()
  assert.equal(tracker.manifest.derived.length,4)
  assert.equal(await workflowFingerprint(root,'equity-thesis',{symbol},{},{inputManifest:tracker.manifest}),original)
  const dependency=await tracker.dependencies('成稿')
  await put(join(data,'benchmark_peers/computed.json'),'externally modified')
  await assert.rejects(tracker.assertCurrent(),/板块基准.*benchmark_peers/u)
  await assert.rejects(tracker.dependencies('成稿'), /reconciliation/)
  assert.equal(await workflowFingerprint(root,'equity-thesis',{symbol},{},{inputManifest:await tracker.resolve()}),original)
  await unlink(join(data,'check_sources/产业/source.txt'))
  await assert.rejects(tracker.assertCurrent(),/check_sources/u)
})

test('unregistered additions are listed, original paths cannot be relabeled, and unsafe paths fail closed', async t => {
  const {root,symbol,data,put}=await setup(t)
  await put(join(data,'benchmark_peers/unregistered.json'),'unknown')
  const manifest=await resolveThesisInputManifest({root,symbol})
  assert.deepEqual(manifest.unclassified,['benchmark_peers/unregistered.json'])
  await assert.rejects(workflowFingerprint(root,'equity-thesis',{symbol},{}),/benchmark_peers.*unregistered/u)
  for (const path of ['aggregate.json','../outside','benchmark_peers/../../escape']) {
    await assert.rejects(resolveThesisInputManifest({root,symbol,derivedRegistry:[{path,stage:'板块基准',sha256:'0'.repeat(64)}]}),/original|unsafe/i)
  }
  await symlink('/tmp',join(data,'link'))
  await assert.rejects(resolveThesisInputManifest({root,symbol}),/symlink/i)
})

test('concurrent producers register only their scoped new paths and reject unknown preexisting paths', async t=>{
  const {root,symbol,runDir,data,put}=await setup(t)
  const tracker=await createThesisInputTracker({root,symbol,runDir})
  const board=await tracker.beforeStage('板块基准'), check=await tracker.beforeStage('核查:产业')
  await put(join(data,'benchmark_peers/peer.json'),'board')
  await put(join(data,'check_sources/产业/source.txt'),'check')
  await Promise.all([tracker.afterStage('板块基准',board),tracker.afterStage('核查:产业',check)])
  assert.deepEqual(tracker.manifest.derived.map(x=>[x.path,x.stage]),[['benchmark_peers/peer.json','板块基准'],['check_sources/产业/source.txt','核查:产业']])
  await put(join(data,'benchmark_peers/stray.json'),'stray')
  await assert.rejects(tracker.beforeStage('板块基准'),/benchmark_peers.*stray/u)
})

test('research original mutation is rejected without replacing the original manifest',async t=>{
  const {root,symbol,runDir,data,put}=await setup(t)
  const tracker=await createThesisInputTracker({root,symbol,runDir})
  const before=await tracker.beforeStage('板块基准')
  await put(join(data,'aggregate.json'),'worker changed raw data')
  await assert.rejects(tracker.afterStage('板块基准',before),/original.*aggregate/u)
})

test('legacy diagnosis is read-only, requires independent origin and round proofs; new protocol without HEAD is not legacy',async t=>{
  const {root,symbol,runDir,put}=await setup(t)
  const statePath=join(runDir,'.codex-workflow/state.json')
  const state={version:1,fingerprint:'legacy',stages:{'修订成稿:1':{status:'succeeded'}}}
  await put(statePath,JSON.stringify(state))
  const bytes=await readFile(statePath)
  const inputManifest=await resolveThesisInputManifest({root,symbol})
  const diagnosis=await diagnoseLegacyReviewState({runDir,inputManifest})
  assert.equal(diagnosis.migratable,false)
  assert.match(diagnosis.reasons.join(' '),/origin.*round|round.*origin/i)
  assert.deepEqual(await readFile(statePath),bytes)
  await put(statePath,JSON.stringify({...state,invocation:{reviewProtocol:2}}))
  const current=await diagnoseLegacyReviewState({runDir,inputManifest})
  assert.equal(current.migratable,true)
  assert.equal(current.proofs.protocol,2)
})

async function legacyProofFixture(t) {
  const {root,symbol,runDir,put}=await setup(t)
  const {sha256}=await import('../../tools/codex_workflow/review-contracts.mjs')
  const proof=join(root,'proof'), statePath=join(runDir,'.codex-workflow/state.json')
  const stages={}
  for(let i=0;i<3;i++) {
    stages[`成稿审查:${i}`]={status:'succeeded',result:{verdict:'revise'}}
    if(i)stages[`修订成稿:${i}`]={status:'succeeded'}
    const report=`frozen candidate ${i}`
    await put(join(proof,'versions',i?`report-revision-${i}.md`:'report-initial.md'),report)
    await put(join(proof,'versions',`review-${i}.json`),JSON.stringify({report_sha256:sha256(report),verdict:'revise'}))
  }
  const state={version:1,fingerprint:'frozen-v1',stages}
  await put(statePath,JSON.stringify(state))
  await put(join(proof,'new-run/.codex-workflow/state.json'),JSON.stringify(state))
  const inputManifest=await resolveThesisInputManifest({root,symbol})
  const raw_inputs=Object.fromEntries(inputManifest.originals.map(e=>[e.path,e.sha256]))
  await put(join(proof,'test-manifest.json'),JSON.stringify({symbol,date:'20261016',raw_inputs}))
  const methods={'.codex/workflows/equity-thesis.mjs':sha256(await readFile(join(root,'.codex/workflows/equity-thesis.mjs')))}
  await put(join(proof,'source-snapshot.json'),JSON.stringify(methods))
  await put(join(proof,'final-integrity.json'),JSON.stringify({raw:Object.entries(raw_inputs).map(([path,expected])=>({path,expected,source:expected,scratch:expected})),source:Object.entries(methods).map(([path,expected])=>({path,expected,source:expected,scratch:expected}))}))
  const index=[]
  for(const label of Object.keys(stages)) {
    const archived=`proof/native-rollouts/${label.replace(':','_')}-fixture.jsonl`,body=`completed ${label}`
    await put(join(root,archived),body)
    index.push({stage:label.replace(':','_')+'-fixture',completed:true,archived,bytes:Buffer.byteLength(body),sha256:sha256(body)})
  }
  await put(join(proof,'native-rollouts/index.json'),JSON.stringify(index))
  await put(join(runDir,'.codex-workflow/legacy-proof.json'),JSON.stringify({directory:proof}))
  return { root, symbol, runDir, put, proof, statePath, inputManifest, index }
}

test('eligible frozen legacy proof reconstructs two rounds and three rejected reviews without writing state or importing',async t=>{
  const {root,symbol,runDir,put,statePath,inputManifest}=await legacyProofFixture(t)
  const original=await readFile(statePath)
  const diagnosis=await diagnoseLegacyReviewState({runDir,inputManifest})
  assert.deepEqual(diagnosis,{migratable:true,reasons:[],usedRounds:2,proofs:{validReviews:3,finalVerdict:'revise',terminalReason:'legacy_review_rejected',requiresExplicitImport:true}})
  assert.deepEqual(await readFile(statePath),original)
  await assert.rejects(readFile(join(runDir,'.codex-workflow/review/HEAD.json')),{code:'ENOENT'})
  const {execFile}=await import('node:child_process'),{promisify}=await import('node:util'),{fileURLToPath}=await import('node:url')
  const cli=fileURLToPath(new URL('../../tools/run_codex_workflow.mjs',import.meta.url))
  await assert.rejects(promisify(execFile)(process.execPath,[cli,'equity-thesis','--root',root,'--symbol',symbol,'--date','20261016']),/Evidence eligible.*used rounds=2.*valid reviews=3.*final verdict=revise/u)
  assert.deepEqual(await readFile(statePath),original)
  await assert.rejects(readFile(join(runDir,'.codex-workflow/workers.json')),{code:'ENOENT'})
  await put(join(root,'.codex/workflows/equity-thesis.mjs'),'new methodology')
  assert.match((await diagnoseLegacyReviewState({runDir,inputManifest})).reasons.join(' '),/Methodology proof mismatch/u)
  assert.deepEqual(await readFile(statePath),original)
})

for (const scenario of ['extra completed revision and review', 'duplicate completed call', 'noncanonical duplicate completed call', 'bare completed review family', 'bare completed revision family', 'malformed completed family']) {
  test('legacy diagnosis refuses '+scenario+' outside a one-to-one complete state history',async t=>{
    const {root,runDir,put,proof,statePath,inputManifest,index}=await legacyProofFixture(t)
    const {sha256}=await import('../../tools/codex_workflow/review-contracts.mjs')
    const before=await readFile(statePath)
    const add=async stage=>{
      const archived='proof/native-rollouts/'+stage+'.jsonl',body='completed '+stage
      await put(join(root,archived),body)
      index.push({stage,completed:true,archived,bytes:Buffer.byteLength(body),sha256:sha256(body)})
    }
    if(scenario==='extra completed revision and review') {
      await add('修订成稿_3-extra');await add('成稿审查_3-extra')
    } else await add({
      'duplicate completed call':'成稿审查_0-duplicate',
      'noncanonical duplicate completed call':'成稿审查_00-duplicate',
      'bare completed review family':'成稿审查',
      'bare completed revision family':'修订成稿',
      'malformed completed family':'修订成稿-3-malformed',
    }[scenario])
    await put(join(proof,'native-rollouts/index.json'),JSON.stringify(index))
    const diagnosis=await diagnoseLegacyReviewState({runDir,inputManifest})
    assert.equal(diagnosis.migratable,false)
    assert.match(diagnosis.reasons.join(' '),/Unexplained|Duplicate|noncanonical/u)
    assert.equal(diagnosis.usedRounds,null)
    assert.equal(diagnosis.proofs.validReviews,null)
    assert.deepEqual(await readFile(statePath),before)
  })
}

for (const rewrite of [false, true]) test(`in-flight ${rewrite ? 'rewritten' : 'new'} producer permits independent runtime admission and recovers interruption`, async t => {
  const { createRuntime } = await import('../../tools/codex_workflow/runtime.mjs')
  const f = await setup(t), tracker = await createThesisInputTracker(f)
  const output = join(f.data, 'peers_curated.json')
  if (rewrite) { const before = await tracker.beforeStage('板块基准'); await f.put(output, 'settled'); await tracker.afterStage('板块基准', before) }
  let wrote, admitted
  const written = new Promise(resolve => { wrote = resolve })
  const admission = new Promise(resolve => { admitted = resolve })
  const runtime = createRuntime({ jobs: 2, runAgent: async (_, {label}, signal) => {
    await tracker.assertCurrent({ admission: true })
    const before = await tracker.beforeStage(label)
    if (label === '板块基准') {
      await f.put(output, 'in flight'); wrote()
      await admission
      signal.throwIfAborted()
      throw Error('interrupted producer')
    }
    if (label === '挖掘:财务') await written
    else admitted()
    await tracker.afterStage(label, before)
  } })
  const work = runtime.parallel([
    () => runtime.agent('', {label:'板块基准'}),
    async () => { await runtime.agent('', {label:'挖掘:财务'}); await runtime.agent('', {label:'核查:财务'}) },
  ])
  // Always release the board on admission failure so the reproduction cannot hang.
  work.catch(() => admitted())
  await assert.rejects(work, /interrupted producer/)
  await runtime.drain()
  await assert.rejects(tracker.dependencies('成稿'), /unsettled|in.flight|producer/i)
  const reopened = await createThesisInputTracker(f)
  await assert.rejects(reopened.assertCurrent(), /Unsettled/ )
  await reopened.assertCurrent({admission:true})
  if (rewrite) assert.equal(await readFile(output, 'utf8'), 'settled')
  else await assert.rejects(readFile(output), {code:'ENOENT'})
  const before = await reopened.beforeStage('板块基准')
  await f.put(output, 'rerun settled'); await reopened.afterStage('板块基准', before)
  await reopened.assertCurrent()
  await f.put(output, 'external change')
  await assert.rejects(reopened.assertCurrent({admission:true}), /reconciliation|changed/)
})

test('new native report date carries only verified producer provenance and leaves prior records immutable', async t => {
  const f = await setup(t), first = await createThesisInputTracker(f)
  const before = await first.beforeStage('板块基准')
  await f.put(join(f.data, 'peers_curated.json'), 'prior derived')
  await first.afterStage('板块基准', before)
  const path = join(f.runDir, '.codex-workflow/input-manifest.json'), bytes = await readFile(path)
  const next = {...f, runDir:join(f.root, 'reports/00700_thesis_20261017')}
  const second = await createThesisInputTracker(next)
  await second.assertCurrent()
  assert.equal(second.manifest.derived[0].sha256, first.manifest.derived[0].sha256)
  assert.deepEqual(await readFile(path), bytes)
  assert.notEqual(second.manifest.derived[0].provenance.run, next.runDir)
  const active = await second.beforeStage('板块基准')
  await f.put(join(f.data, 'peers_curated.json'), 'new research')
  await second.afterStage('板块基准', active)
  assert.notEqual(second.manifest.derived[0].sha256, first.manifest.derived[0].sha256)
  assert.deepEqual(await readFile(path), bytes)
  await f.put(join(f.data, 'peers_curated.json'), 'tampered')
  await assert.rejects(createThesisInputTracker({...next,runDir:join(f.root,'reports/00700_thesis_20261018')}), /Unclassified|provenance|reconciliation/)
})

for (const path of ['aggregate.json','unknown.txt','check_sources/产业/stray.txt']) test('interrupted producer recovery refuses '+path+' before altering any bytes',async t=>{
 const f=await setup(t),tracker=await createThesisInputTracker(f)
 await tracker.beforeStage('板块基准')
 const manifestPath=join(f.runDir,'.codex-workflow/input-manifest.json')
 const durable=JSON.parse(await readFile(manifestPath,'utf8'))
 assert.ok(durable.producers.active['板块基准'])
 await f.put(join(f.data,'peers_curated.json'),'interrupted bytes')
 await f.put(join(f.data,path),'unowned edit')
 const before=await readFile(manifestPath)
 await assert.rejects(createThesisInputTracker(f),/original|Unclassified/)
 assert.deepEqual(await readFile(manifestPath),before)
 assert.equal(await readFile(join(f.data,'peers_curated.json'),'utf8'),'interrupted bytes')
 assert.equal(await readFile(join(f.data,path),'utf8'),'unowned edit')
})

test('recovery preserves quarantined bytes, rejects changed recovery bytes, and never adopts unknown matching names',async t=>{
 const f=await setup(t),tracker=await createThesisInputTracker(f)
 await tracker.beforeStage('板块基准')
 await f.put(join(f.data,'peers_curated.json'),'interrupted bytes')
 const reopened=await createThesisInputTracker(f)
 const history=reopened.manifest.producers.history[0]
 assert.equal(Buffer.from(history.recovery[0].bytes,'base64').toString(),'interrupted bytes')
 assert.deepEqual(reopened.pendingStages,['板块基准'])
 await createThesisInputTracker(f)
 await f.put(join(f.data,'peers_curated.json'),'unowned matching name')
 await assert.rejects(createThesisInputTracker(f),/Unclassified/)
 await assert.rejects(reopened.beforeStage('板块基准'),/Unclassified/)
})

test('two concurrent successful producers settle only after independent runtime admission',async t=>{
 const {createRuntime}=await import('../../tools/codex_workflow/runtime.mjs')
 const f=await setup(t),tracker=await createThesisInputTracker(f)
 let wrote,checked
 const written=new Promise(resolve=>{wrote=resolve}),check=new Promise(resolve=>{checked=resolve})
 const runtime=createRuntime({jobs:2,runAgent:async(_,{label})=>{
  await tracker.assertCurrent({admission:true});await tracker.dependencies(label)
  const before=await tracker.beforeStage(label)
  if(label==='板块基准'){await f.put(join(f.data,'peers_curated.json'),'settled board');wrote();await check}
  if(label==='挖掘:财务')await written
  if(label==='核查:财务'){await f.put(join(f.data,'check_sources/财务/source.txt'),'settled check');checked()}
  await tracker.afterStage(label,before)
 }})
 await runtime.parallel([()=>runtime.agent('',{label:'板块基准'}),async()=>{await runtime.agent('',{label:'挖掘:财务'});await runtime.agent('',{label:'核查:财务'})}])
 await tracker.assertCurrent()
 const before=await tracker.dependencies('成稿')
 assert.equal(tracker.manifest.derived.length,2)
 const reopened=await createThesisInputTracker(f)
 assert.deepEqual(await reopened.dependencies('成稿'),before)
})

test('cross-date continuity records exact immutable native manifest digest',async t=>{
 const {sha256}=await import('../../tools/codex_workflow/review-contracts.mjs')
 const f=await setup(t),first=await createThesisInputTracker(f)
 const before=await first.beforeStage('板块基准');await f.put(join(f.data,'peers_curated.json'),'native');await first.afterStage('板块基准',before)
 const bytes=await readFile(join(f.runDir,'.codex-workflow/input-manifest.json'))
 const next=await createThesisInputTracker({...f,runDir:join(f.root,'reports/00700_thesis_20261017')})
 assert.deepEqual(next.manifest.derived[0].continuity_sources,[{run:f.runDir,manifest_sha256:sha256(bytes)}])
})

test('repeated interrupted producer recovery invalidates real State success cache and invokes backend each time',async t=>{
 const {openState}=await import('../../tools/codex_workflow/state.mjs')
 const f=await setup(t);let tracker=await createThesisInputTracker(f),calls=0
 const state=await openState({dir:join(f.runDir,'.codex-workflow'),fingerprint:'fixture',artifactRoots:[f.runDir],artifactsFor:()=>[]})
 t.after(()=>state.close())
 const run=async()=>state.run('produce',{label:'板块基准',dependencyDigests:await tracker.dependencies('板块基准')},async()=>{
  calls++;const before=await tracker.beforeStage('板块基准');await f.put(join(f.data,'peers_curated.json'),'settled');await tracker.afterStage('板块基准',before);return {}
 })
 await run();assert.equal(calls,1)
 for(let i=0;i<2;i++) {
  await tracker.beforeStage('板块基准');await f.put(join(f.data,'peers_curated.json'),'interrupted '+i)
  tracker=await createThesisInputTracker(f)
  await run();assert.equal(calls,i+2)
  await tracker.assertCurrent()
 }
})

test('recovery journal refuses later physical edits and preserves conflict bytes',async t=>{
 const {sha256}=await import('../../tools/codex_workflow/review-contracts.mjs')
 const f=await setup(t),tracker=await createThesisInputTracker(f)
 await tracker.beforeStage('板块基准');await f.put(join(f.data,'peers_curated.json'),'interrupted')
 const path=join(f.runDir,'.codex-workflow/input-manifest.json'),manifest=JSON.parse(await readFile(path))
 manifest.producers.active['板块基准'].recovery=[{path:'peers_curated.json',sha256:sha256('interrupted'),bytes:Buffer.from('interrupted').toString('base64')}]
 await writeFile(path,JSON.stringify(manifest));const before=await readFile(path)
 await f.put(join(f.data,'peers_curated.json'),'later manual edit')
 await assert.rejects(createThesisInputTracker(f),/recovery conflict/)
 assert.deepEqual(await readFile(path),before)
 assert.equal(await readFile(join(f.data,'peers_curated.json'),'utf8'),'later manual edit')
})

test('supplement producer can rerun its own interrupted scope while aggregate consumers remain blocked',async t=>{
 const f=await setup(t),tracker=await createThesisInputTracker(f)
 await tracker.beforeStage('补参照系');await f.put(join(f.data,'check_sources/补参照系/source.txt'),'interrupted')
 const reopened=await createThesisInputTracker(f)
 await assert.rejects(reopened.dependencies('成稿'),/Unsettled/)
 const dependency=await reopened.dependencies('补参照系')
 assert.equal(dependency.producer_generation,1)
 const before=await reopened.beforeStage('补参照系');await f.put(join(f.data,'check_sources/补参照系/source.txt'),'rerun');await reopened.afterStage('补参照系',before)
 await reopened.dependencies('成稿')
})
