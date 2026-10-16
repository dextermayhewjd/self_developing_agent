import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const api = await import('../../tools/codex_workflow/calibration.mjs').catch(() => ({}))
const codes = ['石基', '澜起', '开立', '中控', '乐鑫']
const repeat = s => (s + '\n').repeat(25)
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'native-calibration-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const evidence = join(root, '.codex/skills/calibrate-equity-thesis/evidence')
  await mkdir(evidence, { recursive: true })
  for (const code of codes) await writeFile(join(evidence, `${code}.md`), repeat(`document ${code} evidence`))
  await writeFile(join(evidence, 'methods.md'), repeat('method action'))
  return { root, evidence, args: { date: '20261016' } }
}
test('calibration reuses only a complete five-document plus methods evidence bundle', async t => {
  assert.equal(typeof api.readCalibrationEvidence, 'function')
  const f = await fixture(t)
  const cached = await api.readCalibrationEvidence(f)
  assert.equal(cached.documents.length, 5)
  assert.match(cached.methods_text, /method action/)
  await rm(join(f.evidence, 'methods.md'))
  assert.equal(await api.readCalibrationEvidence(f), null)
})
test('patch thresholds reject tiny samples and require independently confirmed checks', () => {
  assert.equal(typeof api.patchEligible, 'function')
  const card = (kind, hits, total) => ({ kind, supporting_docs: codes.slice(0, hits), eligible_docs: codes.slice(0, total) })
  assert.equal(api.patchEligible(card('omission', 2, 5), { status: 'confirmed' }), false)
  assert.equal(api.patchEligible(card('omission', 3, 5), { status: 'confirmed' }), true)
  assert.equal(api.patchEligible(card('overfit', 0, 2), { status: 'confirmed' }), false)
  assert.equal(api.patchEligible(card('overfit', 0, 3), { status: 'confirmed' }), true)
  assert.equal(api.patchEligible(card('overfit', 1, 5), { status: 'confirmed' }), false)
  assert.equal(api.patchEligible(card('omission', 3, 5), { status: 'unresolved' }), false)
  assert.equal(api.patchEligible(card('overfit', 0, 0), { status: 'confirmed' }), false)
})
test('complete native calibration runs collision, check, proposal, persists output without touching rules', async t => {
  assert.equal(typeof api.runCalibration, 'function')
  const f = await fixture(t)
  const target = join(f.root, '.codex/skills/equity-thesis-cn/framework.md')
  await mkdir(join(target, '..'), { recursive: true })
  await writeFile(target, 'Original rule text')
  const seen = []
  const card = { id: 'D-01', kind: 'omission', summary: 'missing action', rule_ids: ['R-01'], eligible_docs: codes, supporting_docs: codes.slice(0, 3), source_quote: 'method action' }
  const runtime = { agent: async (prompt, options) => {
    seen.push(options.label)
    if (options.label === '方法对撞') return { cards: [card], matrix: Array.from({length:12},(_,i)=>({section:i+1,cells:codes.map(code=>({code,status:'done',evidence:'page 1 action'}))})) }
    if (options.label === '抽查') return { checks: [{ id: 'D-01', status: 'confirmed', eligible_docs: codes, supporting_docs: codes.slice(0,3), evidence: codes.map(code=>({code,page:'1',quote:'source excerpt',finding:codes.indexOf(code)<3?'present':'confirmed_absence'})) }] }
    if (options.label === '校准报告') return { narrative: 'reviewed', patches: [{ id:'P-01',card_id:'D-01',target:'equity-thesis-cn/framework.md',before:'Original rule text',after:'Revised rule text',reason:'three documents support this' }] }
    throw new Error(options.label)
  } }
  const stale = join(f.root, 'reports/calibrate_20261016/patches/stale.md')
  await mkdir(join(stale, '..'), {recursive:true})
  await writeFile(stale, 'obsolete proposal')
  const result = await api.runCalibration({ ...f, runtime, runWorkflow: async args => {
    assert.equal(args.evidence_ready, true)
    return { rules: [{ id:'R-01',summary:'a rule',source:'framework.md:1',verbatim:'Original rule text',scope:'无条件',scope_reason:'text',form:'方法型' }] }
  } })
  assert.deepEqual(seen, ['方法对撞','抽查','校准报告'])
  assert.equal(result.patches.length, 1)
  await assert.rejects(readFile(stale), {code:'ENOENT'})
  assert.equal(await readFile(target,'utf8'), 'Original rule text')
  assert.match(await readFile(join(result.run_dir,'报告.md'),'utf8'), /12 节符合度/)
  assert.match(await readFile(join(result.run_dir,'patches/equity-thesis-cn/framework.md'),'utf8'), /Revised rule text/)
  assert.ok((await readdir(join(result.run_dir))).includes('rules.json'))
})

test('an interrupted evidence publication is never accepted as a migrated complete bundle', async t => {
  const f = await fixture(t)
  await writeFile(join(f.evidence, '.publishing'), 'in progress')
  assert.equal(await api.readCalibrationEvidence(f), null)
})

test('custom PDF sets do not reuse unbound Markdown evidence', async t => {
  const f = await fixture(t)
  assert.equal(await api.readCalibrationEvidence({ ...f, args: { ...f.args, source_dir: '/a/new/pdf/set' } }), null)
})

test('one missing evidence file rebuilds all five PDFs and induction despite supplied summaries', async t => {
  const f = await fixture(t)
  await rm(join(f.evidence, '开立.md'))
  const documents = []
  for (const code of codes) {
    const file = join(f.root, `${code}.pdf`)
    await writeFile(file, `source pdf ${code}`)
    documents.push({ code, file, pages: 1 })
  }
  let extractionCalls = 0
  const runtime = { agent: async (prompt, options) => {
    if (options.label === '方法对撞') return { cards: [{id:'R-01',kind:'established',summary:'present',rule_ids:['R-01'],eligible_docs:codes,supporting_docs:codes,source_quote:'method action'}], matrix: Array.from({length:12},(_,i)=>({section:i+1,cells:codes.map(code=>({code,status:'done',evidence:'page 1'}))})) }
    if (options.label === '校准报告') return { narrative:'N=5 source checked',patches:[] }
    throw new Error(options.label)
  } }
  const args = { ...f.args, documents, digests: codes.map(code=>({code,actions:[]})) }
  const core = async value => {
    extractionCalls++
    assert.equal(value.evidence_ready, false)
    assert.equal(Object.hasOwn(value,'digests'), false)
    const digests = []
    for (const code of codes) {
      const written_file = join(value.blind_dir, `${code}.md`)
      await mkdir(value.blind_dir,{recursive:true})
      await writeFile(written_file,repeat('action and source excerpt'))
      digests.push({code,written_file,attributes:{profitable:'yes'},actions:Array.from({length:20},()=>({action:'method action',page:'1',quote:'excerpt',serves_what:'judgment'}))})
    }
    return { digests, methods:[{statement:'method action',which_docs:codes,pages:'1',solves_what:'judgment',scope:'无条件'}],rules:[{id:'R-01',summary:'rule',source:'source:1',verbatim:'method action',scope:'无条件',scope_reason:'all',form:'方法型'}] }
  }
  const result = await api.runCalibration({root:f.root,args,runtime,runWorkflow:core})
  assert.equal(result.reused_evidence,false)
  assert.equal(extractionCalls,1)
  assert.equal((await api.readCalibrationEvidence({root:f.root,args})).documents.length,5)
  await writeFile(documents[0].file,'changed source PDF')
  assert.equal(await api.readCalibrationEvidence({root:f.root,args}),null)
})

test('an eligible proposal cannot disappear without an explicit exclusion reason', async t => {
  const f = await fixture(t)
  const runtime = { agent: async (prompt, {label}) => {
    if(label==='方法对撞') return {cards:[{id:'D-01',kind:'omission',summary:'method',rule_ids:['R-01'],eligible_docs:codes,supporting_docs:codes,source_quote:'method action'}],matrix:Array.from({length:12},(_,i)=>({section:i+1,cells:codes.map(code=>({code,status:'done',evidence:'page 1'}))}))}
    if(label==='抽查') return {checks:[{id:'D-01',status:'confirmed',eligible_docs:codes,supporting_docs:codes,evidence:codes.map(code=>({code,page:'1',quote:'excerpt',finding:'present'}))}]}
    return {narrative:'report',patches:[],exclusions:[]}
  } }
  await assert.rejects(api.runCalibration({...f,runtime,runWorkflow:async()=>({rules:[{id:'R-01',verbatim:'method action'}]})}),/eligible.*proposal|exclusion/i)
})

test('the real native calibration script extracts then reuses six files without exposing methodology to blind stages', async t => {
  const f = await fixture(t)
  const { loadWorkflow, createRuntime } = await import('../../tools/codex_workflow/runtime.mjs')
  const { decodeResult } = await import('../../tools/codex_workflow/schema.mjs')
  const { workflowFingerprint } = await import('../../tools/run_codex_workflow.mjs')
  const { copyFile } = await import('node:fs/promises')
  await mkdir(join(f.root,'.codex/workflows'),{recursive:true})
  await copyFile(new URL('../../.codex/workflows/calibrate-equity-thesis.mjs',import.meta.url),join(f.root,'.codex/workflows/calibrate-equity-thesis.mjs'))
  const documents = []
  for(const code of codes) {
    const file = join(f.root,`${code}.pdf`)
    await writeFile(file,`pdf source ${code}`)
    documents.push({code,file,pages:1})
  }
  const args={...f.args,root:f.root,documents}
  const labels=[]
  const rules=Array.from({length:100},(_,i)=>({id:`R-${i+1}`,summary:'rule',source:'framework.md:1',verbatim:'method action 0',scope:'无条件',scope_reason:'all',form:'方法型'}))
  const runtime=createRuntime({runAgent:async(prompt,options)=>{
    labels.push(options.label)
    let result
    if(options.label.startsWith('盲抽:')) {
      assert.equal(options.isolation,'blind')
      assert.ok(!prompt.includes('.codex/skills'))
      assert.ok(!prompt.includes('equity-thesis'))
      const code=options.label.slice(3), match=prompt.match(/`([^`]+\/[^/`]+\.md)`/)
      assert.ok(match,'blind prompt has its neutral output path')
      await mkdir(join(match[1],'..'),{recursive:true})
      await writeFile(match[1],repeat('author action excerpt'))
      result={written_file:match[1],attributes:Object.fromEntries(['product_lines','is_cyclical','profitable','has_ma','multi_segment','overseas_rev'].map(k=>[k,'document says yes'])),actions:Array.from({length:20},()=>({action:'method action 0',page:'1',quote:'excerpt',serves_what:'judgment'}))}
    } else if(options.label==='规则测绘') result={rules}
    else if(options.label==='归纳') {
      assert.equal(options.isolation,'blind')
      assert.ok(!prompt.includes('.codex/skills'))
      result={methods:Array.from({length:60},(_,i)=>({statement:`method action ${i}`,which_docs:codes,pages:'1',solves_what:'judgment',scope:'无条件'}))}
    } else if(options.label==='方法对撞') result={cards:[{id:'D-01',kind:'established',summary:'all mapped',rule_ids:rules.map(r=>r.id),eligible_docs:codes,supporting_docs:codes,source_quote:'method action 0'}],matrix:Array.from({length:12},(_,i)=>({section:i+1,cells:codes.map(code=>({code,status:'done',evidence:'page 1'}))}))}
    else if(options.label==='校准报告') result={narrative:'review done',patches:[],exclusions:[]}
    else throw new Error(`unexpected stage ${options.label}`)
    return decodeResult(options.schema,result)
  }})
  const workflow=await loadWorkflow(join(f.root,'.codex/workflows/calibrate-equity-thesis.mjs'))
  const before=await workflowFingerprint(f.root,'calibrate-equity-thesis',args,{})
  const first=await api.runCalibration({root:f.root,args,runtime,runWorkflow:workflow})
  assert.equal(first.reused_evidence,false)
  assert.equal(labels.filter(label=>label.startsWith('盲抽:')).length,5)
  assert.ok(labels.includes('归纳'))
  assert.ok(!labels.includes('抽查'),'no patch candidates need no source check')
  assert.equal(await workflowFingerprint(f.root,'calibrate-equity-thesis',args,{}),before,'publishing evidence does not change input fingerprint')
  labels.length=0
  const second=await api.runCalibration({root:f.root,args,runtime,runWorkflow:workflow})
  assert.equal(second.reused_evidence,true)
  assert.deepEqual(labels,['规则测绘','方法对撞','校准报告'])
  assert.match(await readFile(second.report,'utf8'),/无法证明修改后运行更好/)
  await assert.rejects(readdir(join(f.root,'.claude')),{code:'ENOENT'})
})

test('verbatim evidence containing quotes, backslashes and newlines is matched as source text', async t => {
  const f=await fixture(t)
  const verbatim='Use "raw" text\\path\nwithout JSON escaping'
  const runtime={agent:async(prompt,{label})=>label==='方法对撞'?{cards:[{id:'R-01',kind:'established',summary:'rule',rule_ids:['R-01'],eligible_docs:codes,supporting_docs:codes,source_quote:verbatim}],matrix:Array.from({length:12},(_,i)=>({section:i+1,cells:codes.map(code=>({code,status:'done',evidence:'page 1'}))}))}:{narrative:'report',patches:[],exclusions:[]}}
  const result=await api.runCalibration({...f,runtime,runWorkflow:async()=>({rules:[{id:'R-01',summary:'rule',verbatim}]})})
  assert.equal(result.counts.cards,1)
})
