import { PROPOSAL_SCHEMA, canonicalJson, sha256 } from './review-contracts.mjs'
import { decodeResult } from './schema.mjs'
import { parseReportSections } from './review-sections.mjs'

const MAX_CONTEXT_BYTES = 32768
const nonempty = value => typeof value === 'string' && value.trim().length > 0
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const fail = message => { throw new Error(message) }
const unique = (values, label) => {
  if (!Array.isArray(values) || new Set(values).size !== values.length) fail(`invalid or duplicate ${label}`)
}
const sectionNumber = value => Number.isInteger(value) && value >= 1 && value <= 12
const clone = value => structuredClone(value)

function readReport(reportBytes) {
  if (typeof reportBytes !== 'string' && !(reportBytes instanceof Uint8Array)) fail('reportBytes must contain UTF-8 bytes')
  const bytes = Buffer.from(reportBytes)
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
  if (typeof reportBytes === 'string' && text !== reportBytes) fail('report is not valid UTF-8 encoded text')
  return { bytes, text, sections: parseReportSections(text) }
}
function checkRef(ref, evidenceSha) {
  if (!ref || !nonempty(ref.source) || !nonempty(ref.quote) || !digest(ref.source_sha256) || ref.evidence_sha256 !== evidenceSha) fail('invalid evidence reference snapshot/source/quote')
  if ((ref.transcript_path === undefined) !== (ref.transcript_sha256 === undefined) || (ref.transcript_path !== undefined && (!nonempty(ref.transcript_path) || !digest(ref.transcript_sha256)))) fail('invalid transcript reference')
}
function selectedTasks(ledger, taskIds, evidenceSha) {
  if (ledger?.version !== 2 || !Array.isArray(ledger.tasks)) fail('invalid task ledger')
  unique(ledger.tasks.map(t => t.id), 'ledger task IDs')
  unique(taskIds, 'task IDs')
  if (!taskIds.length || !taskIds.every(id => /^RT-\d{6,}$/.test(id))) fail('invalid task IDs')
  if (!digest(evidenceSha)) fail('invalid evidence snapshot')
  return taskIds.map(id => {
    const task = ledger.tasks.find(t => t.id === id)
    if (!task || task.status !== 'open') fail(`unknown task or task is not open: ${id}`)
    if (task.evidence_sha256 !== evidenceSha) fail(`task evidence snapshot stale: ${id}`)
    if (!Array.isArray(task.acceptance_criteria) || !task.acceptance_criteria.length || !task.acceptance_criteria.every(nonempty) || !Array.isArray(task.evidence_refs)) fail('invalid task acceptance criteria/evidence refs')
    for (const ref of task.evidence_refs) checkRef(ref, evidenceSha)
    return task
  })
}
function checkManifest(evidence) {
  if (evidence?.version !== 2 || !Array.isArray(evidence.sources) || !digest(evidence.sha256) || evidence.sha256 !== sha256(canonicalJson({ version: 2, sources: evidence.sources }))) fail('invalid evidence manifest snapshot')
  unique(evidence.sources.map(s => s.path), 'evidence source paths')
  for (const source of evidence.sources) {
    if (!nonempty(source.path) || !digest(source.sha256) || !['text', 'image', 'pdf'].includes(source.type)) fail('invalid evidence source descriptor')
    if (source.transcript && (!nonempty(source.transcript.path) || !digest(source.transcript.sha256))) fail('invalid transcript descriptor')
  }
}
function collectEvidence({ evidence, sourceTexts, tasks, all }) {
  checkManifest(evidence)
  const refs = tasks.flatMap(t => t.evidence_refs)
  for (const ref of refs) {
    const source = evidence.sources.find(s => s.path === ref.source)
    if (!source || source.sha256 !== ref.source_sha256) fail('evidence source reference does not match manifest')
    if (source.type === 'text') {
      if (ref.transcript_path !== undefined) fail('text source cannot carry transcript reference')
    } else if (source.transcript) {
      if (ref.transcript_path !== source.transcript.path || ref.transcript_sha256 !== source.transcript.sha256) fail('evidence transcript reference does not match manifest')
    }
  }
  const paths = new Set(refs.map(ref => ref.source))
  const selected = evidence.sources.filter(s => all || paths.has(s.path))
  const missing = []
  const sources = selected.map(source => {
    const text = sourceTexts && Object.hasOwn(sourceTexts, source.path) ? sourceTexts[source.path] : undefined
    if (typeof text !== 'string' || (source.type !== 'text' && !source.transcript)) {
      missing.push(source.path)
      return { ...clone(source), text: null, text_kind: source.type === 'text' ? 'source_text' : 'candidate_transcript' }
    }
    if (source.type === 'text' && sha256(text) !== source.sha256) fail(`evidence source text digest mismatch: ${source.path}`)
    for (const ref of refs.filter(ref => ref.source === source.path)) if (!text.includes(ref.quote)) fail(`evidence quote not found in source: ${source.path}`)
    // Whole cited sources preserve table-wide units, periods, footnotes and caveats.
    return { ...clone(source), text, text_kind: source.type === 'text' ? 'source_text' : 'candidate_transcript' }
  })
  return { sources, missing }
}
function occurrences(text, quote) {
  if (!quote) return []
  const offsets = []
  for (let at = text.indexOf(quote); at !== -1; at = text.indexOf(quote, at + 1)) offsets.push(at)
  return offsets
}
// Paragraph boundaries preserve all original whitespace; no synthesized financial summary.
function paragraphs(section) {
  const ranges = []
  let start = section.heading.length
  if (section.text.slice(start).startsWith('\r\n')) start += 2
  else if (section.text[start] === '\n') start++
  for (const match of section.text.slice(start).matchAll(/(?:\r?\n)[\t ]*(?:\r?\n)/g)) {
    const end = start + match.index + match[0].length
    const previous = ranges.at(-1)?.end ?? start
    ranges.push({ start: previous, end, text: section.text.slice(previous, end) })
  }
  const last = ranges.at(-1)?.end ?? start
  if (last < section.text.length) ranges.push({ start: last, end: section.text.length, text: section.text.slice(last) })
  return ranges.filter(p => p.text.trim())
}
function relevantConstraints(task, sections) {
  if (!Array.isArray(task.judgment_constraints)) return { constraints: [], reason: 'reviewed judgment constraints are unspecified' }
  const constraints = []
  for (const ref of task.judgment_constraints) {
    const section = sections.find(s => s.section === ref.section)
    if (!section || !nonempty(ref.quote)) return { constraints, reason: 'judgment constraint scope is invalid' }
    const hits = occurrences(section.text, ref.quote)
    if (hits.length !== 1) return { constraints, reason: 'judgment constraint quote is missing or ambiguous' }
    const start = hits[0], end = start + ref.quote.length
    const pieces = paragraphs(section).filter(p => p.start < end && p.end > start)
    // A heading/fence/table with no safe paragraph containment escalates unchanged.
    if (!pieces.length || pieces[0].start > start || pieces.at(-1).end < end) return { constraints, reason: 'judgment constraint paragraph scope is ambiguous' }
    const text = section.text.slice(pieces[0].start, pieces.at(-1).end)
    if (!constraints.some(c => c.section === ref.section && c.text === text)) constraints.push({ section: ref.section, quote: ref.quote, text })
  }
  return { constraints }
}
const majorScope = /承重|估值|概率|市值|评分|核心判断|主要判断|重大判断|结论反转|全文|全局|跨节|联动|范围不明|未明确范围|证据冲突|口径冲突|互相矛盾|valuation|probabilit|market.?cap|core.?judg|major.?judg|conflict|whole.?report|unclear.?scope/iu

/** Builds a candidate package without truncation; only route=local_patch is worker-local. */
export function buildTaskContext({ reportBytes, task, ledger, evidence, sourceTexts }) {
  const report = readReport(reportBytes)
  checkManifest(evidence)
  const [current] = selectedTasks(ledger, [task?.id], evidence.sha256)
  if (canonicalJson(task) !== canonicalJson(current)) fail('task does not match current ledger task')
  const { sources, missing } = collectEvidence({ evidence, sourceTexts, tasks: [task], all: false })
  const locations = Array.isArray(task.locations) ? task.locations : []
  const allowed = [...new Set(locations.map(l => l.section))]
  const targets = report.sections.filter(s => allowed.includes(s.section))
  const { constraints, reason: constraintReason } = relevantConstraints(task, report.sections)
  const neighbors = []
  for (const target of targets) for (const delta of [-1, 1]) {
    const adjacent = report.sections.find(s => s.section === target.section + delta)
    if (!adjacent || allowed.includes(adjacent.section)) continue
    const paragraph = delta < 0 ? paragraphs(adjacent).at(-1) : paragraphs(adjacent)[0]
    if (paragraph && !neighbors.some(n => n.section === adjacent.section && n.text === paragraph.text)) neighbors.push({ section: adjacent.section, text: paragraph.text })
  }
  const context = {
    version: 2, snapshot: { report_sha256: sha256(report.bytes), evidence_sha256: evidence.sha256 },
    tasks: [clone(task)], allowed_sections: allowed,
    sections: targets.map(s => ({ section: s.section, heading: s.heading, text: s.text })),
    report_preface: report.text.slice(0, report.sections[0].start), neighbors, constraints, evidence: sources,
  }
  const context_bytes = Buffer.byteLength(JSON.stringify(context), 'utf8')
  let route = 'local_patch', reason = 'bounded exact context'
  if (task.route === 'needs_evidence' || missing.length) {
    route = 'needs_evidence'; reason = missing.length ? `missing evidence text/transcript: ${missing.join(', ')}` : 'review requested missing evidence'
  } else {
    const staleLocation = locations.some(l => !sectionNumber(l.section) || (l.quote !== undefined && (!nonempty(l.quote) || !report.sections[l.section - 1].text.includes(l.quote))))
    const taskScope = [task.description, ...task.acceptance_criteria, ...targets.map(s => s.heading)].join('\n')
    if (task.route === 'full_revision' || !allowed.length || allowed.length > 2 || allowed.some(n => n >= 11) || staleLocation || majorScope.test(taskScope) || constraintReason || context_bytes > MAX_CONTEXT_BYTES) {
      route = 'full_revision'
      reason = constraintReason ?? (context_bytes > MAX_CONTEXT_BYTES ? 'context exceeds 32768 UTF-8 bytes; preserved without truncation' : 'major, broad, conflicting or ambiguous scope requires full revision')
    }
  }
  return { route, context, context_bytes, reason }
}

/** Unbounded exact package for the unified reviser, including every manifest source. */
export function buildFullRevisionContext({ reportBytes, tasks, ledger, evidence, sourceTexts }) {
  const report = readReport(reportBytes)
  checkManifest(evidence)
  const selected = selectedTasks(ledger, tasks.map(t => t.id), evidence.sha256)
  if (canonicalJson(tasks) !== canonicalJson(selected)) fail('tasks do not match current ledger')
  const { sources, missing } = collectEvidence({ evidence, sourceTexts, tasks, all: true })
  const needsEvidence = missing.length > 0 || tasks.some(task => task.route === 'needs_evidence')
  return {
    version: 2, route: needsEvidence ? 'needs_evidence' : 'full_revision',
    reason: missing.length ? `missing evidence text/transcript: ${missing.join(', ')}` : needsEvidence ? 'review requested missing evidence' : 'full exact revision context',
    snapshot: { report_sha256: sha256(report.bytes), evidence_sha256: evidence.sha256 },
    tasks: clone(tasks), allowed_sections: [0, ...report.sections.map(s => s.section)], report_text: report.text, evidence: sources,
    preface_boundary_anchor: report.sections[0].start === 0 ? report.sections[0].heading : null,
  }
}

/** Pure host application. Does not write files or close/transition any ledger task. */
export function applyProposal({ reportBytes, proposal: rawProposal, taskIds, allowedSections, snapshot, ledger, mode = 'local_patch', evidence, sourceTexts }) {
  if (!['local_patch', 'full_revision'].includes(mode)) fail('invalid proposal application mode')
  const report = readReport(reportBytes)
  if (!digest(snapshot?.report_sha256) || !digest(snapshot?.evidence_sha256) || sha256(report.bytes) !== snapshot.report_sha256) fail('report does not match current snapshot')
  const proposal = decodeResult(PROPOSAL_SCHEMA, rawProposal)
  if (proposal.base_report_sha256 !== snapshot.report_sha256) fail('proposal base report snapshot stale')
  const tasks = selectedTasks(ledger, taskIds, snapshot.evidence_sha256)
  unique(proposal.task_ids, 'proposal task IDs')
  if (proposal.task_ids.length !== taskIds.length || !taskIds.every(id => proposal.task_ids.includes(id))) fail('proposal task ID coverage mismatch')
  unique(allowedSections, 'allowed sections')
  if (!allowedSections.length || !allowedSections.every(n => sectionNumber(n) || (mode === 'full_revision' && n === 0))) fail('invalid allowed sections')
  const reviewedRefs = new Map(tasks.flatMap(t => t.evidence_refs).map(ref => [canonicalJson(ref), ref]))
  unique(proposal.evidence_refs.map(ref => canonicalJson(ref)), 'evidence refs')
  for (const ref of proposal.evidence_refs) {
    checkRef(ref, snapshot.evidence_sha256)
    if (mode === 'local_patch' && !reviewedRefs.has(canonicalJson(ref))) fail('proposal evidence ref was not reviewed for selected tasks')
  }
  if (mode === 'full_revision' && (proposal.status === 'proposed' || proposal.evidence_refs.some(ref => !reviewedRefs.has(canonicalJson(ref))))) {
    if (evidence?.sha256 !== snapshot.evidence_sha256) fail('full revision evidence snapshot mismatch')
    const { missing } = collectEvidence({ evidence, sourceTexts, tasks: [...tasks, { evidence_refs: proposal.evidence_refs }], all: true })
    if (missing.length) fail('full revision evidence source text/transcript missing')
  }
  if (proposal.status !== 'proposed') {
    if (proposal.edits.length || proposal.acceptance_checks.length || !nonempty(proposal.escalation_reason)) fail('business status requires reason and no edits/acceptance claims')
    return { status: proposal.status, reportBytes: Buffer.from(report.bytes), applications: [], reason: proposal.escalation_reason }
  }
  const suppliedRefs = new Set(proposal.evidence_refs.map(ref => canonicalJson(ref)))
  if (![...reviewedRefs.keys()].every(ref => suppliedRefs.has(ref))) fail('proposal evidence ref coverage incomplete')
  const checks = new Set()
  for (const check of proposal.acceptance_checks) {
    const task = tasks.find(t => t.id === check.task_id)
    if (!task || check.criterion_index < 0 || check.criterion_index >= task.acceptance_criteria.length || !nonempty(check.response)) fail('invalid acceptance criterion response')
    const key = `${check.task_id}:${check.criterion_index}`
    if (checks.has(key)) fail('duplicate acceptance criterion response')
    checks.add(key)
  }
  if (checks.size !== tasks.reduce((n, t) => n + t.acceptance_criteria.length, 0)) fail('acceptance coverage incomplete')
  if (!proposal.edits.length) fail('proposed edit coverage is empty')
  const editedTasks = new Set()
  const edits = proposal.edits.map(edit => {
    if (!allowedSections.includes(edit.section)) fail('edit section outside allowed scope')
    unique(edit.task_ids, 'edit task IDs')
    for (const id of edit.task_ids) {
      if (!taskIds.includes(id)) fail('unknown edit task ID')
      editedTasks.add(id)
    }
    if (!nonempty(edit.before) || !nonempty(edit.rationale)) fail('edit before/rationale must be nonempty')
    if (edit.before === edit.after) fail('edit does not change report bytes')
    if (edit.section === 0 && report.sections[0].start === 0) {
      const heading = report.sections[0].heading
      if (edit.before !== heading || occurrences(report.text, heading).length !== 1) fail('preface boundary anchor must uniquely equal the complete first heading')
      if (!edit.after.endsWith(heading) || edit.after.length <= heading.length) fail('preface boundary edit must preserve original heading suffix')
      return { ...edit, start:0, end:heading.length, boundaryInsertion:edit.after.slice(0,-heading.length) }
    }
    const section = edit.section === 0 ? {start:0, text:report.text.slice(0, report.sections[0].start)} : report.sections[edit.section - 1]
    const hits = occurrences(section.text, edit.before)
    if (hits.length !== 1) fail('before anchor must uniquely match the specified section')
    const start = section.start + hits[0]
    return { ...edit, start, end: start + edit.before.length }
  }).sort((a, b) => a.start - b.start)
  if (editedTasks.size !== taskIds.length) fail('edit task coverage incomplete')
  for (let i = 1; i < edits.length; i++) if (edits[i].start < edits[i - 1].end) fail('overlapping edit anchors')
  let text = report.text
  for (const edit of edits.toReversed()) text = text.slice(0, edit.start) + edit.after + text.slice(edit.end)
  const updatedSections = parseReportSections(text)
  let expectedPreface = report.text.slice(0, report.sections[0].start)
  for (const edit of edits.filter(e => e.section === 0).toReversed()) expectedPreface = edit.boundaryInsertion ?? (expectedPreface.slice(0,edit.start) + edit.after + expectedPreface.slice(edit.end))
  if (text.slice(0,updatedSections[0].start) !== expectedPreface) fail('patch changed a preface boundary')
  for (const section of report.sections) {
    let expected = section.text
    for (const edit of edits.filter(e => e.section === section.section).toReversed()) expected = expected.slice(0, edit.start - section.start) + edit.after + expected.slice(edit.end - section.start)
    if (updatedSections[section.section - 1].text !== expected) fail('patch changed a section boundary')
  }
  const bytes = Buffer.from(text)
  if (bytes.toString('utf8') !== text) fail('patch result is not valid UTF-8 encoded text')
  return {
    status: 'applied', reportBytes: bytes,
    applications: edits.map(edit => ({
      section: edit.section, task_ids: [...edit.task_ids],
      start_byte: Buffer.byteLength(report.text.slice(0, edit.start), 'utf8'),
      end_byte: Buffer.byteLength(report.text.slice(0, edit.end), 'utf8'),
      before_sha256: sha256(edit.before), after_sha256: sha256(edit.after),
    })),
  }
}
