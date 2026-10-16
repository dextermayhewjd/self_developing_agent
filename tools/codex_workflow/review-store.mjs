import { mkdir, open, readFile, rename, readdir, lstat, unlink, link } from 'node:fs/promises'
import { join, dirname, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { canonicalJson, sha256 } from './review-contracts.mjs'
import { createLedger, reconcileReview, markAwaitingReview, unresolvedBlockers } from './review-ledger.mjs'

const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const hash = value => sha256(canonicalJson(value))
const same = (left, right) => canonicalJson(left) === canonicalJson(right)
const fail = message => { throw new Error(message) }
const clone = value => structuredClone(value)
function checkMax(value) {
  if (!Number.isInteger(value) || value < 1 || value > 10) fail('maxRounds must be an integer from 1 to 10')
}
function checkEvidence(value) {
  if (value?.version !== 2 || !Array.isArray(value.sources) || !digest(value.sha256) || value.sha256 !== hash({ version: 2, sources: value.sources })) fail('invalid evidence manifest digest')
  return clone(value)
}
function checkSnapshot(value, expected) {
  if (!digest(value?.report_sha256) || !digest(value?.evidence_sha256) || !same(value, expected)) fail('Snapshot does not match current report/evidence')
}
const nonempty = value => typeof value === 'string' && value.trim().length > 0
function fieldsOnly(value, required, optional = []) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && required.every(key => Object.hasOwn(value, key)) &&
    Object.keys(value).every(key => required.includes(key) || optional.includes(key))
}
function checkTaskReferences(task, snapshot) {
  for (const location of task.locations) {
    if (!fieldsOnly(location, ['section'], ['quote']) || !Number.isInteger(location.section) || location.section < 1 || location.section > 12 ||
        (Object.hasOwn(location, 'quote') && typeof location.quote !== 'string')) fail('invalid registered task location')
  }
  for (const ref of task.evidence_refs) {
    if (!fieldsOnly(ref, ['source', 'source_sha256', 'evidence_sha256', 'quote'], ['transcript_path', 'transcript_sha256']) ||
        !nonempty(ref.source) || !nonempty(ref.quote) || !digest(ref.source_sha256) || !digest(ref.evidence_sha256) || ref.evidence_sha256 !== snapshot.evidence_sha256) fail('invalid registered task evidence reference')
    const hasPath = Object.hasOwn(ref, 'transcript_path')
    const hasDigest = Object.hasOwn(ref, 'transcript_sha256')
    if (hasPath !== hasDigest || (hasPath && (!nonempty(ref.transcript_path) || !digest(ref.transcript_sha256)))) fail('invalid registered task transcript reference')
  }
}
async function optionalBytes(path) {
  try {
    const stat = await lstat(path)
    if (!stat.isFile() || stat.isSymbolicLink()) fail(`unsafe file: ${path}`)
    return await readFile(path)
  } catch (error) { if (error.code === 'ENOENT') return null; throw error }
}
async function syncDir(path) {
  const file = await open(path, 'r')
  try { await file.sync() } finally { await file.close() }
}
async function durableDirectory(path) {
  const parent = dirname(path)
  if (parent !== path) {
    await durableDirectory(parent)
    try { await mkdir(path) } catch (error) { if (error.code !== 'EEXIST') throw error }
    // Sync even preexisting entries: they may have been created by an interrupted
    // writer before its parent-directory sync completed.
    await syncDir(parent)
  }
  await syncDir(path)
}
async function atomicWrite(path, bytes) {
  await durableDirectory(dirname(path))
  const temp = join(dirname(path), `.${randomUUID()}.tmp`)
  const file = await open(temp, 'wx', 0o600)
  try {
    await file.writeFile(bytes)
    await file.sync()
  } finally { await file.close() }
  try {
    await rename(temp, path)
    await syncDir(dirname(path))
  } finally { await unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error }) }
}

/** Caller holds the existing outer run lock; this module never starts workers. */
export async function openReviewStore({ runDir, maxRounds, emit = () => {}, failpoint = () => {} }) {
  if (maxRounds !== undefined) checkMax(maxRounds)
  const store = new ReviewStore({ runDir: resolve(runDir), maxRounds, emit, failpoint })
  await store.recover()
  if (maxRounds !== undefined && await store.read()) await store.setMaxRounds(maxRounds)
  return store
}

class ReviewStore {
  constructor({ runDir, maxRounds, emit, failpoint }) {
    this.runDir = runDir
    this.dir = join(runDir, '.codex-workflow/review')
    this.initialMaxRounds = maxRounds ?? 2
    this.emit = emit
    this.failpoint = failpoint
  }
  async point(name, context = {}) { await this.failpoint(name, context) }
  path(reference) {
    if (!reference || !digest(reference.sha256) || typeof reference.path !== 'string' || !/^[a-z-]+\/[A-Z]+-[a-zA-Z0-9-]+\.(json|md)$/.test(reference.path)) fail('invalid immutable reference')
    return join(this.dir, reference.path)
  }
  async object(reference, json = true) {
    const bytes = await optionalBytes(this.path(reference))
    if (bytes === null) fail(`missing immutable object ${reference.path}`)
    if (sha256(bytes) !== reference.sha256) fail(`immutable SHA digest mismatch: ${reference.path}`)
    return json ? JSON.parse(bytes.toString('utf8')) : bytes
  }
  async immutable(path, bytes, kind) {
    const full = join(this.dir, path)
    await durableDirectory(dirname(full))
    const existing = await optionalBytes(full)
    if (existing !== null && !existing.equals(bytes)) fail(`immutable collision: ${path}`)
    if (existing === null) {
      // Publish only complete, fsynced bytes. An interrupted write can leave a
      // temporary file, never a truncated object at its immutable final path.
      const temp = join(dirname(full), `.${randomUUID()}.tmp`)
      const file = await open(temp, 'wx', 0o600)
      try { await file.writeFile(bytes); await file.sync() } finally { await file.close() }
      try {
        await this.point('after_object_staged', { kind, path })
        try { await link(temp, full) }
        catch (error) {
          if (error.code !== 'EEXIST') throw error
          const old = await optionalBytes(full)
          if (!old || !old.equals(bytes)) fail(`immutable collision: ${path}`)
        }
      } finally { await unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error }) }
    } else {
      // A verified orphan may have survived without its inode/entry syncs.
      const file = await open(full, 'r')
      try { await file.sync() } finally { await file.close() }
    }
    await syncDir(dirname(full))
    const ref = { path, sha256: sha256(bytes) }
    await this.object(ref, false)
    await this.point('after_object', { kind, reference: ref })
    return ref
  }
  async jsonObject(folder, prefix, value, name) {
    const bytes = Buffer.from(canonicalJson(value))
    return this.immutable(`${folder}/${name ?? `${prefix}-${sha256(bytes)}`}.json`, bytes, folder)
  }
  async head() {
    const bytes = await optionalBytes(join(this.dir, 'HEAD.json'))
    return bytes === null ? null : JSON.parse(bytes.toString('utf8'))
  }
  async load(reference, seen = new Set()) {
    if (seen.has(reference?.path)) fail('cyclic commit ancestry')
    seen.add(reference.path)
    const commit = await this.object(reference)
    if (commit.version !== 2 || !/^CP-\d{6,}$/.test(commit.id) || reference.path !== `commits/${commit.id}.json` || !commit.refs) fail('invalid commit')
    const values = {}
    for (const [key, ref] of Object.entries(commit.refs)) values[key] = ref === null ? null : await this.object(ref, key !== 'report' && key !== 'review_report')
    for (const key of ['report', 'ledger', 'evidence', 'attempt', 'review', 'receipt', 'review_input_ledger', 'review_output_ledger', 'review_report', 'review_evidence']) {
      if (!Object.hasOwn(values, key)) fail(`missing commit reference ${key}`)
    }
    const { ledger, evidence, attempt, review, receipt } = values
    if (ledger?.version !== 2 || !Array.isArray(ledger.tasks)) fail('invalid ledger object')
    checkEvidence(evidence)
    checkSnapshot(commit.snapshot, { report_sha256: sha256(values.report), evidence_sha256: evidence.sha256 })
    if (ledger.active_attempt_id !== null && (!attempt || attempt.id !== ledger.active_attempt_id || !same(attempt.current_snapshot, commit.snapshot))) fail('attempt does not match committed candidate')
    if (review || receipt) {
      if (!review || !receipt || !values.review_input_ledger || !values.review_output_ledger || !values.review_report || !values.review_evidence) fail('incomplete immutable review receipt binding')
      checkEvidence(values.review_evidence)
      const reviewSnapshot = { report_sha256: sha256(values.review_report), evidence_sha256: values.review_evidence.sha256 }
      for (const key of ['report_sha256', 'evidence_sha256']) if (review[key] !== reviewSnapshot[key] || receipt[key] !== reviewSnapshot[key]) fail(`review receipt ${key} mismatch`)
      if (review.review_id !== receipt.review_id || review.input_ledger_sha256 !== hash(values.review_input_ledger) || receipt.input_ledger_sha256 !== review.input_ledger_sha256 || receipt.output_ledger_sha256 !== hash(values.review_output_ledger)) fail('review receipt ledger binding mismatch')
      const checked = reconcileReview({ ledger: values.review_input_ledger, review, snapshot: reviewSnapshot })
      if (!same(checked.ledger, values.review_output_ledger) || !same(checked.receipt, receipt)) fail('immutable review reconciliation mismatch')
    }
    const previous = commit.previous === null ? null : await this.load(commit.previous, seen)
    return { reference, commit, values, previous }
  }
  state(loaded) {
    const { ledger, attempt, review, receipt } = loaded.values
    return clone({ ledger, snapshot: loaded.commit.snapshot, attempt, review, receipt, commit: loaded.commit })
  }
  displays(loaded) {
    if (!loaded) return new Map()
    const { report, ledger, evidence, review, receipt, attempt } = loaded.values
    const entries = new Map([
      [join(this.runDir, 'report.md'), { bytes: report, label: 'report' }],
      [join(this.dir, 'ledger.json'), { bytes: Buffer.from(canonicalJson(ledger)), label: 'ledger' }],
      [join(this.dir, 'evidence-manifest.json'), { bytes: Buffer.from(canonicalJson(evidence)), label: 'evidence' }],
    ])
    if (attempt) entries.set(join(this.dir, `attempts/${attempt.id}.json`), { bytes: Buffer.from(canonicalJson(attempt)), label: 'attempt' })
    if (review) entries.set(join(this.runDir, '成稿审查.json'), {
      bytes: Buffer.from(canonicalJson({ ...review, blocking_issues: unresolvedBlockers(ledger).map(task => task.description), receipt,
        raw_review_path: join('.codex-workflow/review', loaded.commit.refs.review.path) })), label: 'review',
    })
    return entries
  }
  async materialize(loaded) {
    const previous = this.displays(loaded.previous)
    const targets = this.displays(loaded)
    // Check every target first, so a conflict cannot partly replace other entrypoints.
    const check = async (path, bytes) => {
      const existing = await optionalBytes(path)
      const old = previous.get(path)?.bytes
      if (existing !== null && !existing.equals(bytes) && !(old && existing.equals(old))) fail(`manual edit conflict: ${path}`)
      return existing
    }
    let needed = false
    for (const [path, { bytes }] of targets) {
      const existing = await check(path, bytes)
      if (existing === null || !existing.equals(bytes)) needed = true
    }
    if (!needed) return
    await this.point('before_materialize')
    for (const [path, { bytes, label }] of targets) {
      const existing = await check(path, bytes)
      if (existing === null || !existing.equals(bytes)) await atomicWrite(path, bytes)
      await this.point(`after_materialize_${label}`)
    }
    await this.point('after_materialize')
  }
  async recover() {
    const reference = await this.head()
    if (reference === null) return null
    const loaded = await this.load(reference)
    await this.materialize(loaded)
    return this.state(loaded)
  }
  async read() { return this.recover() }
  async current() {
    if (await this.recover() === null) fail('review store is not initialized')
    return this.load(await this.head())
  }
  async nextCommitId() {
    let entries
    try { entries = await readdir(join(this.dir, 'commits')) } catch (error) { if (error.code !== 'ENOENT') throw error; entries = [] }
    const numbers = entries.map(name => /^CP-(\d{6,})\.json$/.exec(name)).filter(Boolean).map(match => Number(match[1]))
    return `CP-${String(Math.max(0, ...numbers) + 1).padStart(6, '0')}`
  }
  async publish({ previous, reportBytes, ledger, evidence, attempt, review, receipt, reviewInputLedger, registrationReason }) {
    const reportRef = await this.immutable(`reports/RP-${sha256(reportBytes)}.md`, reportBytes, 'reports')
    const refs = {
      report: reportRef,
      ledger: await this.jsonObject('ledgers', 'LG', ledger),
      evidence: await this.jsonObject('evidence', 'EV', evidence),
      attempt: attempt ? await this.jsonObject('attempt-snapshots', 'AS', attempt) : null,
      review: previous?.commit.refs.review ?? null,
      receipt: previous?.commit.refs.receipt ?? null,
      review_input_ledger: previous?.commit.refs.review_input_ledger ?? null,
      review_output_ledger: previous?.commit.refs.review_output_ledger ?? null,
      review_report: previous?.commit.refs.review_report ?? null,
      review_evidence: previous?.commit.refs.review_evidence ?? null,
    }
    if (review) {
      if (!/^RV-[A-Za-z0-9-]+$/.test(review.review_id)) fail('review_id must be a safe RV- identifier')
      refs.review = await this.jsonObject('reviews', 'RV', review, review.review_id)
      refs.receipt = await this.jsonObject('receipts', 'RV', receipt, review.review_id)
      refs.review_input_ledger = await this.jsonObject('ledgers', 'LG', reviewInputLedger)
      refs.review_output_ledger = refs.ledger
      refs.review_report = refs.report
      refs.review_evidence = refs.evidence
    }
    await this.point('after_objects')
    const commit = { version: 2, id: await this.nextCommitId(), previous: previous?.reference ?? null,
      snapshot: { report_sha256: reportRef.sha256, evidence_sha256: evidence.sha256 }, refs }
    if (registrationReason !== undefined) commit.registration_reason = registrationReason
    const reference = await this.jsonObject('commits', 'CP', commit, commit.id)
    await this.point('after_commit', { reference })
    // All linked bytes must be readable and verified before HEAD authorizes them.
    const loaded = await this.load(reference)
    await this.point('before_head', { reference })
    await atomicWrite(join(this.dir, 'HEAD.json'), Buffer.from(canonicalJson(reference)))
    await this.point('after_head', { reference })
    await this.materialize(loaded)
    return this.state(loaded)
  }
  async initialize({ reportBytes, evidence }) {
    const existing = await this.head()
    if (existing !== null) return this.recover()
    if (!Buffer.isBuffer(reportBytes) && typeof reportBytes !== 'string' && !(reportBytes instanceof Uint8Array)) fail('reportBytes must be bytes or string')
    const bytes = Buffer.from(reportBytes)
    const manual = await optionalBytes(join(this.runDir, 'report.md'))
    if (manual !== null && !manual.equals(bytes)) fail('manual edit conflict: report.md')
    return this.publish({ previous: null, reportBytes: bytes, ledger: createLedger({ maxRounds: this.initialMaxRounds }), evidence: checkEvidence(evidence), attempt: null })
  }
  async commitReview({ review, ledger, receipt, evidence }) {
    const current = await this.current()
    const { attempt } = current.values
    if (current.values.ledger.active_attempt_id !== null) {
      if (!attempt || attempt.state !== 'finalized' || attempt.cursor !== attempt.task_ids.length) fail('batch must be finalized before independent review')
      if (current.values.ledger.terminal_reason !== null || !attempt.results.some(entry => entry.result.status === 'applied')) fail('no progress; needs_evidence/terminal attempt cannot consume a review')
    }
    const manifest = checkEvidence(evidence)
    const snapshot = { report_sha256: current.commit.snapshot.report_sha256, evidence_sha256: manifest.sha256 }
    const checked = reconcileReview({ ledger: current.values.ledger, review, snapshot })
    if (!same(checked.ledger, ledger) || !same(checked.receipt, receipt)) fail('supplied ledger/receipt does not match independent reconciliation')
    return this.publish({ previous: current, reportBytes: current.values.report, ledger: clone(ledger), evidence: manifest, attempt,
      review: clone(review), receipt: clone(receipt), reviewInputLedger: current.values.ledger })
  }
  /** Add-only host registration of independent hard-gate repair tasks. */
  async registerTasks({ ledger, reason }) {
    const current = await this.current()
    const old = current.values.ledger
    if (typeof reason !== 'string' || !reason.trim()) fail('task registration requires a reason')
    if (same(ledger, old)) return this.state(current)
    if (old.active_attempt_id !== null) fail('cannot register new tasks during an active attempt')
    if (!Array.isArray(ledger?.tasks) || ledger.tasks.length <= old.tasks.length || !same(ledger.tasks.slice(0, old.tasks.length), old.tasks) ||
        !same({ ...ledger, tasks: old.tasks, next_task_number: old.next_task_number }, old)) fail('registration is append-only; existing tasks and budget must remain unchanged')
    const added = ledger.tasks.slice(old.tasks.length)
    const keys = new Set(old.tasks.map(task => task.issue_key))
    for (const [index, task] of added.entries()) {
      const id = `RT-${String(old.next_task_number + index).padStart(6, '0')}`
      if (task.id !== id || task.status !== 'open' || typeof task.issue_key !== 'string' || !task.issue_key.trim() || keys.has(task.issue_key)) fail('registered tasks need new monotonic IDs and unique open issue keys')
      keys.add(task.issue_key)
      if (!['blocking', 'disclosure', 'watch'].includes(task.kind) || typeof task.blocks_delivery !== 'boolean' || (task.kind === 'blocking' && !task.blocks_delivery) || (task.kind === 'watch' && task.blocks_delivery)) fail('invalid registered task kind')
      if (typeof task.description !== 'string' || !task.description.trim() || !Array.isArray(task.acceptance_criteria) || !task.acceptance_criteria.length || task.acceptance_criteria.some(value => typeof value !== 'string' || !value.trim()) || !Array.isArray(task.locations) || !task.locations.length || !Array.isArray(task.evidence_refs) || !['local_patch', 'full_revision', 'needs_evidence'].includes(task.route) || !Array.isArray(task.history) || !task.history.length || typeof task.created_review_id !== 'string' || typeof task.last_review_id !== 'string') fail('invalid registered task contract')
      checkSnapshot({ report_sha256: task.report_sha256, evidence_sha256: task.evidence_sha256 }, current.commit.snapshot)
      checkTaskReferences(task, current.commit.snapshot)
    }
    if (ledger.next_task_number !== old.next_task_number + added.length) fail('registered task next_task_number mismatch')
    return this.publish({ previous: current, reportBytes: current.values.report, ledger: clone(ledger), evidence: current.values.evidence, attempt: current.values.attempt, registrationReason: reason })
  }
  async beginAttempt({ taskIds, snapshot }) {
    const current = await this.current()
    checkSnapshot(snapshot, current.commit.snapshot)
    const ledger = clone(current.values.ledger)
    if (ledger.active_attempt_id !== null) fail('active attempt must finish before reserving another attempt')
    if (ledger.budget.used_rounds >= ledger.budget.max_rounds) fail('revision round budget exhausted')
    if (!Array.isArray(taskIds) || !taskIds.length || new Set(taskIds).size !== taskIds.length) fail('attempt requires unique task IDs')
    for (const id of taskIds) if (!ledger.tasks.some(task => task.id === id && task.status === 'open')) fail(`task ${id} must be open`)
    const attemptId = `A-${String(ledger.budget.used_rounds + 1).padStart(4, '0')}`
    ledger.budget.used_rounds++
    ledger.active_attempt_id = attemptId
    ledger.terminal_reason = null
    const attempt = { id: attemptId, state: 'collecting', task_ids: [...taskIds], cursor: 0, base_snapshot: clone(snapshot), current_snapshot: clone(snapshot), results: [] }
    return this.publish({ previous: current, reportBytes: current.values.report, ledger, evidence: current.values.evidence, attempt })
  }
  async checkpointAttempt({ attemptId, taskId, result, reportBytes, ledger, evidence }) {
    const current = await this.current()
    const attempt = clone(current.values.attempt)
    if (!attempt || attempt.id !== attemptId || current.values.ledger.active_attempt_id !== attemptId) fail('unknown active attempt')
    const manifest = checkEvidence(evidence)
    const bytes = Buffer.from(reportBytes)
    const snapshot = { report_sha256: sha256(bytes), evidence_sha256: manifest.sha256 }
    const prior = attempt.results.find(entry => entry.task_id === taskId)
    if (prior) {
      if (same(prior.result, result) && same(prior.snapshot, snapshot) && prior.output_ledger_sha256 === hash(ledger)) return this.state(current)
      fail('task already completed; conflicting checkpoint replay')
    }
    if (!['collecting', 'applying'].includes(attempt.state)) fail('attempt is already finalized')
    if (attempt.task_ids[attempt.cursor] !== taskId) fail('checkpoint task is out of fixed batch order')
    if (!['applied', 'needs_evidence', 'escalate', 'rejected'].includes(result?.status)) fail('invalid final task result status')
    if (manifest.sha256 !== current.commit.snapshot.evidence_sha256) fail('attempt evidence snapshot changed')
    const ids = result.task_ids ?? [taskId]
    if (!Array.isArray(ids) || !ids.includes(taskId) || !ids.length || new Set(ids).size !== ids.length || ids.some(id => !attempt.task_ids.includes(id) || attempt.results.some(entry => entry.task_id === id))) fail('invalid checkpoint task group')
    let expected = current.values.ledger
    if (result.status === 'applied') {
      if (snapshot.report_sha256 === current.commit.snapshot.report_sha256) fail('applied result must change report bytes')
      expected = markAwaitingReview({ ledger: expected, taskIds: ids, snapshot, attemptId })
    } else if (!bytes.equals(current.values.report)) fail('nonapplied result cannot change report')
    if (!same(expected, ledger)) fail('checkpoint ledger differs from permitted host task transition')
    for (const id of ids) attempt.results.push({ task_id: id, result: clone(result), snapshot: clone(snapshot), output_ledger_sha256: hash(ledger) })
    attempt.cursor = attempt.task_ids.findIndex(id => !attempt.results.some(entry => entry.task_id === id))
    if (attempt.cursor < 0) attempt.cursor = attempt.task_ids.length
    attempt.state = 'applying'
    attempt.current_snapshot = snapshot
    return this.publish({ previous: current, reportBytes: bytes, ledger: clone(ledger), evidence: manifest, attempt })
  }
  async finalizeAttempt({ attemptId, reason }) {
    const current = await this.current()
    const attempt = clone(current.values.attempt)
    if (!attempt || attempt.id !== attemptId || current.values.ledger.active_attempt_id !== attemptId) fail('unknown active attempt')
    if (attempt.state === 'finalized') {
      if ((reason ?? null) !== current.values.ledger.terminal_reason) fail('conflicting finalization reason')
      return this.state(current)
    }
    if (attempt.cursor !== attempt.task_ids.length) fail('cannot finalize an unfinished task batch')
    const progressed = attempt.results.some(entry => entry.result.status === 'applied')
    if (!progressed && !(typeof reason === 'string' && reason.trim())) fail('no-progress attempt requires an explicit terminal reason')
    if (reason !== undefined && (typeof reason !== 'string' || !reason.trim())) fail('invalid terminal reason')
    attempt.state = 'finalized'
    const ledger = clone(current.values.ledger)
    ledger.terminal_reason = reason ?? null
    return this.publish({ previous: current, reportBytes: current.values.report, ledger, evidence: current.values.evidence, attempt })
  }
  async setMaxRounds(value) {
    checkMax(value)
    const current = await this.current()
    const ledger = clone(current.values.ledger)
    if (value < ledger.budget.used_rounds) fail('maxRounds cannot be below consumed used rounds')
    if (value === ledger.budget.max_rounds) return this.state(current)
    const previous = ledger.budget.max_rounds
    if (value > previous) ledger.budget.extensions.push({ from: previous, to: value, used_rounds: ledger.budget.used_rounds })
    ledger.budget.max_rounds = value
    const state = await this.publish({ previous: current, reportBytes: current.values.report, ledger, evidence: current.values.evidence, attempt: current.values.attempt })
    await this.emit({ type: 'review_budget_changed', from: previous, to: value, used_rounds: ledger.budget.used_rounds })
    return state
  }
  /** Persist a host stop without reserving a round or rewriting task history. */
  async recordStop({ reason }) {
    if (reason !== null && (typeof reason !== 'string' || !reason.trim())) fail('stop reason must be nonempty text or explicit null')
    const current = await this.current()
    if (current.values.ledger.terminal_reason === reason) return this.state(current)
    const ledger = clone(current.values.ledger)
    ledger.terminal_reason = reason
    return this.publish({ previous: current, reportBytes: current.values.report, ledger, evidence: current.values.evidence, attempt: current.values.attempt })
  }
  /** snapshot MUST be recomputed by the caller from the current physical evidence inventory. */
  async assertDeliverable({ snapshot }) {
    const current = await this.current()
    checkSnapshot(snapshot, current.commit.snapshot)
    const { ledger, review, receipt } = current.values
    if (!review || !receipt || review.verdict !== 'pass') fail('latest independent review must pass')
    if (ledger.active_attempt_id !== null || unresolvedBlockers(ledger).length) fail('unresolved blocking tasks or active attempt prevent delivery')
    if (receipt.output_ledger_sha256 !== hash(ledger)) fail('receipt output ledger does not match current ledger')
    for (const key of ['report_sha256', 'evidence_sha256']) if (receipt[key] !== snapshot[key] || review[key] !== snapshot[key]) fail(`review receipt ${key} does not match current Snapshot`)
    return this.state(current)
  }
}
