import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm, chmod } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { coordinateThesisReview, reviewStages } from '../../tools/codex_workflow/review-coordinator.mjs'
import { openReviewStore } from '../../tools/codex_workflow/review-store.mjs'
import { REVIEW_LENSES, canonicalJson, sha256 } from '../../tools/codex_workflow/review-contracts.mjs'
import { reportFixture, reviewFixtureV2 } from './fixtures/review-fixture.mjs'

const quote = '现金流依赖回款。'
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'review-coordinator-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const args = { symbol: '000001', date: '20261016' }
  const run = join(root, 'reports/000001_thesis_20261016')
  await mkdir(join(run, 'findings'), { recursive: true })
  await writeFile(join(run, 'report.md'), reportFixture(quote))
  await writeFile(join(run, '疑惑.md'), '待核查问题')
  for (const lens of REVIEW_LENSES) await writeFile(join(run, 'findings', lens + '.md'), quote)
  const store = await openReviewStore({ runDir: run })
  return { root, args, run, store }
}
function issue(context, section, overrides = {}) {
  const source = context.evidence.find(s => s.path === 'findings/财务排雷.md')
  return { issue_key: 'issue-' + section, kind: 'blocking', blocks_delivery: true,
    description: `第${section}节遗漏限制`, locations: [{ section }],
    evidence_refs: [{ source: source.path, source_sha256: source.sha256, evidence_sha256: context.snapshot.evidence_sha256, quote }],
    acceptance_criteria: ['补入限制说明'], judgment_constraints: [], route: 'local_patch', ...overrides }
}
function review(context, issues = [], keepOpen = []) {
  const result = reviewFixtureV2({ ledgerSha256: context.input_ledger_sha256, reviewId: context.review_id,
    snapshot: context.snapshot, reviewed_sources: context.evidence.map(s => s.path),
    verdict: issues.length || keepOpen.length ? 'revise' : 'pass', new_issues: issues,
    task_dispositions: context.ledger.tasks.map(task => ({ task_id: task.id, status: keepOpen.includes(task.id) ? 'open' : 'resolved', reason: '独立核查报告', kind: task.kind, blocks_delivery: task.blocks_delivery })),
  })
  for (const item of issues) result.sections[item.locations[0].section - 1].issue_keys.push(item.issue_key)
  return result
}
function proposal(context, status = 'proposed') {
  return { task_ids: context.tasks.map(task => task.id), base_report_sha256: context.snapshot.report_sha256, status,
    edits: status === 'proposed' ? context.tasks.map(task => ({ section: task.locations[0].section, before: quote, after: quote + `限制已披露${task.id}。`, rationale: '补充限制', task_ids: [task.id] })) : [],
    evidence_refs: [...new Map(context.tasks.flatMap(task => task.evidence_refs).map(ref => [canonicalJson(ref), ref])).values()],
    acceptance_checks: status === 'proposed' ? context.tasks.flatMap(task => task.acceptance_criteria.map((_, criterion_index) => ({ task_id: task.id, criterion_index, response: '已补充，请独立复核' }))) : [],
    escalation_reason: status === 'proposed' ? '' : '需要完整修订或补充证据' }
}
function fake(handler) {
  const calls = []
  return { calls, async agent(prompt, options) {
    const context = JSON.parse(prompt.slice(prompt.indexOf('\nCONTEXT_JSON\n') + '\nCONTEXT_JSON\n'.length))
    calls.push({ prompt, options, context })
    return handler(context, options, calls)
  } }
}

test('real Store two sequential tasks consume one round; full review is independent and archives actual inputs', async t => {
  const f = await fixture(t)
  const runtime = fake(async (context, options) => {
    if (options.contract === 'review') {
      assert.equal(options.effort, undefined)
      assert.equal(context.report_text, await readFile(join(f.run, 'report.md'), 'utf8'))
      assert.equal(context.evidence.length, 6)
      assert.equal(Object.hasOwn(context, 'proposals'), false)
      if (!context.ledger.tasks.length) return review(context, [issue(context, 3), issue(context, 4)])
      assert.deepEqual(context.ledger.tasks.map(task => task.status), ['awaiting_review', 'awaiting_review'])
      return review(context)
    }
    assert.equal(options.contract, 'proposal')
    assert.equal(options.effort, 'low')
    assert.ok(options.context_bytes <= 32768)
    return proposal(context)
  })
  const result = await coordinateThesisReview({ ...f, runtime })
  assert.equal(result.review.verdict, 'pass')
  const state = await f.store.read()
  assert.deepEqual([state.ledger.budget.used_rounds, state.ledger.budget.valid_reviews], [1, 2])
  assert.deepEqual(runtime.calls.map(call => call.options.contract), ['review', 'proposal', 'proposal', 'review'])
  assert.deepEqual(state.ledger.tasks.map(task => task.id), ['RT-000001', 'RT-000002'])
  const archive = join(f.run, '.codex-workflow/review/exchanges')
  const dirs = await readdir(archive)
  assert.equal(dirs.length, 4)
  for (const dir of dirs) {
    const request = JSON.parse(await readFile(join(archive, dir, 'request.json')))
    assert.ok(runtime.calls.some(call => call.prompt === request.prompt))
    assert.equal(request.context_bytes, Buffer.byteLength(JSON.stringify(request.context)))
    assert.ok(JSON.parse(await readFile(join(archive, dir, 'response.json'))))
  }
  await coordinateThesisReview({ ...f, runtime, reason: 'review_only', reviewMaxRounds: 5 })
  assert.equal(runtime.calls.length, 4)
  assert.equal((await f.store.read()).ledger.budget.max_rounds, 2)
  assert.deepEqual((await f.store.read()).receipt, result.receipt)
})

test('mid-batch failure resumes second item without repeating patch or prematurely reviewing', async t => {
  const f = await fixture(t)
  let fail = true
  const runtime = fake((context, options) => {
    if (options.contract === 'review') return review(context, context.ledger.tasks.length ? [] : [issue(context, 3), issue(context, 4)])
    if (context.tasks[0].id === 'RT-000002' && fail) throw new Error('transport interruption')
    return proposal(context)
  })
  await assert.rejects(coordinateThesisReview({ ...f, runtime }), /transport interruption/)
  const state = await f.store.read()
  assert.equal(state.attempt.cursor, 1)
  assert.equal(state.ledger.budget.valid_reviews, 1)
  fail = false
  await coordinateThesisReview({ ...f, runtime })
  assert.equal(runtime.calls.filter(call => call.options.contract === 'proposal' && call.context.tasks[0].id === 'RT-000001').length, 1)
  assert.equal((await f.store.read()).ledger.budget.used_rounds, 1)
})

test('local escalation becomes one full remaining-group proposal before final checkpoint', async t => {
  const f = await fixture(t)
  const runtime = fake((context, options) => {
    if (options.contract === 'review') return review(context, context.ledger.tasks.length ? [] : [issue(context, 3), issue(context, 4)])
    if (options.label.startsWith('问题修订:')) return proposal(context, 'escalate')
    assert.equal(options.label.startsWith('修订成稿:'), true)
    assert.equal(options.effort, undefined)
    assert.equal(context.tasks.length, 2)
    assert.equal(context.evidence.length, 6)
    return proposal(context)
  })
  await coordinateThesisReview({ ...f, runtime })
  const state = await f.store.read()
  assert.equal(state.attempt.results.length, 2)
  assert.deepEqual(state.attempt.results[0].result.task_ids, ['RT-000001', 'RT-000002'])
  assert.equal(runtime.calls.length, 4)
})

test('needs_evidence no-progress batch stops durably without rereview or new reservation', async t => {
  const f = await fixture(t)
  const runtime = fake(context => review(context, [issue(context, 3, { route: 'needs_evidence' })]))
  const result = await coordinateThesisReview({ ...f, runtime })
  assert.equal(result.terminalReason, 'needs_evidence')
  await coordinateThesisReview({ ...f, runtime })
  assert.equal(runtime.calls.length, 1)
  assert.equal((await f.store.read()).ledger.budget.used_rounds, 1)
})

test('mixed applied and needs_evidence gets one full review then stops on unchanged evidence', async t => {
  const f = await fixture(t)
  const runtime = fake((context, options) => {
    if (options.contract === 'proposal') return proposal(context)
    return context.ledger.tasks.length ? review(context, [], ['RT-000002']) : review(context, [issue(context, 3), issue(context, 4, { route: 'needs_evidence' })])
  })
  const result = await coordinateThesisReview({ ...f, runtime })
  assert.equal(result.terminalReason, 'needs_evidence')
  assert.equal(runtime.calls.length, 3)
  await coordinateThesisReview({ ...f, runtime })
  assert.equal(runtime.calls.length, 3)
})

test('absolute budget extends exhausted run without resetting old IDs or counters', async t => {
  const f = await fixture(t)
  let finish = false
  const runtime = fake((context, options) => {
    if (options.contract === 'proposal') {
      const p = proposal(context)
      p.edits[0].after += String(runtime.calls.length)
      return p
    }
    return context.ledger.tasks.length ? review(context, [], finish ? [] : ['RT-000001']) : review(context, [issue(context, 3)])
  })
  const result = await coordinateThesisReview({ ...f, runtime, reviewMaxRounds: 1 })
  assert.equal(result.terminalReason, 'budget_exhausted')
  assert.equal((await f.store.read()).ledger.budget.valid_reviews, 2)
  finish = true
  await coordinateThesisReview({ ...f, runtime, reviewMaxRounds: 2 })
  const state = await f.store.read()
  assert.equal(state.review.verdict, 'pass')
  assert.equal(state.ledger.budget.used_rounds, 2)
  assert.equal(state.ledger.budget.valid_reviews, 3)
  assert.equal(state.ledger.tasks.length, 1)
  assert.equal(state.ledger.budget.extensions.length, 1)
  await assert.rejects(coordinateThesisReview({ ...f, runtime, reviewMaxRounds: 1 }), /consumed/)
})

test('gate task follows existing pass directly into same-budget repair and independent review', async t => {
  const f = await fixture(t)
  const runtime = fake((context, options) => options.contract === 'proposal' ? proposal(context) : review(context))
  await coordinateThesisReview({ ...f, runtime })
  const result = await coordinateThesisReview({ ...f, runtime, gateFeedback: { gateId: 'report-check', feedback: { description: '补充第三节限制', locations: [{ section: 3 }], acceptance_criteria: ['补充限制'], judgment_constraints: [], route: 'local_patch' } } })
  assert.equal(result.review.verdict, 'pass')
  assert.deepEqual(runtime.calls.map(call => call.options.contract), ['review', 'proposal', 'review'])
  const state = await f.store.read()
  assert.equal(state.ledger.tasks[0].history[0].event, 'gate_registered')
  assert.equal(state.ledger.budget.used_rounds, 1)
})

test('invalid independent review cannot consume semantic count and resume allocates a fresh archived ID', async t => {
  const f = await fixture(t)
  const runtime = fake(context => ({ ...review(context), review_id: 'RV-wrong' }))
  await assert.rejects(coordinateThesisReview({ ...f, runtime }), /review_id/)
  assert.equal((await f.store.read()).ledger.budget.valid_reviews, 0)
  const good = fake(context => review(context))
  await coordinateThesisReview({ ...f, runtime: good })
  assert.notEqual(runtime.calls[0].context.review_id, good.calls[0].context.review_id)
})

test('human report edit and current evidence mutation fail closed and preserve human bytes', async t => {
  for (const name of ['report.md', 'findings/财务排雷.md']) {
    const f = await fixture(t)
    const runtime = fake(context => review(context))
    await coordinateThesisReview({ ...f, runtime })
    const changed = (await readFile(join(f.run, name), 'utf8')) + '\n人工修改'
    await writeFile(join(f.run, name), changed)
    await assert.rejects(coordinateThesisReview({ ...f, runtime }), /conflict|evidence|digest|sha256/i)
    assert.equal(await readFile(join(f.run, name), 'utf8'), changed)
    assert.equal(runtime.calls.length, 1)
  }
})

test('static stages expose schemas without any model or Store side effects', () => {
  assert.deepEqual(reviewStages.map(stage => stage.label), ['成稿审查', '问题修订', '修订成稿', '证据转录'])
  assert.ok(reviewStages.every(stage => stage.phase && stage.schema.type === 'object'))
})

test('historical report quotes may change mid-batch but all original source authorization remains checked', async t => {
  const f = await fixture(t)
  const original = await readFile(join(f.run, 'report.md'), 'utf8')
  await writeFile(join(f.run, 'report.md'), original.replace(quote, '历史独有引文。' + quote))
  let interrupted = true
  const runtime = fake((context, options) => {
    if (options.contract === 'review') {
      const r = review(context, context.ledger.tasks.length ? [] : [issue(context, 1), issue(context, 4)])
      if (!context.ledger.tasks.length) r.coverage[0].findings[0].report_quote = '历史独有引文。'
      return r
    }
    if (context.tasks[0].id === 'RT-000001') {
      const p = proposal(context)
      p.edits[0].before = '历史独有引文。'
      p.edits[0].after = '已完成独立核查。'
      return p
    }
    if (interrupted) throw new Error('pause second item')
    return proposal(context)
  })
  await assert.rejects(coordinateThesisReview({ ...f, runtime }), /pause second item/)
  assert.equal((await readFile(join(f.run, 'report.md'), 'utf8')).includes('历史独有引文。'), false)
  interrupted = false
  await coordinateThesisReview({ ...f, runtime })
  assert.equal((await f.store.read()).review.verdict, 'pass')
})

test('new actionable issues are repaired even with a previous unchanged needs_evidence result', async t => {
  const f = await fixture(t)
  let reviews = 0
  const runtime = fake((context, options) => {
    if (options.contract === 'proposal') return proposal(context, context.tasks[0].id === 'RT-000002' ? 'needs_evidence' : 'proposed')
    reviews++
    if (reviews === 1) return review(context, [issue(context, 3), issue(context, 4)])
    if (reviews === 2) return review(context, [issue(context, 5)], ['RT-000002'])
    assert.deepEqual(context.ledger.tasks.map(task => task.id), ['RT-000001', 'RT-000002', 'RT-000003'])
    assert.equal(context.ledger.tasks[0].status, 'resolved')
    return review(context, [], ['RT-000002'])
  })
  const result = await coordinateThesisReview({ ...f, runtime })
  assert.equal(result.terminalReason, 'needs_evidence')
  assert.equal((await f.store.read()).ledger.budget.used_rounds, 2)
  assert.equal(reviews, 3)
  assert.equal(runtime.calls.filter(call => call.options.contract === 'proposal' && call.context.tasks[0].id === 'RT-000002').length, 1)
})

test('missing disposition for an already resolved old ID fails without consuming another valid review', async t => {
  const f = await fixture(t)
  let reviews = 0
  const runtime = fake((context, options) => {
    if (options.contract === 'proposal') return proposal(context)
    reviews++
    if (reviews === 1) return review(context, [issue(context, 3)])
    if (reviews === 2) return review(context, [issue(context, 4)])
    const r = review(context)
    r.task_dispositions = r.task_dispositions.filter(task => task.task_id !== 'RT-000001')
    return r
  })
  await assert.rejects(coordinateThesisReview({ ...f, runtime }), /missing disposition.*RT-000001/)
  assert.equal((await f.store.read()).ledger.budget.valid_reviews, 2)
  assert.equal((await f.store.read()).ledger.budget.used_rounds, 2)
})

const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 255, 254, 128, 0])
function attest(source) {
  return { source: source.path, source_sha256: source.sha256, transcript_path: source.transcript.path,
    transcript_sha256: source.transcript.sha256, method: 'visual', status: 'verified', reason: '独立逐格核对原图' }
}
function withExtraction(runtime) {
  return { async agent(prompt, options) {
    if (options.contract !== 'evidence_extract') return runtime.agent(prompt, options)
    return { version: 2, source: options.label.slice('证据转录:'.length), source_sha256: sha256(await readFile(options.images[0])), text: '原图转录候选', method: 'model' }
  } }
}

test('full reviews receive and attest every image; local package excludes unrelated images', async t => {
  const f = await fixture(t)
  await mkdir(join(f.run, '核查'))
  await writeFile(join(f.run, '核查/a.png'), png)
  await writeFile(join(f.run, '核查/b.png'), png)
  const runtime = fake((context, options) => {
    if (options.contract === 'proposal') {
      assert.deepEqual(options.images, [])
      return proposal(context)
    }
    assert.equal(options.images.length, 2)
    assert.equal(context.evidence.filter(source => source.type === 'image').length, 2)
    const r = review(context, context.ledger.tasks.length ? [] : [issue(context, 3)])
    r.visual_attestations = context.evidence.filter(source => source.type === 'image').map(attest)
    return r
  })
  await coordinateThesisReview({ ...f, runtime: withExtraction(runtime) })
  const state = await f.store.read()
  assert.equal(state.review.visual_attestations.length, 2)
  const originalCalls = runtime.calls.length
  await writeFile(join(f.run, '核查/b.png'), Buffer.concat([png, Buffer.from([1])]))
  await assert.rejects(coordinateThesisReview({ ...f, runtime: withExtraction(runtime) }), /digest|sha256/)
  assert.equal(runtime.calls.length, originalCalls)
})

test('missing or forged image attestation never creates receipt and transcript archive tampering fails closed', async t => {
  for (const tamper of ['missing', 'forged']) {
    const f = await fixture(t)
    await mkdir(join(f.run, '核查'))
    await writeFile(join(f.run, '核查/a.png'), png)
    const runtime = fake(context => {
      const r = review(context)
      if (tamper === 'forged') r.visual_attestations = [{ ...attest(context.evidence.find(source => source.type === 'image')), source_sha256: '0'.repeat(64) }]
      return r
    })
    await assert.rejects(coordinateThesisReview({ ...f, runtime: withExtraction(runtime) }), /visual|attestation/i)
    assert.equal((await f.store.read()).receipt, null)
    assert.equal((await f.store.read()).ledger.budget.valid_reviews, 0)
  }
  const f = await fixture(t)
  await mkdir(join(f.run, '核查'))
  await writeFile(join(f.run, '核查/a.png'), png)
  const runtime = fake(context => ({ ...review(context), visual_attestations: context.evidence.filter(source => source.type === 'image').map(attest) }))
  await coordinateThesisReview({ ...f, runtime: withExtraction(runtime) })
  const transcript = runtime.calls[0].context.evidence.find(source => source.type === 'image').transcript.path
  await writeFile(join(f.run, transcript), '{}')
  await assert.rejects(coordinateThesisReview({ ...f, runtime: withExtraction(runtime) }), /transcript|digest/)
})

test('invalid proposal is archived then escalated, and full rejection consumes no semantic review', async t => {
  const f = await fixture(t)
  const runtime = fake((context, options) => {
    if (options.contract === 'review') return review(context, [issue(context, 3)])
    return { ...proposal(context), closed: true }
  })
  const result = await coordinateThesisReview({ ...f, runtime })
  assert.equal(result.terminalReason, 'no_safe_edit')
  const state = await f.store.read()
  assert.equal(state.ledger.budget.valid_reviews, 1)
  assert.equal(state.attempt.results[0].result.archives.length, 2)
  assert.equal(state.ledger.tasks[0].status, 'open')
  assert.equal(await readFile(join(f.run, 'report.md'), 'utf8'), reportFixture(quote))
})

test('default absolute allowance stops after two revisions and three valid reviews', async t => {
  const f = await fixture(t)
  const runtime = fake((context, options, calls) => {
    if (options.contract === 'review') return review(context, context.ledger.tasks.length ? [] : [issue(context, 3)], context.ledger.tasks.map(task => task.id))
    const p = proposal(context)
    p.edits[0].after += calls.length
    return p
  })
  const result = await coordinateThesisReview({ ...f, runtime })
  assert.equal(result.terminalReason, 'budget_exhausted')
  const state = await f.store.read()
  assert.deepEqual([state.ledger.budget.max_rounds, state.ledger.budget.used_rounds, state.ledger.budget.valid_reviews], [2, 2, 3])
  const count = runtime.calls.length
  await coordinateThesisReview({ ...f, runtime })
  assert.equal(runtime.calls.length, count)
})

test('invalid max rounds fail before initialization; explicit ten is accepted', async t => {
  const f = await fixture(t)
  const runtime = fake(context => review(context))
  for (const reviewMaxRounds of [0, 11, 1.5, '2']) await assert.rejects(coordinateThesisReview({ ...f, runtime, reviewMaxRounds }), /integer/)
  assert.equal(await f.store.read(), null)
  await coordinateThesisReview({ ...f, runtime, reviewMaxRounds: 10 })
  assert.equal((await f.store.read()).ledger.budget.max_rounds, 10)
})

test('crash after group checkpoint resumes directly into full review with no duplicate application', async t => {
  const f = await fixture(t)
  const runtime = fake((context, options) => {
    if (options.contract === 'review') return review(context, context.ledger.tasks.length ? [] : [issue(context, 3, { route: 'full_revision' }), issue(context, 4)])
    return proposal(context)
  })
  await assert.rejects(coordinateThesisReview({ ...f, runtime, emit(event) { if (event.type === 'review_task_checkpoint') throw new Error('checkpoint interruption') } }), /checkpoint interruption/)
  const interrupted = await f.store.read()
  assert.equal(interrupted.attempt.cursor, 2)
  assert.equal(interrupted.ledger.budget.valid_reviews, 1)
  await coordinateThesisReview({ ...f, runtime })
  assert.equal(runtime.calls.filter(call => call.options.contract === 'proposal').length, 1)
  assert.equal((await f.store.read()).ledger.budget.valid_reviews, 2)
})

test('concurrent human edit during proposal preserves human bytes and the uncompleted task', async t => {
  const f = await fixture(t)
  let human
  const runtime = fake(async (context, options) => {
    if (options.contract === 'review') return review(context, [issue(context, 3)])
    human = (await readFile(join(f.run, 'report.md'), 'utf8')) + '\n人工边注'
    await writeFile(join(f.run, 'report.md'), human)
    return proposal(context)
  })
  await assert.rejects(coordinateThesisReview({ ...f, runtime }), /conflict/)
  assert.equal(await readFile(join(f.run, 'report.md'), 'utf8'), human)
})

test('missing source inventory and malformed schema consume no valid reviews', async t => {
  for (const failure of ['inventory', 'schema']) {
    const f = await fixture(t)
    const runtime = fake(context => {
      const r = review(context)
      if (failure === 'inventory') r.reviewed_sources.pop()
      else r.verdict = 'approved'
      return r
    })
    await assert.rejects(coordinateThesisReview({ ...f, runtime }), /reviewed|inventory|allowed values|enum/)
    assert.equal((await f.store.read()).ledger.budget.valid_reviews, 0)
    const good = fake(context => review(context))
    await coordinateThesisReview({ ...f, runtime: good })
    assert.equal((await f.store.read()).ledger.budget.valid_reviews, 1)
  }
})

test('referenced proposal archive tampering is detected on resume before another model call', async t => {
  const f = await fixture(t)
  const runtime = fake((context, options) => options.contract === 'review' ? review(context, context.ledger.tasks.length ? [] : [issue(context, 3)]) : proposal(context))
  await coordinateThesisReview({ ...f, runtime })
  const state = await f.store.read()
  const ref = state.attempt.results[0].result.archives[0].response
  await chmod(join(f.run, '.codex-workflow/review', ref.path), 0o644)
  await writeFile(join(f.run, '.codex-workflow/review', ref.path), '{}')
  const count = runtime.calls.length
  await assert.rejects(coordinateThesisReview({ ...f, runtime }), /archive|reference|digest/)
  assert.equal(runtime.calls.length, count)
})

test('same gate feedback resumes its reserved attempt after transport failure without charging another round', async t => {
  const f = await fixture(t)
  let interrupted = true
  const runtime = fake((context, options) => {
    if (options.contract === 'review') return review(context)
    if (interrupted) throw new Error('gate proposal transport interruption')
    return proposal(context)
  })
  await coordinateThesisReview({ ...f, runtime })
  const gateFeedback = { gateId: 'report-check', feedback: { description: '补充第三节限制', locations: [{ section: 3 }], acceptance_criteria: ['补充限制'], judgment_constraints: [], route: 'local_patch' } }
  await assert.rejects(coordinateThesisReview({ ...f, runtime, gateFeedback }), /gate proposal transport interruption/)
  const reserved = await f.store.read()
  assert.equal(reserved.attempt.id, 'A-0001')
  assert.equal(reserved.attempt.cursor, 0)
  assert.equal(reserved.ledger.tasks.length, 1)
  assert.deepEqual([reserved.ledger.budget.used_rounds, reserved.ledger.budget.valid_reviews], [1, 1])
  assert.equal(await readFile(join(f.run, 'report.md'), 'utf8'), reportFixture(quote))
  interrupted = false
  const resumedStore = await openReviewStore({ runDir: f.run })
  const result = await coordinateThesisReview({ ...f, store: resumedStore, runtime, gateFeedback })
  const final = await resumedStore.read()
  assert.equal(result.review.verdict, 'pass')
  assert.equal(result.terminalReason, null)
  assert.equal(final.attempt.id, reserved.attempt.id)
  assert.equal(final.ledger.tasks.length, 1)
  assert.equal(final.ledger.tasks[0].id, reserved.ledger.tasks[0].id)
  assert.equal(final.ledger.tasks[0].status, 'resolved')
  assert.deepEqual([final.ledger.budget.used_rounds, final.ledger.budget.valid_reviews], [1, 2])
  assert.equal(final.attempt.results.length, 1)
  assert.deepEqual(runtime.calls.map(call => call.options.contract), ['review', 'proposal', 'proposal', 'review'])
})
