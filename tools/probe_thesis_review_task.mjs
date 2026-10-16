#!/usr/bin/env node
import {mkdir,mkdtemp,readFile,writeFile,appendFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join,resolve,dirname} from 'node:path'
import {fileURLToPath,pathToFileURL} from 'node:url'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {parseArgs} from 'node:util'
import {createBackend} from './codex_workflow/backend.mjs'
import {createRuntime} from './codex_workflow/runtime.mjs'
import {resolveExecutionConfig} from './codex_workflow/config.mjs'
import {coordinateThesisReview} from './codex_workflow/review-coordinator.mjs'
import {inspectReviewStore} from './codex_workflow/review-store.mjs'
import {sha256,REVIEW_LENSES} from './codex_workflow/review-contracts.mjs'

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..')
const quote='现金流依赖回款。',limitation='回款延迟会造成流动性压力。'
const scope=`本次仅为虚构 FIXTURE 公司的合成接口探针，不是股票研究。十二节的测试常量已认可，唯一验收缺口是第三节是否准确披露给定证据中的“${limitation}”。初始报告故意遗漏此限制。请独立核对实际输入，若仍遗漏则记录一个第三节 local_patch 阻断任务，judgment_constraints 为 []；仅在确有该缺口时，new_issues.description 使用“第三节遗漏回款延迟的流动性压力限制”；十二节和全部证据的审查覆盖仍照常填入 sections/coverage/reviewed_sources，不在问题描述叙述审查过程。存在则独立裁定。不要新增外部事实或其他测试目标。五路均核对“${quote}”的覆盖；不得因这是探针而预设通过。`

async function effectiveFeatures() {
 const args=['features','list','-c','features.multi_agent=false','-c','features.multi_agent_v2=false']
 const {stdout}=await promisify(execFile)('codex',args,{cwd:root,timeout:15000,maxBuffer:100000})
 const found={}
 for(const name of ['multi_agent','multi_agent_v2']) {
  const match=stdout.match(new RegExp('^'+name+'\\s+\\S+\\s+(true|false)\\s*$','m'))
  found[name]=match ? match[1]==='true' : null
 }
 return {...found,command:['codex',...args],output:stdout.trim()}
}

/** Creates only a new fictional run. The injected executable is a transport seam
 * for tests; default execution uses the production CLI/backend/config unchanged. */
export async function runReviewTaskProbe({outputDir,symbol,executionConfig,backendOptions={},featureCheck=effectiveFeatures}={}) {
 if(symbol!==undefined)throw new Error('Probe accepts only its synthetic fixture; symbol is forbidden')
 const destination=outputDir?resolve(outputDir):await mkdtemp(join(tmpdir(),'thesis-review-probe-'))
 if(destination.split('/').some(part=>/^\d{5,6}_thesis_/.test(part)))throw new Error('Existing real stock run destinations are forbidden')
 if(outputDir){await mkdir(dirname(destination),{recursive:true});await mkdir(destination)} // exclusive; never overwrites earlier logs
 const summary={version:1,synthetic:true,status:'running',final_receipt:null,output_dir:destination,started_at:new Date().toISOString(),workers:[],limits:[
  'Synthetic fixture proves only this observed interface execution, never real research quality.',
  'Neutral cwd, disabled skills/developer instructions/web/nested agents isolate context; normal read-only Codex filesystem access still applies.',
  'skills/list is a validated cwd/error/shape snapshot, not an OS read ACL or guarantee about plugins installed later.',
 ]}
 const save=async()=>{
  await writeFile(join(destination,'summary.json'),JSON.stringify(summary,null,2)+'\n')
  await writeFile(join(destination,'summary.md'),`# Synthetic thesis review task probe\n\nStatus: ${summary.status}\n\n\`\`\`json\n${JSON.stringify(summary,null,2)}\n\`\`\`\n`)
 }
 const initialReport=['一','二','三','四','五','六','七','八','九','十','十一','十二'].map(title=>`## ${title}、虚构测试章节\n\n${quote}\n`).join('\n')
 const events=[]
 const emit=event=>{events.push(event)}
 try {
  summary.effective_features=await featureCheck()
  if(summary.effective_features.multi_agent!==false||summary.effective_features.multi_agent_v2!==false)throw new Error('Effective multi_agent and multi_agent_v2 features must both be false')
  executionConfig??=await resolveExecutionConfig({root})
  summary.execution_config=executionConfig
  summary.skill_inventory={cwd:root,available:executionConfig.skillCatalogAvailable,paths:executionConfig.skillPaths??[],count:executionConfig.skillPaths?.length??0}
  if(executionConfig.skillCatalogAvailable!==true)throw new Error('Validated skills/list snapshot required before inference')
  await writeFile(join(destination,'execution-config.json'),JSON.stringify(executionConfig,null,2)+'\n')
  const fixtureRoot=join(destination,'fixture'),args={symbol:'SYNTHETIC',date:'20261016'}
  const run=join(fixtureRoot,'reports/SYNTHETIC_thesis_20261016')
  await mkdir(join(run,'findings'),{recursive:true})
  const report=initialReport
  await writeFile(join(run,'report.md'),report)
  await writeFile(join(run,'疑惑.md'),scope)
  for(const lens of REVIEW_LENSES)await writeFile(join(run,'findings',lens+'.md'),quote+(lens==='财务排雷'?limitation:'')+'\n'+scope)
  summary.run_dir=run
  const backend=createBackend({root,logDir:join(destination,'agents'),executionConfig,repairAttempts:0,emit,...backendOptions})
  const runtime=createRuntime({runAgent:backend,jobs:1})
  const result=await coordinateThesisReview({root:fixtureRoot,args,runtime,emit})
  const inspected=await inspectReviewStore({runDir:run}),after=await readFile(join(run,'report.md'))
  summary.budget=inspected.ledger.budget
  summary.receipt=result.receipt
  summary.final_receipt=result.receipt
  summary.attempt=inspected.attempt
  summary.terminal_reason=result.terminalReason
  summary.host_application={before_sha256:sha256(report),after_sha256:sha256(after),changed:sha256(report)!==sha256(after),applications:inspected.attempt?.results.filter(item=>item.result.status==='applied').length??0,bytes:after.length}
  summary.independent_review={review_id:result.review?.review_id,verdict:result.review?.verdict,proposal_exposed:false}
  const exchanges=events.filter(event=>event.type==='agent.started')
  for(const event of exchanges)summary.workers.push({label:event.label,directory:event.directory,...JSON.parse(await readFile(join(event.directory,'execution.json'),'utf8'))})
  // Verify actual archived final review input contains no proposal/self-assessment.
  const {readdir}=await import('node:fs/promises')
  const exchangeDir=join(run,'.codex-workflow/review/exchanges')
  for(const name of await readdir(exchangeDir)) {
   const request=JSON.parse(await readFile(join(exchangeDir,name,'request.json')))
   if(request.context.review_id===result.review?.review_id)summary.independent_review.proposal_exposed=Object.hasOwn(request.context,'proposals')||Object.hasOwn(request.context,'acceptance_checks')
  }
  if(result.terminalReason||result.review?.verdict!=='pass'||inspected.deliveryError||inspected.displays.some(item=>item.status!=='current')||result.receipt?.report_sha256!==sha256(after)||!summary.host_application.changed||summary.host_application.applications!==1||summary.independent_review.proposal_exposed||summary.workers.map(worker=>worker.contract).join(',')!=='review,proposal,review'||summary.workers[1].effort!=='low')throw new Error('Observed probe did not complete initial review, one host local application, and independent full review')
  summary.status='passed'
 }catch(error){
  summary.status='failed';summary.error={name:error.name,message:error.message};summary.receipt=null
  if(summary.run_dir) {
   try {
    const inspected=await inspectReviewStore({runDir:summary.run_dir})
    if(inspected) {
     const after=await readFile(join(summary.run_dir,'report.md'))
     summary.snapshot=inspected.snapshot
     summary.budget=inspected.ledger.budget
     summary.attempt=inspected.attempt
     const acceptedFinal=inspected.review?.verdict==='pass'&&!inspected.deliveryError&&inspected.displays.every(item=>item.status==='current')
     summary.final_receipt=acceptedFinal?inspected.receipt:null
     summary.receipt=summary.final_receipt
     summary.prior_receipt=acceptedFinal?null:inspected.receipt
     summary.host_application={before_sha256:sha256(initialReport),after_sha256:sha256(after),changed:sha256(initialReport)!==sha256(after),applications:inspected.attempt?.results.filter(item=>item.result.status==='applied').length??0,bytes:after.length}
     summary.independent_review={accepted:acceptedFinal,last_committed_review_id:inspected.review?.review_id??null,last_committed_verdict:inspected.review?.verdict??null}
    }
   }catch(inspectError){summary.inspection_error=inspectError.message}
  }
  // Preserve metadata even when the very first real worker cannot execute.
  for(const event of events.filter(event=>event.type==='agent.started'))if(!summary.workers.some(worker=>worker.directory===event.directory)) {
   try{summary.workers.push({label:event.label,directory:event.directory,...JSON.parse(await readFile(join(event.directory,'execution.json'),'utf8'))})}catch{/* missing metadata is retained through the event */}
  }
  throw error
 }finally{
  summary.finished_at=new Date().toISOString()
  await appendFile(join(destination,'events.jsonl'),events.map(event=>JSON.stringify(event)).join('\n')+'\n')
  await save()
 }
 return summary
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 try{
  const {values}=parseArgs({options:{'output-dir':{type:'string'}}})
  const result=await runReviewTaskProbe({outputDir:values['output-dir']})
  console.log(JSON.stringify({status:result.status,output_dir:result.output_dir,workers:result.workers.map(({model,effort,context_bytes})=>({model,effort,context_bytes})),receipt:result.receipt},null,2))
 }catch(error){console.error(error.message);process.exitCode=1}
}
