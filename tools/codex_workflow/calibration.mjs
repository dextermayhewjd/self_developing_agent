import { readFile, stat, mkdir, rename, writeFile, rm } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { join, resolve, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { writeJson } from './state.mjs'

const sourceDirectory = '/home/hongshi/ work_document/模板报告（之前的文件）'
const defaults = [
  { code: '石基', file: '次新小组研究框架（石基信息）by 井井.pdf', pages: 23 },
  { code: '澜起', file: '次新股小组-澜起科技-钟央.pdf', pages: 23 },
  { code: '开立', file: '【次新组作业】 开立医疗- BY Kenny.pdf', pages: 19 },
  { code: '中控', file: '次新研究-中控技术-BING.pdf', pages: 15 },
  { code: '乐鑫', file: '9月-乐鑫科技-汤智尧.pdf', pages: 13 },
]
const digest = text => createHash('sha256').update(text).digest('hex')
const nonempty = value => typeof value === 'string' && value.trim().length > 0
const textSchema = { type: 'string' }
const strings = { type: 'array', items: textSchema }
const object = properties => ({ type: 'object', required: Object.keys(properties), properties })
const array = items => ({ type: 'array', items })
const cardSchema = object({ id: textSchema, kind: { enum: ['established', 'omission', 'overfit', 'untestable'] },
  summary: textSchema, rule_ids: strings, eligible_docs: strings, supporting_docs: strings, source_quote: textSchema })
const collisionSchema = object({ cards: array(cardSchema), matrix: array(object({ section: { type: 'integer' },
  cells: array(object({ code: textSchema, status: { enum: ['done', 'missing', 'not_applicable'] }, evidence: textSchema })) })) })
const checksSchema = object({ checks: array(object({ id: textSchema, status: { enum: ['confirmed', 'refuted', 'unresolved'] },
  eligible_docs: strings, supporting_docs: strings, evidence: array(object({ code: textSchema, page: textSchema, quote: textSchema,
    finding: { enum: ['present', 'confirmed_absence', 'not_found', 'out_of_scope'] } })) })) })
const proposalsSchema = object({ narrative: textSchema, patches: array(object({ id: textSchema, card_id: textSchema,
  target: textSchema, before: textSchema, after: textSchema, reason: textSchema })),
  exclusions: array(object({ card_id: textSchema, reason: textSchema })) })

export const calibrationStages = [
  { label: '方法对撞', phase: '对撞', schema: collisionSchema },
  { label: '抽查', phase: '抽查', schema: checksSchema },
  { label: '校准报告', phase: '交付', schema: proposalsSchema },
]

export function calibrationDocuments(args = {}) {
  const documents = args.documents ?? defaults
  if (!Array.isArray(documents) || documents.length !== 5) throw new Error('Calibration requires exactly five source documents')
  const normalized = documents.map(doc => {
    if (!doc || !/^[\p{L}\p{N}_-]{1,32}$/u.test(doc.code) || !nonempty(doc.file) ||
      !Number.isInteger(doc.pages) || doc.pages < 1) throw new Error('Each calibration document needs a safe code, PDF file and positive page count')
    return { code: doc.code, file: resolve(args.source_dir ?? sourceDirectory, doc.file), pages: doc.pages }
  })
  if (new Set(normalized.map(doc => doc.code)).size !== 5) throw new Error('Calibration document codes must be unique')
  return normalized
}

export function calibrationLocations({ root, args = {} }) {
  if (!/^\d{8}$/.test(args.date ?? '')) throw new Error('Calibration requires YYYYMMDD date')
  const run = join(root, `reports/calibrate_${args.date}`)
  const evidence = join(root, '.codex/skills/calibrate-equity-thesis/evidence')
  const blind = join(tmpdir(), `doc-digest-${digest(JSON.stringify([root, args.date, calibrationDocuments(args)])).slice(0, 16)}`)
  return { run, evidence, blind }
}

/** Existing Markdown evidence is a supported migration input; none is inferred from JSON summaries. */
export async function readCalibrationEvidence({ root, args = {} }) {
  const documents = calibrationDocuments(args)
  const directory = join(root, '.codex/skills/calibrate-equity-thesis/evidence')
  try {
    try { await stat(join(directory, '.publishing')); return null }
    catch (error) { if (error.code !== 'ENOENT') throw error }
    const texts = await Promise.all(documents.map(async doc => {
      const text = await readFile(join(directory, `${doc.code}.md`), 'utf8')
      if (Buffer.byteLength(text) <= 200) throw new Error('Incomplete evidence')
      return { code: doc.code, text }
    }))
    const methods_text = await readFile(join(directory, 'methods.md'), 'utf8')
    if (Buffer.byteLength(methods_text) <= 200) return null
    let manifest
    try { manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8')) }
    catch (error) { if (error.code !== 'ENOENT') return null }
    if (manifest) {
      if (manifest.version !== 1 || !Array.isArray(manifest.documents)) return null
      for (const doc of documents) {
        const saved = manifest.documents.find(entry => entry.code === doc.code)
        if (!saved || saved.file !== doc.file || saved.pages !== doc.pages) return null
        try { if (saved.sha256 !== digest(await readFile(doc.file))) return null }
        catch (error) { if (error.code !== 'ENOENT') throw error }
        if (saved.evidence_sha256 !== digest(texts.find(item => item.code === doc.code).text)) return null
      }
      if (manifest.methods_sha256 !== digest(methods_text)) return null
    } else if (args.documents || args.source_dir) return null
    return { documents: texts, methods_text, provenance: manifest ? 'manifest-verified' : 'migrated-markdown' }
  } catch (error) {
    if (error.code === 'ENOENT' || error.message === 'Incomplete evidence') return null
    throw error
  }
}

function countValid(card) {
  return Array.isArray(card?.eligible_docs) && Array.isArray(card?.supporting_docs) &&
    new Set(card.eligible_docs).size === card.eligible_docs.length &&
    new Set(card.supporting_docs).size === card.supporting_docs.length &&
    card.supporting_docs.every(code => card.eligible_docs.includes(code))
}

/** A proposal needs both the sample threshold and independent source confirmation. */
export function patchEligible(card, check) {
  if (!countValid(card) || check?.status !== 'confirmed') return false
  return card.kind === 'omission' ? card.supporting_docs.length >= 3
    : card.kind === 'overfit' && card.supporting_docs.length === 0 && card.eligible_docs.length >= 3
}

const cell = text => String(text).replaceAll('|', '\\|').replaceAll('\n', '<br>')
function table(headers, rows) {
  return `| ${headers.join(' | ')} |\n| ${headers.map(() => '---').join(' | ')} |\n` +
    rows.map(row => `| ${row.map(cell).join(' | ')} |`).join('\n') + '\n'
}
async function writeText(path, text) {
  await mkdir(dirname(path), { recursive: true })
  const temp = `${path}.${randomUUID()}.tmp`
  await writeFile(temp, text)
  await rename(temp, path)
}

function validateCollision(value, codes, rules, evidenceText) {
  if (!Array.isArray(value?.cards) || !Array.isArray(value.matrix) || value.matrix.length !== 12) throw new Error('Calibration collision must include cards and all twelve sections')
  const ids = new Set(), sections = new Set(), ruleIds = new Set(rules.map(rule => rule.id))
  for (const card of value.cards) {
    if (!nonempty(card.id) || ids.has(card.id) || !nonempty(card.summary) || !countValid(card) ||
      !['established', 'omission', 'overfit', 'untestable'].includes(card.kind) ||
      card.eligible_docs.some(code => !codes.includes(code)) ||
      !Array.isArray(card.rule_ids) || card.rule_ids.some(id => !ruleIds.has(id)) ||
      !nonempty(card.source_quote) || !evidenceText.includes(card.source_quote)) throw new Error(`Invalid collision card ${card.id}`)
    if (!card.eligible_docs.length && card.kind !== 'untestable') throw new Error(`Zero-sample card must be untestable: ${card.id}`)
    ids.add(card.id)
  }
  for (const section of value.matrix) {
    if (!Number.isInteger(section.section) || section.section < 1 || section.section > 12 || sections.has(section.section) ||
      !Array.isArray(section.cells) || section.cells.length !== 5 || new Set(section.cells.map(c => c.code)).size !== 5 ||
      section.cells.some(c => !codes.includes(c.code) || !['done', 'missing', 'not_applicable'].includes(c.status) || !nonempty(c.evidence))) {
      throw new Error('Invalid twelve-section calibration matrix')
    }
    sections.add(section.section)
  }
}

export async function runCalibration({ root, args, runtime, runWorkflow }) {
  const paths = calibrationLocations({ root, args }), documents = calibrationDocuments(args)
  let evidence = await readCalibrationEvidence({ root, args })
  const reused = Boolean(evidence)
  // User-supplied summary arrays are not substitutes for the durable six-file bundle.
  const { digests: ignoredDigests, methods: ignoredMethods, ...input } = args
  if (!evidence) for (const doc of documents) {
    const info = await stat(doc.file)
    if (!info.isFile()) throw new Error(`Not a source PDF: ${doc.file}`)
  }
  await mkdir(paths.run, { recursive: true })
  await mkdir(paths.blind, { recursive: true })
  const core = await runWorkflow({ ...input, root, documents, blind_dir: paths.blind, evidence_ready: reused }, runtime)
  if (!Array.isArray(core.rules) || !core.rules.length) throw new Error('Calibration rules mapping is empty')
  if (!evidence) {
    if (!Array.isArray(core.digests) || core.digests.length !== 5 || !Array.isArray(core.methods) || !core.methods.length) throw new Error('Calibration extraction did not return all five documents and methods')
    const byCode = new Map(core.digests.map(item => [item.code, item]))
    const persisted = []
    for (const doc of documents) {
      const item = byCode.get(doc.code)
      if (!item || !Array.isArray(item.actions) || item.actions.length < 20 || !item.attributes ||
        item.actions.some(action => ['action', 'page', 'quote', 'serves_what'].some(key => !nonempty(action[key])))) throw new Error(`Incomplete extraction for ${doc.code}`)
      const expectedFile = join(paths.blind, `${doc.code}.md`)
      if (item.written_file !== expectedFile || (await stat(expectedFile)).size <= 200) throw new Error(`Extraction artifact missing: ${doc.code}`)
      const text = `# ${doc.code}\n\n` + table(['动作', '页码', '原文或表格摘录', '这个动作服务于什么判断'],
        item.actions.map(action => [action.action, action.page, action.quote, action.serves_what])) + '\n## 标的客观属性\n\n' +
        table(['属性', '事实'], Object.entries(item.attributes))
      persisted.push({ code: doc.code, text })
    }
    const methods_text = '# 跨篇方法清单\n\n' + table(['方法陈述', '哪几份在做', '各自页码', '这个方法解决什么问题', '适用域'],
      core.methods.map(method => [method.statement, method.which_docs.join('、'), method.pages, method.solves_what, method.scope]))
    // Publish the manifest last. An interrupted publication cannot masquerade as a complete cache.
    await writeText(join(paths.evidence, '.publishing'), 'Evidence publication in progress\n')
    await rm(join(paths.evidence, 'manifest.json'), { force: true })
    for (const item of persisted) await writeText(join(paths.evidence, `${item.code}.md`), item.text)
    await writeText(join(paths.evidence, 'methods.md'), methods_text)
    await writeJson(join(paths.evidence, 'manifest.json'), { version: 1,
      documents: await Promise.all(documents.map(async doc => ({ ...doc, sha256: digest(await readFile(doc.file)),
        evidence_sha256: digest(persisted.find(item => item.code === doc.code).text) }))), methods_sha256: digest(methods_text) })
    await rm(join(paths.evidence, '.publishing'))
    evidence = { documents: persisted, methods_text, provenance: 'manifest-verified' }
  }
  await writeJson(join(paths.run, 'rules.json'), core.rules)
  await writeText(join(paths.run, 'rules.md'), '# 规则测绘\n\n' + table(['编号', '摘要', '出处', '原文', '适用域', '理由', '形态'],
    core.rules.map(rule => [rule.id, rule.summary, rule.source, rule.verbatim, rule.scope, rule.scope_reason, rule.form])))
  const codes = documents.map(doc => doc.code)
  const ruleText = JSON.stringify(core.rules)
  // Match quotations against raw strings, not JSON serialization (which escapes
  // quotes and newlines). Undo only our Markdown table display escaping.
  const evidenceText = [
    ...evidence.documents.map(doc => doc.text), evidence.methods_text,
    ...core.rules.flatMap(rule => [rule.verbatim, rule.summary].filter(nonempty)),
  ].join('\n').replaceAll('\\|', '|').replaceAll('<br>', '\n')
  const collision = await runtime.agent(`你负责统一完成方法论对撞，不重新盲抽、不联网。读取 ${root}/.codex/skills/equity-thesis-cn/framework.md 得到十二节真实标题。\n
依据下列完整五份动作清单、跨篇方法清单与规则测绘，逐条对齐四象限：established 已固化、omission 遗漏、overfit 疑似过拟合、untestable 本次样本无从检验。
规则必须逐条覆盖，方法清单也要穷尽，禁止只挑容易举例的条目。cards 的 rule_ids 引用规则编号；方法新增项可为空。
eligible_docs 只能按清单中的六项客观属性判定适用域；supporting_docs 必须是其中实际做过的篇目。分母为零必须 untestable。
source_quote 逐字引用输入，给人复核定位。matrix 必须有1至12节，每节完整五篇；done/missing/not_applicable 判实际分析动作，不按同名标题。
新增提案需至少3篇支持；删除提案需适用域至少3篇且零命中；1至2篇或1命中都只能记候选。
另外明确检查骨架中从单点评分外推出五档映射表的已知问题。此时只分析，不修改任何指南。
完整证据：${JSON.stringify(evidence)}\n规则：${ruleText}`, { label: '方法对撞', phase: '对撞', schema: collisionSchema })
  validateCollision(collision, codes, core.rules, evidenceText)
  const coveredRules = new Set(collision.cards.flatMap(card => card.rule_ids))
  if (core.rules.some(rule => !coveredRules.has(rule.id))) throw new Error('Collision omitted mapped rules')
  await writeJson(join(paths.run, 'collision.json'), collision)
  const candidates = collision.cards.filter(card => patchEligible(card, { status: 'confirmed' }))
  let checks = []
  if (candidates.length) {
    const verified = await runtime.agent(`独立复核以下可能生成改写提案的判定。只查这些判定，逐一回到指定PDF原文；不联网，不修改指南。
原件：${JSON.stringify(documents)}\n判定：${JSON.stringify(candidates)}
逐项重核 eligible_docs/supporting_docs。evidence 每条注明篇目、真实页码、逐字原文，区分 present / confirmed_absence / not_found / out_of_scope。
未找到与确实没做不能混淆。无法打开原件或证据不足时标 unresolved，不得以盲抽摘要冒充原件复核。
只有支持度和适用域均经原文复核才可 confirmed；推翻填 refuted。每个判定恰好一条。`,
    { label: '抽查', phase: '抽查', schema: checksSchema })
    if (!Array.isArray(verified.checks) || verified.checks.length !== candidates.length || new Set(verified.checks.map(c => c.id)).size !== candidates.length) throw new Error('Independent check must cover every patch candidate exactly once')
    checks = verified.checks
    for (const check of checks) {
      if (!candidates.some(card => card.id === check.id) || !countValid(check) || check.eligible_docs.some(code => !codes.includes(code)) ||
        !['confirmed', 'refuted', 'unresolved'].includes(check.status) || !Array.isArray(check.evidence) ||
        check.evidence.some(item => !codes.includes(item.code) || !nonempty(item.page) || !nonempty(item.quote) ||
          !['present', 'confirmed_absence', 'not_found', 'out_of_scope'].includes(item.finding))) throw new Error(`Invalid independent check ${check.id}`)
      if (check.status === 'confirmed' && check.eligible_docs.some(code => !check.evidence.some(item => item.code === code &&
        (check.supporting_docs.includes(code) ? item.finding === 'present' : item.finding === 'confirmed_absence')))) {
        throw new Error(`Independent check lacks original-source evidence: ${check.id}`)
      }
    }
  }
  await writeJson(join(paths.run, 'checks.json'), checks)
  const eligible = candidates.filter(card => {
    const check = checks.find(item => item.id === card.id)
    return patchEligible({ ...card, eligible_docs: check?.eligible_docs, supporting_docs: check?.supporting_docs }, check)
  })
  const proposal = await runtime.agent(`生成本次校准的解释与逐条改写提案。完整规则、对撞和原文抽查见下方JSON。
只为 eligible 中的判定生成 patches。每条给唯一P编号、card_id、目标相对路径、before/after逐字文本和理由；先读取对应原文件核对before。
允许目标仅 equity-thesis-cn/{framework,style_guide,valuation_archetypes,writing_contract}.md、equity-thesis-cn/lenses/*.md、financial-redflags-cn/SKILL.md，均相对 ${root}/.codex/skills/。
严禁修改指南文件。本阶段只返回JSON，编排器将提案写到run下patches供用户逐条采纳。没有eligible就返回空patches，不得为候选项硬凑提案。
narrative 必须说明：N=5的小样本限制、样本作者的习惯不等于正确方法；说明已知评分映射问题是否检出。
每个eligible判定必须有patch，或在exclusions里明确说明不提出改写的具体理由，不得静默遗漏。\n${JSON.stringify({ rules: core.rules, collision, checks, eligible })}`,
  { label: '校准报告', phase: '交付', schema: proposalsSchema })
  if (!nonempty(proposal.narrative) || !Array.isArray(proposal.patches)) throw new Error('Missing calibration report')
  const proposalIds = new Set()
  for (const patch of proposal.patches) {
    if (!/^[\p{L}\p{N}_-]+$/u.test(patch.id) || proposalIds.has(patch.id) || !eligible.some(card => card.id === patch.card_id) ||
      !/^(?:equity-thesis-cn\/(?:framework|style_guide|valuation_archetypes|writing_contract)\.md|equity-thesis-cn\/lenses\/[^/.]+\.md|financial-redflags-cn\/SKILL\.md)$/.test(patch.target) ||
      !nonempty(patch.before) || !nonempty(patch.after) || !nonempty(patch.reason)) throw new Error(`Unapproved calibration proposal ${patch.id}`)
    const original = await readFile(join(root, '.codex/skills', patch.target), 'utf8')
    if (!original.includes(patch.before)) throw new Error(`Proposal before text does not exist: ${patch.id}`)
    proposalIds.add(patch.id)
  }
  const exclusions = proposal.exclusions ?? []
  if (!Array.isArray(exclusions) || new Set(exclusions.map(item => item.card_id)).size !== exclusions.length ||
    exclusions.some(item => !eligible.some(card => card.id === item.card_id) || !nonempty(item.reason) ||
      proposal.patches.some(patch => patch.card_id === item.card_id))) throw new Error('Invalid proposal exclusion')
  if (eligible.some(card => !proposal.patches.some(patch => patch.card_id === card.id) &&
    !exclusions.some(item => item.card_id === card.id))) throw new Error('Every eligible card needs a proposal or explicit exclusion')
  await writeJson(join(paths.run, 'proposals.json'), proposal)
  const stagedPatches = join(paths.run, `.patches-${randomUUID()}`)
  await mkdir(stagedPatches, { recursive: true })
  for (const target of new Set(proposal.patches.map(patch => patch.target))) {
    const text = proposal.patches.filter(patch => patch.target === target).map(patch =>
      `## ${patch.id} · ${patch.card_id}\n\n${patch.reason}\n\n### Before\n\n${patch.before}\n\n### After\n\n${patch.after}\n`).join('\n')
    await writeText(join(stagedPatches, target), text)
  }
  const archivedPatches = join(paths.run, '.codex-workflow/proposal-history', randomUUID())
  await mkdir(dirname(archivedPatches), { recursive: true })
  try { await rename(join(paths.run, 'patches'), archivedPatches) }
  catch (error) { if (error.code !== 'ENOENT') throw error }
  await rename(stagedPatches, join(paths.run, 'patches'))
  const matrix = table(['节', ...codes], collision.matrix.sort((a, b) => a.section - b.section).map(section =>
    [section.section, ...codes.map(code => { const item = section.cells.find(c => c.code === code); return `${item.status}: ${item.evidence}` })]))
  await writeText(join(paths.run, '报告.md'), `# 方法论校准 · ${args.date}\n\n${proposal.narrative}\n\n` +
    `样本限制：N=5，只能检验这五篇；作者的做法并不证明方法正确。此次对照无法证明修改后运行更好，需要另行对照运行验证。提案仅供逐条审阅，不会自动改写指南。\n\n` +
    `## 12 节符合度\n\n${matrix}\n## 四象限判定\n\n` + table(['编号', '类型', '支持/适用', '结论'], collision.cards.map(card =>
      [card.id, card.kind, `${card.supporting_docs.length}/${card.eligible_docs.length}`, card.summary])) +
    `\n## 抽查记录\n\n` + table(['编号', '结论', '原文证据'], checks.map(check => [check.id, check.status,
      check.evidence.map(item => `${item.code} p${item.page} ${item.finding}: ${item.quote}`).join('\n')])) +
    `\n提案：${proposal.patches.map(patch => patch.id).join('、') || '无'}\n` +
    (exclusions.length ? '\n明确不提出改写：\n' + exclusions.map(item => `- ${item.card_id}: ${item.reason}`).join('\n') + '\n' : '') +
    `证据来源：${evidence.provenance}\n`)
  return { workflow: 'calibrate-equity-thesis', run_dir: paths.run, report: join(paths.run, '报告.md'), evidence_dir: paths.evidence,
    reused_evidence: reused, counts: { documents: 5, rules: core.rules.length, cards: collision.cards.length, checks: checks.length, patches: proposal.patches.length },
    patches: proposal.patches.map(patch => ({ id: patch.id, card_id: patch.card_id, path: join(paths.run, 'patches', patch.target) })) }
}
