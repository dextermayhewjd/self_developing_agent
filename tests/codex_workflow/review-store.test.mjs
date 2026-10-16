import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, rm, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import fsPromises from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { openReviewStore } from '../../tools/codex_workflow/review-store.mjs'
import { canonicalJson, sha256 } from '../../tools/codex_workflow/review-contracts.mjs'
import { markAwaitingReview, reconcileReview } from '../../tools/codex_workflow/review-ledger.mjs'
import { reviewFixtureV2, issueFixtureV2 } from './fixtures/review-fixture.mjs'

const hash = value => sha256(canonicalJson(value))
const report = Buffer.from('## 三、现金流\r\n初稿，尚未披露回款限制。\r\n')
const changed = Buffer.from('## 三、现金流\r\n修订，明确披露回款限制。\r\n')
const payload = { version: 2, sources: [] }
const evidence = { ...payload, sha256: hash(payload) }
function observeSync(t, onSync) {
  const originalOpen = fsPromises.open
  const wrapped = t.mock.method(fsPromises, 'open', async (path, ...args) => {
    const file = await originalOpen(path, ...args)
    const sync = file.sync.bind(file)
    file.sync = async () => { await onSync(path); return sync() }
    return file
  })
  syncBuiltinESMExports()
  t.after(() => { wrapped.mock.restore(); syncBuiltinESMExports() })
}
async function setup(t, options = {}) {
  const runDir = await mkdtemp(join(tmpdir(), 'review-store-'))
  t.after(() => rm(runDir, { recursive: true, force: true }))
  const store = await openReviewStore({ runDir, ...options })
  return { runDir, store, control: join(runDir, '.codex-workflow/review') }
}
function revisionReview(state, reviewId = 'RV-000001') {
  const issues = [1, 2].map(n => issueFixtureV2({ issue_key: `issue-${n}`, evidence_refs: [] }))
  const review = reviewFixtureV2({ snapshot: state.snapshot, ledgerSha256: hash(state.ledger), reviewId, verdict: 'revise', new_issues: issues })
  review.sections[2] = { ...review.sections[2], status: 'revise', issue_keys: issues.map(issue => issue.issue_key) }
  return review
}
async function accept(store, review) {
  const state = await store.read()
  const { ledger, receipt } = reconcileReview({ ledger: state.ledger, review, snapshot: { report_sha256: review.report_sha256, evidence_sha256: review.evidence_sha256 } })
  return store.commitReview({ review, ledger, receipt, evidence })
}
async function prepared(t, options) {
  const env = await setup(t, options)
  await env.store.initialize({ reportBytes: report, evidence })
  await accept(env.store, revisionReview(await env.store.read()))
  const state = await env.store.read()
  const begun = await env.store.beginAttempt({ taskIds: state.ledger.tasks.map(task => task.id), snapshot: state.snapshot })
  return { ...env, begun }
}
function checkpoint(state, bytes = changed) {
  const snapshot = { ...state.snapshot, report_sha256: sha256(bytes) }
  const taskId = state.attempt.task_ids[state.attempt.cursor]
  return { attemptId: state.attempt.id, taskId, result: { status: 'applied', note: 'validated host patch' }, reportBytes: bytes,
    ledger: markAwaitingReview({ ledger: state.ledger, taskIds: [taskId], snapshot, attemptId: state.attempt.id }), evidence }
}

test('initialize preserves exact report bytes and recovery ignores mutable display authority', async t => {
  const { store, runDir, control } = await setup(t)
  assert.equal(await store.read(), null)
  const state = await store.initialize({ reportBytes: report, evidence })
  assert.equal(state.snapshot.report_sha256, sha256(report))
  assert.equal(state.ledger.budget.max_rounds, 2)
  await writeFile(join(control, 'ledger.json'), '{"forged":true}')
  // Mutable display corruption must never become authoritative or be silently overwritten.
  await assert.rejects(openReviewStore({ runDir }), /conflict/i)
  assert.deepEqual(await readFile(join(runDir, 'report.md')), report)
})

for (const phase of ['after_objects', 'after_commit', 'before_head', 'after_head', 'before_materialize', 'after_materialize_report', 'after_materialize_ledger', 'after_materialize']) {
  test(`checkpoint crash at ${phase} recovers only the HEAD-selected complete version`, async t => {
    let armed = false
    const { store, runDir, begun } = await prepared(t, { failpoint: name => { if (armed && name === phase) throw new Error(`crash ${phase}`) } })
    const input = checkpoint(begun)
    armed = true
    await assert.rejects(store.checkpointAttempt(input), /crash/)
    const recovered = await (await openReviewStore({ runDir })).read()
    const published = !['after_objects', 'after_commit', 'before_head'].includes(phase)
    assert.equal(recovered.attempt.cursor, published ? 1 : 0)
    assert.equal(recovered.ledger.budget.used_rounds, 1)
    assert.deepEqual(await readFile(join(runDir, 'report.md')), published ? changed : report)
    assert.equal(recovered.ledger.tasks[0].status, published ? 'awaiting_review' : 'open')
  })
}
for (const phase of ['after_objects', 'after_commit', 'after_head', 'before_materialize', 'after_materialize_report']) {
  test(`initial publication crash at ${phase} is recoverable without inventing a previous report`, async t => {
    const { runDir, store } = await setup(t, { failpoint: name => { if (name === phase) throw new Error('initial crash') } })
    await assert.rejects(store.initialize({ reportBytes: report, evidence }), /initial crash/)
    const reopened = await openReviewStore({ runDir })
    let state = await reopened.read()
    if (['after_objects', 'after_commit'].includes(phase)) {
      assert.equal(state, null)
      state = await reopened.initialize({ reportBytes: report, evidence })
    }
    assert.equal(state.snapshot.report_sha256, sha256(report))
    assert.deepEqual(await readFile(join(runDir, 'report.md')), report)
  })
}

test('manual edit between HEAD publication and materialization is preserved as a conflict', async t => {
  let armed = false
  const { runDir, store, begun } = await prepared(t, { failpoint: name => { if (armed && name === 'after_head') throw new Error('crash') } })
  armed = true
  await assert.rejects(store.checkpointAttempt(checkpoint(begun)), /crash/)
  const manual = Buffer.from('人工修改\r\n保留原始字节')
  await writeFile(join(runDir, 'report.md'), manual)
  await assert.rejects(openReviewStore({ runDir }), /conflict.*report|report.*conflict/i)
  assert.deepEqual(await readFile(join(runDir, 'report.md')), manual)
})

test('initialization refuses to replace an existing different manual report', async t => {
  const { store, runDir } = await setup(t)
  await writeFile(join(runDir, 'report.md'), '人工稿')
  await assert.rejects(store.initialize({ reportBytes: report, evidence }), /conflict/i)
  assert.equal(await readFile(join(runDir, 'report.md'), 'utf8'), '人工稿')
})

for (const mutation of ['missing', 'digest']) {
  test(`recovery refuses ${mutation} immutable objects and leaves compatibility bytes intact`, async t => {
    const { store, runDir, control } = await setup(t)
    const state = await store.initialize({ reportBytes: report, evidence })
    const path = join(control, state.commit.refs.ledger.path)
    if (mutation === 'missing') await unlink(path)
    else await writeFile(path, '{}')
    await assert.rejects(openReviewStore({ runDir }), /missing|digest|SHA|ENOENT/i)
    assert.deepEqual(await readFile(join(runDir, 'report.md')), report)
  })
}

test('a fixed two-task batch resumes at its cursor, rejects early review and never reapplies a checkpoint', async t => {
  const { runDir, store, begun, control } = await prepared(t)
  const input = checkpoint(begun)
  const first = await store.checkpointAttempt(input)
  // The mutable attempt display is disposable; only the committed snapshot is authoritative.
  await unlink(join(control, `attempts/${begun.attempt.id}.json`))
  const reopened = await openReviewStore({ runDir })
  const resumed = await reopened.read()
  assert.equal(resumed.attempt.cursor, 1)
  assert.equal(JSON.parse(await readFile(join(control, `attempts/${begun.attempt.id}.json`), 'utf8')).cursor, 1)
  assert.equal(resumed.attempt.task_ids[1], 'RT-000002')
  assert.equal(resumed.ledger.budget.used_rounds, 1)
  assert.deepEqual((await reopened.checkpointAttempt(input)).commit, first.commit)
  await assert.rejects(reopened.commitReview({ review: revisionReview(resumed, 'RV-000002'), ledger: resumed.ledger, receipt: {}, evidence }), /finaliz|batch/i)
  await assert.rejects(reopened.checkpointAttempt({ ...checkpoint(resumed), taskId: 'RT-000001' }), /already|order|replay/i)
  const second = await reopened.checkpointAttempt(checkpoint(resumed, Buffer.from('两项修订完成。')))
  assert.equal(second.attempt.cursor, 2)
  await assert.rejects(reopened.beginAttempt({ taskIds: ['RT-000002'], snapshot: second.snapshot }), /active|attempt/i)
  const final = await reopened.finalizeAttempt({ attemptId: begun.attempt.id })
  assert.equal(final.attempt.state, 'finalized')
  assert.equal((await reopened.finalizeAttempt({ attemptId: begun.attempt.id })).commit.id, final.commit.id)
})

test('no-progress business results retain their reason and cannot authorize another semantic review', async t => {
  const { store, begun } = await prepared(t)
  for (const taskId of begun.attempt.task_ids) {
    const state = await store.read()
    await store.checkpointAttempt({ attemptId: begun.attempt.id, taskId, result: { status: 'needs_evidence', reason: '缺少原始材料' }, reportBytes: report, ledger: state.ledger, evidence })
  }
  const final = await store.finalizeAttempt({ attemptId: begun.attempt.id, reason: 'needs_evidence' })
  assert.equal(final.ledger.terminal_reason, 'needs_evidence')
  assert.equal(final.ledger.budget.used_rounds, 1)
  await assert.rejects(store.commitReview({ review: revisionReview(final, 'RV-000002'), ledger: final.ledger, receipt: {}, evidence }), /progress|evidence|terminal/i)
})

test('durable budget survives reopen, explicit extension is idempotent, N revisions allow N+1 reviews', async t => {
  const { store: initial, runDir } = await setup(t)
  await initial.initialize({ reportBytes: report, evidence })
  let store = initial
  await accept(store, revisionReview(await store.read()))
  for (let round = 1; round <= 3; round++) {
    if (round === 3) {
      store = await openReviewStore({ runDir })
      let state = await store.read()
      assert.equal(state.ledger.budget.max_rounds, 2)
      assert.equal(state.ledger.budget.used_rounds, 2)
      await assert.rejects(store.beginAttempt({ taskIds: state.ledger.tasks.map(task => task.id), snapshot: state.snapshot }), /budget|round/i)
      await store.setMaxRounds(3)
      await store.setMaxRounds(3)
      state = await store.read()
      assert.equal(state.ledger.budget.extensions.length, 1)
    }
    let state = await store.read()
    state = await store.beginAttempt({ taskIds: state.ledger.tasks.map(task => task.id), snapshot: state.snapshot })
    for (const taskId of state.attempt.task_ids) {
      state = await store.read()
      await store.checkpointAttempt(checkpoint(state, Buffer.from(`round ${round} task ${taskId}`)))
    }
    state = await store.finalizeAttempt({ attemptId: state.attempt.id })
    const review = reviewFixtureV2({ snapshot: state.snapshot, ledgerSha256: hash(state.ledger), reviewId: `RV-${round + 1}`, verdict: 'revise', task_dispositions: state.ledger.tasks.map(task => ({ task_id: task.id, status: 'open', reason: '尚未满足', kind: task.kind, blocks_delivery: task.blocks_delivery })) })
    review.sections[2] = { ...review.sections[2], status: 'revise', task_ids: state.ledger.tasks.map(task => task.id) }
    await accept(store, review)
  }
  const state = await (await openReviewStore({ runDir })).read()
  assert.equal(state.ledger.budget.valid_reviews, 4)
  assert.equal(state.ledger.budget.used_rounds, 3)
  await assert.rejects(store.beginAttempt({ taskIds: ['RT-000001'], snapshot: state.snapshot }), /budget|round/i)
  await assert.rejects(store.setMaxRounds(2), /used|consumed/i)
  for (const invalid of [0, 11, 2.5, '4']) await assert.rejects(store.setMaxRounds(invalid), /integer|1.*10/i)
})

test('delivery uses receipt OUTPUT ledger, independent pass and current snapshot, never stage success', async t => {
  const { store, runDir } = await setup(t)
  let state = await store.initialize({ reportBytes: report, evidence })
  await assert.rejects(store.assertDeliverable({ snapshot: state.snapshot }), /pass|review/i)
  const review = reviewFixtureV2({ snapshot: state.snapshot, ledgerSha256: hash(state.ledger) })
  state = await accept(store, review)
  assert.notEqual(state.receipt.input_ledger_sha256, state.receipt.output_ledger_sha256)
  assert.equal((await store.assertDeliverable({ snapshot: state.snapshot })).review.verdict, 'pass')
  assert.equal(state.commit.refs.review_input_ledger.sha256, review.input_ledger_sha256)
  const different = { ...state.snapshot, evidence_sha256: 'f'.repeat(64) }
  await assert.rejects(store.assertDeliverable({ snapshot: different }), /snapshot|evidence/i)
  await writeFile(join(runDir, 'report.md'), '人工稿变化')
  await assert.rejects(store.assertDeliverable({ snapshot: state.snapshot }), /conflict|report/i)
  assert.equal(await readFile(join(runDir, 'report.md'), 'utf8'), '人工稿变化')
})

test('changing the committed ledger after a pass revokes receipt authorization', async t => {
  const { store } = await setup(t)
  let state = await store.initialize({ reportBytes: report, evidence })
  state = await accept(store, reviewFixtureV2({ snapshot: state.snapshot, ledgerSha256: hash(state.ledger) }))
  await store.setMaxRounds(3)
  await assert.rejects(store.assertDeliverable({ snapshot: state.snapshot }), /output.*ledger|ledger.*receipt/i)
})

test('forged reconciliation, stale snapshot and evidence self-digest never commit', async t => {
  const { store } = await setup(t)
  let state = await store.initialize({ reportBytes: report, evidence })
  const review = reviewFixtureV2({ snapshot: state.snapshot, ledgerSha256: hash(state.ledger) })
  const checked = reconcileReview({ ledger: state.ledger, review, snapshot: state.snapshot })
  checked.ledger.budget.used_rounds = 1
  await assert.rejects(store.commitReview({ review, ...checked, evidence }), /ledger|reconcil/i)
  await assert.rejects(store.beginAttempt({ taskIds: ['RT-000001'], snapshot: { ...state.snapshot, report_sha256: 'd'.repeat(64) } }), /snapshot|report/i)
  await assert.rejects(store.commitReview({ review, ...checked, evidence: { ...evidence, sha256: 'd'.repeat(64) } }), /evidence|digest/i)
  state = await store.read()
  assert.equal(state.ledger.budget.valid_reviews, 0)
})

test('full-revision group checkpoints all fixed members atomically and rejects forged state', async t => {
  const { store, begun, runDir } = await prepared(t)
  const snapshot = { ...begun.snapshot, report_sha256: sha256(changed) }
  const taskIds = begun.attempt.task_ids
  const ledger = markAwaitingReview({ ledger: begun.ledger, taskIds, snapshot, attemptId: begun.attempt.id })
  const input = { attemptId: begun.attempt.id, taskId: taskIds[0], result: { status: 'applied', task_ids: taskIds }, ledger, evidence, reportBytes: changed }
  const bad = structuredClone(ledger)
  bad.tasks[0].status = 'resolved'
  await assert.rejects(store.checkpointAttempt({ ...input, ledger: bad }), /ledger|transition/i)
  const state = await store.checkpointAttempt(input)
  assert.equal(state.attempt.cursor, 2)
  assert.equal(state.attempt.results.length, 2)
  assert.ok(state.ledger.tasks.every(task => task.status === 'awaiting_review'))
  const reopened = await openReviewStore({ runDir })
  assert.equal((await reopened.checkpointAttempt(input)).commit.id, state.commit.id)
  await reopened.finalizeAttempt({ attemptId: state.attempt.id })
})

test('budget reservation published before return survives a beginAttempt crash', async t => {
  let armed = false
  const { store, runDir } = await setup(t, { failpoint: name => { if (armed && name === 'after_head') throw new Error('reservation crash') } })
  let state = await store.initialize({ reportBytes: report, evidence })
  state = await accept(store, revisionReview(state))
  armed = true
  await assert.rejects(store.beginAttempt({ taskIds: state.ledger.tasks.map(task => task.id), snapshot: state.snapshot }), /reservation crash/)
  const reopened = await openReviewStore({ runDir })
  state = await reopened.read()
  assert.equal(state.ledger.budget.used_rounds, 1)
  assert.equal(state.attempt.cursor, 0)
  assert.deepEqual(state.attempt.task_ids, ['RT-000001', 'RT-000002'])
  await assert.rejects(reopened.beginAttempt({ taskIds: state.attempt.task_ids, snapshot: state.snapshot }), /active/i)
})

test('manual edit made at materialization boundary is rechecked before replacing report bytes', async t => {
  let armed = false
  let runDir
  const env = await prepared(t, { failpoint: async name => {
    if (armed && name === 'before_materialize') {
      armed = false
      await writeFile(join(runDir, 'report.md'), 'boundary manual edit')
    }
  } })
  runDir = env.runDir
  armed = true
  await assert.rejects(env.store.checkpointAttempt(checkpoint(env.begun)), /conflict/i)
  assert.equal(await readFile(join(runDir, 'report.md'), 'utf8'), 'boundary manual edit')
})

test('host gate registration only appends open snapshot-bound tasks and revokes prior pass', async t => {
  const { store } = await setup(t)
  let state = await store.initialize({ reportBytes: report, evidence })
  state = await accept(store, reviewFixtureV2({ snapshot: state.snapshot, ledgerSha256: hash(state.ledger) }))
  const ledger = structuredClone(state.ledger)
  const task = { ...issueFixtureV2({ issue_key: 'gate:citations', evidence_refs: [] }), id: 'RT-000001', status: 'open', created_review_id: 'gate:citations', last_review_id: 'gate:citations', ...state.snapshot,
    history: [{ event: 'created', status: 'open', kind: 'blocking', blocks_delivery: true, reason: '引用硬门发现', ...state.snapshot }] }
  ledger.tasks.push(task)
  ledger.next_task_number = 2
  const bad = structuredClone(ledger)
  bad.budget.used_rounds = 1
  await assert.rejects(store.registerTasks({ ledger: bad, reason: '引用硬门发现' }), /append|budget|unchanged/i)
  const registered = await store.registerTasks({ ledger, reason: '引用硬门发现' })
  assert.equal(registered.ledger.budget.valid_reviews, 1)
  assert.equal(registered.ledger.budget.used_rounds, 0)
  assert.equal(registered.ledger.tasks[0].status, 'open')
  assert.equal((await store.registerTasks({ ledger, reason: '引用硬门发现' })).commit.id, registered.commit.id)
  await assert.rejects(store.assertDeliverable({ snapshot: registered.snapshot }), /blocking|ledger/i)
  const changedOld = structuredClone(registered.ledger)
  changedOld.tasks[0].status = 'resolved'
  await assert.rejects(store.registerTasks({ ledger: changedOld, reason: 'self-close' }), /append|existing|unchanged/i)
  const attempt = await store.beginAttempt({ taskIds: ['RT-000001'], snapshot: registered.snapshot })
  assert.equal(attempt.ledger.budget.used_rounds, 1)
})

for (const kind of ['reports', 'ledgers', 'evidence', 'attempt-snapshots']) {
  test(`crash after the ${kind} object leaves no partly committed checkpoint`, async t => {
    let armed = false
    const { store, runDir, begun } = await prepared(t, { failpoint: (name, context) => {
      if (armed && name === 'after_object' && context.kind === kind) throw new Error('object crash')
    } })
    const input = checkpoint(begun)
    armed = true
    await assert.rejects(store.checkpointAttempt(input), /object crash/)
    const reopened = await openReviewStore({ runDir })
    assert.equal((await reopened.read()).attempt.cursor, 0)
    // Retrying can safely reuse verified complete orphan objects without consuming a second round.
    const state = await reopened.checkpointAttempt(input)
    assert.equal(state.attempt.cursor, 1)
    assert.equal(state.ledger.budget.used_rounds, 1)
  })
}

test('interrupted immutable staging never leaves a partial published object', async t => {
  let armed = false
  const { store, runDir, begun } = await prepared(t, { failpoint: name => {
    if (armed && name === 'after_object_staged') throw new Error('staging crash')
  } })
  armed = true
  await assert.rejects(store.checkpointAttempt(checkpoint(begun)), /staging crash/)
  const reopened = await openReviewStore({ runDir })
  assert.equal((await reopened.read()).attempt.cursor, 0)
  assert.equal((await reopened.checkpointAttempt(checkpoint(begun))).attempt.cursor, 1)
})

test('missing or forged commit references cannot authorize a report', async t => {
  const { store, runDir, control } = await setup(t)
  await store.initialize({ reportBytes: report, evidence })
  const headPath = join(control, 'HEAD.json')
  const head = JSON.parse(await readFile(headPath, 'utf8'))
  const original = await readFile(join(control, head.path))
  await writeFile(join(control, head.path), '{}')
  await assert.rejects(openReviewStore({ runDir }), /digest|SHA/i)
  await writeFile(join(control, head.path), original)
  await writeFile(headPath, canonicalJson({ ...head, path: 'commits/CP-999999.json' }))
  await assert.rejects(openReviewStore({ runDir }), /missing/i)
  assert.deepEqual(await readFile(join(runDir, 'report.md')), report)
})

test('budget-exhausted stop persists without reserving another attempt or changing tasks', async t => {
  const { store, runDir } = await setup(t)
  let state = await store.initialize({ reportBytes: report, evidence })
  state = await accept(store, revisionReview(state))
  const stopped = await store.recordStop({ reason: 'budget_exhausted' })
  assert.equal(stopped.ledger.terminal_reason, 'budget_exhausted')
  assert.deepEqual(stopped.ledger.budget, state.ledger.budget)
  assert.deepEqual(stopped.ledger.tasks, state.ledger.tasks)
  assert.equal(stopped.ledger.active_attempt_id, null)
  assert.equal(stopped.attempt, null)
  assert.equal((await store.recordStop({ reason: 'budget_exhausted' })).commit.id, stopped.commit.id)
  const reopened = await openReviewStore({ runDir })
  assert.equal((await reopened.read()).ledger.terminal_reason, 'budget_exhausted')
  await assert.rejects(store.recordStop({ reason: '' }), /reason/i)
  const cleared = await store.recordStop({ reason: null })
  assert.equal(cleared.ledger.terminal_reason, null)
  assert.deepEqual(cleared.ledger.budget, state.ledger.budget)
  assert.deepEqual(cleared.ledger.tasks, state.ledger.tasks)
})

test('initial publication syncs directory parents before HEAD can authorize their objects', async t => {
  const synced = []
  observeSync(t, path => { synced.push(path) })
  let runDir
  let control
  const env = await setup(t, { failpoint: name => {
    if (name === 'before_head') {
      for (const path of [runDir, join(runDir, '.codex-workflow'), control, ...['reports', 'ledgers', 'evidence', 'commits'].map(folder => join(control, folder))]) {
        assert.ok(synced.includes(path), `missing directory sync before HEAD: ${path}`)
      }
    }
  } })
  ;({ runDir, control } = env)
  await env.store.initialize({ reportBytes: report, evidence })
})

test('retry after object-directory sync failure syncs a verified orphan file and its directory before HEAD', async t => {
  let failReportsSync = false
  let control
  let synced = []
  observeSync(t, path => {
    if (failReportsSync && path === join(control, 'reports')) {
      failReportsSync = false
      throw new Error('directory sync interrupted')
    }
    synced.push(path)
  })
  const env = await setup(t, { failpoint: (name, context) => {
    if (name === 'after_object_staged' && context.kind === 'reports') failReportsSync = true
  } })
  control = env.control
  await assert.rejects(env.store.initialize({ reportBytes: report, evidence }), /directory sync interrupted/)
  const orphanPath = join(control, `reports/RP-${sha256(report)}.md`)
  assert.deepEqual(await readFile(orphanPath), report)
  synced = []
  const reopened = await openReviewStore({ runDir: env.runDir, failpoint: name => {
    if (name === 'before_head') {
      assert.ok(synced.includes(orphanPath), 'reused orphan inode must be synced')
      assert.ok(synced.includes(join(control, 'reports')), 'reused orphan directory entry must be synced')
      assert.ok(synced.includes(env.runDir), 'control-directory ancestry must be synced')
    }
  } })
  assert.equal(await reopened.read(), null)
  await reopened.initialize({ reportBytes: report, evidence })
})

test('gate registration rejects malformed or foreign evidence references before committing any task', async t => {
  const { store } = await setup(t)
  const state = await store.initialize({ reportBytes: report, evidence })
  const ref = { source: 'findings/财务排雷.md', source_sha256: 'c'.repeat(64), evidence_sha256: evidence.sha256, quote: '现金流依赖回款。' }
  const task = { ...issueFixtureV2({ issue_key: 'gate:refs', evidence_refs: [ref] }), id: 'RT-000001', status: 'open', created_review_id: 'gate:refs', last_review_id: 'gate:refs', ...state.snapshot,
    history: [{ event: 'created', status: 'open', kind: 'blocking', blocks_delivery: true, reason: '引用硬门发现', ...state.snapshot }] }
  const invalidRefs = [null, {}, [], { ...ref, extra: true }, { ...ref, source: '' }, { ...ref, source_sha256: 'X'.repeat(64) }, { ...ref, quote: '' }, { ...ref, evidence_sha256: 'd'.repeat(64) },
    { ...ref, transcript_path: 'transcripts/t.json' }, { ...ref, transcript_sha256: 'c'.repeat(64) }, { ...ref, transcript_path: '', transcript_sha256: 'c'.repeat(64) }, { ...ref, transcript_path: 'transcripts/t.json', transcript_sha256: 'invalid' }]
  for (const invalid of invalidRefs) {
    const ledger = { ...structuredClone(state.ledger), next_task_number: 2, tasks: [{ ...task, evidence_refs: [invalid] }] }
    await assert.rejects(store.registerTasks({ ledger, reason: '引用硬门发现' }), /evidence|reference|transcript/i)
    assert.equal((await store.read()).commit.id, state.commit.id)
  }
  for (const location of [null, { section: 3, quote: 7 }, { section: 3, quote: null }, { section: 3, extra: true }]) {
    const ledger = { ...structuredClone(state.ledger), next_task_number: 2, tasks: [{ ...task, locations: [location] }] }
    await assert.rejects(store.registerTasks({ ledger, reason: '引用硬门发现' }), /location|contract/i)
    assert.equal((await store.read()).commit.id, state.commit.id)
  }
  const valid = { ...task, locations: [{ section: 3, quote: '回款限制' }], evidence_refs: [{ ...ref, transcript_path: 'transcripts/t.json', transcript_sha256: 'e'.repeat(64) }] }
  const registered = await store.registerTasks({ ledger: { ...state.ledger, next_task_number: 2, tasks: [valid] }, reason: '引用硬门发现' })
  assert.deepEqual(registered.ledger.tasks[0].evidence_refs, valid.evidence_refs)
})
