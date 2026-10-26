import { mkdir, lstat, readFile, readdir, open, link, unlink } from 'node:fs/promises'
import { join, resolve, relative, sep, basename } from 'node:path'
import { randomUUID } from 'node:crypto'
import { REVIEW_SCHEMA, PROPOSAL_SCHEMA, TRANSCRIPT_SCHEMA, canonicalJson, sha256 } from './review-contracts.mjs'
import { reconcileReview, markAwaitingReview, unresolvedBlockers, registerGateIssue } from './review-ledger.mjs'
import { openReviewStore, recoverableEvidenceRejection, validateProposalArchives } from './review-store.mjs'
import { prepareEvidence, loadEvidenceContext, validateEvidenceQuotes, safeEvidenceFile } from './review-evidence.mjs'
import { buildTaskContext, buildFullRevisionContext, applyProposal, bindProposalEvidence } from './review-proposals.mjs'
import { freezeReviewMethods } from './review-methods.mjs'
import { validateReviewRecord } from '../check_thesis_review.mjs'

export const reviewStages = Object.freeze([
  { label: '成稿审查', phase: '成稿审查', schema: REVIEW_SCHEMA },
  { label: '问题修订', phase: '问题修订', schema: PROPOSAL_SCHEMA },
  { label: '修订成稿', phase: '修订成稿', schema: PROPOSAL_SCHEMA },
  { label: '证据转录', phase: '证据转录', schema: TRANSCRIPT_SCHEMA },
])
const control = '.codex-workflow/review'
const evidenceImages = (runDir, sources) => sources.flatMap(source => source.type === 'image' ? [resolve(runDir, source.path)] : source.type === 'pdf' ? (source.pdf_origin?.pages ?? []).map(page => resolve(runDir, page.image.path)) : [])
const utf8 = bytes => new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)

async function storedObject(runDir, reference) {
  const bytes = await readFile(await safeEvidenceFile(runDir, `${control}/${reference.path}`))
  if (sha256(bytes) !== reference.sha256) throw new Error('immutable review reference digest mismatch')
  return JSON.parse(utf8(bytes))
}

// Only current evidence authorization is projected. Historical report anchors may
// have changed in an earlier host patch. This is never a raw review, receipt or
// semantic verdict: Store separately verifies the original immutable linkage.
async function validateHistoricalEvidence(runDir, state, evidence) {
  if (!state.review) return
  const projection = {
    reviewed_sources: state.review.reviewed_sources,
    visual_attestations: state.review.visual_attestations,
    coverage: state.review.coverage.map(item => ({ ...item, findings: item.findings.map(({ report_quote, ...finding }) => finding) })),
    new_issues: state.review.new_issues.map(item => ({ ...item, locations: item.locations.map(({ quote, ...location }) => location) })),
  }
  await validateEvidenceQuotes({ runDir, review: projection, manifest: evidence })
}

async function currentInputs(runDir, store) {
  const state = await store.read()
  await validateProposalArchives({ runDir, state })
  const evidence = await storedObject(runDir, state.commit.refs.evidence)
  const context = await loadEvidenceContext({ runDir, manifest: evidence })
  const reportBytes = await readFile(await safeEvidenceFile(runDir, 'report.md'))
  if (sha256(reportBytes) !== state.snapshot.report_sha256) throw new Error('manual report edit conflict')
  await validateHistoricalEvidence(runDir, state, evidence)
  return { state, evidence, reportBytes, ...context }
}

async function syncDirectory(path) {
  const file = await open(path, 'r')
  try { await file.sync() } finally { await file.close() }
}
async function archiveDirectory(runDir, path) {
  const rel = relative(runDir, path)
  if (rel.startsWith('..') || resolve(runDir, rel) !== path) throw new Error('exchange archive path escaped run directory')
  let current = runDir
  for (const part of rel.split(sep)) {
    const parent = current
    current = join(current, part)
    try { await mkdir(current) } catch (error) { if (error.code !== 'EEXIST') throw error }
    const info = await lstat(current)
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('unsafe exchange archive directory')
    await syncDirectory(parent)
    await syncDirectory(current)
  }
}
async function archiveJson(runDir, path, value) {
  await archiveDirectory(runDir, resolve(path, '..'))
  const bytes = Buffer.from(canonicalJson(value))
  const temp = join(resolve(path, '..'), `.${basename(path)}-${randomUUID()}.tmp`)
  const file = await open(temp, 'wx', 0o444)
  try {
    try { await file.writeFile(bytes); await file.sync() } finally { await file.close() }
    try { await link(temp, path) }
    catch (error) {
      if (error.code !== 'EEXIST') throw error
      const existing = await readFile(await safeEvidenceFile(runDir, relative(runDir, path)))
      if (!existing.equals(bytes)) throw new Error('conflicting exchange archive replay')
    }
  } finally {
    await unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error })
  }
  await syncDirectory(resolve(path, '..'))
  return { path: relative(join(runDir, control), path).split(sep).join('/'), sha256: sha256(bytes) }
}

const reviewerInstructions = `独立完整审查当前报告十二节、五路底稿和全部附件。遵循提供的 methodology 完整方法文本与语义覆盖 rubric。仅使用提供的完整报告、证据与任务账本；不得依赖修订者自评。对全部旧任务 ID（包括 resolved）给出唯一独立处置，允许重新打开和发现新问题。status 与 kind/blocks_delivery 分开：blocking 必须 blocks_delivery:true，watch 必须 false；disclosure 按实际是否阻断决定。resolved 只关闭状态，不改变问题分类或阻断属性。例如旧阻断任务修复后合法处置是 {"task_id":"RT-000001","status":"resolved","reason":"独立核对验收条件已满足","kind":"blocking","blocks_delivery":true}。若确需升降级，须同时满足 kind/blocks_delivery 约束，并在 reason 说明改变依据；不能仅因任务已解决就把 blocking 的 blocks_delivery 改 false。每个新问题关联章节/coverage。局部候选须声明 judgment_constraints 的精确原文引用；没有跨节约束时明确 []，不确定则 full_revision。所有二进制附件必须逐一目视核对原图/全部 PDF 页及候选转录，返回绑定摘要的 visual_attestations。未知事实保留限制；不要制造证据。严格回传 host 分配的 review_id、Snapshot、input_ledger_sha256。只返回 schema JSON，不写文件。`
const proposalInstructions = `full_revision 须遵循 methodology 完整方法文本及语义覆盖 rubric。full_revision 可使用 section:0 精确修改第一节之前的开篇/前言；局部提案禁止 section:0。若 preface_boundary_anchor 非空（第一节标题就在字节0），section:0 的 before 必须精确等于该完整标题，after 必须以原标题逐字结尾，只允许在其前插入开篇；禁止空 before。仍保留十二节顺序与边界。只返回任务修订 Proposal，不写文件、不研究新资料、不关闭任务。基于当前 Snapshot 和精确原文给出可唯一定位的 edits，完整覆盖任务验收条件和授权证据；信息不足返回 needs_evidence，局部范围不够返回 escalate。`

async function exchange({ runDir, runtime, signal, context, label, phase, schema, contract, images, instructions, archiveId }) {
  signal?.throwIfAborted()
  const contextJson = canonicalJson(context)
  const contextBytes = Buffer.byteLength(contextJson, 'utf8')
  const prompt = instructions + '\nCONTEXT_JSON\n' + contextJson
  const options = { label, phase, schema, contract, images, context_bytes: contextBytes }
  const dir = join(runDir, control, 'exchanges', `EX-${archiveId ?? randomUUID()}`)
  const request = await archiveJson(runDir, join(dir, 'request.json'), { context, context_bytes: contextBytes, prompt, options })
  let response
  if (archiveId) {
    let existing
    try { existing = await readFile(await safeEvidenceFile(runDir, relative(runDir, join(dir, 'response.json')))) }
    catch (error) { if (error.code !== 'ENOENT') throw error }
    if (existing) {
      signal?.throwIfAborted()
      return { response: JSON.parse(utf8(existing)), archive: { request, response: { path: relative(join(runDir, control), join(dir, 'response.json')).split(sep).join('/'), sha256: sha256(existing) } } }
    }
  }
  try { response = await runtime.agent(prompt, options) }
  catch (error) {
    await archiveJson(runDir, join(dir, `error-${randomUUID()}.json`), { name: error.name, message: error.message })
    throw error
  }
  const responseRef = await archiveJson(runDir, join(dir, 'response.json'), response)
  signal?.throwIfAborted()
  return { response, archive: { request, response: responseRef } }
}

async function optionalArchive(runDir, path) {
  let bytes
  try { bytes = await readFile(await safeEvidenceFile(runDir, `${control}/${path}`)) }
  catch (error) { if (error.code === 'ENOENT') return null; throw error }
  return { value: JSON.parse(utf8(bytes)), ref: { path, sha256: sha256(bytes) } }
}

// Preserve a previously received full review when upgrading a stalled run.
// Its entire context (except the host review ID) must match the current input.
async function previousReviewExchange(runDir, context) {
  let entries
  try { entries = await readdir(join(runDir, control, 'exchanges')) }
  catch (error) { if (error.code === 'ENOENT') return null; throw error }
  for (const entry of entries.sort()) {
    if (!/^EX-[A-Za-z0-9-]+$/.test(entry)) continue
    let request, response
    try { request = await optionalArchive(runDir, `exchanges/${entry}/request.json`) }
    catch (error) { if (error instanceof SyntaxError || error.code === 'ERR_ENCODING_INVALID_ENCODED_DATA') continue; throw error }
    if (request?.value.options?.contract !== 'review') continue
    const { review_id, ...base } = request.value.context ?? {}
    if (!/^RV-[A-Za-z0-9-]+$/.test(review_id ?? '') || canonicalJson(base) !== canonicalJson(context)) continue
    try { response = await optionalArchive(runDir, `exchanges/${entry}/response.json`) }
    catch (error) { if (error instanceof SyntaxError || error.code === 'ERR_ENCODING_INVALID_ENCODED_DATA') continue; throw error }
    if (response) return { review_id, archive: { request: request.ref, response: response.ref } }
  }
  return null
}

async function validatedReview({ runDir, runtime, signal, context, schema, inputs, store, emit }) {
  const key = sha256(canonicalJson(context)), path = `review-sessions/RS-${key}.json`
  let session = (await optionalArchive(runDir, path))?.value
  if (!session) {
    const prior = await previousReviewExchange(runDir, context)
    session = { version: 1, context_sha256: key, review_id: prior?.review_id ?? `RV-${randomUUID()}`, initial_exchange: prior?.archive ?? null }
    await archiveJson(runDir, join(runDir, control, path), session)
  }
  if (session.version !== 1 || session.context_sha256 !== key || !/^RV-[A-Za-z0-9-]+$/.test(session.review_id)) throw Error('invalid review session binding')
  let correction
  for (let index = 0; index < 3; index++) {
    const called = index === 0 && session.initial_exchange
      ? { response: await storedObject(runDir, session.initial_exchange.response), archive: session.initial_exchange }
      : await exchange({ runDir, runtime, signal,
        context: { ...context, review_id: session.review_id, ...(correction ? { review_correction: correction } : {}) },
        label: index ? `成稿审查:纠正-${index}` : '成稿审查', phase: '成稿审查', schema, contract: 'review', images: inputs.images,
        archiveId: `review-${key}-${index}`,
        instructions: reviewerInstructions + '\nreviewed_sources 必须与 expected_reviewed_sources 完全一致，每个路径恰好一次；只列 evidence 的 path。methodology 文档、report_text、ledger 不得列入。sections 中的 task_ids 只能列该 task.locations 登记的章节；跨节总结无需重复挂任务 ID。若提供 review_correction，只修正不合规的返回内容，并依据同一完整上下文重新核对；不得因格式纠正强行改变独立结论。' })
    if (session.initial_exchange && index === 0) await storedObject(runDir, session.initial_exchange.request)
    await emit({ type: 'review.response_archived', review_id: session.review_id, attempt: index + 1 })
    await currentInputs(runDir, store)
    let review, reconciled, failure
    try {
      if (called.response.review_id !== session.review_id) throw Error('independent review_id differs from host allocation')
      review = await validateReviewRecord({ runDir, review: called.response, manifest: inputs.evidence, inputLedger: inputs.state.ledger })
      reconciled = reconcileReview({ ledger: inputs.state.ledger, review, snapshot: inputs.state.snapshot })
    } catch (error) { failure = error }
    if (!failure) return { review, reconciled, reviewId: session.review_id }
    if (index === 2) throw Error(`independent review validation exhausted: ${failure.message}`)
    correction = { error: failure.message, previous_review: called.response,
      allowed_section_task_ids: Object.fromEntries(Array.from({ length: 12 }, (_, index) => [String(index + 1),
        context.ledger.tasks.filter(task => task.locations.some(location => location.section === index + 1)).map(task => task.id)])) }
    await emit({ type: 'review.correction', review_id: session.review_id, attempt: index + 1, reason: failure.message })
  }
}

async function validatedProposal({ runDir, runtime, signal, context, label, images, inputs, state, store, tasks, mode, refresh, initialExchange, emit }) {
  for (;;) {
    const group = await store.reserveProposalCall({ attemptId: state.attempt.id, snapshot: state.snapshot, taskIds: tasks.map(task => task.id), mode })
    const index = group.calls.length - 1, call = group.calls[index]
    const archives = group.calls.flatMap(item => item.archive ? [item.archive] : [])
    const errors = group.calls.filter(item => item.status === 'rejected').map(item => item.error)
    if (call.status === 'rejected') return { status: 'rejected', reportBytes: inputs.reportBytes, applications: [], reason: call.error,
      archives, host_added_refs: [], validation_attempts: group.calls.length, protocol_version: 2, validation_errors: errors }
    const prior = group.calls[index - 1]
    const correction = prior ? { error: prior.error, previous_proposal: await storedObject(runDir, prior.archive.response) } : undefined
    const called = index === 0 && initialExchange ? initialExchange : await exchange({ runDir, runtime, signal,
      context: correction ? { ...context, correction } : context,
      label: index ? `${label}:correction-${index}` : label,
      phase: mode === 'full_revision' ? '修订成稿' : '问题修订', schema: PROPOSAL_SCHEMA, contract: 'proposal', images,
      archiveId: call.id,
      instructions: proposalInstructions + '\n任务的必需 evidence_refs 由 host 原样保留；你可以补充本次使用的合法引用。若提供 correction，按校验错误修正 previous_proposal，保留其他有效修改。' })
    await emit({ type: 'proposal.response_archived', label, call_id: call.id })
    await refresh()
    let bound, applied, validationError = null
    try {
      bound = bindProposalEvidence({ proposal: called.response, tasks })
      applied = applyProposal({ ...inputs, proposal: bound.proposal, taskIds: tasks.map(task => task.id), allowedSections: context.allowed_sections,
        snapshot: state.snapshot, ledger: state.ledger, mode })
    } catch (error) { validationError = error.message }
    await store.recordProposalValidation({ attemptId: state.attempt.id, groupKey: group.key, callId: call.id, archive: called.archive, error: validationError })
    await emit({ type: 'proposal.validation_recorded', label, call_id: call.id })
    if (!validationError) return { ...applied, archives: [...group.calls.slice(0, index).map(item => item.archive), called.archive],
      host_added_refs: bound.added_refs, validation_attempts: index + 1, protocol_version: 2, validation_errors: errors }
    if (index + 1 < group.maximum) await emit({ type: 'proposal.correction', label, attempt: index + 1, reason: validationError })
  }
}

// Follow committed attempts, not mutable diagnostic displays. A later successful
// application supersedes an earlier no-evidence result for that same task.
async function evidenceStops(runDir, state) {
  const seen = new Set(), stopped = new Set(), attempts = new Set()
  let commit = state.commit
  while (commit) {
    if (commit.refs.attempt && !attempts.has(commit.refs.attempt.sha256)) {
      attempts.add(commit.refs.attempt.sha256)
      const attempt = await storedObject(runDir, commit.refs.attempt)
      for (const item of attempt.results.toReversed()) {
        if (seen.has(item.task_id)) continue
        seen.add(item.task_id)
        if (item.snapshot.evidence_sha256 === state.snapshot.evidence_sha256 && item.result.status === 'needs_evidence') stopped.add(item.task_id)
      }
    }
    commit = commit.previous ? await storedObject(runDir, commit.previous) : null
  }
  return stopped
}

/** Caller holds the existing run lock. All model roles are read-only; only Store
 * publishes report/ledger changes. terminalReason MUST block downstream delivery. */
export async function coordinateThesisReview({ root, args, runtime, store, reason = 'initial', signal, emit = () => {}, reviewMaxRounds, gateFeedback }) {
  if (reviewMaxRounds !== undefined && (!Number.isInteger(reviewMaxRounds) || reviewMaxRounds < 1 || reviewMaxRounds > 10)) throw new Error('reviewMaxRounds must be an integer from 1 to 10')
  const runDir = resolve(root, `reports/${args.symbol}_thesis_${args.date}`)
  const methodology = await freezeReviewMethods({ root, runDir })
  store ??= await openReviewStore({ runDir, emit }) // Explicit expansion is deferred until a repair is necessary.
  let state = await store.read()
  if (reviewMaxRounds !== undefined && reviewMaxRounds < (state?.ledger.budget.used_rounds ?? 0)) throw new Error('reviewMaxRounds cannot be below consumed used rounds')
  signal?.throwIfAborted()
  if (!state) {
    const evidence = await prepareEvidence({ runDir, runtime, store })
    const reportBytes = await readFile(await safeEvidenceFile(runDir, 'report.md'))
    state = await store.initialize({ reportBytes, evidence })
  }
  let inputs = await currentInputs(runDir, store)
  if (recoverableEvidenceRejection(state)) {
    state = await store.reopenEvidenceRejection({ attemptId: state.attempt.id, snapshot: state.snapshot })
    inputs = await currentInputs(runDir, store)
  }
  const result = () => ({ review: state.review, receipt: state.receipt, ledgerPath: join(runDir, control, 'ledger.json'), snapshot: state.snapshot, terminalReason: state.ledger.terminal_reason })
  if (gateFeedback !== undefined) {
    if (!gateFeedback || typeof gateFeedback.gateId !== 'string') throw new Error('gateFeedback requires gateId and feedback')
    const ledger = registerGateIssue({ ledger: state.ledger, snapshot: state.snapshot, ...gateFeedback })
    state = await store.registerTasks({ ledger, reason: `technical gate: ${gateFeedback.gateId}` })
  }
  if (state.review?.verdict === 'pass' && !unresolvedBlockers(state.ledger).length && state.ledger.active_attempt_id === null && !state.ledger.terminal_reason) {
    state = await store.assertDeliverable({ snapshot: inputs.state.snapshot })
    if (reviewMaxRounds !== undefined && reviewMaxRounds !== state.ledger.budget.max_rounds) await emit({ type: 'review_budget_deferred', requested: reviewMaxRounds, reason: 'current pass needs no revision' })
    return result()
  }
  if (reviewMaxRounds !== undefined) state = await store.setMaxRounds(reviewMaxRounds)

  for (;;) {
    signal?.throwIfAborted()
    inputs = await currentInputs(runDir, store)
    state = inputs.state
    const active = state.ledger.active_attempt_id !== null
    const needsReview = !state.review || (active && state.attempt.state === 'finalized' && !state.ledger.terminal_reason)
    if (needsReview) {
      const expectedSources = inputs.evidence.sources.map(source => source.path)
      const reviewSchema = structuredClone(REVIEW_SCHEMA)
      reviewSchema.properties.reviewed_sources = { ...reviewSchema.properties.reviewed_sources,
        items: { type: 'string', enum: expectedSources }, minItems: expectedSources.length, maxItems: expectedSources.length }
      const context = { version: 2, methodology, snapshot: state.snapshot, expected_reviewed_sources: expectedSources,
        input_ledger_sha256: sha256(canonicalJson(state.ledger)), ledger: state.ledger,
        report_text: utf8(inputs.reportBytes), evidence: inputs.evidence.sources.map(source => ({ ...source, text: inputs.sourceTexts[source.path] ?? null, text_kind: source.type === 'text' ? 'source_text' : 'candidate_transcript' })) }
      const { review, reconciled, reviewId } = await validatedReview({ runDir, runtime, signal, context, schema: reviewSchema, inputs, store, emit })
      state = await store.commitReview({ review, ...reconciled, evidence: inputs.evidence })
      await emit({ type: 'review_committed', review_id: reviewId, reason, verdict: review.verdict })
      continue
    }
    if (!active) {
      if (state.review.verdict === 'pass' && !unresolvedBlockers(state.ledger).length) {
        state = await store.assertDeliverable({ snapshot: inputs.state.snapshot })
        return result()
      }
      const stopped = await evidenceStops(runDir, state)
      const open = state.ledger.tasks.filter(task => task.status === 'open' && (task.blocks_delivery || state.review.verdict === 'revise'))
      const actionable = open.filter(task => !stopped.has(task.id))
      if (!actionable.length) {
        state = await store.recordStop({ reason: 'needs_evidence' })
        return result()
      }
      if (state.ledger.budget.used_rounds >= state.ledger.budget.max_rounds) {
        state = await store.recordStop({ reason: 'budget_exhausted' })
        return result()
      }
      state = await store.beginAttempt({ taskIds: actionable.map(task => task.id), snapshot: state.snapshot })
      continue
    }
    if (state.ledger.terminal_reason) return result()
    const attempt = state.attempt
    if (attempt.cursor === attempt.task_ids.length) {
      const progress = attempt.results.some(item => item.result.status === 'applied')
      const stop = attempt.results.some(item => item.result.status === 'needs_evidence') ? 'needs_evidence' : 'no_safe_edit'
      state = await store.finalizeAttempt({ attemptId: attempt.id, ...(progress ? {} : { reason: stop }) })
      continue
    }
    const taskId = attempt.task_ids[attempt.cursor]
    const task = state.ledger.tasks.find(task => task.id === taskId)
    let built = buildTaskContext({ ...inputs, task, ledger: state.ledger })
    let tasks = [task], mode = 'local_patch', context = built.context, archive = [], applied
    if (built.route === 'local_patch') {
      applied = await validatedProposal({ runDir, runtime, signal, context, label: `问题修订:${taskId}:${attempt.id}`,
        images: evidenceImages(runDir, context.evidence), inputs, state, store, tasks, mode, refresh: () => currentInputs(runDir, store), emit })
      archive.push(...applied.archives)
      if (applied.status === 'rejected') built = { route: 'full_revision', reason: `local proposal rejected: ${applied.reason}` }
      if (applied?.status === 'escalate') built = { route: 'full_revision', reason: applied.reason }
    }
    if (built.route === 'full_revision') {
      mode = 'full_revision'
      // Escalate the unfinished fixed group, excluding already known missing-evidence tasks.
      tasks = attempt.task_ids.slice(attempt.cursor).map(id => state.ledger.tasks.find(task => task.id === id)).filter(task => task.id === taskId || task.route !== 'needs_evidence')
      context = { ...buildFullRevisionContext({ ...inputs, tasks, ledger: state.ledger }), methodology }
      if (context.route === 'needs_evidence') applied = { status: 'needs_evidence', reportBytes: inputs.reportBytes, applications: [], reason: context.reason }
      else {
        const replay = attempt.cursor === 0 && attempt.replay && canonicalJson(tasks.map(task => task.id)) === canonicalJson(attempt.task_ids)
          ? { response: await storedObject(runDir, attempt.replay.response), archive: attempt.replay } : undefined
        applied = await validatedProposal({ runDir, runtime, signal, context, label: `修订成稿:${attempt.id}:${taskId}`,
          images: inputs.images, inputs, state, store, tasks, mode, refresh: () => currentInputs(runDir, store), initialExchange: replay, emit })
        archive.push(...applied.archives)
      }
    }
    if (built.route === 'needs_evidence') applied = { status: 'needs_evidence', reportBytes: inputs.reportBytes, applications: [], reason: built.reason }
    const taskIds = tasks.map(task => task.id)
    const snapshot = { ...state.snapshot, report_sha256: sha256(applied.reportBytes) }
    const ledger = applied.status === 'applied' ? markAwaitingReview({ ledger: state.ledger, taskIds, snapshot, attemptId: attempt.id }) : state.ledger
    await currentInputs(runDir, store)
    state = await store.checkpointAttempt({ attemptId: attempt.id, taskId,
      result: { status: applied.status, task_ids: taskIds, mode, archives: archive, applications: applied.applications,
        ...(applied.protocol_version ? { protocol_version: applied.protocol_version, validation_attempts: applied.validation_attempts,
          host_added_refs: applied.host_added_refs, validation_errors: applied.validation_errors } : {}),
        ...(applied.reason ? { reason: applied.reason } : {}) },
      reportBytes: applied.reportBytes, ledger, evidence: inputs.evidence })
    await emit({ type: 'review_task_checkpoint', attempt_id: attempt.id, task_ids: taskIds, status: applied.status })
  }
}
