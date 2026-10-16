import { readFile, readdir, lstat, realpath, mkdir, unlink, writeFile } from 'node:fs/promises'
import { join, resolve, relative, isAbsolute } from 'node:path'
import { createReadStream } from 'node:fs'
import { createHash } from 'node:crypto'
import { canonicalJson, sha256 } from './review-contracts.mjs'
import { writeJson } from './state.mjs'

const originalNames = new Set(['basic.json', 'governance.json', 'news.json', 'aggregate.json', 'annual.json', 'peers.json', 'earnings_call.json', 'ccass.json', 'filings.json'])
const originalPath = path => originalNames.has(path) || /^annual_pdf\/[^/]+\.pdf$/i.test(path)
const digest = value => sha256(canonicalJson(value))
const safeRelative = path => typeof path === 'string' && path && !isAbsolute(path) && !path.includes('\\') && !path.split('/').some(p => !p || p === '.' || p === '..')
const readJson = async path => { try { return JSON.parse(await readFile(path, 'utf8')) } catch (error) { if (error.code === 'ENOENT') return null; throw error } }
const knownDerived = (path, stage) => stage === '板块基准'
  ? ['peers_curated.json', 'peer_financials_benchmark.json'].includes(path) || path.startsWith('benchmark_peers/')
  : /^(核查:|补参照系$)/u.test(stage) && path.startsWith(`check_sources/${stage.replace('核查:', '')}/`)

async function inventory(directory) {
  const files = new Map()
  if ((await lstat(directory)).isSymbolicLink()) throw new Error('Unsafe symlink stock input directory')
  const root = await realpath(directory)
  async function visit(path, prefix = '') {
    for (const entry of (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const name = prefix + entry.name, file = join(path, entry.name), info = await lstat(file)
      if (info.isSymbolicLink()) throw new Error(`Unsafe symlink in thesis inputs: ${name}`)
      const physical = await realpath(file), rel = relative(root, physical)
      if (rel.startsWith('..') || isAbsolute(rel)) throw new Error(`Unsafe input path: ${name}`)
      if (info.isDirectory()) await visit(file, `${name}/`)
      else if (info.isFile()) files.set(name, sha256(await readFile(file)))
      else throw new Error(`Unsafe non-file input: ${name}`)
    }
  }
  await visit(directory)
  return files
}

export async function resolveThesisInputManifest({ root, symbol, previousManifest, derivedRegistry = previousManifest?.derived ?? [] }) {
  if (!/^(?:\d{5}|\d{6})$/.test(symbol)) throw new Error('Unsafe thesis symbol')
  const files = await inventory(join(root, 'data', symbol)), registry = new Map()
  for (const entry of derivedRegistry) {
    if (!safeRelative(entry.path)) throw new Error(`Unsafe derived path: ${entry.path}`)
    if (originalPath(entry.path)) throw new Error(`Cannot register original as derived: ${entry.path}`)
    if (!knownDerived(entry.path, entry.stage) || !/^[a-f0-9]{64}$/.test(entry.sha256) || registry.has(entry.path)) throw new Error(`Invalid derived provenance: ${entry.path}`)
    registry.set(entry.path, entry)
  }
  const originals = [], derived = [], unclassified = []
  const paths = new Set([...files.keys(), ...(previousManifest?.originals ?? []).map(e => e.path), ...registry.keys()])
  for (const path of [...paths].sort()) {
    if (!safeRelative(path)) throw new Error(`Unsafe input path: ${path}`)
    const current = files.get(path) ?? null
    if (originalPath(path)) originals.push({ path, sha256: current })
    else if (registry.has(path)) {
      const entry = registry.get(path)
      derived.push({ ...entry, path, stage: entry.stage, sha256: entry.sha256, current_sha256: current })
    } else unclassified.push(path)
  }
  return { version: 2, originals, derived, unclassified }
}

export function assertClassified(manifest) {
  if (manifest.unclassified.length) throw new Error(`Unclassified thesis input paths; reuse/finalization blocked: ${manifest.unclassified.join(', ')}`)
}

export function assertDerivedCurrent(manifest) {
  const stale = manifest.derived.filter(e => e.current_sha256 !== e.sha256)
  if (stale.length) throw new Error(`Derived inputs require stage reconciliation; reuse blocked: ${stale.map(e => `${e.stage}: ${e.path} (${e.current_sha256 === null ? 'missing' : 'changed'})`).join(', ')}`)
}

// Called under the symbol and run locks. Historical runs supply provenance only,
// never reusable conclusions. The current physical digest selects prior settled bytes.
async function nativeContinuity(root, symbol, runDir) {
  const files = await inventory(join(root, 'data', symbol)), entries = new Map()
  let runs = []
  try { runs = await readdir(join(root, 'reports')) } catch (e) { if (e.code !== 'ENOENT') throw e }
  for (const name of runs.sort()) {
    if (!new RegExp('^' + symbol + '_thesis_[0-9]{8}$').test(name)) continue
    const prior = join(root, 'reports', name)
    if (resolve(prior) === resolve(runDir)) continue
    const manifestPath = join(prior, '.codex-workflow/input-manifest.json')
    let bytes
    try { if ((await lstat(manifestPath)).isSymbolicLink()) throw Error('Unsafe native continuity manifest'); bytes=await readFile(manifestPath) } catch(error) { if(error.code==='ENOENT')continue;throw error }
    const manifest = JSON.parse(bytes)
    if (manifest?.version !== 2) continue
    for (const entry of manifest.derived ?? []) {
      if (!safeRelative(entry.path) || originalPath(entry.path) || !knownDerived(entry.path, entry.stage) || !/^[a-f0-9]{64}$/.test(entry.sha256)) throw Error('Invalid native continuity provenance')
      if (files.get(entry.path) !== entry.sha256) continue
      const candidate = { ...entry, provenance: { run: prior, stage: entry.stage, sha256: entry.sha256 }, continuity_sources: [...(entries.get(entry.path)?.continuity_sources ?? []), {run:prior,manifest_sha256:sha256(bytes)}] }
      if (entries.has(entry.path) && entries.get(entry.path).stage !== entry.stage) throw Error('Conflicting native producer provenance: ' + entry.path)
      entries.set(entry.path, candidate)
    }
  }
  return [...entries.values()]
}

// Lifecycle is durable before dispatch. Interrupted bytes are preserved in a
// recovery journal; only exact backed-up settled bytes may be restored. No
// interrupted output is promoted to evidence, and the producer must rerun.
export async function createThesisInputTracker({ root, symbol, runDir, previousManifest, persist = true }) {
  const path = join(runDir, '.codex-workflow/input-manifest.json')
  previousManifest ??= await readJson(path)
  const derivedRegistry = previousManifest?.derived ?? await nativeContinuity(root, symbol, runDir)
  let manifest = await resolveThesisInputManifest({ root, symbol, previousManifest, derivedRegistry })
  const originals = previousManifest?.originals ?? manifest.originals
  let lifecycle = previousManifest?.producers ?? { version: 1, symbol, run: resolve(runDir), active: {}, pending: [] }
  if (lifecycle.version !== 1 || lifecycle.symbol !== symbol || lifecycle.run !== resolve(runDir)) throw Error('Invalid producer lifecycle binding')
  let queue = Promise.resolve()
  const serial = fn => { const work = queue.then(fn); queue = work.catch(() => {}); return work }
  const resolveCurrent = () => resolveThesisInputManifest({ root, symbol, previousManifest: { ...manifest, originals } })
  const assertOriginals = current => {
    if (digest(current.originals) !== digest(originals)) throw Error('Research original inputs changed or missing: ' + current.originals.filter(e => originals.find(o => o.path === e.path)?.sha256 !== e.sha256).map(e => e.path).join(', '))
  }
  const activeStages = () => Object.keys(lifecycle.active)
  const scoped = p => activeStages().some(stage => knownDerived(p, stage))
  const validate = (current, admission = false, producer = null) => {
    assertOriginals(current)
    assertClassified({ ...current, unclassified: current.unclassified.filter(p => !scoped(p)) })
    assertDerivedCurrent({ ...current, derived: current.derived.filter(e => !scoped(e.path)) })
    const unsettled = [...activeStages(), ...lifecycle.pending].filter(stage => stage !== producer)
    if (!admission && unsettled.length) throw Error('Unsettled producer stages require rerun: ' + unsettled.join(', '))
  }
  const save = () => { manifest.producers = lifecycle; return persist ? writeJson(path, manifest) : Promise.resolve() }
  const saveLife = save
  // Validate scopes and backup hashes before masking any in-flight paths.
  for (const [stage, record] of Object.entries(lifecycle.active)) {
    if (record.originals_sha256 !== digest(originals) || !Array.isArray(record.before)) throw Error('Invalid producer lifecycle originals binding')
    for (const entry of record.before) if (!safeRelative(entry.path) || !knownDerived(entry.path, stage) || sha256(Buffer.from(entry.bytes, 'base64')) !== entry.sha256 || !manifest.derived.some(e => e.path === entry.path && e.sha256 === entry.sha256 && e.stage === stage)) throw Error('Invalid producer backup provenance')
  }
  validate(manifest, true)
  for (const [stage, record] of Object.entries(lifecycle.active)) {
    if (!persist) throw Error('Interrupted producer requires locked recovery')
    const files = await inventory(join(root, 'data', symbol))
    if (!record.recovery) {
      record.recovery = []
      for (const [p, hash] of files) if (knownDerived(p, stage)) record.recovery.push({ path: p, sha256: hash, bytes: (await readFile(join(root, 'data', symbol, p))).toString('base64') })
      await saveLife()
    }
    const paths = new Set([...record.before, ...record.recovery].map(e => e.path))
    for (const p of paths) {
      const old = record.before.find(e => e.path === p), interrupted = record.recovery.find(e => e.path === p)
      if (interrupted && (!safeRelative(p) || !knownDerived(p, stage) || sha256(Buffer.from(interrupted.bytes,'base64')) !== interrupted.sha256)) throw Error('Invalid interrupted producer journal')
      const hash = files.get(p) ?? null
      if (hash !== (old?.sha256 ?? null) && hash !== (interrupted?.sha256 ?? null)) throw Error('Producer recovery conflict: ' + p)
      if (old) { await mkdir(join(root, 'data', symbol, p, '..'), {recursive:true}); await writeFile(join(root,'data',symbol,p), Buffer.from(old.bytes,'base64')) }
      else await unlink(join(root,'data',symbol,p)).catch(e => { if(e.code !== 'ENOENT') throw e })
    }
    lifecycle.history ??= []
    lifecycle.history.push({ stage, ...record, status: 'interrupted-quarantined' })
    delete lifecycle.active[stage]
    lifecycle.pending = [...new Set([...lifecycle.pending, stage])]
    await saveLife()
  }
  manifest = await resolveCurrent()
  validate(manifest, true)
  await save()
  return {
    get manifest() { return manifest },
    resolve: resolveCurrent,
    get pendingStages() { return [...lifecycle.pending] },
    beforeStage(stage) { return serial(async () => {
      const current = await resolveCurrent(); validate(current, true)
      const files = await inventory(join(root,'data',symbol))
      const before = new Map([...files].filter(([p]) => knownDerived(p, stage)))
      if (stage === '板块基准' || /^(核查:|补参照系$)/u.test(stage)) {
        if (lifecycle.active[stage]) throw Error('Producer already active: ' + stage)
        const backups = []
        for (const [p, hash] of before) backups.push({path:p, sha256:hash, bytes:(await readFile(join(root,'data',symbol,p))).toString('base64')})
        lifecycle.active[stage] = { originals_sha256:digest(originals), before:backups }
        await saveLife()
      }
      return before
    }) },
    afterStage(stage, before) { return serial(async () => {
      const current = await resolveCurrent(); validate(current, true)
      const registry = new Map(manifest.derived.map(e => [e.path,e]))
      if (lifecycle.active[stage]) {
        const files = await inventory(join(root,'data',symbol))
        for (const p of registry.keys()) if(knownDerived(p,stage) && !files.has(p)) registry.delete(p)
        for (const [p, hash] of files) if(knownDerived(p,stage)) registry.set(p, {path:p, stage, sha256:hash, provenance:{run:resolve(runDir),stage,sha256:hash}})
      }
      manifest = await resolveThesisInputManifest({root,symbol,previousManifest:{...manifest,originals},derivedRegistry:[...registry.values()]})
      delete lifecycle.active[stage]
      lifecycle.pending = lifecycle.pending.filter(s => s !== stage)
      await saveLife()
    }) },
    // Keep registry selection, inventory I/O and lifecycle validation in one
    // queue turn. Only internal unqueued helpers are called while holding it.
    dependencies(stage) { return serial(async () => {
      const current = await resolveCurrent()
      const independent = /^(盘点$|立疑$|板块基准$|挖掘:|核查:)/u.test(stage)
      validate(current, independent, stage)
      // Independent research branches consume originals, not concurrent producer
      // outputs. Aggregate consumers require all producers settled and verified.
      return { stage, sha256:digest(independent ? [] : current.derived.filter(e=>e.stage!==stage).map(e=>({path:e.path,stage:e.stage,sha256:e.sha256}))), producer_generation:(lifecycle.history ?? []).filter(record => record.stage === stage).length }
    }) },
    assertCurrent({ admission = false } = {}) { return serial(async () => {
      const current = await resolveCurrent()
      validate(current, admission)
      return current
    }) },
  }
}

async function streamHash(path) {
  const hash = createHash('sha256')
  for await (const bytes of createReadStream(path)) hash.update(bytes)
  return hash.digest('hex')
}

// Diagnostic eligibility is not a v2 import: legacy reviews cannot become v2
// receipts. Explicit proof selection is required; there is no stock-specific fallback.
export async function diagnoseLegacyReviewState({ runDir, inputManifest }) {
  const control = join(runDir, '.codex-workflow'), state = await readJson(join(control, 'state.json'))
  const proofs = {}, reasons = []
  if (state?.invocation?.reviewProtocol === 2) return { migratable: true, reasons, usedRounds: 0, proofs: { protocol: 2 } }
  const head = await readJson(join(control, 'review/HEAD.json'))
  if (head) return { migratable: true, reasons, usedRounds: null, proofs: { protocol: 2, head: true } }
  if (!state && !await readJson(join(runDir, '成稿审查.json'))) {
    try { await lstat(join(runDir, 'report.md')) } catch (e) { if (e.code === 'ENOENT') return { migratable: true, reasons, usedRounds: 0, proofs: { newRun: true } }; throw e }
  }
  const selection = await readJson(join(control, 'legacy-proof.json'))
  if (!selection?.directory || !isAbsolute(selection.directory)) return { migratable: false, reasons: ['Missing independent frozen origin manifest and reconstructible round proofs: .codex-workflow/legacy-proof.json'], usedRounds: null, proofs }
  try {
    const base = selection.directory
    const origin = await readJson(join(base, 'test-manifest.json')), integrity = await readJson(join(base, 'final-integrity.json')), methods = await readJson(join(base, 'source-snapshot.json'))
    const currentOriginals = Object.fromEntries((inputManifest?.originals ?? []).map(e => [e.path, e.sha256]))
    if (!origin?.raw_inputs || digest(origin.raw_inputs) !== digest(currentOriginals)) reasons.push('Frozen origin raw_inputs do not match current originals')
    if (!integrity?.raw || digest(Object.fromEntries(integrity.raw.map(e => [e.path, e.expected]))) !== digest(origin?.raw_inputs) || integrity.raw.some(e => e.source !== e.expected || e.scratch !== e.expected)) reasons.push('Missing or contradictory final-integrity.json raw path/hash proof')
    if (!integrity?.source || digest(Object.fromEntries(integrity.source.map(e => [e.path, e.expected]))) !== digest(methods) || integrity.source.some(e => e.source !== e.expected || e.scratch !== e.expected)) reasons.push('Missing or contradictory final-integrity.json methodology path/hash proof')
    const root = resolve(runDir, '../..')
    if (runDir !== join(root, 'reports', origin?.symbol + '_thesis_' + origin?.date)) reasons.push('Frozen origin symbol/date does not bind the selected run')
    if (!methods || !Object.keys(methods).length) reasons.push('Missing source-snapshot.json methodology proof')
    for (const [path, expected] of Object.entries(methods ?? {})) {
      if (!safeRelative(path) || !/^[a-f0-9]{64}$/.test(expected) || await streamHash(join(root, path)) !== expected) reasons.push(`Methodology proof mismatch: ${path}`)
    }
    const history = await readJson(join(base, 'new-run/.codex-workflow/state.json')), rollouts = await readJson(join(base, 'native-rollouts/index.json'))
    if (!history || history.fingerprint !== state?.fingerprint || !Array.isArray(rollouts)) reasons.push('Missing or contradictory legacy fingerprint/round history')
    const stages = Object.entries(history?.stages ?? {}).filter(([label]) => /^(成稿审查|修订成稿):\d+$/u.test(label))
    const currentStages = Object.entries(state?.stages ?? {}).filter(([label]) => /^(成稿审查|修订成稿):\d+$/u.test(label))
    const summaries = entries => entries.map(([label, record]) => ({label,status:record.status,verdict:record.result?.verdict ?? null})).sort((a,b)=>a.label.localeCompare(b.label))
    if (digest(summaries(currentStages)) !== digest(summaries(stages))) reasons.push('Current legacy round history contradicts frozen stage history')
    // Stage state can omit calls completed before a crash. Reconcile the entire
    // completed review/revision inventory before trusting any consumed allowance.
    const stageHistory = new Map(stages), completedCalls = new Map()
    let completeInventory = Array.isArray(rollouts)
    for (const entry of rollouts ?? []) {
      if (entry?.completed !== true) continue
      if (typeof entry.stage !== 'string') {
        reasons.push('Unexplained completed archived call without a stage label')
        completeInventory = false
        continue
      }
      if (!/^(成稿审查|修订成稿)/u.test(entry.stage)) continue
      const match = /^(成稿审查|修订成稿)_(0|[1-9]\d*)-.+$/u.exec(entry.stage)
      if (!match) {
        reasons.push('Unexplained noncanonical completed archived round: ' + entry.stage)
        completeInventory = false
        continue
      }
      const label = match[1] + ':' + match[2]
      if (completedCalls.has(label)) {
        reasons.push('Duplicate completed archived round: ' + label)
        completeInventory = false
      }
      completedCalls.set(label, entry)
      if (stageHistory.get(label)?.status !== 'succeeded') {
        reasons.push('Unexplained completed archived round outside succeeded state history: ' + label)
        completeInventory = false
      }
    }
    for (const [label, record] of stages) if (record.status !== 'succeeded' || !completedCalls.has(label)) completeInventory = false
    const reviews = stages.filter(([label]) => label.startsWith('成稿审查:')).sort((a,b)=>Number(a[0].split(':')[1])-Number(b[0].split(':')[1]))
    const revisions = stages.filter(([label]) => label.startsWith('修订成稿:'))
    if (!reviews.length || reviews.length !== revisions.length + 1) reasons.push('Incomplete review/revision round history')
    for (let i=0;i<reviews.length;i++) {
      const [label, record] = reviews[i]
      if (label !== `成稿审查:${i}` || record.status !== 'succeeded' || (i && !stages.some(([l,r])=>l===`修订成稿:${i}` && r.status==='succeeded'))) reasons.push(`Incomplete round proof: ${label}`)
      const review = await readJson(join(base, `versions/review-${i}.json`))
      const version = i === 0 ? 'report-initial.md' : `report-revision-${i}.md`
      if (!review || review.report_sha256 !== await streamHash(join(base,'versions',version)) || review.verdict !== record.result?.verdict) reasons.push(`Report/review version mismatch: ${i}`)
    }
    for (const [label, record] of stages) {
      const prefix = label.replace(':','_') + '-'
      const entries = (rollouts ?? []).filter(e=>e.stage.startsWith(prefix))
      if (record.status !== 'succeeded' || entries.length!==1 || !entries[0].completed || !/^[a-f0-9]{64}$/.test(entries[0].sha256)) reasons.push(`Missing completed archived round proof: ${label}`)
      else {
        const entry=entries[0], archivePath=resolve(root,entry.archived)
        if (!safeRelative(entry.archived) || await streamHash(archivePath)!==entry.sha256 || (await lstat(archivePath)).size!==entry.bytes) reasons.push(`Archived round digest mismatch: ${label}`)
      }
    }
    proofs.validReviews=completeInventory ? reviews.length : null
    proofs.finalVerdict=reviews.at(-1)?.[1].result?.verdict ?? null
    proofs.terminalReason=proofs.finalVerdict==='revise' ? 'legacy_review_rejected' : 'legacy_requires_independent_v2_review'
    proofs.requiresExplicitImport=true
    return { migratable: reasons.length===0, reasons, usedRounds: completeInventory ? revisions.length : null, proofs }
  } catch(error) {
    reasons.push(`Missing/invalid legacy proof: ${error.message}`)
    return { migratable:false, reasons, usedRounds:null, proofs }
  }
}
