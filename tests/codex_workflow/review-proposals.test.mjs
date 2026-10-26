import test from 'node:test'
import assert from 'node:assert/strict'
import { canonicalJson, sha256 } from '../../tools/codex_workflow/review-contracts.mjs'
import { createLedger } from '../../tools/codex_workflow/review-ledger.mjs'
import { parseReportSections } from '../../tools/codex_workflow/review-sections.mjs'
import { buildTaskContext, buildFullRevisionContext, applyProposal, bindProposalEvidence } from '../../tools/codex_workflow/review-proposals.mjs'

function fixture({ eol = '\n', sourceText = '全表单位：万元；期间：2025年度。\n\n余额 -12；不确定；未披露；口径限制：未经审计。\n\n后续调整可能改变本表。', extra = '' } = {}) {
  const reportBytes = Buffer.from('约束：只使用当前底稿。' + eol + Array.from({ length: 12 }, (_, i) => `## ${i + 1}、章节${i + 1}${eol}${i === 2 ? '原文待补充。' + extra : i === 10 ? '判断边界：现金流不足时限制结论。' : '相邻段落。'}${eol}${eol}`).join(''))
  const source = { path: '核查/核查.md', type: 'text', sha256: sha256(sourceText) }
  const sources = [source]
  const evidence = { version: 2, sources, sha256: sha256(canonicalJson({ version: 2, sources })) }
  const snapshot = { report_sha256: sha256(reportBytes), evidence_sha256: evidence.sha256 }
  const ref = { source: source.path, source_sha256: source.sha256, evidence_sha256: evidence.sha256, quote: '余额 -12；不确定；未披露' }
  const task = { id: 'RT-000001', issue_key: 'missing', kind: 'disclosure', blocks_delivery: true, status: 'open', description: '补充余额限制的披露', locations: [{ section: 3, quote: '原文待补充。' }], evidence_refs: [ref], acceptance_criteria: ['保留期间和单位', '注明未知和限制'], route: 'local_patch', judgment_constraints: [{ section: 11, quote: '判断边界：现金流不足时限制结论。' }], ...snapshot, created_review_id: 'RV-000001', last_review_id: 'RV-000001', history: [] }
  const ledger = createLedger()
  ledger.tasks = [task]
  ledger.next_task_number = 2
  const sourceTexts = { [source.path]: sourceText }
  const proposal = { task_ids: [task.id], base_report_sha256: snapshot.report_sha256, status: 'proposed', edits: [{ section: 3, before: '原文待补充。', after: '余额为 -12 万元，2025年度，未经审计且存在不确定性。', rationale: '披露原文限制', task_ids: [task.id] }], evidence_refs: [ref], acceptance_checks: task.acceptance_criteria.map((_, criterion_index) => ({ task_id: task.id, criterion_index, response: '已在提案保留该限制，待独立复核' })), escalation_reason: '' }
  return { reportBytes, task, ledger, evidence, sourceTexts, snapshot, proposal, taskIds: [task.id], allowedSections: [3] }
}
function sameInputs(f, action, expected) {
  const original = Buffer.from(f.reportBytes)
  const ledger = canonicalJson(f.ledger)
  assert.throws(action, expected)
  assert.deepEqual(f.reportBytes, original)
  assert.equal(canonicalJson(f.ledger), ledger)
}

test('host retains required evidence when the reviser cites an expanded paragraph', () => {
  const f = fixture()
  f.proposal.evidence_refs = [{ ...f.task.evidence_refs[0], quote: f.sourceTexts['核查/核查.md'] }]
  const original = structuredClone(f.proposal)
  const bound = bindProposalEvidence({ proposal: f.proposal, tasks: [f.task] })
  assert.deepEqual(f.proposal, original)
  assert.deepEqual(bound.added_refs, f.task.evidence_refs)
  assert.equal(bound.proposal.evidence_refs.length, 2)
  const result = applyProposal({ ...f, proposal: bound.proposal, mode: 'full_revision' })
  assert.equal(result.status, 'applied')
})

test('host evidence binding does not sanitize a forged or nonexistent extra reference', () => {
  const f = fixture()
  f.proposal.evidence_refs = [{ ...f.task.evidence_refs[0], quote: '不存在的引用' }]
  const bound = bindProposalEvidence({ proposal: f.proposal, tasks: [f.task] })
  assert.throws(() => applyProposal({ ...f, proposal: bound.proposal, mode: 'full_revision' }), /quote not found/)
})

test('local context includes exact target, adjacent paragraphs, judgment constraints and whole cited source', () => {
  const f = fixture({ eol: '\r\n' })
  const result = buildTaskContext(f)
  assert.equal(result.route, 'local_patch')
  assert.deepEqual(result.context.allowed_sections, [3])
  assert.equal(result.context.sections[0].text, parseReportSections(f.reportBytes.toString())[2].text)
  assert.equal(result.context.evidence[0].text, f.sourceTexts['核查/核查.md'])
  assert.equal(result.context.evidence[0].path, '核查/核查.md')
  assert.equal(result.context.evidence[0].sha256, f.task.evidence_refs[0].source_sha256)
  assert.ok(result.context.constraints.some(x => x.text.includes('判断边界')))
  assert.ok(result.context.neighbors.some(x => x.section === 2))
  assert.deepEqual(result.context.tasks[0].acceptance_criteria, f.task.acceptance_criteria)
  assert.equal(result.context_bytes, Buffer.byteLength(JSON.stringify(result.context), 'utf8'))
  assert.ok(result.context_bytes <= 32768)
  assert.equal(f.task.status, 'open')
})

test('UTF8 32768 boundary is inclusive and overflow escalates without truncation', () => {
  const f = fixture()
  const base = buildTaskContext(f)
  const padding = 32768 - base.context_bytes
  f.task.description += 'a'.repeat(padding)
  const atLimit = buildTaskContext(f)
  assert.equal(atLimit.route, 'local_patch')
  assert.equal(atLimit.context_bytes, 32768)
  f.task.description += '中'
  const overflow = buildTaskContext(f)
  assert.equal(overflow.route, 'full_revision')
  assert.equal(overflow.context_bytes, 32771)
  assert.ok(overflow.context.tasks[0].description.endsWith('中'))
})

test('oversized Chinese source stays complete when routed to full revision', () => {
  const f = fixture({ sourceText: '单位：元\n\n' + '中'.repeat(12000) + '\n\n余额 -12；不确定；未披露' })
  const result = buildTaskContext(f)
  assert.equal(result.route, 'full_revision')
  assert.equal(result.context.evidence[0].text, f.sourceTexts['核查/核查.md'])
  assert.ok(result.context_bytes > 32768)
})

test('eleven, twelve, three chapters, broad scope, conflicts and major judgments require full revision', () => {
  for (const locations of [[{ section: 11 }], [{ section: 12 }], [{ section: 3 }, { section: 4 }, { section: 5 }], []]) {
    const f = fixture(); f.task.locations = locations
    assert.equal(buildTaskContext(f).route, 'full_revision')
  }
  for (const description of ['调整承重假设', '更换主要估值锚', '修改概率和市值区间', '证据冲突', '范围不明确', '重新评估核心判断', '全文联动', 'revise valuation assumptions', 'conflicting evidence']) {
    const f = fixture(); f.task.description = description
    assert.equal(buildTaskContext(f).route, 'full_revision', description)
  }
  const f = fixture(); f.task.route = 'full_revision'
  assert.equal(buildTaskContext(f).route, 'full_revision')
})

test('two explicitly scoped chapters can remain local; stale location cannot silently shrink context', () => {
  const f = fixture(); f.task.locations.push({ section: 4, quote: '相邻段落。' })
  assert.equal(buildTaskContext(f).route, 'local_patch')
  f.task.locations[1].quote = '报告里没有的原句'
  assert.equal(buildTaskContext(f).route, 'full_revision')
})

test('missing evidence returns business needs_evidence; stale bindings and changed text reject', () => {
  const f = fixture(); delete f.sourceTexts['核查/核查.md']
  assert.equal(buildTaskContext(f).route, 'needs_evidence')
  const declared = fixture(); declared.task.route = 'needs_evidence'
  assert.equal(buildTaskContext(declared).route, 'needs_evidence')
  for (const mutate of [
    f => { f.task.evidence_sha256 = 'f'.repeat(64) },
    f => { f.task.evidence_refs[0].evidence_sha256 = 'e'.repeat(64) },
    f => { f.sourceTexts['核查/核查.md'] += '人工更改' },
    f => { f.evidence.sha256 = 'd'.repeat(64) },
    f => { f.task.evidence_refs[0].quote = '来源里没有的事实' },
  ]) {
    const bad = fixture(); mutate(bad)
    sameInputs(bad, () => buildTaskContext(bad), /evidence|source|quote|snapshot/i)
  }
})

test('binary candidate keeps transcript provenance without inventing visual authorization', () => {
  const f = fixture()
  const source = f.evidence.sources[0]
  source.type = 'image'; source.sha256 = sha256('binary image')
  source.transcript = { path: '.codex-workflow/review/transcripts/T.json', sha256: sha256('candidate JSON bytes') }
  f.evidence.sha256 = sha256(canonicalJson({ version: 2, sources: f.evidence.sources }))
  f.task.evidence_sha256 = f.evidence.sha256
  Object.assign(f.task.evidence_refs[0], { source_sha256: source.sha256, evidence_sha256: f.evidence.sha256, transcript_path: source.transcript.path, transcript_sha256: source.transcript.sha256 })
  const result = buildTaskContext(f)
  assert.equal(result.route, 'local_patch')
  assert.deepEqual(result.context.evidence[0].transcript, source.transcript)
  assert.equal(result.context.evidence[0].text_kind, 'candidate_transcript')
  assert.equal('visual_attestations' in result.context, false)
  f.task.evidence_refs[0].transcript_sha256 = 'a'.repeat(64)
  assert.throws(() => buildTaskContext(f), /transcript/i)
})

test('full revision includes exact entire report, every source and all tasks without local limits', () => {
  const f = fixture({ sourceText: '余额 -12；不确定；未披露\n' + '大'.repeat(15000) })
  const extra = { path: '疑惑.md', type: 'text', sha256: sha256('限制：未知，不得推定。') }
  f.evidence.sources.push(extra)
  f.sourceTexts[extra.path] = '限制：未知，不得推定。'
  f.evidence.sha256 = sha256(canonicalJson({ version: 2, sources: f.evidence.sources }))
  f.task.evidence_sha256 = f.evidence.sha256; f.task.evidence_refs[0].evidence_sha256 = f.evidence.sha256
  const result = buildFullRevisionContext({ ...f, tasks: [f.task] })
  assert.equal(result.report_text, f.reportBytes.toString())
  assert.deepEqual(result.allowed_sections, Array.from({ length: 13 }, (_, i) => i))
  assert.equal(result.evidence.length, 2)
  assert.ok(Buffer.byteLength(JSON.stringify(result)) > 32768)
  assert.equal(result.tasks[0].id, f.task.id)
  delete f.sourceTexts[extra.path]
  assert.equal(buildFullRevisionContext({ ...f, tasks: [f.task] }).route, 'needs_evidence')
})

test('normal CRLF patch changes only intended bytes, keeps ledger open and returns application facts', () => {
  const f = fixture({ eol: '\r\n' })
  const before = Buffer.from(f.reportBytes)
  const ledger = canonicalJson(f.ledger)
  const result = applyProposal(f)
  assert.equal(result.reportBytes.toString(), before.toString().replace('原文待补充。', f.proposal.edits[0].after))
  assert.deepEqual(f.reportBytes, before)
  assert.equal(canonicalJson(f.ledger), ledger)
  assert.equal(result.status, 'applied')
  assert.equal(result.applications.length, 1)
  assert.equal(result.applications[0].section, 3)
  assert.equal(result.applications[0].before_sha256, sha256('原文待补充。'))
})

test('fenced fake chapter and a repeated quote in another chapter do not change scoped anchors', () => {
  const f = fixture({ eol: '\r\n', extra: '\r\n```md\r\n## 4、假标题\r\n```\r\n' })
  f.reportBytes = Buffer.from(f.reportBytes.toString().replace('## 4、章节4\r\n相邻段落。', '## 4、章节4\r\n原文待补充。'))
  f.snapshot.report_sha256 = sha256(f.reportBytes); f.proposal.base_report_sha256 = f.snapshot.report_sha256
  const result = applyProposal(f)
  const sections = parseReportSections(result.reportBytes.toString())
  assert.ok(sections[2].text.includes(f.proposal.edits[0].after))
  assert.ok(sections[3].text.includes('原文待补充。'))
  const wrong = fixture(); wrong.proposal.edits[0].before = '相邻段落。'
  sameInputs(wrong, () => applyProposal(wrong), /anchor|unique/i)
})

test('empty, duplicate, overlapping and out-of-scope anchors reject atomically', () => {
  for (const mutate of [
    f => { f.proposal.edits[0].before = '' },
    f => { f.reportBytes = Buffer.from(f.reportBytes.toString().replace('原文待补充。', '原文待补充。原文待补充。')); f.snapshot.report_sha256 = sha256(f.reportBytes); f.proposal.base_report_sha256 = f.snapshot.report_sha256 },
    f => { f.proposal.edits.push({ ...f.proposal.edits[0], before: '待补充' }) },
    f => { f.proposal.edits[0].section = 4; f.proposal.edits[0].before = '相邻段落。' },
    f => { f.proposal.edits[0].before += '\n\n## 4、章节4' },
  ]) {
    const f = fixture(); mutate(f)
    sameInputs(f, () => applyProposal(f), /before|anchor|unique|overlap|scope|section/i)
  }
})

test('stale report/evidence, foreign source/ref, unknown IDs and closed tasks reject', () => {
  for (const mutate of [
    f => { f.proposal.base_report_sha256 = 'a'.repeat(64) },
    f => { f.snapshot.report_sha256 = 'a'.repeat(64) },
    f => { f.snapshot.evidence_sha256 = 'a'.repeat(64) },
    f => { f.proposal.evidence_refs[0].source_sha256 = 'a'.repeat(64) },
    f => { f.proposal.evidence_refs[0] = { ...f.proposal.evidence_refs[0], source: '不存在.md' } },
    f => { f.proposal.task_ids = ['RT-999999'] },
    f => { f.taskIds = ['RT-999999']; f.proposal.task_ids = ['RT-999999'] },
    f => { f.proposal.edits[0].task_ids = ['RT-999999'] },
    f => { f.task.status = 'resolved' },
    f => { f.task.status = 'awaiting_review' },
  ]) {
    const f = fixture(); f.proposal.evidence_refs = structuredClone(f.proposal.evidence_refs); mutate(f)
    sameInputs(f, () => applyProposal(f), /snapshot|report|evidence|source|ref|task|open/i)
  }
})

test('every criterion, selected task, edit linkage and reviewed ref requires complete unique coverage', () => {
  for (const mutate of [
    f => { f.proposal.acceptance_checks.pop() },
    f => { f.proposal.acceptance_checks.push({ ...f.proposal.acceptance_checks[0] }) },
    f => { f.proposal.acceptance_checks[0].criterion_index = -1 },
    f => { f.proposal.acceptance_checks[0].response = '  ' },
    f => { f.proposal.evidence_refs = [] },
    f => { f.proposal.task_ids.push(f.task.id) },
    f => { f.proposal.edits = [] },
    f => { f.proposal.edits[0].task_ids = [] },
    f => { f.proposal.status = 'resolved' },
    f => { f.proposal.closed_tasks = [f.task.id] },
  ]) {
    const f = fixture(); mutate(f)
    sameInputs(f, () => applyProposal(f), /acceptance|criterion|coverage|ref|task|edit|schema/i)
  }
})

test('valid business results do not throw, apply edits or need fabricated acceptance responses', () => {
  for (const status of ['needs_evidence', 'escalate']) {
    const f = fixture(); Object.assign(f.proposal, { status, edits: [], acceptance_checks: [], evidence_refs: [], escalation_reason: '需要新的原始证据或统一判断' })
    const result = applyProposal(f)
    assert.equal(result.status, status)
    assert.deepEqual(result.reportBytes, f.reportBytes)
    assert.deepEqual(result.applications, [])
    f.proposal.edits = [{ ...fixture().proposal.edits[0] }]
    assert.throws(() => applyProposal(f), /business|edit|status/i)
  }
})

test('full proposal may cover all chapters but cannot remove or reorder twelve chapter headings', () => {
  const f = fixture(); f.allowedSections = Array.from({ length: 12 }, (_, i) => i + 1)
  f.proposal.edits[0] = { ...f.proposal.edits[0], section: 11, before: '判断边界：现金流不足时限制结论。', after: '判断边界：保留未知。' }
  assert.equal(applyProposal(f).status, 'applied')
  f.proposal.edits[0].before = '## 11、章节11'
  f.proposal.edits[0].after = '## 12、章节12'
  sameInputs(f, () => applyProposal(f), /section|十二节/i)
})

test('chapter boundary must remain the edit chapter even when global section order stays valid', () => {
  const f = fixture()
  f.proposal.edits[0].before = '## 3、章节3'
  f.proposal.edits[0].after = '越界新增到第二节的正文。\n## 3、章节3'
  sameInputs(f, () => applyProposal(f), /boundary/i)
})

test('sequential tasks can use current snapshot despite historical creation report hash', () => {
  const f = fixture(); f.task.report_sha256 = sha256('older accepted review report')
  assert.equal(applyProposal(f).status, 'applied')
  assert.equal(buildTaskContext(f).route, 'local_patch')
})

test('malformed UTF8 is rejected before any byte-changing decode', () => {
  const f = fixture(); f.reportBytes = Buffer.concat([f.reportBytes, Buffer.from([0xff])]); f.snapshot.report_sha256 = sha256(f.reportBytes); f.proposal.base_report_sha256 = f.snapshot.report_sha256
  sameInputs(f, () => applyProposal(f), /utf|encoded/i)
})


test('large unrelated report chapters stay out of explicitly constrained local package', () => {
  const f = fixture()
  f.reportBytes = Buffer.from(f.reportBytes.toString().replace('## 8、章节8\n相邻段落。', '## 8、章节8\n' + '无关背景'.repeat(30000)))
  const result = buildTaskContext(f)
  assert.equal(result.route, 'local_patch')
  assert.ok(result.context_bytes < 32768)
  assert.ok(!JSON.stringify(result.context).includes('无关背景'))
  assert.equal(result.context.constraints[0].text, '判断边界：现金流不足时限制结论。\n\n')
})

test('missing or ambiguous reviewed judgment constraints escalate; explicit empty list is usable', () => {
  const f = fixture()
  delete f.task.judgment_constraints
  assert.equal(buildTaskContext(f).route, 'full_revision')
  f.task.judgment_constraints = []
  assert.equal(buildTaskContext(f).route, 'local_patch')
  f.task.judgment_constraints = [{ section: 11, quote: '不存在的约束' }]
  assert.equal(buildTaskContext(f).route, 'full_revision')
  f.task.judgment_constraints = [{ section: 3, quote: '原文待补充。' }]
  f.reportBytes = Buffer.from(f.reportBytes.toString().replace('原文待补充。', '原文待补充。原文待补充。'))
  assert.equal(buildTaskContext(f).route, 'full_revision')
})

test('explicit full mode can cite additional current in-context sources; local/foreign/stale refs reject', () => {
  const setup = () => {
    const f = fixture()
    const text = '2025年度；单位：万元。另一底稿限制：尚未核实。'
    const source = { path: 'findings/尽调.md', type: 'text', sha256: sha256(text) }
    f.evidence.sources.push(source); f.sourceTexts[source.path] = text
    f.evidence.sha256 = sha256(canonicalJson({ version: 2, sources: f.evidence.sources }))
    f.task.evidence_sha256 = f.evidence.sha256; f.snapshot.evidence_sha256 = f.evidence.sha256
    f.task.evidence_refs[0].evidence_sha256 = f.evidence.sha256
    f.proposal.evidence_refs = structuredClone(f.task.evidence_refs)
    f.proposal.evidence_refs.push({ source: source.path, source_sha256: source.sha256, evidence_sha256: f.evidence.sha256, quote: '另一底稿限制：尚未核实。' })
    return f
  }
  const full = setup()
  assert.equal(applyProposal({ ...full, mode: 'full_revision' }).status, 'applied')
  const local = setup(); sameInputs(local, () => applyProposal(local), /ref|reviewed/i)
  const missing = setup(); delete missing.sourceTexts['findings/尽调.md']
  sameInputs(missing, () => applyProposal({ ...missing, mode: 'full_revision' }), /evidence|source/i)
  for (const mutate of [
    f => { f.proposal.evidence_refs[1].source = '新增研究.md' },
    f => { f.proposal.evidence_refs[1].source_sha256 = 'a'.repeat(64) },
    f => { f.proposal.evidence_refs[1].evidence_sha256 = 'a'.repeat(64) },
    f => { f.proposal.evidence_refs[1].quote = '不存在的事实' },
    f => { f.evidence.sha256 = 'a'.repeat(64) },
  ]) {
    const f = setup(); mutate(f)
    sameInputs(f, () => applyProposal({ ...f, mode: 'full_revision' }), /evidence|source|ref|snapshot|quote/i)
  }
})

test('multiple exact edits and multiple task coverage apply against original offsets', () => {
  const f = fixture()
  const second = { ...structuredClone(f.task), id: 'RT-000002', issue_key: 'second', locations: [{ section: 4 }], acceptance_criteria: ['标记当前限制'] }
  f.ledger.tasks.push(second); f.ledger.next_task_number = 3
  f.taskIds.push(second.id); f.proposal.task_ids.push(second.id); f.allowedSections.push(4)
  f.proposal.acceptance_checks.push({ task_id: second.id, criterion_index: 0, response: '已标记，待独立审查' })
  f.proposal.edits.push({ section: 4, before: '相邻段落。', after: '当前限制：尚未披露。', rationale: '原文披露', task_ids: [second.id] })
  const original = f.reportBytes.toString()
  const result = applyProposal(f)
  assert.equal(result.reportBytes.toString(), original.replace('原文待补充。', f.proposal.edits[0].after).replace('## 4、章节4\n相邻段落。', '## 4、章节4\n当前限制：尚未披露。'))
  assert.equal(result.applications.length, 2)
  assert.equal(result.applications[0].start_byte, Buffer.byteLength(original.slice(0, original.indexOf('原文待补充。'))))
  assert.deepEqual(f.ledger.tasks.map(t => t.status), ['open', 'open'])
})

test('full context honors a declared missing-evidence route and full application returns legal business outcomes', () => {
  const f = fixture(); f.task.route = 'needs_evidence'
  assert.equal(buildFullRevisionContext({ ...f, tasks: [f.task] }).route, 'needs_evidence')
  for (const status of ['needs_evidence', 'escalate']) {
    const f = fixture()
    Object.assign(f.proposal, { status, edits: [], acceptance_checks: [], evidence_refs: [], escalation_reason: '需要更多证据，保留当前稿。' })
    assert.equal(applyProposal({ ...f, mode: 'full_revision', evidence: undefined, sourceTexts: undefined }).status, status)
  }
})

for (const eol of ['\n','\r\n']) test('full revision repairs exact nonempty preface; local proposals and chapter boundary changes reject '+JSON.stringify(eol), () => {
  const f = fixture({eol})
  f.proposal.edits[0] = {...f.proposal.edits[0], section:0, before:'约束：只使用当前底稿。', after:'约束：参照系未知，判断有限。'}
  const context = buildFullRevisionContext({...f,tasks:[f.task]})
  assert.ok(context.allowed_sections.includes(0))
  const applied = applyProposal({...f, mode:'full_revision', allowedSections:context.allowed_sections})
  assert.ok(applied.reportBytes.toString().startsWith('约束：参照系未知，判断有限。'+eol))
  assert.deepEqual(parseReportSections(applied.reportBytes.toString()).map(s=>s.text),parseReportSections(f.reportBytes.toString()).map(s=>s.text))
  assert.throws(()=>applyProposal({...f,allowedSections:[0]}),/scope|allowed/)
  f.proposal.edits[0].after = '## 1、伪造边界'+eol
  assert.throws(()=>applyProposal({...f,mode:'full_revision',allowedSections:context.allowed_sections}),/headings|boundary/)
})

for(const eol of ['\n','\r\n'])test('empty preface full-only boundary anchor inserts opening without changing chapter bytes '+JSON.stringify(eol),()=>{
 const f=fixture({eol})
 f.reportBytes=Buffer.from(f.reportBytes.toString().slice(f.reportBytes.toString().indexOf('## 1')))
 f.snapshot.report_sha256=sha256(f.reportBytes);f.task.report_sha256=f.snapshot.report_sha256;f.proposal.base_report_sha256=f.snapshot.report_sha256
 const heading='## 1、章节1',opening='## 〇、开篇结论'+eol+'参照系有限。'+eol+eol
 f.proposal.edits[0]={...f.proposal.edits[0],section:0,before:heading,after:opening+heading}
 const context=buildFullRevisionContext({...f,tasks:[f.task]})
 const applied=applyProposal({...f,mode:'full_revision',allowedSections:context.allowed_sections})
 assert.equal(applied.reportBytes.toString(),opening+f.reportBytes.toString())
 assert.throws(()=>applyProposal({...f,allowedSections:[0]}),/scope|allowed/)
 f.proposal.edits[0].after=opening+'## 1、改变标题'
 assert.throws(()=>applyProposal({...f,mode:'full_revision',allowedSections:context.allowed_sections}),/boundary|suffix/)
 f.proposal.edits[0].after=opening+heading
 const original=f.reportBytes
 f.reportBytes=Buffer.from(original.toString()+eol+'重复原文 '+heading);f.snapshot.report_sha256=sha256(f.reportBytes);f.proposal.base_report_sha256=f.snapshot.report_sha256
 assert.throws(()=>applyProposal({...f,mode:'full_revision',allowedSections:context.allowed_sections}),/uniquely/)
 f.reportBytes=original
 f.reportBytes=Buffer.from('nonempty prefix'+eol+f.reportBytes.toString());f.snapshot.report_sha256=sha256(f.reportBytes);f.proposal.base_report_sha256=f.snapshot.report_sha256
 assert.throws(()=>applyProposal({...f,mode:'full_revision',allowedSections:context.allowed_sections}),/anchor/)
})
