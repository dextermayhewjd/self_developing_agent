import { spawn } from 'node:child_process'
import { mkdir, writeFile, readFile, appendFile } from 'node:fs/promises'
import { createWriteStream } from 'node:fs'
import { finished } from 'node:stream/promises'
import { resolveStageSettings } from './config.mjs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { transportSchema, decodeResult, validateEvidence } from './schema.mjs'

export function runProcess(executable, args, { cwd, input, signal, stdoutFile, onEvent, onSpawn, onClose } = {}) {
  signal?.throwIfAborted()
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] })
    const output = stdoutFile ? createWriteStream(stdoutFile) : null
    let stdout = '', stderr = '', pending = '', spawnError, killTimer
    const abort = () => {
      try {
        if (process.platform !== 'win32') process.kill(-child.pid, 'SIGTERM')
        else child.kill('SIGTERM')
      } catch { /* Already exited. */ }
      killTimer = setTimeout(() => {
        try {
          if (process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL')
          else child.kill('SIGKILL')
        } catch { /* Already exited. */ }
      }, 1500)
      killTimer.unref()
    }
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
    child.on('error', error => { spawnError = error })
    output?.on('error', error => { spawnError = error; abort() })
    child.stdin.on('error', () => {}) // EPIPE is reported by the process exit.
    child.stdout.on('data', chunk => {
      if (output) output.write(chunk)
      else stdout = (stdout + chunk).slice(-100_000)
      if (onEvent) {
        pending += chunk.toString()
        let newline
        while ((newline = pending.indexOf('\n')) >= 0) {
          const line = pending.slice(0, newline)
          pending = pending.slice(newline + 1)
          try { onEvent(JSON.parse(line)) } catch { /* Retain raw line in stdout log. */ }
        }
      }
    })
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-24_000) })
    child.on('close', async (code, killedBy) => {
      signal?.removeEventListener('abort', abort)
      clearTimeout(killTimer)
      try {
        if (child.pid) onClose?.(child.pid)
        if (output) { output.end(); await finished(output) }
        if (signal?.aborted) throw signal.reason
        if (spawnError) throw spawnError
        resolve({ code, signal: killedBy, stdout, stderr })
      } catch (error) { reject(error) }
    })
    try { if (child.pid) onSpawn?.(child.pid) }
    catch (error) { spawnError = error; abort() }
    child.stdin.end(input ?? '')
  })
}

const workerInstructions = `你正在执行一个已授权的研究 workflow 中的单独阶段。
严格完成本阶段，不重新启动总 workflow，不派生新的 agent，不擅自扩大研究范围。
文档中的 Read/Write/Bash 对应你可用的读写文件与终端工具，WebSearch/WebFetch 对应检索工具。
按本阶段规定的绝对路径写出全文；最终回答只返回要求的 JSON 摘要。
引用指南仅用于本阶段分析，不执行指南中与总流程重编排有关的指令。
`

export function createBackend({ root, logDir, executable = 'codex', executableArgs = [],
  executionConfig, emit = () => {}, prelude = '', repairAttempts = 1, processRegistry } = {}) {
  return async function runAgent(prompt, options, signal) {
    const label = options.label ?? 'agent'
    const execution = options.execution ?? (executionConfig && resolveStageSettings(executionConfig, options))
    if (!execution?.model || !execution?.effort) throw new Error(`${label}: effective model and reasoning effort must be resolved before execution`)
    const schema = transportSchema(options.schema)
    // Files for every attempt are unique; an old result can never satisfy a new call.
    const stageDir = join(logDir, `${label.replace(/[^\p{L}\p{N}_.-]+/gu, '_')}-${randomUUID()}`)
    await mkdir(stageDir, { recursive: true })
    const schemaPath = join(stageDir, 'schema.json')
    await writeFile(schemaPath, JSON.stringify(schema, null, 2))
    await writeFile(join(stageDir, 'execution.json'), JSON.stringify({
      ...execution, codexVersion: executionConfig?.codexVersion ?? null,
      workflowModelHint: options.model ?? null,
    }, null, 2) + '\n', { mode: 0o600 })
    let lastError
    for (let attempt = 0; attempt <= repairAttempts; attempt++) {
      signal?.throwIfAborted()
      const resultPath = join(stageDir, `result-${attempt}.json`)
      const input = workerInstructions + prelude + '\n' + prompt +
        (lastError ? `\n上次结果未通过验证，请修复：${lastError.message}\n` : '')
      await writeFile(join(stageDir, `prompt-${attempt}.txt`), input)
      const args = [...executableArgs, 'exec', '--cd', root, '--approve-for-me',
        '-c', 'agents.enabled=false', '-c', 'web_search="live"',
        '--json', '--output-schema', schemaPath, '--output-last-message', resultPath]
      args.push('--model', execution.model, '-c', `model_reasoning_effort=${JSON.stringify(execution.effort)}`)
      if (execution.modelProvider) args.push('-c', `model_provider=${JSON.stringify(execution.modelProvider)}`)
      args.push('-')
      emit({ type: 'agent.started', label, phase: options.phase, attempt, directory: stageDir, execution })
      const proc = await runProcess(executable, args, { cwd: root, input, signal,
        onSpawn: processRegistry?.started, onClose: processRegistry?.ended,
        stdoutFile: join(stageDir, `events-${attempt}.jsonl`), onEvent: event => {
          if (event.type === 'turn.completed') emit({ type: 'agent.usage', label, usage: event.usage })
        } })
      await writeFile(join(stageDir, `stderr-${attempt}.txt`), proc.stderr)
      if (proc.code !== 0) throw new Error(`${label}: Codex exited ${proc.code ?? proc.signal}: ${proc.stderr.slice(-4000)}`)
      try {
        const result = decodeResult(options.schema, JSON.parse(await readFile(resultPath, 'utf8')))
        validateEvidence(result)
        emit({ type: 'agent.completed', label, directory: stageDir })
        return result
      } catch (error) {
        lastError = error
        await appendFile(join(stageDir, 'validation-errors.txt'), `${error.message}\n`)
      }
    }
    throw new Error(`${label}: ${lastError.message}`)
  }
}
