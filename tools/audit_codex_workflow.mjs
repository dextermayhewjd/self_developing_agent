#!/usr/bin/env node
import { readFile, readdir, stat } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

import { inspectReviewStore } from './codex_workflow/review-store.mjs'
import { loadEvidenceContext } from './codex_workflow/review-evidence.mjs'
import { validateReviewRecord } from './check_thesis_review.mjs'

// This is a trace audit, not an assessment of financial truth or semantic coverage.
export function classifyTool(item) {
  const command = String(item.command ?? '')
  if (item.type === 'command_execution') {
    let kind = 'command'
    if (/\b(?:curl|wget)\b/.test(command)) kind = 'download'
    else if (/\b(?:pdftotext|pdftoppm)\b/.test(command)) kind = 'pdf'
    else if (/\b(?:cat|sed|head|tail|rg|grep|readFile)\b/.test(command)) kind = 'read'
    else if (/\b(?:apply_patch|writeFile|tee)\b/.test(command)) kind = 'write'
    return { kind, command: command.slice(0, 1800), exit_code: item.exit_code ?? null }
  }
  const action = item.action ?? {}
  if (item.type === 'web_search') {
    return { kind: /open|click|find/.test(action.type ?? '') ? 'open' : 'search',
      action: action.type ?? 'search', query: action.query ?? action.queries ?? item.query ?? action.url ?? null }
  }
  if (item.type === 'file_change') return { kind: 'write', files: (item.changes ?? []).map(change => change.path) }
  if (item.type === 'mcp_tool_call' || item.type === 'dynamic_tool_call') {
    return { kind: 'tool', tool: item.tool ?? item.name ?? 'unknown', server: item.server ?? null }
  }
  return null
}

export function detectSelfLookup(query, { symbol, company } = {}) {
  const text = Array.isArray(query) ? query.join(' ') : String(query ?? '')
  const escaped = String(symbol ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const self = (symbol && new RegExp(`(?<!\\d)${escaped}(?!\\d)`).test(text)) || (company && text.includes(company))
  const financial = /净利润|营收|营业收入|毛利率|净利率|市值|\b(?:PE|PB|PS)\b|现金流|负债率|股东|业绩|财报|年报|净资产/i.test(text)
  const peers = /同业|可比|对标|peer|comparable|中位数|板块|行业|对比|比较|同行|同类|竞品|竞争对手|benchmark|分位|均值|平均/i.test(text)
  return Boolean(self && financial && !peers)
}

export async function auditCodexWorkflow(directory, identity = {}) {
  const supplied = resolve(directory)
  const control = basename(supplied) === '.codex-workflow' ? supplied : join(supplied, '.codex-workflow')
  const run = dirname(control), findings = []
  const add = (severity, code, message, evidence) => findings.push({ severity, code, message, evidence })
  async function json(path) {
    try { return JSON.parse(await readFile(path, 'utf8')) }
    catch (error) { add('error', 'metadata-unreadable', `${basename(path)} 无法读取或解析`, path); return null }
  }
  async function lines(path, historical = false) {
    let data
    try { data = await readFile(path, 'utf8') }
    catch { add(historical ? 'warning' : 'error', 'log-missing', '缺少日志，无法验证执行', path); return [] }
    const result = []
    for (const [i, line] of data.split('\n').entries()) {
      if (!line.trim()) continue
      try { result.push({ event: JSON.parse(line), line: i + 1 }) }
      catch { add(historical ? 'warning' : 'error', 'invalid-jsonl', '日志包含不可解析的记录', `${path}:${i + 1}`) }
    }
    return result
  }
  const state = await json(join(control, 'state.json'))
  const result = await json(join(control, 'result.json'))
  const subject = { symbol: identity.symbol ?? state?.invocation?.args?.symbol, company: identity.company }
  if (!subject.company) {
    try {
      const report = await readFile(join(run, 'report.md'), 'utf8')
      subject.company = report.match(/^name:\s*['"]?([^\n'"]+)['"]?\s*$/m)?.[1]?.trim()
    } catch { /* The explicit ticker can still support the check. */ }
  }
  const events = await lines(join(control, 'events.jsonl'))
  const starts = new Map(), latest = new Map()
  for (const { event } of events) if (event.type === 'agent.started' && event.directory) {
    starts.set(basename(event.directory), event)
    latest.set(event.label, basename(event.directory))
  }
  const stages = [], seen = new Set(), artifacts = []
  let dirs = []
  try { dirs = await readdir(join(control, 'agents'), { withFileTypes: true }) }
  catch { add('error', 'worker-log-missing', '缺少阶段日志目录', join(control, 'agents')) }
  for (const entry of dirs.filter(d => d.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const stageDir = join(control, 'agents', entry.name), started = starts.get(entry.name)
    const label = started?.label ?? entry.name.replace(/-[a-f\d]{8}-[a-f\d-]{27,}$/i, '')
    const historical = Boolean(started && latest.get(label) !== entry.name)
    const files = (await readdir(stageDir)).filter(f => /^events-\d+\.jsonl$/.test(f))
      .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]))
    const tools = [], usage = { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 }
    let terminal = false
    if (!files.length) add(historical ? 'warning' : 'error', 'worker-log-missing', `${label} 缺少工具日志`, stageDir)
    for (const file of files) {
      const path = join(stageDir, file), ids = new Set()
      for (const { event, line } of await lines(path, historical)) {
        if (event.type === 'turn.completed') {
          terminal = true
          for (const field of Object.keys(usage)) usage[field] += Number(event.usage?.[field] ?? 0)
        }
        if (event.type !== 'item.completed' || !event.item) continue
        const id = event.item.id ?? `line:${line}`
        if (ids.has(id)) continue
        ids.add(id)
        const tool = classifyTool(event.item)
        if (!tool) continue
        const record = { ...tool, evidence: `${path}:${line}` }
        tools.push(record)
        const writing = /^(成稿(?:$|[^审])|修订成稿)/u.test(label)
        if (writing && ['pdf', 'download', 'search'].includes(tool.kind)) {
          add('warning', 'writer-source-retrieval', `${label} 出现新增取证信号，请核对是否越过既有底稿范围`, record.evidence)
        }
        if (label.startsWith('核查') && tool.kind === 'search') {
          add('warning', 'verification-web-search', `${label} 使用搜索；原件回读与新增搜索需要分别核对`, record.evidence)
        }
        if (['板块基准', '补参照系'].includes(label) && ['search', 'open', 'download'].includes(tool.kind) &&
            detectSelfLookup(tool.query ?? tool.command, subject)) {
          add('warning', 'benchmark-self-lookup', `${label} 出现检索标的自身财务数据的信号，请核对是否超出同业研究范围`, record.evidence)
        }
      }
    }
    const status = historical ? 'superseded' : state?.stages?.[label]?.status ?? 'untracked'
    if (status === 'succeeded' && !terminal) add('error', 'worker-incomplete', `${label} 未发现成功终止记录`, stageDir)
    stages.push({ label, status, started: started?.time ?? null, directory: stageDir, tools, usage })
    if (!historical) seen.add(label)
  }
  for (const [label, stage] of Object.entries(state?.stages ?? {})) {
    if (stage.status !== 'succeeded') add('error', 'stage-not-complete', `${label}: ${stage.status}`, join(control, 'state.json'))
    if (!seen.has(label)) {
      add('error', 'stage-trace-unavailable', `${label} 只有状态记录，缺少可对应的工具轨迹`, join(control, 'state.json'))
      stages.push({ label, status: stage.status, directory: null, tools: [], usage: null })
    }
    for (const path of stage.artifacts ?? []) {
      let exists = false
      try { exists = (await stat(path)).isFile() } catch { /* Report missing evidence. */ }
      artifacts.push({ stage: label, path, exists })
      if (!exists) add('error', 'artifact-missing', `${label} 已登记产物不存在`, path)
    }
  }
  if (!stages.length) add('error', 'no-stage-evidence', '没有可审计的阶段记录', control)
  if (!state?.completed) add('error', 'run-not-complete', '运行没有完成标记', join(control, 'state.json'))
  if (result?.gate_exit_code === 1) add('error', 'delivery-gate-failed', '报告硬门未通过', join(control, 'result.json'))
  let reviewTasks = null
  if (state?.invocation?.name === 'equity-thesis' || stages.some(stage => /成稿审查|问题修订|修订成稿/.test(stage.label))) {
    reviewTasks = { proof: 'missing', by_kind: {}, by_status: {}, open_blocking_ids: [], snapshot: null, receipt: null, budget: null, attempt: null, terminal_reason: null, workers: [] }
    try {
      const inspected = await inspectReviewStore({ runDir: run })
      if (!inspected) add('error', 'review-proof-missing', '缺少 v2 Store HEAD/ledger/receipt；旧审查仅可诊断', join(control, 'review/HEAD.json'))
      else {
        const { ledger, snapshot, receipt, attempt, review } = inspected
        Object.assign(reviewTasks, { proof: 'verified-immutable', snapshot, receipt, budget: ledger.budget, attempt, terminal_reason: ledger.terminal_reason,
          open_blocking_ids: ledger.tasks.filter(task => task.status !== 'resolved' && task.blocks_delivery).map(task => task.id) })
        for (const task of ledger.tasks) {
          reviewTasks.by_kind[task.kind] = (reviewTasks.by_kind[task.kind] ?? 0) + 1
          reviewTasks.by_status[task.status] = (reviewTasks.by_status[task.status] ?? 0) + 1
        }
        for (const display of inspected.displays) if (display.status !== 'current') add('error', 'review-display-' + display.status, display.label + ' 显示文件' + (display.status === 'missing' ? '缺失' : '与 Store 不符；保留原文件'), display.path)
        if (inspected.deliveryError) add('error', 'review-not-deliverable', inspected.deliveryError, join(control, 'review/HEAD.json'))
        if (ledger.terminal_reason) add('error', 'review-terminal', ledger.terminal_reason, join(control, 'review/ledger.json'))
        try {
          await loadEvidenceContext({ runDir: run, manifest: inspected.evidence })
          reviewTasks.evidence_valid = true
        } catch (error) { reviewTasks.evidence_valid = false; add('error', 'review-evidence-invalid', error.message, join(control, 'review/evidence-manifest.json')) }
        if (review && (review.report_sha256 !== snapshot.report_sha256 || review.evidence_sha256 !== snapshot.evidence_sha256)) {
          reviewTasks.independent_review = 'pending-rereview'
          add('error', 'review-pending-rereview', 'Historical independent review is bound to its prior snapshot; current host candidate awaits independent rereview', join(control, 'review/HEAD.json'))
        } else if (reviewTasks.evidence_valid && review && !inspected.displays.some(item => item.label === 'report' && item.status !== 'current')) {
          try {
            await validateReviewRecord({ runDir: run, review, manifest: inspected.evidence, inputLedger: inspected.inputLedger })
            reviewTasks.independent_review = 'current'
          } catch (error) { reviewTasks.independent_review = 'invalid'; add('error', 'review-record-invalid', error.message, join(control, 'review/HEAD.json')) }
        }
      }
    } catch (error) { add('error', 'review-proof-invalid', error.message, join(control, 'review/HEAD.json')) }
    for (const stage of stages.filter(item => item.status !== 'superseded' && /成稿审查|问题修订|修订成稿/.test(item.label))) {
      try {
        const path = join(stage.directory, 'execution.json'), actual = JSON.parse(await readFile(path, 'utf8'))
        if (!actual.model || !actual.effort || !Number.isSafeInteger(actual.context_bytes)) throw new Error('missing actual model/effort/context_bytes')
        reviewTasks.workers.push({ label: stage.label, path, model: actual.model, effort: actual.effort, context_bytes: actual.context_bytes,
          sandbox: actual.sandbox, approval: actual.approval, isolation: actual.isolation ?? null })
      } catch { add('error', 'review-execution-missing', stage.label + ' 缺少实际 model/effort/context_bytes 执行元数据', stage.directory ?? control) }
    }
  }
  return { version: 2, review_tasks: reviewTasks, run_dir: run, workflow: state?.invocation?.name ?? null,
    status: findings.some(f => f.severity === 'error') ? 'incomplete' : 'complete',
    behaviour_proven: false,
    self_lookup_check: { symbol: subject.symbol ?? null, company: subject.company ?? null,
      performed: Boolean(subject.symbol || subject.company) },
    limits: ['日志证明可观察调用与文件状态，不能证明模型完整理解了指南或财务事实正确。',
      '取证信号是启发式提示；动态脚本、间接路径和外部工具可能无法被完整识别。',
      ...(!subject.symbol && !subject.company ? ['未提供或识别标的代码/名称，查自身数据的检查未执行。'] : [])],
    timeline: events.filter(({ event }) => ['phase', 'agent.started', 'agent.completed', 'agent.cached', 'agent.invalidated'].includes(event.type))
      .map(({ event, line }) => ({ time: event.time ?? null, type: event.type, label: event.label ?? event.name ?? null, evidence: `${control}/events.jsonl:${line}` })),
    stages, artifacts, findings }
}

export function renderAudit(audit) {
  const text = [`# Codex 运行审计`, '', `运行：${audit.run_dir}`, `工作流：${audit.workflow ?? '未知'}`,
    `记录状态：${audit.status}`, '', '## 阶段', '', '| 阶段 | 状态 | 工具调用 | 输入 / 输出 tokens |', '|---|---|---:|---:|']
  for (const s of audit.stages) text.push(`| ${s.label} | ${s.status} | ${s.tools.length} | ${s.usage?.input_tokens ?? '未知'} / ${s.usage?.output_tokens ?? '未知'} |`)
  if (audit.review_tasks) text.push('', '## 审查任务证明', '', '```json', JSON.stringify(audit.review_tasks, null, 2), '```')
  text.push('', '## 发现', '')
  for (const f of audit.findings) text.push(`- [${f.severity}] ${f.code}：${f.message}（${f.evidence}）`)
  if (!audit.findings.length) text.push('未发现日志完整性问题或已识别的阶段越界信号。')
  text.push('', '## 工具轨迹', '')
  for (const s of audit.stages) {
    text.push(`### ${s.label}`, '')
    for (const t of s.tools) text.push(`- ${t.kind}：${String(t.command ?? t.tool ?? t.query ?? t.files ?? t.action).replace(/\n/g, ' ')}（${t.evidence}）`)
  }
  text.push('', ...audit.limits.map(x => `- ${x}`))
  return text.join('\n') + '\n'
}

async function main() {
  const { positionals, values } = parseArgs({ allowPositionals: true, options: { json: { type: 'boolean' }, symbol: { type: 'string' }, company: { type: 'string' } } })
  if (positionals.length !== 1) throw new Error('Usage: node tools/audit_codex_workflow.mjs RUN [--json] [--symbol CODE] [--company NAME]')
  const audit = await auditCodexWorkflow(positionals[0], values)
  process.stdout.write(values.json ? JSON.stringify(audit, null, 2) + '\n' : renderAudit(audit))
  if (audit.status !== 'complete') process.exitCode = 1
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 2 })
}
