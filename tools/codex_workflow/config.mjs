import { spawn, execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { createInterface } from 'node:readline'

const aliases = new Set(['haiku', 'sonnet', 'opus'])
const stages = new Set(['盘点', '立疑', '挖掘', '核查', '板块基准', '补参照系', '成稿', '成稿审查', '修订成稿', '更新档案', '修复硬门'])
const lenses = ['财务排雷', '尽调', '产业', '竞争', '战略驱动']
for (const stage of ['挖掘', '核查']) for (const lens of lenses) stages.add(`${stage}:${lens}`)
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const isText = value => typeof value === 'string' && value.trim().length > 0

function validateSettings(value, context) {
  if (!isObject(value)) throw new Error(`${context}: stage config settings must be an object`)
  const out = {}
  for (const [key, setting] of Object.entries(value)) {
    if (!['model', 'effort'].includes(key)) throw new Error(`${context}: unknown stage config setting ${key}`)
    if (!isText(setting)) throw new Error(`${context}: ${key} must be a nonempty string`)
    out[key] = setting.trim()
  }
  return out
}

function validateStageConfig(value = {}) {
  if (!isObject(value)) throw new Error('stage config must be an object')
  const out = {}
  for (const key of Object.keys(value)) if (!['default', 'stages'].includes(key)) throw new Error(`unknown stage config key ${key}`)
  if (Object.hasOwn(value, 'default')) out.default = validateSettings(value.default, 'default')
  if (Object.hasOwn(value, 'stages')) {
    if (!isObject(value.stages)) throw new Error('stage config stages must be an object')
    out.stages = {}
    for (const [label, settings] of Object.entries(value.stages)) {
      if (!stages.has(label)) throw new Error(`unknown stage config label ${label}`)
      out.stages[label] = validateSettings(settings, label)
    }
  }
  return out
}

/** Read and validate the complete stage file, including otherwise unused labels. */
export async function readStageConfig(path) {
  let value
  try { value = JSON.parse(await readFile(path, 'utf8')) }
  catch (error) {
    if (error instanceof SyntaxError) throw new Error(`invalid stage config JSON: ${path}`)
    throw error
  }
  return validateStageConfig(value)
}

function safeOrigin(origin) {
  const name = origin?.name
  if (isText(name)) return name
  if (!isObject(name)) return undefined
  const out = {}
  // ConfigLayerSource contains only a type and the source path. Never retain
  // ConfigLayerMetadata.version (the whole-config hash) or arbitrary fields.
  for (const key of ['type', 'file', 'path', 'cwd']) if (isText(name[key])) out[key] = name[key]
  return Object.keys(out).length ? out : undefined
}

function safeConfig(raw = {}) {
  const out = {}
  for (const key of ['model', 'model_reasoning_effort', 'model_provider']) if (isText(raw[key])) out[key] = raw[key].trim()
  return out
}

function safeOrigins(raw = {}) {
  const out = {}
  for (const key of ['model', 'model_reasoning_effort', 'model_provider']) {
    const name = safeOrigin(raw[key])
    if (name !== undefined) out[key] = { name }
  }
  return out
}

function safeModels(raw = []) {
  if (!Array.isArray(raw)) throw new Error('invalid Codex model catalog')
  return raw.filter(item => isObject(item) && isText(item.model)).map(item => ({
    model: item.model.trim(), isDefault: item.isDefault === true,
    ...(isText(item.defaultReasoningEffort) ? { defaultReasoningEffort: item.defaultReasoningEffort.trim() } : {}),
    supportedReasoningEfforts: (Array.isArray(item.supportedReasoningEfforts) ? item.supportedReasoningEfforts : [])
      .map(value => typeof value === 'string' ? value : value?.reasoningEffort).filter(isText).map(value => value.trim()),
  }))
}

function concreteModel(model, fallback) {
  return aliases.has(model) ? fallback : model
}

function validateResolved(snapshot, model, effort) {
  if (!isText(model) || aliases.has(model)) throw new Error('Cannot resolve a concrete Codex model')
  const metadata = snapshot.models.find(item => item.model === model)
  if (snapshot.catalogAvailable && !metadata) throw new Error(`Unknown Codex model: ${model}`)
  if (!isText(effort)) throw new Error(`Cannot resolve reasoning effort for model ${model}; model catalog or explicit effort is required`)
  if (metadata?.supportedReasoningEfforts.length && !metadata.supportedReasoningEfforts.includes(effort)) {
    throw new Error(`Unsupported reasoning effort ${effort} for model ${model}`)
  }
}

/** Resolve only against this saved snapshot; this function never reads user config. */
export function resolveStageSettings(snapshot, options = {}) {
  const configured = snapshot.stageConfig ?? {}
  const label = options.label ?? ''
  // Runtime review rounds route to the approved base stage. File keys remain
  // strict so a misspelling cannot silently stop an override from applying.
  const routed = label.replace(/^(成稿审查|修订成稿|审查|修订):\d+$/, (_, prefix) =>
    prefix === '审查' ? '成稿审查' : prefix === '修订' ? '修订成稿' : prefix)
  const prefix = routed.split(':')[0]
  const candidates = [
    [snapshot.overrides, 'cli'],
    [configured.stages?.[routed], `stage:${routed}`],
    ...(prefix === routed ? [] : [[configured.stages?.[prefix], `stage:${prefix}`]]),
    [options, 'shared-stage'],
    [configured.default, 'stage-default'],
  ]
  function choose(key) {
    for (const [settings, source] of candidates) if (settings?.[key] !== undefined) return { value: settings[key], source }
    return {}
  }
  const selectedModel = choose('model')
  const model = concreteModel(selectedModel.value ?? snapshot.defaults.model, snapshot.defaults.model)
  const selectedEffort = choose('effort')
  let effort = selectedEffort.value
  let effortSource = selectedEffort.source
  if (effort === undefined) {
    if (model === snapshot.defaults.model) {
      effort = snapshot.defaults.effort
      effortSource = 'effective-config'
    } else {
      effort = snapshot.models.find(item => item.model === model)?.defaultReasoningEffort
      effortSource = 'model-catalog'
    }
  }
  validateResolved(snapshot, model, effort)
  const provider = snapshot.defaults.modelProvider
  return { model, effort, ...(provider ? { modelProvider: provider } : {}), sources: {
    model: selectedModel.source ?? 'effective-config', effort: effortSource,
    ...(provider ? { modelProvider: 'effective-config' } : {}),
  } }
}

/** Probe once and retain only the reproducible, non-secret execution settings. */
export async function resolveExecutionConfig({ root, model, effort, stageConfig = {}, probe = probeCodexConfig } = {}) {
  const overrides = validateSettings({ ...(model !== undefined ? { model } : {}), ...(effort !== undefined ? { effort } : {}) }, 'CLI')
  const configured = typeof stageConfig === 'string' ? await readStageConfig(stageConfig) : validateStageConfig(stageConfig)
  const result = await probe({ root })
  if (!isText(result.codexVersion) || result.codexVersion === 'unknown') throw new Error('Cannot resolve Codex version')
  const config = safeConfig(result.config)
  const models = safeModels(result.models)
  const catalogAvailable = result.catalogAvailable !== false && models.length > 0
  const defaults = {}
  const defaultModels = models.filter(item => item.isDefault)
  defaults.model = concreteModel(config.model, undefined) ?? (defaultModels.length === 1 ? defaultModels[0].model : undefined) ?? concreteModel(overrides.model, undefined)
  if (!isText(defaults.model)) throw new Error('Cannot resolve effective Codex model; configure model or provide a model catalog default')
  defaults.effort = config.model_reasoning_effort ?? models.find(item => item.model === defaults.model)?.defaultReasoningEffort ?? overrides.effort
  if (!isText(defaults.effort)) throw new Error('Cannot resolve effective Codex reasoning effort; configure model_reasoning_effort or provide its catalog default')
  defaults.modelProvider = config.model_provider ?? 'openai'
  const origins = safeOrigins(result.origins)
  const sources = {
    model: origins.model?.name ?? (config.model ? 'effective-config' : defaultModels.length === 1 ? 'model-catalog' : 'cli'),
    effort: origins.model_reasoning_effort?.name ?? (config.model_reasoning_effort ? 'effective-config' : models.find(item => item.model === defaults.model)?.defaultReasoningEffort ? 'model-catalog' : 'cli'),
    modelProvider: origins.model_provider?.name ?? (config.model_provider ? 'effective-config' : 'builtin-default'),
  }
  const snapshot = { version: 1, codexVersion: result.codexVersion.trim(), defaults, overrides, stageConfig: configured, models, sources, catalogAvailable }
  resolveStageSettings(snapshot)
  for (const label of Object.keys(configured.stages ?? {})) resolveStageSettings(snapshot, { label })
  return snapshot
}

/** A resumed run needs the executable version, not today's model defaults. */
export async function readCodexVersion({ root, executable = 'codex', executableArgs = [], timeoutMs = 15000 } = {}) {
  const stdout = await new Promise((resolve, reject) => {
    execFile(executable, [...executableArgs, '--version'], { cwd: root, timeout: timeoutMs, maxBuffer: 100_000 }, (error, output) => {
      if (error) reject(new Error('Cannot read Codex CLI version'))
      else resolve(output)
    })
  })
  const version = stdout.match(/\b(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)(?:\s|$)/)?.[1]
  if (!version) throw new Error('Cannot resolve Codex CLI version')
  return version
}

/** Read-only app-server RPC. Never starts a thread or inference request. */
export async function probeCodexConfig({ root, executable = 'codex', executableArgs = [], timeoutMs = 15000 } = {}) {
  const child = spawn(executable, [...executableArgs, 'app-server', '--listen', 'stdio://'], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] })
  const pending = new Map()
  let sequence = 0, terminalError, killTimer
  const rejectPending = error => {
    terminalError = error
    for (const request of pending.values()) request.reject(error)
    pending.clear()
  }
  const stop = () => {
    if (child.exitCode !== null || child.signalCode !== null) return
    child.kill('SIGTERM')
    killTimer ??= setTimeout(() => child.kill('SIGKILL'), 500)
    killTimer.unref()
  }
  child.on('error', () => rejectPending(new Error('Unable to start Codex config probe')))
  child.on('close', () => { clearTimeout(killTimer); rejectPending(new Error('Codex config probe exited before completing RPC')) })
  child.stdin.on('error', () => rejectPending(new Error('Codex config probe input closed')))
  // Drain stderr without echoing it: it can contain local paths or credentials.
  child.stderr.on('data', () => {})
  const lines = createInterface({ input: child.stdout })
  lines.on('line', line => {
    let message
    try { message = JSON.parse(line) }
    catch { rejectPending(new Error('Invalid JSON from Codex config probe')); stop(); return }
    const request = pending.get(message.id)
    if (!request) return
    pending.delete(message.id)
    if (message.error) request.reject(new Error(`Codex config RPC ${request.method} failed`))
    else request.resolve(message.result)
  })
  function notify(method, params) {
    child.stdin.write(JSON.stringify({ method, ...(params ? { params } : {}) }) + '\n')
  }
  function rpc(method, params) {
    if (terminalError) return Promise.reject(terminalError)
    return new Promise((resolve, reject) => {
      const id = ++sequence
      pending.set(id, { resolve, reject, method })
      child.stdin.write(JSON.stringify({ id, method, params }) + '\n')
    })
  }
  const timeout = setTimeout(() => { rejectPending(new Error('Codex config probe timeout')); stop() }, timeoutMs)
  try {
    const initialized = await rpc('initialize', { clientInfo: { name: 'thesis-workflow', version: '1.0' } })
    // The leading product/version identifies Codex; subsequent tokens describe
    // the OS and terminal and must not affect a resumable run's fingerprint.
    const codexVersion = typeof initialized?.userAgent === 'string'
      ? initialized.userAgent.match(/^[^/\s]+\/(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)(?:\s|$)/)?.[1] : undefined
    if (!codexVersion) throw new Error('Cannot resolve Codex version from initialize response')
    notify('initialized')
    const response = await rpc('config/read', { cwd: root, includeLayers: false })
    const config = safeConfig(response?.config)
    const origins = safeOrigins(response?.origins)
    let models = [], catalogAvailable = true
    try {
      let cursor
      const cursors = new Set()
      do {
        const page = await rpc('model/list', { includeHidden: true, limit: 100, ...(cursor ? { cursor } : {}) })
        models.push(...safeModels(page?.data))
        cursor = page?.nextCursor
        if (cursor && cursors.has(cursor)) throw new Error('Codex model catalog repeated a cursor')
        if (cursor) cursors.add(cursor)
      } while (cursor)
      if (!models.length) throw new Error('Codex model catalog is empty')
    } catch (error) {
      if (terminalError) throw terminalError
      // The resolver may still have explicit CLI settings. It, rather than
      // this read-only probe, rejects an incomplete final model/effort pair.
      models = []; catalogAvailable = false
    }
    return { codexVersion, config, origins, models, catalogAvailable }
  } finally {
    clearTimeout(timeout)
    lines.close()
    stop()
  }
}
