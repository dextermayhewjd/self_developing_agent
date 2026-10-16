import test from 'node:test'
import assert from 'node:assert/strict'
import Ajv from 'ajv'
import { REVIEW_SCHEMA, PROPOSAL_SCHEMA, TRANSCRIPT_SCHEMA, canonicalJson, sha256 } from '../../tools/codex_workflow/review-contracts.mjs'
import { createLedger, reconcileReview, markAwaitingReview, unresolvedBlockers } from '../../tools/codex_workflow/review-ledger.mjs'
import { decodeResult, transportSchema } from '../../tools/codex_workflow/schema.mjs'
import { issueFixtureV2, reviewFixtureV2, snapshotFixtureV2 as snapshot } from './fixtures/review-fixture.mjs'

function withOptionalNulls(schema, value) {
  if (schema.type === 'array') return value.map(item => withOptionalNulls(schema.items, item))
  if (schema.type !== 'object') return value
  return Object.fromEntries(Object.entries(schema.properties).map(([key, child]) => [key, key in value ? withOptionalNulls(child, value[key]) : null]))
}

function reviewFor(ledger, overrides = {}) {
  return reviewFixtureV2({ ledgerSha256: sha256(canonicalJson(ledger)), ...overrides })
}
function firstIssue(issue = issueFixtureV2()) {
  const ledger = createLedger({ maxRounds: 5 })
  const review = reviewFor(ledger, { verdict: issue.blocks_delivery ? 'revise' : 'pass', new_issues: [issue] })
  review.sections[2].issue_keys = [issue.issue_key]
  return reconcileReview({ ledger, review, snapshot }).ledger
}
function disposition(overrides = {}) {
  return { task_id: 'RT-000001', status: 'open', reason: '限制仍未说明', kind: 'blocking', blocks_delivery: true, ...overrides }
}
function next(ledger, overrides = {}) {
  // Simulate the store's separately committed reservation before subsequent review.
  ledger.budget.used_rounds = Math.max(ledger.budget.used_rounds, ledger.budget.valid_reviews)
  return reviewFor(ledger, { reviewId: `RV-${String(ledger.budget.valid_reviews + 1).padStart(6, '0')}`, verdict: 'revise', task_dispositions: [disposition()], ...overrides })
}

// These assertions catch ID regeneration, writer-authorized closure and history loss.
test('allocates stable monotonic host IDs and preserves identity through changed wording', () => {
  const ledger = firstIssue()
  assert.equal(ledger.tasks[0].id, 'RT-000001')
  const review = next(ledger)
  review.sections[2].evidence = '换一种说法：未说明回款的不确定性'
  review.new_issues = [issueFixtureV2({ issue_key: 'inventory', description: '存货口径遗漏' })]
  review.sections[2].issue_keys = ['inventory']
  const result = reconcileReview({ ledger, review, snapshot })
  assert.deepEqual(result.ledger.tasks.map(t => t.id), ['RT-000001', 'RT-000002'])
  assert.equal(result.ledger.next_task_number, 3)
  assert.equal(result.receipt.input_ledger_sha256, sha256(canonicalJson(ledger)))
  assert.equal(result.receipt.output_ledger_sha256, sha256(canonicalJson(result.ledger)))
})

test('only independent review closes a task and recurrence reopens with appended history', () => {
  const ledger = firstIssue()
  const original = structuredClone(ledger)
  const awaiting = markAwaitingReview({ ledger, taskIds: ['RT-000001'], snapshot, attemptId: 'A-0001' })
  assert.equal(awaiting.tasks[0].status, 'awaiting_review')
  assert.deepEqual(ledger, original)
  const review = next(awaiting, { verdict: 'pass', task_dispositions: [disposition({ status: 'resolved', reason: '已准确披露限制' })] })
  const closed = reconcileReview({ ledger: awaiting, review, snapshot }).ledger
  assert.equal(closed.tasks[0].status, 'resolved')
  assert.equal(unresolvedBlockers(closed).length, 0)
  const reopened = reconcileReview({ ledger: closed, review: next(closed), snapshot }).ledger
  assert.equal(reopened.tasks[0].status, 'open')
  assert.deepEqual(reopened.tasks[0].history.slice(0, closed.tasks[0].history.length), closed.tasks[0].history)
  assert.equal(reopened.tasks[0].history.at(-1).event, 'reopened')
})

test('initializes persistent budget and watch tasks do not block', () => {
  assert.equal(createLedger({ maxRounds: 2 }).budget.max_rounds, 2)
  assert.equal(createLedger().budget.used_rounds, 0)
  for (const maxRounds of [0, -1, 11, 1.5, '2']) assert.throws(() => createLedger({ maxRounds }), /maxRounds/)
  const ledger = firstIssue(issueFixtureV2({ kind: 'watch', blocks_delivery: false }))
  assert.equal(ledger.tasks[0].status, 'open')
  assert.equal(unresolvedBlockers(ledger).length, 0)
  assert.equal(ledger.budget.valid_reviews, 1)
})

test('requires unique complete dispositions, including closed tasks', () => {
  const ledger = firstIssue()
  const missing = next(ledger, { task_dispositions: [] })
  assert.throws(() => reconcileReview({ ledger, review: missing, snapshot }), /missing.*RT-000001/)
  const duplicate = next(ledger, { task_dispositions: [disposition(), disposition()] })
  assert.throws(() => reconcileReview({ ledger, review: duplicate, snapshot }), /duplicate/)
  const unknown = next(ledger, { task_dispositions: [disposition({ task_id: 'RT-999999' })] })
  assert.throws(() => reconcileReview({ ledger, review: unknown, snapshot }), /unknown/)
  const closed = reconcileReview({ ledger, review: next(ledger, { verdict: 'pass', task_dispositions: [disposition({ status: 'resolved', reason: '已补充' })] }), snapshot }).ledger
  assert.throws(() => reconcileReview({ ledger: closed, review: next(closed, { task_dispositions: [] }), snapshot }), /missing.*RT-000001/)
})

test('requires recorded reason for any category or delivery-block change', () => {
  const ledger = firstIssue()
  const review = next(ledger, { verdict: 'pass', task_dispositions: [disposition({ kind: 'watch', blocks_delivery: false, reason: ' ' })] })
  assert.throws(() => reconcileReview({ ledger, review, snapshot }), /reason/)
  review.task_dispositions[0].reason = '仅跟踪长期观察指标，与当前交付判断无关'
  const result = reconcileReview({ ledger, review, snapshot }).ledger
  assert.equal(result.tasks[0].kind, 'watch')
  assert.equal(result.tasks[0].history.at(-1).reason, review.task_dispositions[0].reason)
})

test('disclosure can close by accurately explaining unknown facts', () => {
  const ledger = firstIssue(issueFixtureV2({ kind: 'disclosure' }))
  const review = next(ledger, { verdict: 'pass', task_dispositions: [disposition({ kind: 'disclosure', status: 'resolved', blocks_delivery: false, reason: '报告明确回款数据尚未知，判断仅在披露范围成立' })] })
  const result = reconcileReview({ ledger, review, snapshot }).ledger
  assert.equal(result.tasks[0].status, 'resolved')
  assert.equal(unresolvedBlockers(result).length, 0)
})

test('deduplicates issue_key across sections but rejects conflicting definitions', () => {
  const ledger = createLedger()
  const issue = issueFixtureV2()
  const review = reviewFor(ledger, { verdict: 'revise', new_issues: [issue, { ...issue, locations: [{ section: 4 }] }] })
  review.sections[2].issue_keys = [issue.issue_key]
  const result = reconcileReview({ ledger, review, snapshot }).ledger
  assert.equal(result.tasks.length, 1)
  assert.deepEqual(result.tasks[0].locations, [{ section: 3 }, { section: 4 }])
  review.new_issues[1].description = '另一个问题'
  assert.throws(() => reconcileReview({ ledger, review, snapshot }), /conflicting/)
  const old = next(result, { new_issues: [issue] })
  assert.throws(() => reconcileReview({ ledger: result, review: old, snapshot }), /existing.*issue_key/)
})

test('rejects stale report, evidence and input-ledger bindings without mutation', () => {
  const ledger = createLedger()
  for (const key of ['report_sha256', 'evidence_sha256', 'input_ledger_sha256']) {
    const review = reviewFor(ledger, { [key]: 'd'.repeat(64) })
    assert.throws(() => reconcileReview({ ledger, review, snapshot }), new RegExp(key))
  }
  const review = reviewFor(ledger)
  const original = structuredClone({ ledger, review, snapshot })
  reconcileReview({ ledger, review, snapshot })
  assert.deepEqual({ ledger, review, snapshot }, original)
  assert.throws(() => markAwaitingReview({ ledger, taskIds: ['RT-000001'], snapshot, attemptId: 'A-0001' }), /unknown/)
})

test('rejects malformed sections, coverage, verdicts, issue linkage and kind flags', () => {
  const ledger = createLedger()
  const cases = [
    r => { r.sections[11].section = 1 },
    r => { r.coverage[4].lens = r.coverage[0].lens },
    r => { r.sections[0].status = 'revise' },
    r => { r.coverage[0].findings[0].disposition = 'omitted' },
    r => { r.new_issues = [issueFixtureV2()]; r.verdict = 'revise' },
    r => { r.new_issues = [issueFixtureV2({ kind: 'watch' })]; r.verdict = 'revise'; r.sections[2].issue_keys = ['cash-flow-limit'] },
  ]
  for (const change of cases) {
    const review = reviewFor(ledger)
    change(review)
    assert.throws(() => reconcileReview({ ledger, review, snapshot }))
  }
  const blocked = firstIssue()
  assert.throws(() => reconcileReview({ ledger: blocked, review: next(blocked, { verdict: 'pass' }), snapshot }), /verdict/)
})

test('canonical JSON sorts nested keys, preserves arrays and hashes raw bytes', () => {
  assert.equal(canonicalJson({ z: 1, a: { y: 2, x: ['中', 3] } }), '{"a":{"x":["中",3],"y":2},"z":1}')
  assert.equal(sha256(Buffer.from('abc')), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  assert.notEqual(sha256(Buffer.from('a\r\n')), sha256(Buffer.from('a\n')))
  for (const value of [undefined, NaN, { a: undefined }, new Date(), [Infinity]]) assert.throws(() => canonicalJson(value), /JSON/)
})

test('schemas decode real review, proposal and transcript and transport optional nulls', () => {
  const ledger = createLedger()
  const proposal = { task_ids: ['RT-000001'], base_report_sha256: snapshot.report_sha256, status: 'proposed', edits: [{ section: 3, before: '未知', after: '未知且限制判断', rationale: '披露边界', task_ids: ['RT-000001'] }], evidence_refs: issueFixtureV2().evidence_refs, acceptance_checks: [{ task_id: 'RT-000001', criterion_index: 0, response: '已披露' }], escalation_reason: '' }
  const transcript = { version: 2, source: 'findings/chart.png', source_sha256: 'c'.repeat(64), text: '收入100万元', method: 'ocr' }
  for (const [schema, value] of [[REVIEW_SCHEMA, reviewFor(ledger)], [PROPOSAL_SCHEMA, proposal], [TRANSCRIPT_SCHEMA, transcript]]) {
    assert.deepEqual(decodeResult(schema, value), value)
    const transport = transportSchema(schema)
    const validate = new Ajv({ strict: false }).compile(transport)
    assert.equal(validate(withOptionalNulls(schema, value)), true)
    assert.throws(() => decodeResult(schema, { ...value, extra: true }), /schema mismatch/)
  }
  const value = reviewFor(ledger)
  value.written_file = null
  assert.equal('written_file' in decodeResult(REVIEW_SCHEMA, value), false)
  assert.throws(() => decodeResult(REVIEW_SCHEMA, { ...reviewFor(ledger), blocking_issues: ['自由文本'] }), /schema mismatch/)
  assert.throws(() => decodeResult(PROPOSAL_SCHEMA, { ...proposal, status: 'resolved' }), /schema mismatch/)
})


test('counts each review once including clean reviews and requires reserved rounds', () => {
  const initial = createLedger({ maxRounds: 1 })
  const first = reconcileReview({ ledger: initial, review: reviewFor(initial), snapshot }).ledger
  assert.equal(first.budget.valid_reviews, 1)
  assert.deepEqual(first.budget.review_ids, ['RV-000001'])
  assert.throws(() => reconcileReview({ ledger: first, review: reviewFor(first), snapshot }), /duplicate.*review/)
  assert.throws(() => reconcileReview({ ledger: first, review: reviewFor(first, { reviewId: 'RV-000002' }), snapshot }), /reserved|budget/)
  const reserved = structuredClone(first)
  reserved.budget.used_rounds = 1
  const second = reconcileReview({ ledger: reserved, review: reviewFor(reserved, { reviewId: 'RV-000002' }), snapshot }).ledger
  assert.equal(second.budget.valid_reviews, 2)
  assert.throws(() => reconcileReview({ ledger: second, review: reviewFor(second, { reviewId: 'RV-000003' }), snapshot }), /budget|reserved/)
})
