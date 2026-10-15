import { mkdir, readFile, writeFile, rename, unlink, stat, realpath, open } from 'node:fs/promises'
import { resolve, relative, isAbsolute, join, dirname, basename } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { hostname } from 'node:os'

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

export async function openState({ dir, fingerprint, artifactRoots, artifactsFor = () => [], reset = false, resetArtifacts = [], invocation = {}, emit = () => {} }) {
  dir = resolve(dir)
  await mkdir(dir, { recursive: true })
  const lockPath = join(dir, 'run.lock')
  const owner = { pid: process.pid, host: hostname(), token: randomUUID(), started: new Date().toISOString() }
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
      // Recheck ownership before reclaiming a lock left by a dead process.
      if ((JSON.parse(await readFile(lockPath, 'utf8'))).token === old.token) await unlink(lockPath)
    }
  }
  if (!acquired) throw new Error(`Could not acquire workflow lock: ${lockPath}`)
  let writes = Promise.resolve()
  const close = async () => {
    await writes.catch(() => {})
    try {
      if ((JSON.parse(await readFile(lockPath, 'utf8'))).token === owner.token) await unlink(lockPath)
    } catch (error) { if (error.code !== 'ENOENT') throw error }
  }
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
    const statePath = join(dir, 'state.json')
    let data = { version: 1, fingerprint, stages: {} }
    if (await exists(statePath)) data = JSON.parse(await readFile(statePath, 'utf8'))
    const archive = join(dir, 'quarantine', randomUUID())
    const quarantine = async paths => {
      for (const path of new Set(paths)) {
        if (!await exists(path)) continue
        await safePath(path)
        // Persistent position files are inputs to the next run and must not be removed.
        if (!within(resolve(path), dirname(dir))) continue
        await mkdir(archive, { recursive: true })
        await rename(path, join(archive, `${hash(path).slice(0, 12)}-${basename(path)}`))
        emit({ type: 'artifact.quarantined', path, archive })
      }
    }
    if (data.fingerprint !== fingerprint && !reset) throw new Error('Workflow or inputs changed; use --reset to archive prior workflow outputs and restart')
    if (reset) {
      await quarantine([...resetArtifacts, ...Object.values(data.stages).flatMap(s => s.artifacts ?? [])])
      if (await exists(statePath)) {
        await mkdir(archive, { recursive: true })
        await rename(statePath, join(archive, 'state.json'))
      }
      data = { version: 1, fingerprint, stages: {} }
    }
    data.invocation = invocation
    for (const record of Object.values(data.stages)) {
      if (record.status !== 'succeeded') await quarantine(record.artifacts ?? [])
    }
    const save = () => {
      writes = writes.then(() => writeJson(statePath, data))
      return writes
    }
    await save()
    const run = async (prompt, options, execute, signal) => {
      const label = options.label ?? 'agent'
      const key = hash(JSON.stringify({ prompt, schema: options.schema }))
      const prior = data.stages[label]
      const cacheable = label !== '盘点' && !label.startsWith('修复')
      if (cacheable && prior?.status === 'succeeded' && prior.key === key) {
        try {
          await checkFiles(prior.artifacts)
          emit({ type: 'agent.cached', label })
          return prior.result
        } catch { /* Missing or moved output must be regenerated. */ }
      }
      const expected = artifactsFor(label, prompt).map(p => typeof p === 'string' ? { path: p } : p)
      const record = { key, status: 'running', started: new Date().toISOString(), artifacts: expected.map(p => p.path) }
      data.stages[label] = record
      await save()
      try {
        const result = await execute(prompt, options, signal)
        const paths = [...new Set([...expected.filter(p => !p.optional).map(p => p.path), ...claimedPaths(result)])]
        await checkFiles(paths)
        record.artifacts = [...new Set([...paths, ...expected.filter(p => p.optional).map(p => p.path)])]
        // Optional absent artifacts are tracked for cleanup, not required for cache replay.
        record.artifacts = await (async () => {
          const present = []
          for (const path of record.artifacts) if (await exists(path)) present.push(path)
          return present
        })()
        record.status = 'succeeded'
        record.result = result
        record.finished = new Date().toISOString()
        await save()
        return result
      } catch (error) {
        record.status = 'failed'
        record.error = error.message
        await save()
        throw error
      }
    }
    return { run, close, data, directory: dir, checkFiles }
  } catch (error) {
    await close()
    throw error
  }
}
