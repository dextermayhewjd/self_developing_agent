import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,readFile,writeFile,mkdir,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'

const executionConfig={version:1,codexVersion:'fixture',skillCatalogAvailable:true,skillPaths:[],defaults:{model:'fixture-model',effort:'xhigh',modelProvider:'openai'},overrides:{},stageConfig:{},models:[],catalogAvailable:false}
async function fixture(t){const dir=await mkdtemp(join(tmpdir(),'review-probe-test-'));t.after(()=>rm(dir,{recursive:true,force:true}));return dir}

test('synthetic probe exercises production coordinator/backend, host application and independent review receipt',async t=>{
 const {runReviewTaskProbe}=await import('../../tools/probe_thesis_review_task.mjs')
 const dir=await fixture(t),outputDir=join(dir,'probe')
 const summary=await runReviewTaskProbe({outputDir,executionConfig,featureCheck:async()=>({multi_agent:false,multi_agent_v2:false}),backendOptions:{executable:process.execPath,executableArgs:[resolve('tests/codex_workflow/fixtures/review-probe-cli.mjs')]}})
 assert.equal(summary.status,'passed');assert.equal(summary.synthetic,true)
 assert.deepEqual(summary.workers.map(w=>w.contract),['review','proposal','review'])
 assert.deepEqual(summary.workers.map(w=>w.effort),['xhigh','xhigh','xhigh'])
 assert.ok(summary.workers.every(w=>w.model==='fixture-model'&&w.context_bytes>0&&w.sandbox==='read-only'&&w.approval==='never'))
 assert.equal(summary.budget.used_rounds,1);assert.equal(summary.budget.valid_reviews,2)
 assert.equal(summary.host_application.changed,true);assert.equal(summary.host_application.applications,1)
 assert.match(summary.workers[1].label,/^问题修订:/);assert.equal(summary.attempt.results[0].result.mode,'local_patch');assert.ok(summary.workers[1].context_bytes<=32768)
 assert.equal(summary.receipt.report_sha256,summary.host_application.after_sha256)
 assert.equal(summary.independent_review.proposal_exposed,false)
 assert.match(await readFile(join(outputDir,'summary.md'),'utf8'),/fixture-model/)
 const stored=JSON.parse(await readFile(join(outputDir,'summary.json')));assert.deepEqual(stored.receipt,summary.receipt)
})

test('probe refuses symbols, occupied directories and effective enabled nested-agent features before workers',async t=>{
 const {runReviewTaskProbe}=await import('../../tools/probe_thesis_review_task.mjs')
 const dir=await fixture(t)
 await assert.rejects(runReviewTaskProbe({outputDir:join(dir,'symbol'),symbol:'300209'}),/synthetic|symbol/i)
 const real=join(dir,'reports/300209_thesis_20261016');await mkdir(real,{recursive:true});await writeFile(join(real,'report.md'),'protected')
 await assert.rejects(runReviewTaskProbe({outputDir:real}),/exist|occupied|empty/i)
 assert.equal(await readFile(join(real,'report.md'),'utf8'),'protected')
 await assert.rejects(runReviewTaskProbe({outputDir:join(dir,'enabled'),executionConfig,featureCheck:async()=>({multi_agent:true,multi_agent_v2:false})}),/effective|multi_agent/i)
 const failed=JSON.parse(await readFile(join(dir,'enabled/summary.json')));assert.equal(failed.status,'failed');assert.equal(failed.workers.length,0)
})

test('probe preserves unavailable inventory snapshot and stops before backend inference',async t=>{
 const {runReviewTaskProbe}=await import('../../tools/probe_thesis_review_task.mjs')
 const outputDir=join(await fixture(t),'inventory')
 await assert.rejects(runReviewTaskProbe({outputDir,executionConfig:{...executionConfig,skillCatalogAvailable:false},featureCheck:async()=>({multi_agent:false,multi_agent_v2:false})}),/skills\/list/)
 const summary=JSON.parse(await readFile(join(outputDir,'summary.json')))
 assert.equal(summary.execution_config.skillCatalogAvailable,false)
 assert.equal(summary.skill_inventory.available,false)
 assert.equal(summary.workers.length,0)
})

test('failed final review preserves actual host checkpoint and budget without claiming a final receipt',async t=>{
 const {runReviewTaskProbe}=await import('../../tools/probe_thesis_review_task.mjs')
 const outputDir=join(await fixture(t),'invalid-final')
 await assert.rejects(runReviewTaskProbe({outputDir,executionConfig,featureCheck:async()=>({multi_agent:false,multi_agent_v2:false}),backendOptions:{executable:process.execPath,executableArgs:[resolve('tests/codex_workflow/fixtures/review-probe-cli.mjs'),'--invalid-final']}}),/kind conflicts/)
 const summary=JSON.parse(await readFile(join(outputDir,'summary.json')))
 assert.equal(summary.status,'failed');assert.equal(summary.host_application.changed,true)
 assert.equal(summary.host_application.applications,1);assert.equal(summary.budget.valid_reviews,1)
 assert.equal(summary.receipt,null);assert.equal(summary.final_receipt,null);assert.ok(summary.prior_receipt)
 assert.equal(summary.attempt.state,'finalized');assert.equal(summary.workers.length,3)
})

test('valid full-route receipt stays accepted when equal-effort full revision fails the local-route scenario',async t=>{
 const {runReviewTaskProbe}=await import('../../tools/probe_thesis_review_task.mjs')
 const outputDir=join(await fixture(t),'full-scope')
 await assert.rejects(runReviewTaskProbe({outputDir,executionConfig,featureCheck:async()=>({multi_agent:false,multi_agent_v2:false}),backendOptions:{executable:process.execPath,executableArgs:[resolve('tests/codex_workflow/fixtures/review-probe-cli.mjs'),'--full-scope']}}),/Observed probe/)
 const summary=JSON.parse(await readFile(join(outputDir,'summary.json')))
 assert.equal(summary.status,'failed');assert.equal(summary.workers[1].effort,'xhigh')
 assert.equal(summary.independent_review.accepted,true)
 assert.ok(summary.final_receipt);assert.deepEqual(summary.receipt,summary.final_receipt)
 assert.equal(summary.prior_receipt,null);assert.equal(summary.budget.valid_reviews,2)
})

for (const scenario of [
 {name:'frozen xhigh model without low support',config:{...executionConfig,catalogAvailable:true,models:[{model:'fixture-model',supportedReasoningEfforts:['xhigh']}]},want:['xhigh','xhigh','xhigh'],model:'fixture-model'},
 {name:'explicit 问题修订 high override without changing independent review',config:{...executionConfig,stageConfig:{stages:{问题修订:{effort:'high'}}}},want:['xhigh','high','xhigh'],model:'fixture-model'},
 {name:'explicit local model and its catalog effort',config:{...executionConfig,stageConfig:{stages:{问题修订:{model:'local-model'}}},models:[{model:'local-model',defaultReasoningEffort:'high',supportedReasoningEfforts:['high']}]},want:['xhigh','high','xhigh'],model:'local-model'},
]) test(scenario.name,async t=>{
 const {runReviewTaskProbe}=await import('../../tools/probe_thesis_review_task.mjs')
 const summary=await runReviewTaskProbe({outputDir:join(await fixture(t),'probe'),executionConfig:scenario.config,featureCheck:async()=>({multi_agent:false,multi_agent_v2:false}),backendOptions:{executable:process.execPath,executableArgs:[resolve('tests/codex_workflow/fixtures/review-probe-cli.mjs')]}})
 assert.equal(summary.status,'passed')
 assert.deepEqual(summary.workers.map(w=>w.effort),scenario.want)
 assert.equal(summary.workers[1].model,scenario.model)
 for(const [i,worker] of summary.workers.entries()){
  const {args}=JSON.parse(await readFile(join(worker.directory,'result-0.json.transport.json')))
  assert.equal(args[args.indexOf('--model')+1],i===1?scenario.model:'fixture-model')
  assert.ok(args.includes('model_reasoning_effort='+JSON.stringify(scenario.want[i])))
 }
 assert.equal(summary.attempt.results[0].result.mode,'local_patch')
 assert.ok(summary.workers[1].context_bytes<=32768)
 assert.equal(summary.receipt.report_sha256,summary.host_application.after_sha256)
})
