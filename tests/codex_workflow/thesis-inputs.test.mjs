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
    await put(join(data,path), 'changed')
    assert.notEqual(await fingerprint(),initial)
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
  assert.notEqual(await tracker.dependencies('成稿'),dependency)
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
  const before=await tracker.beforeStage('板块基准')
  await tracker.afterStage('板块基准',before)
  await assert.rejects(tracker.assertCurrent(),/benchmark_peers.*stray/u)
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

test('eligible frozen legacy proof reconstructs two rounds and three rejected reviews without writing state or importing',async t=>{
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

test('frozen 300209 originals replay in temporary stock tree; exact registered additions preserve identity',async t=>{
  const {root,runDir,put}=await setup(t)
  const source=new URL('../../debug/300209_native_retest_20261016/test-manifest.json',import.meta.url)
  const frozen=JSON.parse(await readFile(source,'utf8'))
  for(const [path,expected] of Object.entries(frozen.raw_inputs)) {
    const bytes=await readFile(new URL(`../../data/300209/${path}`,import.meta.url))
    const {sha256}=await import('../../tools/codex_workflow/review-contracts.mjs')
    assert.equal(sha256(bytes),expected,path)
    await put(join(root,'data/300209',path),bytes)
  }
  const tracker=await createThesisInputTracker({root,symbol:'300209',runDir})
  const fingerprint=()=>workflowFingerprint(root,'equity-thesis',{symbol:'300209'},{},{inputManifest:tracker.manifest})
  const original=await fingerprint()
  const before=await tracker.beforeStage('板块基准')
  await put(join(root,'data/300209/benchmark_peers/computed.json'),'fixture derived')
  await tracker.afterStage('板块基准',before)
  assert.equal(await fingerprint(),original)
  assert.equal(tracker.manifest.originals.length,11)
})
