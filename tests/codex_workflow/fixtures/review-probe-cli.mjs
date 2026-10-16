// External transport fixture. All Store, application and review validation run in production code.
import {readFileSync,writeFileSync} from 'node:fs'
const args=process.argv.slice(2),prompt=readFileSync(0,'utf8')
const context=JSON.parse(prompt.split('\nCONTEXT_JSON\n').at(-1))
const quote='现金流依赖回款。',limitation='回款延迟会造成流动性压力。'
const lenses=['财务排雷','尽调','产业','竞争','战略驱动']
let result
if(context.review_id){
 const missing=!context.report_text.includes(limitation),source=context.evidence.find(s=>s.path==='findings/财务排雷.md')
 const issue={issue_key:'missing-limit',kind:'blocking',blocks_delivery:true,description:'第三节遗漏回款限制',locations:[{section:3}],evidence_refs:[{source:source.path,source_sha256:source.sha256,evidence_sha256:context.snapshot.evidence_sha256,quote:limitation}],acceptance_criteria:['第三节写明'+limitation],judgment_constraints:[],route:'local_patch'}
 result={version:2,review_id:context.review_id,...context.snapshot,input_ledger_sha256:context.input_ledger_sha256,verdict:missing?'revise':'pass',reviewed_sources:context.evidence.map(s=>s.path),sections:Array.from({length:12},(_,i)=>({section:i+1,status:i===2&&missing?'revise':'pass',evidence:'已独立核对虚构测试常量',issue_keys:i===2&&missing?['missing-limit']:[],task_ids:[]})),coverage:lenses.map(lens=>({lens,findings:[{finding:quote,source:'findings/'+lens+'.md',source_quote:quote,disposition:'covered',report_quote:quote,exclusion_reason:'',issue_keys:[],task_ids:[]}]})),new_issues:missing?[issue]:[],task_dispositions:context.ledger.tasks.map(task=>({task_id:task.id,status:missing?'open':'resolved',reason:'独立核对第三节与证据',kind:task.kind,blocks_delivery:task.blocks_delivery})),visual_attestations:[]}
}else{
 const task=context.tasks[0]
 result={task_ids:[task.id],base_report_sha256:context.snapshot.report_sha256,status:'proposed',edits:[{section:3,before:quote,after:quote+limitation,rationale:'披露已给定限制',task_ids:[task.id]}],evidence_refs:task.evidence_refs,acceptance_checks:task.acceptance_criteria.map((_,criterion_index)=>({task_id:task.id,criterion_index,response:'请独立核对第三节'})),escalation_reason:''}
}
if(args.includes('--full-scope')&&context.review_id&&result.new_issues.length)result.new_issues[0].description='全文核对后发现第三节遗漏回款限制'
if(args.includes('--invalid-final')&&context.review_id&&context.ledger.tasks.length)result.task_dispositions[0].blocks_delivery=false
writeFileSync(args[args.indexOf('--output-last-message')+1],JSON.stringify(result))
process.stdout.write(JSON.stringify({type:'turn.completed',usage:{input_tokens:10,output_tokens:20}})+'\n')
