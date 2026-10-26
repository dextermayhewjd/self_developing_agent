import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, rm, chmod } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { captureReviewUpgradeBaseline, verifyReviewUpgrade, implementationSnapshot, implementationFingerprint } from '../../tools/codex_workflow/review-upgrade.mjs'
import { openState, writeJson } from '../../tools/codex_workflow/state.mjs'
import { createThesisInputTracker } from '../../tools/codex_workflow/thesis-inputs.mjs'
import { openReviewStore } from '../../tools/codex_workflow/review-store.mjs'
import { snapshotEvidence } from '../../tools/codex_workflow/review-evidence.mjs'
import { canonicalJson, sha256 } from '../../tools/codex_workflow/review-contracts.mjs'
import { reportFixture } from './fixtures/review-fixture.mjs'
import { registerGateIssue, markAwaitingReview } from '../../tools/codex_workflow/review-ledger.mjs'

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'review-upgrade-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const toolRoot = join(root, 'tools'), runDir = join(root, 'reports/00700_thesis_20261019')
  const put = async (path, value) => { await mkdir(join(path, '..'), { recursive: true }); await writeFile(path, value) }
  for (const path of ['.codex/workflows/equity-thesis.mjs', '.codex/skills/method.md',
    'tools/run_codex_workflow.mjs', 'tools/check_thesis_review.mjs', 'tools/codex_workflow/state.mjs',
    'tools/codex_workflow/review-coordinator.mjs', 'tools/codex_workflow/thesis.mjs']) await put(join(root, path), path)
  await put(join(root, 'data/00700/aggregate.json'), '{}')
  const tracker = await createThesisInputTracker({ root, symbol: '00700', runDir })
  await put(join(runDir, 'report.md'), reportFixture())
  await put(join(runDir, '疑惑.md'), '原始问题')
  const store = await openReviewStore({ runDir })
  await store.initialize({ reportBytes: await readFile(join(runDir, 'report.md')), evidence: await snapshotEvidence({ runDir }) })
  await put(join(runDir, '.codex-workflow/review/methodology.json'), '{"frozen":true}')
  const invocation = { reviewProtocol: 2, name: 'equity-thesis', args: { symbol: '00700', date: '20261019', root },
    executionConfig: { defaults: { model: 'test-model', effort: 'high' } }, jobs: 3, noPdf: false }
  const implementation = await implementationSnapshot({ root, toolRoot })
  const fingerprint = implementationFingerprint({ implementation, invocation, originals: tracker.manifest.originals })
  const state = { version: 1, fingerprint, stages: {}, invocation }
  await writeJson(join(runDir, '.codex-workflow/state.json'), state)
  const baseline = await captureReviewUpgradeBaseline({ root, toolRoot, runDir })
  const baselinePath = join(root, 'baseline.json')
  await writeFile(baselinePath, canonicalJson(baseline))
  return { root, toolRoot, runDir, put, invocation, state, baseline, baselinePath, store }
}

async function verify(f, overrides = {}) {
  const implementation = await implementationSnapshot(f)
  const fingerprint = implementationFingerprint({ implementation, invocation: f.invocation, originals: f.baseline.input_manifest.originals })
  return verifyReviewUpgrade({ ...f, previous: f.state, fingerprint, ...overrides })
}

test('review-only code upgrade preserves the Store and candidate and records one state transition', async t => {
  const f = await fixture(t)
  const report = await readFile(join(f.runDir, 'report.md'))
  const head = await readFile(join(f.runDir, '.codex-workflow/review/HEAD.json'))
  const before = await f.store.read()
  await f.put(join(f.toolRoot, 'codex_workflow/review-coordinator.mjs'), 'new review protocol')
  const record = await verify(f)
  assert.deepEqual(record.changes.map(change => change.path), ['codex_workflow/review-coordinator.mjs'])
  assert.equal(record.from, f.state.fingerprint)
  assert.notEqual(record.to, record.from)
  const opened = await openState({ dir: join(f.runDir, '.codex-workflow'), fingerprint: record.to, artifactRoots: [f.runDir], invocation: f.invocation,
    acceptFingerprintChange: ({ previous, fingerprint }) => verify(f, { previous, fingerprint }) })
  await opened.close()
  const saved = JSON.parse(await readFile(join(f.runDir, '.codex-workflow/state.json')))
  assert.equal(saved.fingerprint, record.to)
  assert.equal(saved.review_upgrades.length, 1)
  const reopened = await openState({ dir: join(f.runDir, '.codex-workflow'), fingerprint: record.to, artifactRoots: [f.runDir], invocation: f.invocation })
  await reopened.close()
  assert.equal(JSON.parse(await readFile(join(f.runDir, '.codex-workflow/state.json'))).review_upgrades.length, 1)
  assert.deepEqual(await readFile(join(f.runDir, 'report.md')), report)
  assert.deepEqual(await readFile(join(f.runDir, '.codex-workflow/review/HEAD.json')), head)
  assert.deepEqual((await f.store.read()).ledger, before.ledger)
})

for (const path of ['.codex/workflows/equity-thesis.mjs', '.codex/skills/method.md', 'tools/codex_workflow/thesis.mjs',
  'data/00700/aggregate.json', 'reports/00700_thesis_20261019/report.md', 'reports/00700_thesis_20261019/疑惑.md']) {
  test('upgrade rejects changed protected content: ' + path, async t => {
    const f = await fixture(t)
    await f.put(join(f.toolRoot, 'codex_workflow/review-coordinator.mjs'), 'new protocol')
    await f.put(join(f.root, path), 'changed protected content')
    await assert.rejects(verify(f), /changed|conflict|mismatch|digest|protected/i)
    assert.equal(JSON.parse(await readFile(join(f.runDir, '.codex-workflow/state.json'))).fingerprint, f.state.fingerprint)
  })
}

test('upgrade rejects a forged baseline or different execution configuration', async t => {
  const f = await fixture(t)
  await f.put(join(f.toolRoot, 'codex_workflow/review-coordinator.mjs'), 'new protocol')
  await assert.rejects(verify(f, { invocation: { ...f.invocation, executionConfig: { defaults: { model: 'other', effort: 'high' } } } }), /configuration|invocation/i)
  const forged = structuredClone(f.baseline)
  forged.implementation.before[0].content_base64 = Buffer.from('forged').toString('base64')
  await writeFile(f.baselinePath, canonicalJson(forged))
  await assert.rejects(verify(f), /baseline|digest|fingerprint/i)
})

test('normal resume still rejects code changes without an explicit upgrade', async t => {
  const f = await fixture(t)
  await assert.rejects(openState({ dir: join(f.runDir, '.codex-workflow'), fingerprint: 'different', artifactRoots: [f.runDir], invocation: f.invocation }), /changed.*reset/i)
})

test('baseline capture refuses an implementation that already differs from the saved run', async t => {
  const f = await fixture(t)
  await f.put(join(f.toolRoot, 'codex_workflow/review-coordinator.mjs'), 'changed before capture')
  await assert.rejects(captureReviewUpgradeBaseline(f), /changed before baseline/)
})

test('upgrade rejects new unapproved runtime files and a changed Store HEAD', async t => {
  const f = await fixture(t)
  await f.put(join(f.toolRoot, 'codex_workflow/unrelated.mjs'), 'new runtime code')
  await assert.rejects(verify(f), /protected implementation/)
  await rm(join(f.toolRoot, 'codex_workflow/unrelated.mjs'))
  await f.put(join(f.toolRoot, 'codex_workflow/review-coordinator.mjs'), 'new protocol')
  await f.store.setMaxRounds(3)
  await assert.rejects(verify(f), /HEAD changed/)
})

test('rejected upgrade leaves state bytes and candidate untouched', async t => {
  const f = await fixture(t)
  const statePath = join(f.runDir, '.codex-workflow/state.json')
  const before = await readFile(statePath)
  const report = await readFile(join(f.runDir, 'report.md'))
  await f.put(join(f.toolRoot, 'codex_workflow/thesis.mjs'), 'changed research code')
  const fingerprint = implementationFingerprint({ implementation: await implementationSnapshot(f), invocation: f.invocation, originals: f.baseline.input_manifest.originals })
  await assert.rejects(openState({ dir: join(f.runDir, '.codex-workflow'), fingerprint, artifactRoots: [f.runDir], invocation: f.invocation,
    acceptFingerprintChange: ({ previous, fingerprint }) => verify(f, { previous, fingerprint }) }), /protected implementation/)
  assert.deepEqual(await readFile(statePath), before)
  assert.deepEqual(await readFile(join(f.runDir, 'report.md')), report)
})

test('upgrade validates legacy exchange bytes and binding before changing the fingerprint', async t => {
  const f = await fixture(t)
  let state = await f.store.read()
  const ledger = registerGateIssue({ ledger: state.ledger, snapshot: state.snapshot, gateId: 'legacy',
    feedback: { description: 'legacy task', locations: [{ section: 3 }], acceptance_criteria: ['fix'], judgment_constraints: [], route: 'full_revision' } })
  state = await f.store.registerTasks({ ledger, reason: 'fixture' })
  state = await f.store.beginAttempt({ taskIds: state.ledger.tasks.map(task => task.id), snapshot: state.snapshot })
  const archive = { request: { path: 'exchanges/EX-legacy/request.json' }, response: { path: 'exchanges/EX-legacy/response.json' } }
  const context = { snapshot: state.snapshot, tasks: state.ledger.tasks }
  const response = { task_ids: state.attempt.task_ids, base_report_sha256: state.snapshot.report_sha256 }
  for (const [name, value] of Object.entries({ request: { context }, response })) {
    archive[name].sha256 = sha256(canonicalJson(value))
    await f.put(join(f.runDir, '.codex-workflow/review', archive[name].path), canonicalJson(value))
  }
  await f.store.checkpointAttempt({ attemptId: state.attempt.id, taskId: state.attempt.task_ids[0],
    result: { status: 'rejected', task_ids: state.attempt.task_ids, mode: 'full_revision', reason: 'proposal evidence ref coverage incomplete', archives: [archive] },
    reportBytes: await readFile(join(f.runDir, 'report.md')), ledger: state.ledger,
    evidence: JSON.parse(await readFile(join(f.runDir, '.codex-workflow/review/evidence-manifest.json'))) })
  await f.store.finalizeAttempt({ attemptId: state.attempt.id, reason: 'no_safe_edit' })
  f.baseline = await captureReviewUpgradeBaseline(f)
  await writeFile(f.baselinePath, canonicalJson(f.baseline))
  await f.put(join(f.toolRoot, 'codex_workflow/review-coordinator.mjs'), 'fixed protocol')
  await verify(f)
  const statePath = join(f.runDir, '.codex-workflow/state.json'), before = await readFile(statePath)
  await f.put(join(f.runDir, '.codex-workflow/review', archive.response.path), 'corrupted archived response')
  const fingerprint = implementationFingerprint({ implementation: await implementationSnapshot(f), invocation: f.invocation, originals: f.baseline.input_manifest.originals })
  await assert.rejects(openState({ dir: join(f.runDir, '.codex-workflow'), fingerprint, artifactRoots: [f.runDir], invocation: f.invocation,
    acceptFingerprintChange: ({ previous, fingerprint }) => verify(f, { previous, fingerprint }) }), /exchange digest/)
  assert.deepEqual(await readFile(statePath), before)
})

test('upgrade preserves a finalized applied batch awaiting independent review', async t => {
  const f = await fixture(t)
  let state = await f.store.read()
  const ledger = registerGateIssue({ ledger: state.ledger, snapshot: state.snapshot, gateId: 'gate',
    feedback: { description: 'task', locations: [{ section: 3 }], acceptance_criteria: ['fix'], judgment_constraints: [], route: 'full_revision' } })
  state = await f.store.registerTasks({ ledger, reason: 'fixture' })
  state = await f.store.beginAttempt({ taskIds: state.ledger.tasks.map(t => t.id), snapshot: state.snapshot })
  await assert.rejects(captureReviewUpgradeBaseline(f), /settled or recoverable/)
  const reportBytes = Buffer.from(reportFixture() + '\n已修订'), taskId = state.attempt.task_ids[0]
  const archive = {}
  for (const name of ['request', 'response']) {
    const bytes = canonicalJson({ name })
    archive[name] = { path: `exchanges/EX-applied/${name}.json`, sha256: sha256(bytes) }
    await f.put(join(f.runDir, '.codex-workflow/review', archive[name].path), bytes)
  }
  await f.store.checkpointAttempt({ attemptId: state.attempt.id, taskId, result: { status: 'applied', archives: [archive] }, reportBytes,
    ledger: markAwaitingReview({ ledger: state.ledger, taskIds: [taskId], snapshot: { ...state.snapshot, report_sha256: sha256(reportBytes) }, attemptId: state.attempt.id }),
    evidence: JSON.parse(await readFile(join(f.runDir, '.codex-workflow/review/evidence-manifest.json'))) })
  await f.store.finalizeAttempt({ attemptId: state.attempt.id })
  f.baseline = await captureReviewUpgradeBaseline(f)
  await writeFile(f.baselinePath, canonicalJson(f.baseline))
  const before = await f.store.read()
  await f.put(join(f.toolRoot, 'codex_workflow/review-coordinator.mjs'), 'correct review response before validation')
  await verify(f)
  assert.deepEqual(await f.store.read(), before)
  await f.put(join(f.runDir, '.codex-workflow/review', archive.response.path), '{}')
  const saved = await readFile(join(f.runDir, '.codex-workflow/state.json'))
  await assert.rejects(verify(f), /reference digest mismatch/)
  assert.deepEqual(await readFile(join(f.runDir, '.codex-workflow/state.json')), saved)
})

test('CLI rejects a changed producer lifecycle before recovering or rewriting its files', async t => {
  const f = await fixture(t)
  f.invocation.executionConfig = { ...f.invocation.executionConfig, codexVersion: '1.0.0', overrides: {}, stageConfig: {} }
  const implementation = await implementationSnapshot({ root: f.root })
  const coordinator = implementation.before.find(file => file.path.endsWith('/review-coordinator.mjs'))
  coordinator.content_base64 = Buffer.from('previous reviewed implementation').toString('base64')
  coordinator.sha256 = sha256(Buffer.from(coordinator.content_base64, 'base64'))
  f.state.fingerprint = implementationFingerprint({ implementation, invocation: f.invocation, originals: f.baseline.input_manifest.originals })
  f.baseline = { ...f.baseline, tool_root: fileURLToPath(new URL('../../tools/', import.meta.url)).replace(/\/$/, ''),
    fingerprint: f.state.fingerprint, state: f.state, implementation }
  await writeJson(join(f.runDir, '.codex-workflow/state.json'), f.state)
  await writeFile(f.baselinePath, canonicalJson(f.baseline))
  const tracker = await createThesisInputTracker({ root: f.root, symbol: '00700', runDir: f.runDir })
  await tracker.beforeStage('板块基准')
  const source = join(f.root, 'data/00700/peers_curated.json')
  await f.put(source, 'interrupted producer bytes')
  const manifestPath = join(f.runDir, '.codex-workflow/input-manifest.json')
  const manifestBytes = await readFile(manifestPath)
  const stateBytes = await readFile(join(f.runDir, '.codex-workflow/state.json'))
  const codex = join(f.root, 'bin/codex')
  await f.put(codex, '#!/usr/bin/env node\nprocess.stdout.write("codex-cli 1.0.0\\n")\n')
  await chmod(codex, 0o755)
  const cli = fileURLToPath(new URL('../../tools/run_codex_workflow.mjs', import.meta.url))
  await assert.rejects(promisify(execFile)(process.execPath, [cli, 'equity-thesis', '--root', f.root,
    '--symbol', '00700', '--date', '20261019', '--review-upgrade', f.baselinePath],
    { env: { ...process.env, PATH: join(f.root, 'bin') + ':' + process.env.PATH } }), /input manifest changed|unsettled|Unclassified/i)
  assert.deepEqual(await readFile(manifestPath), manifestBytes)
  assert.deepEqual(await readFile(join(f.runDir, '.codex-workflow/state.json')), stateBytes)
  assert.equal(await readFile(source, 'utf8'), 'interrupted producer bytes')
})
