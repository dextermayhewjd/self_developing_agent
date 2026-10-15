import { access, readFile, stat, readdir } from 'node:fs/promises'
import { constants } from 'node:fs'
import { join } from 'node:path'
import { runProcess } from './backend.mjs'

export const lensNames = ['财务排雷', '尽调', '产业', '竞争', '战略驱动']
export async function pythonFor(root) {
  const path = join(root, '.venv/bin/python')
  try { await access(path, constants.X_OK); return path } catch { return 'python3' }
}
const output = p => [p.stdout, p.stderr].filter(Boolean).join('\n')

export async function prepareData({ root, symbol, signal, runCommand = runProcess }) {
  const python = await pythonFor(root)
  const validate = () => runCommand(python, [join(root, 'tools/validate.py'), symbol], { cwd: root, signal })
  let result = await validate()
  if (result.code === 1) {
    const fetched = await runCommand(python, [join(root, 'tools/run_pipeline.py'), symbol], { cwd: root, signal })
    if (fetched.code !== 0) throw new Error(`Data pipeline failed (${fetched.code}): ${output(fetched)}`)
    result = await validate()
  }
  if (![0, 2].includes(result.code)) throw new Error(`Data validation failed (${result.code}): ${output(result)}`)
  return { warnings: result.code === 2 ? [output(result)] : [] }
}

async function requireFile(path) {
  const info = await stat(path)
  if (!info.isFile() || info.size <= 200) throw new Error(`Incomplete artifact: ${path}`)
}

async function requireArtifacts(run) {
  await requireFile(join(run, '疑惑.md'))
  await requireFile(join(run, 'report.md'))
  for (const name of lensNames) {
    await requireFile(join(run, `findings/${name}.md`))
    await requireFile(join(run, `核查/${name}.md`))
  }
}

async function requirePosition(path, date) {
  const expected = `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`
  if (!new RegExp(`^最近更新:\\s*['"]?${expected}['"]?\\s*$`, 'm').test(await readFile(path, 'utf8'))) {
    throw new Error(`Position 最近更新 must equal ${expected}: ${path}`)
  }
}

async function totals(run) {
  let checked = 0
  for (const name of lensNames) {
    const body = await readFile(join(run, `核查/${name}.md`), 'utf8')
    checked += (body.match(/^\s*- \[(?:确认无误|修正)\]/gm) ?? []).length
  }
  const report = await readFile(join(run, 'report.md'), 'utf8')
  return { verified_total: checked, doubts_answered: new Set(report.match(/现在回答开篇的问题\s*\d+/g) ?? []).size }
}

export async function runThesis({ root, args, runtime, runWorkflow, noPdf = false,
  prepared, signal, runCommand = runProcess, allowReuse = true }) {
  const { symbol, date } = args
  const run = join(root, `reports/${symbol}_thesis_${date}`)
  const reportPath = join(run, 'report.md')
  const positionPath = join(root, `positions/${symbol}.md`)
  const pdfPath = join(root, `reports/pdf/${symbol}_thesis_${date}.pdf`)
  const python = await pythonFor(root)
  const { warnings } = prepared ?? await prepareData({ root, symbol, signal, runCommand })
  const gate = async () => {
    const result = await runCommand(python, [join(root, 'tools/check_thesis.py'), symbol, reportPath], { cwd: root, signal })
    if (![0, 1, 2].includes(result.code)) throw new Error(`Gate tool failed (${result.code}): ${output(result)}`)
    return result
  }
  let reused = false, gateResult, researchResult
  try {
    if (!allowReuse) throw new Error('Incomplete prior workflow stages require reconciliation')
    await requireArtifacts(run)
    await requirePosition(positionPath, date)
    gateResult = await gate()
    reused = [0, 2].includes(gateResult.code)
  } catch (error) {
    // Missing prior files are normal on a first run. Tool errors are not.
    if (error.message.startsWith('Gate tool failed')) throw error
  }
  if (!reused) {
    researchResult = await runWorkflow(args, runtime)
    await requireArtifacts(run)
    await runtime.agent(`根据 ${reportPath} 更新 ${positionPath}，先读取已有档案及
${root}/.claude/skills/equity-thesis-cn/position_file.md。保留人工注入区，更新评分、评级、估值锚及变更理由、
假设记分板、未决疑问和变更日志。frontmatter 最近更新必须为 ${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}。
只更新档案，不重做研究，不修改输入数据或检验规则。`, {
      label: '更新档案', phase: '交付', schema: { type: 'object', required: ['written_file'], properties: { written_file: { type: 'string' } } },
    })
    await requirePosition(positionPath, date)
    gateResult = await gate()
    for (let attempt = 1; gateResult.code === 1 && attempt <= 2; attempt++) {
      await runtime.agent(`交付硬门失败。只根据下面的反馈修复 ${reportPath}、${positionPath}，
必要时修正本 run 下已有的 findings/核查/参照系文件；不重跑全套研究，不修改校验器或源数据，
不得编造缺失证据。修复后保持最近更新为报告日。\n${output(gateResult)}`, {
        label: `修复硬门:${attempt}`, phase: '交付', schema: { type: 'object', required: ['written_file'], properties: { written_file: { type: 'string' } } },
      })
      await requirePosition(positionPath, date)
      gateResult = await gate()
    }
    if (gateResult.code === 1) throw new Error(`Hard gate failed after two repairs: ${output(gateResult)}`)
  }
  if (gateResult.code === 2) warnings.push(output(gateResult))
  const pdf = { status: 'skipped', path: null }
  if (!noPdf) {
    const result = await runCommand(python, [join(root, 'tools/md_to_pdf.py'), '--md', reportPath], { cwd: root, signal })
    if (result.code !== 0) throw new Error(`PDF generation failed (${result.code}): ${output(result)}`)
    if ((await stat(pdfPath)).size === 0) throw new Error(`Empty PDF: ${pdfPath}`)
    pdf.status = 'generated'; pdf.path = pdfPath
  }
  return { symbol, run_dir: run, report: reportPath, position: positionPath, reused,
    gate_exit_code: gateResult.code, warnings, pdf, ...await totals(run),
    verified_this_run: researchResult?.checked_total ?? 0 }
}
