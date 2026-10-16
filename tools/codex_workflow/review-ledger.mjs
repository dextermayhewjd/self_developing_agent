import { REVIEW_SCHEMA, REVIEW_LENSES, canonicalJson, sha256 } from './review-contracts.mjs'
import { decodeResult } from './schema.mjs'

const nonempty = value => typeof value === 'string' && value.trim().length > 0
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const fail = message => { throw new Error(message) }
const unique = (values, label) => {
  if (new Set(values).size !== values.length) fail(`duplicate ${label}`)
}
function checkSnapshot(snapshot) {
  for (const key of ['report_sha256', 'evidence_sha256']) if (!digest(snapshot?.[key])) fail(`invalid Snapshot ${key}`)
}
function checkKind(task) {
  if (!['blocking', 'disclosure', 'watch'].includes(task.kind) || typeof task.blocks_delivery !== 'boolean') fail('invalid task kind/blocks_delivery')
  if ((task.kind === 'blocking' && !task.blocks_delivery) || (task.kind === 'watch' && task.blocks_delivery)) fail('kind conflicts with blocks_delivery')
}
function checkLedger(ledger) {
  if (ledger?.version !== 2 || !Array.isArray(ledger.tasks) || !Number.isInteger(ledger.next_task_number) || ledger.next_task_number < 1) fail('invalid ledger')
  const budget = ledger.budget
  if (!budget || !Number.isInteger(budget.max_rounds) || budget.max_rounds < 1 || budget.max_rounds > 10 || !Number.isInteger(budget.used_rounds) || budget.used_rounds < 0 || budget.used_rounds > budget.max_rounds || !Number.isInteger(budget.valid_reviews) || budget.valid_reviews < 0 || !Array.isArray(budget.review_ids) || budget.review_ids.length !== budget.valid_reviews || !Array.isArray(budget.extensions)) fail('invalid ledger budget')
  unique(budget.review_ids, 'review IDs')
  unique(ledger.tasks.map(task => task.id), 'ledger task IDs')
  unique(ledger.tasks.map(task => task.issue_key), 'ledger issue_key')
  for (const task of ledger.tasks) {
    if (!/^RT-\d{6,}$/.test(task.id) || Number(task.id.slice(3)) >= ledger.next_task_number || !nonempty(task.issue_key) || !['open', 'awaiting_review', 'resolved'].includes(task.status) || !Array.isArray(task.history)) fail('invalid ledger task')
    checkKind(task)
  }
}

export function createLedger({ maxRounds = 2 } = {}) {
  if (!Number.isInteger(maxRounds) || maxRounds < 1 || maxRounds > 10) fail('maxRounds must be an integer from 1 to 10')
  return {
    version: 2, next_task_number: 1, tasks: [],
    budget: { max_rounds: maxRounds, used_rounds: 0, valid_reviews: 0, extensions: [], review_ids: [] },
    active_attempt_id: null, terminal_reason: null,
  }
}

export function unresolvedBlockers(ledger) {
  return ledger.tasks.filter(task => task.blocks_delivery && task.status !== 'resolved').map(task => structuredClone(task))
}

function historyEvent(task, { event, snapshot, reviewId, attemptId, reason }) {
  const entry = { event, status: task.status, kind: task.kind, blocks_delivery: task.blocks_delivery, reason, ...snapshot }
  if (reviewId !== undefined) entry.review_id = reviewId
  if (attemptId !== undefined) entry.attempt_id = attemptId
  return entry
}

export function markAwaitingReview({ ledger, taskIds, snapshot, attemptId }) {
  checkLedger(ledger)
  checkSnapshot(snapshot)
  if (!nonempty(attemptId) || !Array.isArray(taskIds) || taskIds.length === 0) fail('attemptId and taskIds are required')
  unique(taskIds, 'task IDs')
  if (ledger.active_attempt_id !== null && ledger.active_attempt_id !== attemptId) fail('conflicting active attempt')
  const result = structuredClone(ledger)
  for (const id of taskIds) {
    const task = result.tasks.find(task => task.id === id)
    if (!task) fail(`unknown task ID ${id}`)
    if (task.status !== 'open') fail(`task ${id} must be open before applying a proposal`)
    task.status = 'awaiting_review'
    // These hashes describe the applied candidate; last_review_id remains independent.
    Object.assign(task, snapshot)
    task.history.push(historyEvent(task, { event: 'awaiting_review', snapshot, attemptId, reason: 'host applied validated proposal' }))
  }
  result.active_attempt_id = attemptId
  return result
}

function mergeIssues(issues, snapshot) {
  const merged = new Map()
  for (const issue of issues) {
    checkKind(issue)
    if (![issue.issue_key, issue.description, ...issue.acceptance_criteria].every(nonempty)) fail('issue requires issue_key, description and acceptance criteria')
    if (issue.judgment_constraints !== undefined) {
      for (const ref of issue.judgment_constraints) if (!nonempty(ref.quote)) fail('judgment constraint requires a nonempty quote')
      unique(issue.judgment_constraints.map(ref => canonicalJson(ref)), 'judgment constraints')
    }
    for (const ref of issue.evidence_refs) {
      if (!nonempty(ref.source) || !nonempty(ref.quote) || !digest(ref.source_sha256) || ref.evidence_sha256 !== snapshot.evidence_sha256) fail('invalid issue evidence_refs or evidence_sha256')
      if ((ref.transcript_path === undefined) !== (ref.transcript_sha256 === undefined) || (ref.transcript_sha256 !== undefined && (!digest(ref.transcript_sha256) || !nonempty(ref.transcript_path)))) fail('invalid transcript evidence reference')
    }
    const previous = merged.get(issue.issue_key)
    if (!previous) { merged.set(issue.issue_key, structuredClone(issue)); continue }
    const definition = ({ locations, evidence_refs, ...rest }) => rest
    if (canonicalJson(definition(previous)) !== canonicalJson(definition(issue))) fail(`conflicting definitions for issue_key ${issue.issue_key}`)
    for (const field of ['locations', 'evidence_refs']) {
      const values = new Map([...previous[field], ...issue[field]].map(value => [canonicalJson(value), value]))
      previous[field] = [...values.values()]
    }
  }
  return [...merged.values()]
}

function validateCoverage(review, tasks, issues) {
  unique(review.sections.map(section => section.section), 'sections')
  unique(review.coverage.map(coverage => coverage.lens), 'coverage lenses')
  unique(review.reviewed_sources, 'reviewed_sources')
  if (!review.reviewed_sources.every(nonempty) || !review.reviewed_sources.includes('疑惑.md')) fail('reviewed_sources requires full source inventory including 疑惑.md')
  const newByKey = new Map(issues.map(issue => [issue.issue_key, issue]))
  const oldById = new Map(tasks.map(task => [task.id, task]))
  const byKey = new Map(tasks.map(task => [task.issue_key, task]))
  for (const issue of issues) byKey.set(issue.issue_key, issue)
  const linkedNew = new Set()
  function checkLinks(item, requiresIssue, sectionNumber) {
    const linked = []
    unique(item.issue_keys ?? [], 'issue_key links')
    unique(item.task_ids ?? [], 'task_id links')
    for (const key of item.issue_keys ?? []) {
      const task = byKey.get(key)
      if (!task) fail(`unknown issue_key link ${key}`)
      if (sectionNumber !== undefined && !task.locations.some(location => location.section === sectionNumber)) fail(`issue_key location mismatch ${key}`)
      linked.push(task)
      if (newByKey.has(key)) linkedNew.add(key)
    }
    for (const id of item.task_ids ?? []) {
      const task = oldById.get(id)
      if (!task) fail(`unknown task_id link ${id}`)
      if (sectionNumber !== undefined && !task.locations.some(location => location.section === sectionNumber)) fail(`task_id location mismatch ${id}`)
      linked.push(task)
    }
    if (requiresIssue && !linked.some(task => task.status !== 'resolved')) fail('unresolved section/coverage requires known unresolved issue_keys/task_ids')
  }
  for (const section of review.sections) {
    if (!nonempty(section.evidence)) fail('section evidence required')
    checkLinks(section, section.status === 'revise', section.section)
  }
  for (const coverage of review.coverage) {
    if (!REVIEW_LENSES.includes(coverage.lens) || !coverage.findings.some(finding => finding.source === `findings/${coverage.lens}.md`)) fail('coverage missing its lens findings source')
    for (const finding of coverage.findings) {
      if (!nonempty(finding.finding) || !nonempty(finding.source_quote) || !review.reviewed_sources.includes(finding.source)) fail('coverage requires finding, quote and reviewed source')
      if (['covered', 'contradicted'].includes(finding.disposition) && !nonempty(finding.report_quote)) fail('coverage requires report_quote')
      if (finding.disposition === 'excluded' && !nonempty(finding.exclusion_reason)) fail('excluded finding requires exclusion_reason')
      checkLinks(finding, ['omitted', 'contradicted'].includes(finding.disposition))
    }
  }
  for (const issue of issues) {
    if (!linkedNew.has(issue.issue_key)) fail(`new issue_key lacks section/coverage linkage: ${issue.issue_key}`)
    for (const ref of issue.evidence_refs) if (!review.reviewed_sources.includes(ref.source)) fail(`issue evidence source was not reviewed: ${ref.source}`)
  }
}

export function reconcileReview({ ledger, review: rawReview, snapshot }) {
  checkLedger(ledger)
  checkSnapshot(snapshot)
  const review = decodeResult(REVIEW_SCHEMA, rawReview)
  for (const key of ['report_sha256', 'evidence_sha256']) if (review[key] !== snapshot[key]) fail(`${key} does not match Snapshot`)
  if (review.input_ledger_sha256 !== sha256(canonicalJson(ledger))) fail('input_ledger_sha256 does not match ledger')
  if (!nonempty(review.review_id)) fail('review_id required')
  if (ledger.budget.review_ids.includes(review.review_id)) fail(`duplicate review ID ${review.review_id}`)
  if (ledger.budget.valid_reviews >= ledger.budget.used_rounds + 1 || ledger.budget.valid_reviews >= ledger.budget.max_rounds + 1) fail('review budget requires a reserved revision round')
  unique(review.task_dispositions.map(disposition => disposition.task_id), 'task dispositions')
  const oldIds = new Set(ledger.tasks.map(task => task.id))
  for (const disposition of review.task_dispositions) if (!oldIds.has(disposition.task_id)) fail(`unknown task ID ${disposition.task_id}`)
  for (const id of oldIds) if (!review.task_dispositions.some(disposition => disposition.task_id === id)) fail(`missing disposition for ${id}`)
  const result = structuredClone(ledger)
  for (const disposition of review.task_dispositions) {
    checkKind(disposition)
    if (!nonempty(disposition.reason)) fail(`independent disposition requires reason for ${disposition.task_id}`)
    const task = result.tasks.find(task => task.id === disposition.task_id)
    const event = task.status === 'resolved' && disposition.status === 'open' ? 'reopened' : 'reviewed'
    Object.assign(task, { status: disposition.status, kind: disposition.kind, blocks_delivery: disposition.blocks_delivery, last_review_id: review.review_id }, snapshot)
    task.history.push(historyEvent(task, { event, snapshot, reviewId: review.review_id, reason: disposition.reason }))
  }
  const issues = mergeIssues(review.new_issues, snapshot)
  for (const issue of issues) {
    if (result.tasks.some(task => task.issue_key === issue.issue_key)) fail(`existing issue_key must use its old task disposition: ${issue.issue_key}`)
  }
  validateCoverage(review, result.tasks, issues)
  for (const issue of issues) {
    const task = { ...issue, id: `RT-${String(result.next_task_number++).padStart(6, '0')}`, status: 'open', created_review_id: review.review_id, last_review_id: review.review_id, ...snapshot, history: [] }
    task.history.push(historyEvent(task, { event: 'created', snapshot, reviewId: review.review_id, reason: issue.description }))
    result.tasks.push(task)
  }
  const needsRevision = unresolvedBlockers(result).length > 0 || review.sections.some(section => section.status === 'revise') || review.coverage.some(coverage => coverage.findings.some(finding => ['omitted', 'contradicted'].includes(finding.disposition)))
  if ((review.verdict === 'revise') !== needsRevision) fail('verdict inconsistent with sections, coverage or unresolved blockers')
  result.budget.valid_reviews++
  result.budget.review_ids.push(review.review_id)
  result.active_attempt_id = null
  result.terminal_reason = null
  return {
    ledger: result,
    receipt: { review_id: review.review_id, ...snapshot, input_ledger_sha256: review.input_ledger_sha256, output_ledger_sha256: sha256(canonicalJson(result)) },
  }
}
