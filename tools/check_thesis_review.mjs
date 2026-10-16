import { readFile, readdir, lstat, realpath } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { resolve, relative, isAbsolute, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

const lenses = ['财务排雷', '尽调', '产业', '竞争', '战略驱动']
const fail = message => { throw new Error(`Thesis review: ${message}`) }
const text = value => typeof value === 'string' && value.trim().length > 0
const normalize = value => value.replace(/\s+/gu, '')

function object(value, keys, where) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${where} must be an object`)
  if (Object.keys(value).some(key => !keys.includes(key)) || keys.some(key => !(key in value))) {
    fail(`${where} has missing or unknown fields`)
  }
}

function sourcePath(source) {
  if (!text(source) || source.includes('\\') || source.includes('\0') || isAbsolute(source) ||
      source.split('/').some(part => !part || part === '.' || part === '..') ||
      !(source === '疑惑.md' || /^(findings|核查|参照系)\/.+/.test(source))) fail(`invalid source path: ${source}`)
  return source
}

function inRoot(root, file) {
  const rel = relative(root, file)
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

async function safeFile(root, rel) {
  const file = resolve(root, rel)
  if (!inRoot(root, file)) fail(`source path escapes run: ${rel}`)
  const canonical = await realpath(file)
  if (!inRoot(root, canonical)) fail(`source path symlink escapes run: ${rel}`)
  // Keeping each component regular also prevents symlink aliases from hiding
  // evidence in another, unapproved subtree of this run.
  let current = root
  for (const part of rel.split('/')) {
    current = resolve(current, part)
    if ((await lstat(current)).isSymbolicLink()) fail(`source path contains symlink: ${rel}`)
  }
  if (!(await lstat(file)).isFile()) fail(`source path is not a regular file: ${rel}`)
  return file
}

async function sourceInventory(root) {
  const files = ['疑惑.md']
  async function visit(dir) {
    const full = resolve(root, dir)
    let info
    try { info = await lstat(full) } catch (error) {
      if (error.code === 'ENOENT') return
      throw error
    }
    if (info.isSymbolicLink() || !info.isDirectory()) fail(`invalid source directory path: ${dir}`)
    for (const entry of await readdir(full, { withFileTypes: true })) {
      const rel = `${dir}/${entry.name}`
      if (entry.isDirectory()) await visit(rel)
      else { await safeFile(root, rel); files.push(rel) }
    }
  }
  for (const dir of ['findings', '核查', '参照系']) await visit(dir)
  return files.sort()
}

function checkReportSections(report) {
  const numbers = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10, 十一: 11, 十二: 12 }
  const sections = []
  let fence = null
  for (const line of report.split(/\r?\n/u)) {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1]
    if (marker) {
      if (!fence) fence = marker
      else if (marker[0] === fence[0] && marker.length >= fence.length && /^ {0,3}(`{3,}|~{3,})\s*$/.test(line)) fence = null
      continue
    }
    if (fence) continue
    const match = /^ {0,3}##[ \t]+(?:第)?(十二|十一|十|[一二三四五六七八九]|\d{1,2})(?:节)?[、.．:：)） \t]+\S/u.exec(line)
    if (match) {
      const number = numbers[match[1]] ?? Number(match[1])
      if (number !== 0) sections.push(number)
    }
  }
  if (sections.length !== 12 || sections.some((number, index) => number !== index + 1)) {
    fail('report section headings must contain exactly 1..12 in order (十二节标题)')
  }
}

/** Validate evidence integrity. A structurally valid `revise` remains a failure
 * to deliver; callers must additionally require verdict === 'pass'. */
export async function validateThesisReview(runDir) {
  const root = await realpath(resolve(runDir))
  const reviewPath = await safeFile(root, '成稿审查.json')
  const reportPath = await safeFile(root, 'report.md')
  const review = JSON.parse(await readFile(reviewPath, 'utf8'))
  object(review, ['written_file', 'report_sha256', 'verdict', 'reviewed_sources', 'sections', 'coverage', 'blocking_issues'], 'review')
  if (typeof review.written_file !== 'string' || !isAbsolute(review.written_file) ||
      resolve(review.written_file) !== resolve(runDir, '成稿审查.json')) fail('written_file must identify this review artifact')
  const reportBytes = await readFile(reportPath)
  const hash = createHash('sha256').update(reportBytes).digest('hex')
  if (!/^[a-f0-9]{64}$/.test(review.report_sha256) || review.report_sha256 !== hash) fail('report_sha256 does not match current report digest')
  checkReportSections(reportBytes.toString('utf8'))
  if (!['pass', 'revise'].includes(review.verdict)) fail('unknown verdict')
  if (!Array.isArray(review.sections) || review.sections.length !== 12) fail('sections must cover exactly 1..12')
  const sectionNumbers = new Set()
  let needsRevision = false
  for (const section of review.sections) {
    object(section, ['section', 'status', 'evidence'], 'section')
    if (!Number.isInteger(section.section) || section.section < 1 || section.section > 12 || sectionNumbers.has(section.section)) fail('sections must uniquely cover 1..12')
    sectionNumbers.add(section.section)
    if (!['pass', 'revise'].includes(section.status) || !text(section.evidence)) fail('section status and evidence required')
    if (section.status === 'revise') needsRevision = true
  }
  if (!Array.isArray(review.blocking_issues) || review.blocking_issues.some(issue => !text(issue))) fail('blocking_issues must contain concrete nonempty strings')
  needsRevision ||= review.blocking_issues.length > 0

  const inventory = await sourceInventory(root)
  if (!Array.isArray(review.reviewed_sources)) fail('reviewed_sources must list all source paths')
  review.reviewed_sources.forEach(sourcePath)
  if (new Set(review.reviewed_sources).size !== review.reviewed_sources.length ||
      JSON.stringify([...review.reviewed_sources].sort()) !== JSON.stringify(inventory)) fail('reviewed_sources must uniquely include the full source inventory')
  const sources = new Map()
  for (const source of inventory) sources.set(source, normalize(await readFile(await safeFile(root, source), 'utf8')))
  if (!Array.isArray(review.coverage) || review.coverage.length !== 5) fail('coverage must include all five lenses')
  const seen = new Set()
  const reportText = normalize(reportBytes.toString('utf8'))
  for (const coverage of review.coverage) {
    object(coverage, ['lens', 'findings'], 'coverage')
    if (!lenses.includes(coverage.lens) || seen.has(coverage.lens)) fail('coverage lens must be unique and recognized')
    seen.add(coverage.lens)
    if (!Array.isArray(coverage.findings) || !coverage.findings.length) fail('every lens needs key findings')
    if (!coverage.findings.some(f => f?.source === `findings/${coverage.lens}.md`)) fail(`lens missing its findings source: ${coverage.lens}`)
    for (const finding of coverage.findings) {
      object(finding, ['finding', 'source', 'source_quote', 'disposition', 'report_quote', 'exclusion_reason'], 'finding')
      if (!text(finding.finding)) fail('finding must explain the key judgment')
      sourcePath(finding.source)
      if (!sources.has(finding.source)) fail(`source not in reviewed inventory: ${finding.source}`)
      if (!text(finding.source_quote) || !sources.get(finding.source).includes(normalize(finding.source_quote))) fail(`source_quote not found in source: ${finding.source}`)
      if (!['covered', 'excluded', 'omitted', 'contradicted'].includes(finding.disposition)) fail('unknown finding disposition')
      if (typeof finding.report_quote !== 'string' || typeof finding.exclusion_reason !== 'string') fail('report_quote and exclusion_reason must be strings')
      if (['covered', 'contradicted'].includes(finding.disposition) && !text(finding.report_quote)) fail('report_quote required for covered or contradicted finding')
      if (text(finding.report_quote) && !reportText.includes(normalize(finding.report_quote))) fail('report_quote not found in current report')
      if (finding.disposition === 'excluded' && !text(finding.exclusion_reason)) fail('excluded finding requires exclusion_reason')
      if (['omitted', 'contradicted'].includes(finding.disposition)) needsRevision = true
    }
  }
  if ((review.verdict === 'revise') !== needsRevision) fail('verdict is inconsistent with section status, omissions, contradictions or blocking issues')
  return review
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 3) fail('usage: node tools/check_thesis_review.mjs <runDir>')
    const review = await validateThesisReview(process.argv[2])
    if (review.verdict !== 'pass') fail('verdict requires revision; delivery blocked')
    console.log(`Thesis review PASS ${review.report_sha256}`)
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
