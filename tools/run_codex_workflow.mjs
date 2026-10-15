#!/usr/bin/env node
import { parseArgs } from 'node:util'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { resolve, join, dirname } from 'node:path'
import { readFile, readdir, appendFile, access } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { createRuntime, loadWorkflow } from './codex_workflow/runtime.mjs'
import { createBackend, runProcess } from './codex_workflow/backend.mjs'
import { transportSchema, decodeResult, validDate } from './codex_workflow/schema.mjs'
import { openState, writeJson, acquireRunLock, createProcessRegistry } from './codex_workflow/state.mjs'
import { prepareData, runThesis, lensNames } from './codex_workflow/thesis.mjs'

const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const workflows = ['equity-thesis', 'peer-comparability', 'calibrate-equity-thesis']

export function parseArguments(argv) {
  const { values: v, positionals } = parseArgs({ args: argv, allowPositionals: true, options: {
    symbol: { type: 'string' }, date: { type: 'string' }, root: { type: 'string' },
    jobs: { type: 'string', default: '3' }, model: { type: 'string' }, effort: { type: 'string' },
    'args-file': { type: 'string' }, 'no-pdf': { type: 'boolean' }, check: { type: 'boolean' },
    reset: { type: 'boolean' }, help: { type: 'boolean' },
  } })
  if (v.help) return { help: true }
  if (positionals.length !== 1 || !workflows.includes(positionals[0])) throw new Error(`Choose workflow: ${workflows.join(', ')}`)
  const jobs = Number(v.jobs)
  if (!Number.isInteger(jobs) || jobs < 1) throw new Error('jobs must be a positive integer')
  if (v.effort && !['low', 'medium', 'high', 'xhigh'].includes(v.effort)) throw new Error('effort must be low, medium, high or xhigh')
  const now = new Date()
  const today = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`
  const args = {}
  if (v.symbol) args.symbol = v.symbol.toUpperCase().replace(/\.HK$/, '')
  if (args.symbol && !/^(?:\d{5}|\d{6})$/.test(args.symbol)) throw new Error('symbol must be 5 HK digits or 6 A-share digits')
  if (v.date || positionals[0] === 'equity-thesis') {
    args.date = v.date ?? today
    if (!/^\d{8}$/.test(args.date) || !validDate(`${args.date.slice(0, 4)}-${args.date.slice(4, 6)}-${args.date.slice(6, 8)}`)) throw new Error('date must be a valid YYYYMMDD')
  }
  if (positionals[0] === 'equity-thesis' && !v.symbol && !v['args-file']) throw new Error('equity-thesis requires --symbol')
  const root = resolve(v.root ?? defaultRoot)
  return { name: positionals[0], root, args: { ...args, root }, jobs, model: v.model, effort: v.effort,
    argsFile: v['args-file'], noPdf: !!v['no-pdf'], check: !!v.check, reset: !!v.reset }
}

function sample(schema) {
  if (schema.enum) return schema.enum[0]
  if (schema.type === 'object') return Object.fromEntries(Object.entries(schema.properties ?? {}).map(([key, value]) => [key, sample(value)]))
  if (schema.type === 'array') return Array.from({ length: schema.minItems ?? 1 }, () => sample(schema.items))
  if (schema.type === 'boolean') return false
  if (schema.type === 'number' || schema.type === 'integer') return 1
  return 'check'
}

export async function inspectWorkflow({ root, name, args }) {
  const stages = []
  const runtime = createRuntime({ runAgent: async (prompt, options) => {
    transportSchema(options.schema)
    stages.push({ label: options.label, phase: options.phase })
    const value = sample(options.schema)
    if (options.label === '盘点') for (const [key, field] of Object.entries(options.schema.properties)) {
      if (field.type === 'array') value[key] = []
    }
    return decodeResult(options.schema, value)
  } })
  const run = await loadWorkflow(join(root, `.claude/workflows/${name}.mjs`))
  await run(args, runtime)
  return { workflow: name, checked: true, model_calls: 0, stages }
}

export async function workflowFingerprint(root, name, args, config) {
  const hash = createHash('sha256').update(JSON.stringify({ name, args, model: config.model, effort: config.effort }))
  const visited = new Set()
  async function include(path) {
    let entries
    try { entries = await readdir(path, { withFileTypes: true }) }
    catch (e) {
      if (e.code === 'ENOTDIR') {
        hash.update(path)
        for await (const chunk of createReadStream(path)) hash.update(chunk)
        return
      }
      throw e
    }
    const { realpath } = await import('node:fs/promises')
    const physical = await realpath(path)
    if (visited.has(physical)) return
    visited.add(physical)
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!['.codex-workflow', 'peers_curated.json'].includes(entry.name)) await include(join(path, entry.name))
    }
  }
  await include(join(root, `.claude/workflows/${name}.mjs`))
  await include(join(root, '.claude/skills'))
  await include(fileURLToPath(new URL('./codex_workflow/', import.meta.url)))
  await include(fileURLToPath(import.meta.url))
  if (name === 'equity-thesis') await include(join(root, `data/${args.symbol}`))
  if (name === 'calibrate-equity-thesis' && !(Array.isArray(args.digests) && args.digests.length === 5)) {
    const source = await readFile(join(root, '.claude/workflows/calibrate-equity-thesis.mjs'), 'utf8')
    const directory = source.match(/const DIR = '([^']+)'/)[1]
    for (const match of source.matchAll(/file: '([^']+\.pdf)'/g)) await include(join(directory, match[1]))
  }
  return hash.digest('hex')
}

export function workflowLocations({ root, name, args }) {
  if (name === 'equity-thesis') {
    const run = join(root, `reports/${args.symbol}_thesis_${args.date}`)
    const position = join(root, `positions/${args.symbol}.md`)
    return { run, sharedLock: join(root, 'positions/.codex-workflow', args.symbol), roots: [run, position], resetArtifacts: ['疑惑.md', 'report.md', 'findings', '核查', '参照系'].map(p => join(run, p)),
      dependents: (label, labels) => labels.filter(target => {
        if (label === '立疑') return target !== label && target !== '盘点'
        if (label.startsWith('挖掘:') && target === `核查:${label.slice(3)}`) return true
        if (label.startsWith('挖掘:') || label.startsWith('核查:') || label === '板块基准') return ['补参照系', '成稿', '更新档案'].includes(target) || target.startsWith('修复')
        if (label === '补参照系') return ['成稿', '更新档案'].includes(target) || target.startsWith('修复')
        if (label === '成稿') return target === '更新档案' || target.startsWith('修复')
        return false
      }), artifactsFor: label => {
      if (label === '立疑') return [join(run, '疑惑.md')]
      if (label.startsWith('挖掘:')) return [join(run, `findings/${label.slice(3)}.md`)]
      if (label.startsWith('核查:')) return [join(run, `核查/${label.slice(3)}.md`), { path: join(run, `findings/${label.slice(3)}.md`), retainOnInvalidate: true }]
      if (label === '板块基准') return [join(run, '参照系/板块基准.md')]
      if (label === '补参照系') return [{ path: join(run, '参照系/补.md'), optional: true }]
      if (label === '成稿') return [join(run, 'report.md')]
      if (label === '更新档案') return [position]
      if (label.startsWith('修复硬门')) return [position, join(run, 'report.md'), join(run, '疑惑.md'),
        ...lensNames.flatMap(n => [join(run, `findings/${n}.md`), join(run, `核查/${n}.md`)]),
        ...['板块基准', '补'].map(n => ({ path: join(run, `参照系/${n}.md`), optional: true }))]
      return []
    } }
  }
  if (name === 'peer-comparability') {
    if (!args.variety || !args.archetype || /[\\/]|^\.{1,2}$/.test(args.variety)) throw new Error('peer-comparability requires a safe variety and archetype in --args-file')
    const run = join(root, 'data/_peers', args.variety)
    return { run, sharedLock: join(root, 'data/_peers/.codex-workflow'), roots: [run], resetArtifacts: ['制度导航.md', 'ledger.md', '判定'].map(p => join(run, p)),
      dependents: (label, labels) => labels.filter(target => {
        if (label === '读配置') return !['读配置', '盘点'].includes(target)
        if (label === '制度导航') return ['候选发现', '出台账'].includes(target) || target.startsWith('判定:')
        if (label === '候选发现') return target === '出台账' || target.startsWith('判定:')
        return label.startsWith('判定:') && target === '出台账'
      }), artifactsFor: (label, prompt) => {
      if (label === '制度导航') return [join(run, '制度导航.md')]
      if (label === '出台账') return [join(run, 'ledger.md')]
      if (label.startsWith('判定:')) {
        const prefix = join(run, '判定') + '/'
        const matches = prompt.split(prefix).slice(1).map(part => part.match(/^[A-Za-z0-9\u4e00-\u9fff_]{1,32}\.md/)?.[0]).filter(Boolean)
        if (!matches.length) throw new Error(`Cannot determine verdict output for ${label}`)
        return [...new Set(matches.map(file => prefix + file))]
      }
      return []
    } }
  }
  const run = '/tmp/doc-digest'
  return { run, roots: [run], dependents: label => label.startsWith('盲抽:') ? ['归纳'] : [], resetArtifacts: ['石基', '澜起', '开立', '中控', '乐鑫'].map(p => join(run, `${p}.md`)), artifactsFor: label => label.startsWith('盲抽:') ? [join(run, `${label.slice(3)}.md`)] : [] }
}

export async function main(argv = process.argv.slice(2)) {
  const config = parseArguments(argv)
  if (config.help) {
    console.log('Usage: node tools/run_codex_workflow.mjs <equity-thesis|peer-comparability|calibrate-equity-thesis>\n  --symbol CODE --date YYYYMMDD --args-file FILE --root DIR\n  --jobs 3 --model MODEL --effort high --check --reset --no-pdf')
    return
  }
  if (config.argsFile) {
    const supplied = JSON.parse(await readFile(resolve(config.argsFile), 'utf8'))
    if (!supplied || Array.isArray(supplied) || typeof supplied !== 'object') throw new Error('args-file must contain a JSON object')
    config.args = { ...config.args, ...supplied, root: config.root }
    // Apply the same symbol/date validation to JSON input.
    if (config.name === 'equity-thesis') {
      const validated = parseArguments(['equity-thesis', '--symbol', String(config.args.symbol ?? ''), '--date', String(config.args.date)])
      config.args.symbol = validated.args.symbol
      config.args.date = validated.args.date
    }
  }
  if (config.check) {
    console.log(JSON.stringify(await inspectWorkflow(config), null, 2))
    return
  }
  const { run, sharedLock, roots, artifactsFor, resetArtifacts, dependents } = workflowLocations(config)
  if (config.name === 'calibrate-equity-thesis' && !config.args.digests) {
    await access('/home/hongshi/ work_document/模板报告（之前的文件）')
  }
  const control = new AbortController()
  const interrupt = () => control.abort(new Error('Workflow interrupted'))
  process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt)
  let state, runtime, prepared, sharedRelease, logWrites = Promise.resolve()
  const emit = event => {
    const item = { time: new Date().toISOString(), ...event }
    process.stderr.write(`[${item.type}] ${item.label ?? item.name ?? item.message ?? item.path ?? ''}\n`)
    if (state) logWrites = logWrites.then(() => appendFile(join(state.directory, 'events.jsonl'), JSON.stringify(item) + '\n'))
  }
  const registry = createProcessRegistry(join(run, '.codex-workflow'))
  const runCommand = (command, args, options) => runProcess(command, args, { ...options, onSpawn: registry.started, onClose: registry.ended })
  try {
    if (sharedLock) sharedRelease = await acquireRunLock(sharedLock, { processesFile: registry.path })
    state = await openState({ dir: join(run, '.codex-workflow'), artifactRoots: roots, artifactsFor, resetArtifacts, dependents, processesFile: registry.path, reset: config.reset, emit,
      invocation: { name: config.name, args: config.args, jobs: config.jobs, model: config.model ?? null, effort: config.effort ?? null, noPdf: config.noPdf },
      fingerprint: async () => {
        if (config.name === 'equity-thesis') prepared = await prepareData({ root: config.root, symbol: config.args.symbol, signal: control.signal, runCommand })
        return workflowFingerprint(config.root, config.name, config.args, config)
      } })
    const backend = createBackend({ root: config.root, logDir: join(state.directory, 'agents'), model: config.model, effort: config.effort, emit, processRegistry: registry })
    runtime = createRuntime({ jobs: config.jobs, signal: control.signal, emit, runAgent: (prompt, options, signal) => {
      if (config.name === 'equity-thesis' && ['立疑', '成稿'].includes(options.label)) {
        prompt += `\n读取 ${config.root}/positions/${config.args.symbol}.md（不存在就是首次建档）。带入上次估值锚及理由、假设记分板、未决疑问，保留人工注入信息。\n数据警告必须在成稿披露：${prepared.warnings.join('\n') || '无'}\n`
      }
      return state.run(prompt, options, backend, signal)
    } })
    const workflow = await loadWorkflow(join(config.root, `.claude/workflows/${config.name}.mjs`))
    const result = config.name === 'equity-thesis'
      ? await runThesis({ root: config.root, args: config.args, runtime, runWorkflow: workflow, prepared, noPdf: config.noPdf, signal: runtime.signal, runCommand, allowReuse: state.canReuse() })
      : await workflow(config.args, runtime)
    await writeJson(join(state.directory, 'result.json'), result)
    await state.complete()
    const summary = config.name === 'equity-thesis' ? result : { workflow: config.name, run_dir: run, result_file: join(state.directory, 'result.json'), counts: result.counts, ledger_file: result.ledger_file }
    console.log(JSON.stringify(summary, null, 2))
  } finally {
    runtime?.abort(new Error('Workflow finished'))
    await runtime?.drain()
    await logWrites
    await state?.close()
    await sharedRelease?.()
    process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(`Workflow failed: ${error.message}`); process.exitCode = 1 })
}
