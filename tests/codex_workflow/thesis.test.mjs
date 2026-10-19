import {writeSyntheticReviewMethods} from './fixtures/review-methods.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { runThesis, prepareData, lensNames } from '../../tools/codex_workflow/thesis.mjs'
import { reportFixture, writeStoreReviewFixtureV2 } from './fixtures/review-fixture.mjs'

async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), 'thesis-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await writeSyntheticReviewMethods(root)
  const args = { symbol: '00700', date: '20261015', root }
  const run = join(root, 'reports/00700_thesis_20261015')
  const events = []
  const make = async file => { await mkdir(join(file, '..'), { recursive: true }); await writeFile(file, '内容'.repeat(160)) }
  const runWorkflow = async (options = {}) => {
    if (options.review_only) { events.push('review-only'); return { content_review: await writeStoreReviewFixtureV2(run) } }
    events.push('research')
    for (const name of lensNames) {
      await make(join(run, `findings/${name}.md`))
      await make(join(run, `核查/${name}.md`))
    }
    await make(join(run, '疑惑.md'))
    await make(join(run, 'report.md'))
    await writeFile(join(run, 'report.md'), reportFixture())
    await writeStoreReviewFixtureV2(run)
    return { checked_total: 5 }
  }
  const runtime = { agent: async (prompt, options) => {
    events.push(options.label)
    const written_file = options.stagedPosition ?? join(root, 'positions/00700.md')
    await make(written_file)
    await writeFile(written_file, '---\n最近更新: 2026-10-15\n---\n' + '档案'.repeat(150))
    return { written_file }
  } }
  return { root, args, run, events, make, runWorkflow, runtime }
}

test('data warnings proceed; missing core fields collect once and then validate again', async t => {
  const { root } = await setup(t)
  const calls = []
  const codes = [1, 0, 2]
  const result = await prepareData({ root, symbol: '00700', runCommand: async (cmd, args) => {
    calls.push(args[0].split('/').at(-1)); return { code: codes.shift(), stdout: 'warning', stderr: '' }
  } })
  assert.deepEqual(calls, ['validate.py', 'run_pipeline.py', 'validate.py'])
  assert.ok(result.warnings.length > 0)
})

test('updates position before gate and converts PDF only after passing gate', async t => {
  const f = await setup(t)
  const command = async (cmd, argv) => {
    const script = argv[0].split('/').at(-1)
    f.events.push(script)
    if (script === 'md_to_pdf.py') await f.make(argv[argv.indexOf('--output')+1])
    return { code: 0, stdout: '', stderr: '' }
  }
  const summary = await runThesis({ ...f, prepared: { warnings: ['data warning'] }, runCommand: command })
  assert.deepEqual(f.events, ['research', '更新档案', 'check_thesis.py', 'md_to_pdf.py'])
  assert.equal(summary.gate_exit_code, 0)
  assert.equal(summary.pdf.status, 'generated')
  assert.ok(summary.warnings.includes('data warning'))
})

test('a complete existing report is independently reviewed without repeating research', async t => {
  const f = await setup(t)
  await f.runWorkflow(); await f.runtime.agent('', { label: '更新档案' }); f.events.length = 0
  const summary = await runThesis({ ...f, noPdf: true, prepared: { warnings: [] }, runCommand: async () => ({ code: 0, stdout: '', stderr: '' }) })
  assert.deepEqual(f.events, ['更新档案'])
  assert.equal(summary.reused, true)
  assert.equal(summary.pdf.status, 'skipped')
})

test('failed delivery stage cannot reuse a date-only partial position even if the old gate passes', async t => {
  const f = await setup(t)
  await f.runWorkflow(); await f.runtime.agent('', { label: '更新档案' }); f.events.length = 0
  await runThesis({ ...f, allowReuse: false, noPdf: true, prepared: { warnings: [] }, runCommand: async () => ({ code: 0, stdout: '', stderr: '' }) })
  assert.deepEqual(f.events, ['更新档案'])
})

test('missing or stale content review blocks position update and PDF delivery', async t => {
  const f = await setup(t)
  const runWorkflow = async (...args) => {
    await f.runWorkflow(...args)
    await writeFile(join(f.run, 'report.md'), reportFixture('审查后被改动'))
    return {}
  }
  await assert.rejects(runThesis({ ...f, runWorkflow, prepared: { warnings: [] },
    runCommand: async () => { throw new Error('must not reach gate or PDF') } }), /digest|sha256|conflict/i)
  assert.deepEqual(f.events, ['research'])
})


test('candidate without position ignores failed stage reuse flag and never prepares data or restarts research',async t=>{
 const f=await setup(t);await f.runWorkflow();f.events.length=0
 await runThesis({...f,allowReuse:false,noPdf:true,runCommand:async(cmd,argv)=>{assert.match(argv[0],/check_thesis.py$/);return {code:0}}})
 assert.deepEqual(f.events,['更新档案'])
})
test('nonempty coordinator terminalReason blocks old passing receipt before delivery',async t=>{
 const f=await setup(t);await f.runWorkflow();f.events.length=0
 await assert.rejects(runThesis({...f,prepared:{warnings:[]},coordinateReview:async()=>({review:{verdict:'pass'},terminalReason:'budget_exhausted'}),runCommand:async()=>{throw Error('unexpected')}}),/budget_exhausted/)
 assert.deepEqual(f.events,[])
})
for(const failure of ['nonzero','empty','absent','stale-report','stale-input']) test('PDF '+failure+' preserves existing canonical position and PDF',async t=>{
 const f=await setup(t);await f.runWorkflow();await f.runtime.agent('',{label:'更新档案'})
 const position=join(f.root,'positions/00700.md'),pdf=join(f.root,'reports/pdf/00700_thesis_20261015.pdf');await f.make(pdf)
 const oldPosition=await readFile(position),oldPdf=await readFile(pdf);let fresh=true
 await assert.rejects(runThesis({...f,prepared:{warnings:[]},assertInputsCurrent:async()=>{if(!fresh)throw Error('input stale')},runCommand:async(cmd,argv)=>{
 if(argv[0].endsWith('check_thesis.py'))return {code:0}
 const stage=argv[argv.indexOf('--output')+1]
 if(failure!=='absent')await writeFile(stage,failure==='empty'?'':'new PDF')
 if(failure==='stale-report')await writeFile(join(f.run,'report.md'),reportFixture('manual report'))
 if(failure==='stale-input')fresh=false
 return {code:failure==='nonzero'?1:0}
 }}))
 assert.deepEqual(await readFile(position),oldPosition);assert.deepEqual(await readFile(pdf),oldPdf)
})

async function nativeFixture(t) {
 const f=await setup(t),position=f.runtime.agent;const snapshots=[]
 f.runWorkflow=async()=>{
  f.events.push('research')
  for(const name of lensNames){await f.make(join(f.run,`findings/${name}.md`));await f.make(join(f.run,`核查/${name}.md`))}
  await f.make(join(f.run,'疑惑.md'));await writeFile(join(f.run,'初稿.md'),reportFixture('内容'))
  return {checked_total:5}
 }
 const {reviewFixtureV2}=await import('./fixtures/review-fixture.mjs')
 f.runtime.agent=async(prompt,options)=>{
  if(options.label==='更新档案'){snapshots.push(options.reportSnapshot);return position(prompt,options)}
  const context=JSON.parse(prompt.split('\nCONTEXT_JSON\n')[1]);f.events.push(options.contract)
  if(options.contract==='review')return reviewFixtureV2({ledgerSha256:context.input_ledger_sha256,reviewId:context.review_id,snapshot:context.snapshot,
   reviewed_sources:context.evidence.map(s=>s.path),
   task_dispositions:context.ledger.tasks.map(task=>({task_id:task.id,status:'resolved',reason:'独立确认',kind:task.kind,blocks_delivery:task.blocks_delivery})),
   coverage:lensNames.map(lens=>({lens,findings:[{finding:'source preserved',source:`findings/${lens}.md`,source_quote:context.evidence.find(s=>s.path===`findings/${lens}.md`).text,disposition:'covered',report_quote:'## 一、章节',exclusion_reason:'',issue_keys:[],task_ids:[]}]}))})
  return {task_ids:context.tasks.map(t=>t.id),base_report_sha256:context.snapshot.report_sha256,status:'proposed',
   edits:[{section:1,before:'内容',after:'内容 已修复',rationale:'checker repair',task_ids:context.tasks.map(t=>t.id)}],
   evidence_refs:context.tasks.flatMap(t=>t.evidence_refs),acceptance_checks:context.tasks.flatMap(task=>task.acceptance_criteria.map((_,criterion_index)=>({task_id:task.id,criterion_index,response:'请独立确认'}))),escalation_reason:''}
 }
 return {...f,snapshots}
}
test('initial draft enters real coordinator; gate repair shares one round and refreshes position snapshot',async t=>{
 const f=await nativeFixture(t);let gates=0
 const result=await runThesis({...f,prepared:{warnings:[]},noPdf:true,runCommand:async()=>({code:++gates===1?1:0,stdout:'[FAIL] 第一节格式错误'})})
 assert.equal(result.gate_exit_code,0);assert.deepEqual(f.events,['research','review','更新档案','proposal','review','更新档案'])
 assert.notEqual(f.snapshots[0].report_sha256,f.snapshots[1].report_sha256)
 const {openReviewStore}=await import('../../tools/codex_workflow/review-store.mjs');const state=await(await openReviewStore({runDir:f.run})).read()
 assert.equal(state.ledger.budget.used_rounds,1);assert.equal(state.ledger.budget.valid_reviews,2)
 const journal=JSON.parse(await readFile(join(f.run,'.codex-workflow/delivery/journal.json'),'utf8'))
 assert.deepEqual(journal.snapshot,state.snapshot);assert.deepEqual(journal.receipt,state.receipt)
 assert.match(await readFile(join(f.run,'report.md'),'utf8'),/已修复/)
 f.events.length=0
 await runThesis({...f,prepared:{warnings:[]},noPdf:true,runCommand:async()=>({code:0})})
 assert.deepEqual(f.events,['更新档案'])
})
test('gate exhaustion under absolute quota preserves prior delivery files',async t=>{
 const f=await nativeFixture(t);await f.runtime.agent('',{label:'更新档案'})
 const pos=join(f.root,'positions/00700.md'),pdf=join(f.root,'reports/pdf/00700_thesis_20261015.pdf');await f.make(pdf)
 const before=[await readFile(pos),await readFile(pdf)]
 await assert.rejects(runThesis({...f,reviewMaxRounds:1,prepared:{warnings:[]},runCommand:async()=>({code:1,stdout:'[FAIL] 第一节格式错误'})}),/budget_exhausted/)
 assert.deepEqual(await readFile(pos),before[0]);assert.deepEqual(await readFile(pdf),before[1])
})
test('review_only missing candidate cannot start research',async t=>{
 const f=await setup(t)
 await assert.rejects(runThesis({...f,args:{...f.args,review_only:true},prepared:{warnings:[]}}),/requires an existing candidate/)
 assert.deepEqual(f.events,[])
})

test('position-only checker repair does not consume semantic quota',async t=>{
 const f=await setup(t);await f.runWorkflow();f.events.length=0;let gates=0
 await runThesis({...f,noPdf:true,prepared:{warnings:[]},runCommand:async()=>({code:++gates===1?1:0,stdout:'[FAIL] 档案未更新到报告日：synthetic date issue'})})
 assert.deepEqual(f.events,['更新档案','更新档案'])
 const {openReviewStore}=await import('../../tools/codex_workflow/review-store.mjs');const state=await(await openReviewStore({runDir:f.run})).read()
 assert.equal(state.ledger.budget.used_rounds,0);assert.equal(state.ledger.budget.valid_reviews,1)
})

test('a different valid receipt during PDF generation cannot authorize outputs staged for the older snapshot',async t=>{
 const f=await nativeFixture(t);await f.runtime.agent('',{label:'更新档案'})
 const pos=join(f.root,'positions/00700.md'),pdf=join(f.root,'reports/pdf/00700_thesis_20261015.pdf');await f.make(pdf)
 const before=[await readFile(pos),await readFile(pdf)]
 const {coordinateThesisReview}=await import('../../tools/codex_workflow/review-coordinator.mjs')
 await assert.rejects(runThesis({...f,prepared:{warnings:[]},runCommand:async(cmd,argv)=>{
  if(argv[0].endsWith('check_thesis.py'))return {code:0}
  await writeFile(argv[argv.indexOf('--output')+1],'PDF of the older snapshot')
  await coordinateThesisReview({...f,gateFeedback:{gateId:'external-host-repair',feedback:'第一节格式修正'}})
  return {code:0}
 }}),/receipt changed/i)
 assert.deepEqual(await readFile(pos),before[0]);assert.deepEqual(await readFile(pdf),before[1])
})

for(const claim of ['wrong-path','nested'])test('direct runThesis rejects position '+claim+' output before gate or publication',async t=>{
 const f=await setup(t);await f.runWorkflow();const agent=f.runtime.agent
 f.runtime.agent=async(prompt,options)=>{const result=await agent(prompt,options);return claim==='wrong-path'?{written_file:join(f.run,'findings/产业.md')}:{...result,extra:{written_file:join(f.run,'findings/产业.md')}}}
 await assert.rejects(runThesis({...f,noPdf:true,prepared:{warnings:[]},runCommand:async()=>({code:0})}),/exclusive output/i)
 assert.equal((await readFile(join(f.run,'findings/产业.md'),'utf8')).length,320)
 await assert.rejects(readFile(join(f.root,'positions/00700.md')),{code:'ENOENT'})
})

for(const claim of ['wrong-path','nested'])test('native host plus real State rejects '+claim+' position claims before ownership registration',async t=>{
 const f=await setup(t);await f.runWorkflow()
 const {openState}=await import('../../tools/codex_workflow/state.mjs')
 const {workflowLocations}=await import('../../tools/run_codex_workflow.mjs')
 const layout=workflowLocations({root:f.root,name:'equity-thesis',args:f.args})
 const config={dir:join(f.run,'.codex-workflow'),fingerprint:'native-output-fixture',artifactRoots:layout.roots,artifactsFor:layout.artifactsFor,invocation:{reviewProtocol:2}}
 const state=await openState(config),agent=f.runtime.agent,evidence=join(f.run,'findings/产业.md')
 f.runtime.agent=(prompt,options)=>state.run(prompt,options,async()=>{
  const result=await agent(prompt,options)
  return claim==='wrong-path'?{written_file:evidence}:{...result,extra:{written_file:evidence}}
 })
 let record
 try {
  await assert.rejects(runThesis({...f,noPdf:true,prepared:{warnings:[]},runCommand:async()=>({code:0})}),/exclusive output/i)
  record=state.data.stages['更新档案']
  assert.equal(record.status,'failed')
  assert.deepEqual(record.artifacts,[record.exclusiveOutputPath])
  assert.ok(!record.outputs.includes(evidence))
 } finally {await state.close()}
 await rm(record.exclusiveOutputPath,{force:true})
 const reopened=await openState(config);await reopened.close()
 assert.equal(await readFile(evidence,'utf8'),'内容'.repeat(160))
})

for (const missingOpening of [false,true]) for (const failReview of [false,true]) test('real opening gate repairs preface through host and independent review; missing opening='+missingOpening+'; failure='+failReview,async t=>{
 const {execFile}=await import('node:child_process'),{promisify}=await import('node:util')
 const f=await nativeFixture(t),research=f.runWorkflow,agent=f.runtime.agent
 f.runWorkflow=async()=>{const result=await research();await writeFile(join(f.run,'初稿.md'),(missingOpening?'':'---\r\n标题: 合成研究\r\n---\r\n\r\n## 〇、开篇结论\r\n> **参照系声明**「净利」为私有基准。\r\n\r\n')+reportFixture('内容').replaceAll('\n','\r\n'));return result}
 let reviews=0,gateCalls=0
 f.runtime.agent=async(prompt,options)=>{
  if(options.contract==='review' && ++reviews===2 && failReview)throw Error('independent review failed')
  const result=await agent(prompt,options)
  if(options.contract==='proposal')result.edits=[{...result.edits[0],section:0,before:missingOpening?'## 一、章节':'「净利」为私有基准。',after:missingOpening?'## 〇、开篇结论\r\n> **参照系声明**「净利」为私有基准，未取得外部参照系，无法判断相对水平。\r\n\r\n## 一、章节':'「净利」为私有基准，未取得外部参照系，无法判断相对水平。'}]
  return result
 }
 await f.runtime.agent('',{label:'更新档案'})
 const position=join(f.root,'positions/00700.md'),pdf=join(f.root,'reports/pdf/00700_thesis_20261015.pdf')
 await f.make(pdf);const old=[await readFile(position),await readFile(pdf)]
 const run=runThesis({...f,prepared:{warnings:[]},noPdf:true,runCommand:async()=>{
  gateCalls++
  const {stdout}=await promisify(execFile)('python3',['-c',"import sys,json;sys.path.insert(0,'tools');from check_thesis import check_opening_benchmark;print(json.dumps(check_opening_benchmark(open(sys.argv[1]).read(),{'净利':'私有基准'}),ensure_ascii=False))",join(f.run,'report.md')],{cwd:process.cwd()})
  const errors=JSON.parse(stdout);return {code:errors.length?1:0,stdout:errors.join('\n')}
 }})
 if(failReview){await assert.rejects(run,/independent review failed/);assert.deepEqual(await readFile(position),old[0]);assert.deepEqual(await readFile(pdf),old[1])}
 else {assert.equal((await run).gate_exit_code,0);assert.equal(gateCalls,2);assert.equal(reviews,2);assert.match(await readFile(join(f.run,'report.md'),'utf8'),/未取得外部参照系/)}
})
