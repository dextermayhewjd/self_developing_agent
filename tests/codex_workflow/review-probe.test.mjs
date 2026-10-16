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
 assert.deepEqual(summary.workers.map(w=>w.effort),['xhigh','low','xhigh'])
 assert.ok(summary.workers.every(w=>w.model==='fixture-model'&&w.context_bytes>0&&w.sandbox==='read-only'&&w.approval==='never'))
 assert.equal(summary.budget.used_rounds,1);assert.equal(summary.budget.valid_reviews,2)
 assert.equal(summary.host_application.changed,true);assert.equal(summary.host_application.applications,1)
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

test('valid full-route receipt stays accepted when only synthetic local-low scenario fails',async t=>{
 const {runReviewTaskProbe}=await import('../../tools/probe_thesis_review_task.mjs')
 const outputDir=join(await fixture(t),'full-scope')
 await assert.rejects(runReviewTaskProbe({outputDir,executionConfig,featureCheck:async()=>({multi_agent:false,multi_agent_v2:false}),backendOptions:{executable:process.execPath,executableArgs:[resolve('tests/codex_workflow/fixtures/review-probe-cli.mjs'),'--full-scope']}}),/Observed probe/)
 const summary=JSON.parse(await readFile(join(outputDir,'summary.json')))
 assert.equal(summary.status,'failed');assert.equal(summary.workers[1].effort,'xhigh')
 assert.equal(summary.independent_review.accepted,true)
 assert.ok(summary.final_receipt);assert.deepEqual(summary.receipt,summary.final_receipt)
 assert.equal(summary.prior_receipt,null);assert.equal(summary.budget.valid_reviews,2)
})
