import { access, readFile, stat, copyFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { join } from 'node:path'
import { runProcess } from './backend.mjs'
import { validateThesisReview } from '../check_thesis_review.mjs'
import { coordinateThesisReview } from './review-coordinator.mjs'
import { beginDelivery, recoverDelivery } from './thesis-delivery.mjs'
import { validateExclusiveOutput, validateExclusiveOutputPath } from './stage-output.mjs'

export const lensNames = ['财务排雷', '尽调', '产业', '竞争', '战略驱动']
export async function pythonFor(root) {
  const path = join(root, '.venv/bin/python')
  try { await access(path, constants.X_OK); return path } catch { return 'python3' }
}
const output = p => [p.stdout, p.stderr].filter(Boolean).join('\n')

export async function prepareData({ root, symbol, signal, runCommand = runProcess }) {
  const python = await pythonFor(root)
  const validate = () => runCommand(python, [join(root, 'tools/validate.py'), symbol], { cwd: root, signal })
  let result = await validate()
  if (result.code === 1) {
    const fetched = await runCommand(python, [join(root, 'tools/run_pipeline.py'), symbol], { cwd: root, signal })
    if (fetched.code !== 0) throw new Error(`Data pipeline failed (${fetched.code}): ${output(fetched)}`)
    result = await validate()
  }
  if (![0, 2].includes(result.code)) throw new Error(`Data validation failed (${result.code}): ${output(result)}`)
  return { warnings: result.code === 2 ? [output(result)] : [] }
}

async function requireFile(path) {
  const info = await stat(path)
  if (!info.isFile() || info.size <= 200) throw new Error(`Incomplete artifact: ${path}`)
}

async function requireArtifacts(run) {
  await requireFile(join(run, '疑惑.md'))
  await requireFile(join(run, 'report.md'))
  for (const name of lensNames) {
    await requireFile(join(run, `findings/${name}.md`))
    await requireFile(join(run, `核查/${name}.md`))
  }
}

async function requirePosition(path, date) {
  const expected = `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`
  if (!new RegExp(`^最近更新:\\s*['"]?${expected}['"]?\\s*$`, 'm').test(await readFile(path, 'utf8'))) {
    throw new Error(`Position 最近更新 must equal ${expected}: ${path}`)
  }
}

async function totals(run) {
  let checked = 0
  for (const name of lensNames) {
    const body = await readFile(join(run, `核查/${name}.md`), 'utf8')
    checked += (body.match(/^\s*- \[(?:确认无误|修正)\]/gm) ?? []).length
  }
  const report = await readFile(join(run, 'report.md'), 'utf8')
  return { verified_total: checked, doubts_answered: new Set(report.match(/现在回答开篇的问题\s*\d+/g) ?? []).size }
}

const exists = async path => { try { await access(path); return true } catch (e) { if(e.code==='ENOENT')return false;throw e } }
export async function establishInitialCandidate(run) {
  if(await exists(join(run,'.codex-workflow/review/HEAD.json')))return false
  const draft=join(run,'初稿.md'),report=join(run,'report.md')
  const bytes=await readFile(draft)
  if(await exists(report)) {
    if(!(await readFile(report)).equals(bytes))throw Error('Initial candidate conflict: '+report)
    return false
  }
  await copyFile(draft,report,constants.COPYFILE_EXCL)
  return true
}

export async function runThesis({ root, args, runtime, runWorkflow, noPdf = false,
  prepared, signal, runCommand = runProcess, coordinateReview = coordinateThesisReview,
  reviewStore, reviewMaxRounds, assertInputsCurrent = async()=>{}, emit }) {
  const {symbol,date}=args, run=join(root,`reports/${symbol}_thesis_${date}`)
  const reportPath=join(run,'report.md'),positionPath=join(root,`positions/${symbol}.md`),pdfPath=join(root,`reports/pdf/${symbol}_thesis_${date}.pdf`)
  const targets={position:positionPath,pdf:pdfPath}
  await recoverDelivery({runDir:run,targets})
  const hasHead=await exists(join(run,'.codex-workflow/review/HEAD.json'))
  const reused=hasHead || await exists(join(run,'初稿.md'))
  let researchResult
  if(!reused) {
    if(args.review_only)throw Error('review_only requires an existing candidate; research not started')
    if(await exists(reportPath))throw Error('Legacy candidate requires explicit migration')
    prepared ??= await prepareData({root,symbol,signal,runCommand})
    researchResult=await runWorkflow(args,runtime)
  }
  if(!await exists(join(run,'.codex-workflow/review/HEAD.json')))await establishInitialCandidate(run)
  await requireArtifacts(run)
  const warnings=[...(prepared?.warnings??[])],python=await pythonFor(root)
  let coordination,contentReview
  const coordinate=async gateFeedback=>{
    await assertInputsCurrent()
    coordination=await coordinateReview({root,args,runtime,store:reviewStore,reviewMaxRounds,signal,emit,
      reason:gateFeedback?'gate':args.review_only?'review_only':reused?'resume':'initial',gateFeedback})
    if(coordination.terminalReason || coordination.review?.verdict!=='pass')throw Error('Content review blocks delivery: '+(coordination.terminalReason??'revise'))
  }
  const guard=async()=>{
    await assertInputsCurrent()
    if(coordination.terminalReason)throw Error('Content review blocks delivery: '+coordination.terminalReason)
    contentReview=await validateThesisReview(run)
    if(contentReview.verdict!=='pass')throw Error('Content review requires revision; delivery blocked')
    if(contentReview.review_id!==coordination.receipt?.review_id ||
      contentReview.report_sha256!==coordination.snapshot?.report_sha256 ||
      contentReview.evidence_sha256!==coordination.snapshot?.evidence_sha256)throw Error('Delivery receipt changed from the staged snapshot')
  }
  await coordinate();await guard()
  const tx=await beginDelivery({runDir:run,targets:noPdf?{position:positionPath}:targets,snapshot:coordination.snapshot,receipt:coordination.receipt})
  let gateResult,positionRepairs=0
  try {
    const updatePosition=async(feedback='')=>{
      await guard()
      await validateExclusiveOutputPath(tx.staged.position)
      const positionResult = await runtime.agent(`根据 ${reportPath} 更新暂存档案，输出路径：${tx.staged.position}
先读取已有档案 ${positionPath} 及 ${root}/.codex/skills/equity-thesis-cn/position_file.md。
保留人工注入区，更新评分、评级、估值锚及变更理由、假设记分板、未决疑问和变更日志。
最近更新必须为 ${date.slice(0,4)}-${date.slice(4,6)}-${date.slice(6,8)}。
只写暂存输出路径，不修改正式档案、报告、底稿或数据。${feedback}
报告快照：${JSON.stringify(coordination.snapshot)}`,{
        label:'更新档案',phase:'交付',stagedPosition:tx.staged.position,exclusiveOutputPath:tx.staged.position,reportSnapshot:coordination.snapshot,
        schema:{type:'object',additionalProperties:false,required:['written_file'],properties:{written_file:{type:'string',enum:[tx.staged.position]}}},
      })
      await validateExclusiveOutput(positionResult,tx.staged.position)
      await requirePosition(tx.staged.position,date)
    }
    await updatePosition()
    for(;;) {
      await guard()
      gateResult=await runCommand(python,[join(root,'tools/check_thesis.py'),symbol,reportPath,'--position',tx.staged.position],{cwd:root,signal})
      if(![0,1,2].includes(gateResult.code))throw Error(`Gate tool failed (${gateResult.code}): ${output(gateResult)}`)
      if(gateResult.code!==1)break
      const feedback=output(gateResult)
      // Only the checker's two explicit position diagnostics are position-only.
      const failures=feedback.split('\n').filter(line=>/^\s*\[FAIL\]/.test(line))
      const positionOnly=failures.length>0 && failures.every(line=>/档案不存在|档案未更新到报告日/.test(line))
      if(positionOnly && positionRepairs++<2)await updatePosition(feedback)
      else if(positionOnly)throw Error('Hard gate position repair exhausted: '+feedback)
      else {await coordinate({gateId:'check-thesis-report',feedback});await guard();await updatePosition()}
    }
    if(gateResult.code===2)warnings.push(output(gateResult))
    await guard()
    if(!noPdf) {
      const result=await runCommand(python,[join(root,'tools/md_to_pdf.py'),'--md',reportPath,'--output',tx.staged.pdf],{cwd:root,signal})
      if(result.code!==0)throw Error(`PDF generation failed (${result.code}): ${output(result)}`)
      if((await stat(tx.staged.pdf)).size===0)throw Error('Empty PDF: '+tx.staged.pdf)
    }
    await tx.publish({guard,emit,snapshot:coordination.snapshot,receipt:coordination.receipt})
  } catch(error) {
    try {await tx.rollback()}catch(conflict){throw new AggregateError([error,conflict],error.message+'; '+conflict.message)}
    throw error
  }
  return {symbol,run_dir:run,report:reportPath,position:positionPath,reused,gate_exit_code:gateResult.code,warnings,
    pdf:{status:noPdf?'skipped':'generated',path:noPdf?null:pdfPath},...await totals(run),
    content_review:{written_file:contentReview.written_file,verdict:contentReview.verdict,report_sha256:contentReview.report_sha256},
    verified_this_run:researchResult?.checked_total??0}
}
