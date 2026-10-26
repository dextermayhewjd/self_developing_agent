import { mkdir, readFile, writeFile, rename, unlink, stat, realpath, open, copyFile } from 'node:fs/promises'
import { mkdirSync, readFileSync, writeFileSync, renameSync, realpathSync } from 'node:fs'
import { resolve, relative, isAbsolute, join, dirname, basename } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { hostname } from 'node:os'
import { validateExclusiveOutput, validateExclusiveOutputPath } from './stage-output.mjs'

const hash = value => createHash('sha256').update(value).digest('hex')
const within = (path, root) => { const rel = relative(root, path); return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel)) }
const exists = async path => { try { await stat(path); return true } catch (e) { if (e.code === 'ENOENT') return false; throw e } }

export async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true })
  const temp = `${path}.${randomUUID()}.tmp`
  await writeFile(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 })
  await rename(temp, path)
}

function claimedPaths(value, paths = []) {
  if (!value || typeof value !== 'object') return paths
  for (const [key, child] of Object.entries(value)) {
    if (key === 'written_file' && typeof child === 'string' && child) paths.push(child)
    else if (child && typeof child === 'object') claimedPaths(child, paths)
  }
  return paths
}

export function createProcessRegistry(dir) {
  mkdirSync(dir, { recursive: true })
  const path = join(dir, 'workers.json')
  let groups = new Set()
  try { groups = new Set(JSON.parse(readFileSync(path, 'utf8')).groups) }
  catch (e) { if (e.code !== 'ENOENT') throw e }
  const save = () => {
    const temp = `${path}.${randomUUID()}.tmp`
    writeFileSync(temp, JSON.stringify({ groups: [...groups] }), { mode: 0o600 })
    renameSync(temp, path)
  }
  return { path, started: pid => { groups.add(pid); save() }, ended: pid => { groups.delete(pid); save() } }
}

export async function acquireRunLock(dir, { processesFile = join(dir, 'workers.json') } = {}) {
  await mkdir(dir, { recursive: true })
  const lockPath = join(dir, 'run.lock')
  const owner = { pid: process.pid, host: hostname(), token: randomUUID(), processesFile, started: new Date().toISOString() }
  let acquired = false
  for (let attempt = 0; attempt < 3 && !acquired; attempt++) {
    try {
      const file = await open(lockPath, 'wx', 0o600)
      await file.writeFile(JSON.stringify(owner))
      await file.close()
      acquired = true
    } catch (e) {
      if (e.code !== 'EEXIST') throw e
      let old
      try { old = JSON.parse(await readFile(lockPath, 'utf8')) } catch { throw new Error(`Unreadable run lock: ${lockPath}`) }
      if (old.host !== hostname() || !Number.isInteger(old.pid)) throw new Error(`Workflow already running or lock needs inspection: ${lockPath}`)
      try { process.kill(old.pid, 0); throw new Error(`Workflow already running (PID ${old.pid})`) }
      catch (error) {
        if (error.code !== 'ESRCH') throw error
      }
      try {
        const workers = JSON.parse(await readFile(old.processesFile ?? processesFile, 'utf8')).groups
        if (workers.some(pid => {
          try { process.kill(process.platform === 'win32' ? pid : -pid, 0); return true }
          catch (error) { return error.code !== 'ESRCH' }
        })) throw new Error(`Orphan worker groups still running; inspect ${old.processesFile ?? processesFile}`)
      } catch (error) { if (error.code !== 'ENOENT') throw error }
      // Recheck ownership before reclaiming a lock left by a dead process.
      if ((JSON.parse(await readFile(lockPath, 'utf8'))).token === old.token) await unlink(lockPath)
    }
  }
  if (!acquired) throw new Error(`Could not acquire workflow lock: ${lockPath}`)
  return async () => {
    try {
      if ((JSON.parse(await readFile(lockPath, 'utf8'))).token === owner.token) await unlink(lockPath)
    } catch (error) { if (error.code !== 'ENOENT') throw error }
  }
}

export async function openState({ dir, fingerprint, artifactRoots, artifactsFor = () => [], dependents = () => [], reset = false, resetArtifacts = [], invocation = {}, protectedPaths = [], processesFile, emit = () => {}, acceptFingerprintChange }) {
  dir = resolve(dir)
  const unlock = await acquireRunLock(dir, { processesFile })
  let writes = Promise.resolve()
  const close = async () => { await writes.catch(() => {}); await unlock() }
  try {
    fingerprint = typeof fingerprint === 'function' ? await fingerprint() : fingerprint
    const roots = await Promise.all(artifactRoots.map(async p => {
      try { return await realpath(p) } catch (e) { if (e.code === 'ENOENT') return resolve(p); throw e }
    }))
    const safePath = async path => {
      if (!isAbsolute(path)) throw new Error(`Artifact path must be absolute: ${path}`)
      const physical = await realpath(path)
      if (!roots.some(root => within(physical, root))) throw new Error(`Path outside allowed artifact roots: ${path}`)
      return physical
    }
    const checkFiles = async paths => {
      for (const path of paths) {
        await safePath(path)
        const info = await stat(path)
        if (!info.isFile() || info.size === 0) throw new Error(`Missing or empty artifact: ${path}`)
      }
    }
    const storeDir = join(dir, 'review')
    const hasStoreOwnership = invocation.reviewProtocol === 2 || await exists(storeDir)
    const ownedPaths = [storeDir, ...protectedPaths, ...(hasStoreOwnership ? [join(dirname(dir), 'report.md'), join(dirname(dir), '成稿审查.json')] : [])]
    const storeOwned = path => {
      let physical
      try { physical = realpathSync(path) } catch (error) { if (error.code !== 'ENOENT') throw error }
      return [resolve(path), physical].filter(Boolean).some(candidate => ownedPaths.some(target => within(candidate, resolve(target)) || within(resolve(target), candidate)))
    }
    const statePath = join(dir, 'state.json')
    let data = { version: 1, fingerprint, stages: {} }
    if (await exists(statePath)) data = JSON.parse(await readFile(statePath, 'utf8'))
    const archive = join(dir, 'quarantine', randomUUID())
    const quarantine = async (paths, includePersistent = false, allowStore = false) => {
      for (const path of new Set(paths)) {
        if (!allowStore && storeOwned(path)) continue
        if (!await exists(path)) continue
        await safePath(path)
        // Persistent position files are inputs to the next run and must not be removed.
        if (!includePersistent && !within(resolve(path), dirname(dir))) continue
        await mkdir(archive, { recursive: true })
        await rename(path, join(archive, `${hash(path).slice(0, 12)}-${randomUUID()}-${basename(path)}`))
        emit({ type: 'artifact.quarantined', path, archive })
      }
    }
    const validateOwnership = async record => {
      if (record.exclusiveOutputPath === undefined) return
      const path = record.exclusiveOutputPath
      await validateExclusiveOutputPath(path)
      const claims = [...(record.artifacts ?? []), ...(record.outputs ?? []), ...(record.backups ?? []).map(entry => entry.path)]
      if (claims.some(claim => claim !== path)) throw new Error('Exclusive output violation: persisted ownership differs from host-selected path')
    }
    const restore = async record => {
      await validateOwnership(record)
      if (record.restored) return
      if (record.backups) {
        for (const entry of record.backups) {
          if (storeOwned(entry.path)) continue
          await quarantine([entry.path], true)
          if (entry.backup) {
            await mkdir(dirname(entry.path), { recursive: true })
            await copyFile(entry.backup, entry.path)
          }
        }
      } else await quarantine(record.artifacts ?? [])
      record.restored = true
    }
    if (data.fingerprint !== fingerprint && !reset) {
      if (!acceptFingerprintChange) throw new Error('Workflow or inputs changed; use --reset to archive prior workflow outputs and restart')
      const upgrade = await acceptFingerprintChange({ previous: structuredClone(data), fingerprint })
      if (upgrade?.from !== data.fingerprint || upgrade?.to !== fingerprint || upgrade?.kind !== 'review-only') throw new Error('Invalid review compatibility upgrade')
      data.review_upgrades = [...(data.review_upgrades ?? []), upgrade]
      data.fingerprint = fingerprint
      emit({ type: 'review.compatibility-upgraded', message: `${upgrade.from} -> ${upgrade.to}` })
    }
    for (const record of Object.values(data.stages)) await validateOwnership(record)
    if (!reset) for (const record of Object.values(data.stages)) {
      if (['running', 'failed'].includes(record.status)) await restore(record)
    }
    if (reset) {
      await quarantine([...resetArtifacts, ...Object.values(data.stages).flatMap(s => s.artifacts ?? [])].filter(path => !within(resolve(path), storeDir)), false, true)
      await mkdir(archive, { recursive: true })
      for (const [source, target] of [[storeDir, 'review'], [join(dir, 'input-manifest.json'), 'input-manifest.json']]) {
        if (await exists(source)) await rename(source, join(archive, target))
      }
      if (await exists(statePath)) {
        await mkdir(archive, { recursive: true })
        await rename(statePath, join(archive, 'state.json'))
      }
      data = { version: 1, fingerprint, stages: {} }
    }
    data.invocation = invocation
    const invalid = new Set()
    for (const [label, record] of Object.entries(data.stages)) {
      if (record.status !== 'succeeded') invalid.add(label)
      else try { await checkFiles((record.artifacts ?? []).filter(path => !storeOwned(path))) } catch { invalid.add(label) }
    }
    for (const label of invalid) for (const child of dependents(label, Object.keys(data.stages))) invalid.add(child)
    for (const label of invalid) {
      const record = data.stages[label]
      if (!record) continue
      await validateOwnership(record)
      await quarantine(record.outputs ?? record.artifacts ?? [])
      record.status = 'invalidated'
      emit({ type: 'agent.invalidated', label })
    }
    const save = () => {
      writes = writes.then(() => writeJson(statePath, data))
      return writes
    }
    await save()
    const run = async (prompt, options, execute, signal) => {
      const label = options.label ?? 'agent'
      const readonly = ['proposal', 'review', 'evidence_extract'].includes(options.contract)
      const exclusiveOutputPath = options.exclusiveOutputPath
      if (exclusiveOutputPath !== undefined) await validateExclusiveOutputPath(exclusiveOutputPath)
      const key = hash(JSON.stringify({ prompt, schema: options.schema, execution: options.execution,
        contract: options.contract, isolation: options.isolation, images: options.images, dependencyDigests: options.dependencyDigests, exclusiveOutputPath }))
      const prior = data.stages[label]
      const cacheable = label !== '盘点' && !/^(修复|成稿审查|修订成稿|更新档案)/u.test(label)
      if (cacheable && prior?.status === 'succeeded' && prior.key === key) {
        try {
          await checkFiles(prior.artifacts)
          emit({ type: 'agent.cached', label })
          return prior.result
        } catch { /* Missing or moved output must be regenerated. */ }
      }
      const expected = (readonly ? [] : exclusiveOutputPath !== undefined ? [exclusiveOutputPath] : artifactsFor(label, prompt)).map(p => typeof p === 'string' ? { path: p } : p).filter(entry => !storeOwned(entry.path))
      const record = { key, exclusiveOutputPath, contract: options.contract, execution: options.execution, status: 'running', started: new Date().toISOString(), artifacts: expected.map(p => p.path),
        outputs: expected.filter(p => !p.retainOnInvalidate).map(p => p.path), backups: [] }
      for (const entry of expected) {
        let backup = null
        if (await exists(entry.path)) {
          await safePath(entry.path)
          backup = join(dir, 'backups', randomUUID())
          await mkdir(dirname(backup), { recursive: true })
          await copyFile(entry.path, backup)
        }
        record.backups.push({ path: entry.path, backup })
      }
      data.stages[label] = record
      await save()
      try {
        const result = await execute(prompt, options, signal)
        if (exclusiveOutputPath !== undefined) await validateExclusiveOutput(result, exclusiveOutputPath)
        const paths = [...new Set([...expected.filter(p => !p.optional).map(p => p.path), ...(readonly ? [] : claimedPaths(result).filter(path => !storeOwned(path)))])]
        await checkFiles(paths)
        record.artifacts = [...new Set([...paths, ...expected.filter(p => p.optional).map(p => p.path)])]
        // Optional absent artifacts are tracked for cleanup, not required for cache replay.
        record.artifacts = await (async () => {
          const present = []
          for (const path of record.artifacts) if (await exists(path)) present.push(path)
          return present
        })()
        record.status = 'succeeded'
        record.outputs = [...new Set([...record.outputs, ...(readonly ? [] : claimedPaths(result)).filter(p => !storeOwned(p) && !expected.some(e => e.path === p && e.retainOnInvalidate))])]
        record.result = result
        record.finished = new Date().toISOString()
        await save()
        return result
      } catch (error) {
        record.status = 'failed'
        record.error = error.message
        await save()
        await restore(record)
        await save()
        throw error
      }
    }
    return { run, close, data, directory: dir, checkFiles,
      canReuse: () => Object.values(data.stages).every(s => s.status === 'succeeded'),
      complete: async () => {
        data.stages = Object.fromEntries(Object.entries(data.stages).filter(([, s]) => s.status === 'succeeded'))
        data.completed = new Date().toISOString()
        await save()
      } }
  } catch (error) {
    await close()
    throw error
  }
}
