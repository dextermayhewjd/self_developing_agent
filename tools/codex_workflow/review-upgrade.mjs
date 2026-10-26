import { readFile, readdir, realpath } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join, resolve, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { canonicalJson, sha256 } from './review-contracts.mjs'
import { inspectReviewStore, recoverableEvidenceRejection, validateEvidenceRejectionArchives, validateProposalArchives } from './review-store.mjs'
import { loadEvidenceContext } from './review-evidence.mjs'
import { resolveThesisInputManifest, assertClassified, assertDerivedCurrent } from './thesis-inputs.mjs'

const defaultToolRoot = resolve(fileURLToPath(new URL('../', import.meta.url)))
const same = (a, b) => canonicalJson(a) === canonicalJson(b)
const json = async path => JSON.parse(await readFile(path, 'utf8'))
const fail = message => { throw Error('Review upgrade: ' + message) }
// Research and evidence validation remain protected. The Store/proposal entries
// support the audited recovery of a rejected reference-copy proposal.
const allowedChanges = new Set([
  'run_codex_workflow.mjs', 'codex_workflow/state.mjs',
  'codex_workflow/review-coordinator.mjs', 'codex_workflow/review-contracts.mjs',
  'codex_workflow/review-upgrade.mjs',
  'codex_workflow/review-proposals.mjs', 'codex_workflow/review-store.mjs',
])

/** Keep the legacy fingerprint ordering so captured source bytes prove its value. */
export async function implementationSnapshot({ root, toolRoot = defaultToolRoot }) {
  const before = [], after = [], visited = new Set()
  async function walk(path, output) {
    let entries
    try { entries = await readdir(path, { withFileTypes: true }) }
    catch (error) {
      if (error.code !== 'ENOTDIR') throw error
      const bytes = await readFile(path)
      output.push({ path, sha256: sha256(bytes), content_base64: bytes.toString('base64') })
      return
    }
    const physical = await realpath(path)
    if (visited.has(physical)) return
    visited.add(physical)
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === 'evidence' && path.endsWith('/calibrate-equity-thesis')) continue
      if (entry.name !== '.codex-workflow') await walk(join(path, entry.name), output)
    }
  }
  await walk(join(root, '.codex/workflows/equity-thesis.mjs'), before)
  await walk(join(root, '.codex/skills'), before)
  await walk(join(toolRoot, 'codex_workflow'), before)
  await walk(join(toolRoot, 'run_codex_workflow.mjs'), before)
  await walk(join(toolRoot, 'check_thesis_review.mjs'), after)
  return { before, after }
}

function researchArgs(args) {
  const value = { ...args }
  delete value.review_only
  delete value.reviewMaxRounds
  delete value.review_max_rounds
  return value
}

export function implementationFingerprint({ implementation, invocation, originals }) {
  const hash = createHash('sha256').update(JSON.stringify({ name: 'equity-thesis', args: researchArgs(invocation.args), executionConfig: invocation.executionConfig }))
  const seen = new Set()
  function include(files) {
    if (!Array.isArray(files)) fail('invalid baseline source inventory')
    for (const file of files) {
      if (typeof file.path !== 'string' || typeof file.content_base64 !== 'string' || seen.has(file.path)) fail('invalid or duplicate baseline source')
      seen.add(file.path)
      const bytes = Buffer.from(file.content_base64, 'base64')
      if (bytes.toString('base64') !== file.content_base64 || sha256(bytes) !== file.sha256) fail('baseline source digest mismatch')
      hash.update(file.path).update(bytes)
    }
  }
  include(implementation.before)
  hash.update(JSON.stringify(originals))
  include(implementation.after)
  return hash.digest('hex')
}

async function currentProof({ root, runDir, state, inputManifest }) {
  if (state.invocation?.name !== 'equity-thesis' || state.invocation.reviewProtocol !== 2 ||
      runDir !== join(root, `reports/${state.invocation.args.symbol}_thesis_${state.invocation.args.date}`)) fail('unsupported run binding')
  if (Object.keys(inputManifest.producers?.active ?? {}).length || inputManifest.producers?.pending?.length) fail('unsettled research producer')
  const physicalInputs = await resolveThesisInputManifest({ root, symbol: state.invocation.args.symbol, previousManifest: inputManifest })
  assertClassified(physicalInputs)
  assertDerivedCurrent(physicalInputs)
  if (!same(physicalInputs.originals, inputManifest.originals)) fail('original inputs changed')
  const proof = await inspectReviewStore({ runDir })
  const awaitingReview = proof && proof.ledger.terminal_reason === null && proof.attempt?.state === 'finalized' &&
    proof.attempt.cursor === proof.attempt.task_ids.length && proof.attempt.results.some(item => item.result.status === 'applied')
  if (!proof || (proof.ledger.active_attempt_id !== null && !awaitingReview && !recoverableEvidenceRejection(proof))) fail('candidate with settled or recoverable review Store required')
  if (recoverableEvidenceRejection(proof)) await validateEvidenceRejectionArchives({ runDir, state: proof })
  await validateProposalArchives({ runDir, state: proof })
  await loadEvidenceContext({ runDir, manifest: proof.evidence })
  if (sha256(await readFile(join(runDir, 'report.md'))) !== proof.snapshot.report_sha256) fail('candidate report changed')
  return proof
}

/** Read-only capture. Caller holds the normal symbol and run locks. */
export async function captureReviewUpgradeBaseline({ root, runDir, toolRoot = defaultToolRoot }) {
  root = resolve(root); runDir = resolve(runDir); toolRoot = resolve(toolRoot)
  const control = join(runDir, '.codex-workflow')
  const state = await json(join(control, 'state.json'))
  const inputManifest = await json(join(control, 'input-manifest.json'))
  const proof = await currentProof({ root, runDir, state, inputManifest })
  const implementation = await implementationSnapshot({ root, toolRoot })
  if (implementationFingerprint({ implementation, invocation: state.invocation, originals: inputManifest.originals }) !== state.fingerprint) fail('code changed before baseline capture')
  return { version: 1, kind: 'thesis-review-upgrade', created_at: new Date().toISOString(), root, tool_root: toolRoot, run_dir: runDir,
    fingerprint: state.fingerprint, state, input_manifest: inputManifest, implementation,
    head: await json(join(control, 'review/HEAD.json')), snapshot: proof.snapshot,
    methodology_sha256: sha256(await readFile(join(control, 'review/methodology.json'))) }
}

/** Verify first; the state owner performs the single durable state transition. */
export async function verifyReviewUpgrade({ root, runDir, baselinePath, previous, fingerprint, invocation, toolRoot = defaultToolRoot }) {
  root = resolve(root); runDir = resolve(runDir); toolRoot = resolve(toolRoot)
  const baseline = await json(baselinePath), control = join(runDir, '.codex-workflow')
  if (baseline.version !== 1 || baseline.kind !== 'thesis-review-upgrade' || baseline.root !== root ||
      baseline.tool_root !== toolRoot || baseline.run_dir !== runDir) fail('baseline run binding mismatch')
  const inputManifest = await json(join(control, 'input-manifest.json'))
  if (!same(inputManifest, baseline.input_manifest)) fail('input manifest changed')
  // Baselines use canonical JSON; the legacy hash used insertion-ordered JSON.
  // Reconstruct with the unchanged state/input serialization, after comparing
  // their complete values to the baseline, rather than its reordered objects.
  if (baseline.fingerprint !== previous.fingerprint || !same(baseline.state, previous) ||
      implementationFingerprint({ implementation: baseline.implementation, invocation: previous.invocation, originals: inputManifest.originals }) !== previous.fingerprint) fail('baseline fingerprint or state mismatch')
  for (const key of ['executionConfig', 'jobs', 'noPdf']) if (!same(invocation[key], previous.invocation[key])) fail('execution configuration changed: ' + key)
  if (!same(researchArgs(invocation.args), researchArgs(previous.invocation.args))) fail('research invocation changed')
  const proof = await currentProof({ root, runDir, state: previous, inputManifest })
  if (!same(proof.snapshot, baseline.snapshot) || !same(await json(join(control, 'review/HEAD.json')), baseline.head)) fail('review Store HEAD changed')
  if (sha256(await readFile(join(control, 'review/methodology.json'))) !== baseline.methodology_sha256) fail('frozen methodology changed')
  const current = await implementationSnapshot({ root, toolRoot })
  if (implementationFingerprint({ implementation: current, invocation, originals: inputManifest.originals }) !== fingerprint) fail('current implementation fingerprint mismatch')
  const files = value => new Map([...value.before, ...value.after].map(file => [file.path, file.sha256]))
  const oldFiles = files(baseline.implementation), newFiles = files(current), changes = []
  for (const path of [...new Set([...oldFiles.keys(), ...newFiles.keys()])].sort()) {
    if (oldFiles.get(path) === newFiles.get(path)) continue
    const name = relative(toolRoot, path)
    if (!allowedChanges.has(name)) fail('protected implementation changed: ' + path)
    changes.push({ path: name, before_sha256: oldFiles.get(path) ?? null, after_sha256: newFiles.get(path) ?? null })
  }
  if (!changes.length) fail('no review implementation changes')
  return { version: 1, kind: 'review-only', created_at: new Date().toISOString(), from: previous.fingerprint, to: fingerprint,
    baseline: resolve(baselinePath), baseline_sha256: sha256(canonicalJson(baseline)), changes, snapshot: proof.snapshot, head: baseline.head }
}
