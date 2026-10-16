import { parseReportSections } from './codex_workflow/review-sections.mjs'
import { snapshotEvidence, validateEvidenceQuotes, loadEvidenceContext, safeEvidenceFile } from './codex_workflow/review-evidence.mjs'
import { sha256, REVIEW_SCHEMA } from './codex_workflow/review-contracts.mjs'
import { decodeResult } from './codex_workflow/schema.mjs'
import { reconcileReview } from './codex_workflow/review-ledger.mjs'
import { openReviewStore } from './codex_workflow/review-store.mjs'
import { readFile, realpath } from 'node:fs/promises'
import { resolve, isAbsolute } from 'node:path'
import { pathToFileURL } from 'node:url'

const lenses = ['财务排雷', '尽调', '产业', '竞争', '战略驱动']
const fail = message => { throw new Error(`Thesis review: ${message}`) }
const text = value => typeof value === 'string' && value.trim().length > 0

function object(value, keys, where) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${where} must be an object`)
  if (Object.keys(value).some(key => !keys.includes(key)) || keys.some(key => !(key in value))) {
    fail(`${where} has missing or unknown fields`)
  }
}

/** Legacy structure is available for diagnostics only. */
async function validateLegacyReviewRecord({runDir,review,manifest}) {
  object(review, ['written_file', 'report_sha256', 'verdict', 'reviewed_sources', 'sections', 'coverage', 'blocking_issues'], 'review')
  if (typeof review.written_file !== 'string' || !isAbsolute(review.written_file) ||
      resolve(review.written_file) !== resolve(runDir, '成稿审查.json')) fail('written_file must identify this review artifact')
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

  const inventory = manifest.sources.map(source => source.path).sort()
  if (!Array.isArray(review.reviewed_sources)) fail('reviewed_sources must list all source paths')
  if (new Set(review.reviewed_sources).size !== review.reviewed_sources.length ||
      JSON.stringify([...review.reviewed_sources].sort()) !== JSON.stringify(inventory)) fail('reviewed_sources must uniquely include the full source inventory')
  if (!Array.isArray(review.coverage) || review.coverage.length !== 5) fail('coverage must include all five lenses')
  const seen = new Set()
  for (const coverage of review.coverage) {
    object(coverage, ['lens', 'findings'], 'coverage')
    if (!lenses.includes(coverage.lens) || seen.has(coverage.lens)) fail('coverage lens must be unique and recognized')
    seen.add(coverage.lens)
    if (!Array.isArray(coverage.findings) || !coverage.findings.length) fail('every lens needs key findings')
    if (!coverage.findings.some(f => f?.source === `findings/${coverage.lens}.md`)) fail(`lens missing its findings source: ${coverage.lens}`)
    for (const finding of coverage.findings) {
      object(finding, ['finding', 'source', 'source_quote', 'disposition', 'report_quote', 'exclusion_reason'], 'finding')
      if (!text(finding.finding)) fail('finding must explain the key judgment')
      if (!['covered', 'excluded', 'omitted', 'contradicted'].includes(finding.disposition)) fail('unknown finding disposition')
      if (typeof finding.report_quote !== 'string' || typeof finding.exclusion_reason !== 'string') fail('report_quote and exclusion_reason must be strings')
      if (['covered', 'contradicted'].includes(finding.disposition) && !text(finding.report_quote)) fail('report_quote required for covered or contradicted finding')
      if (finding.disposition === 'excluded' && !text(finding.exclusion_reason)) fail('excluded finding requires exclusion_reason')
      if (['omitted', 'contradicted'].includes(finding.disposition)) needsRevision = true
    }
  }
  if ((review.verdict === 'revise') !== needsRevision) fail('verdict is inconsistent with section status, omissions, contradictions or blocking issues')
  return review
}

/** Raw validation is diagnostic. It does not publish a receipt or authorize delivery. */
export async function validateReviewRecord({runDir,review,manifest,inputLedger}) {
  manifest ??= await snapshotEvidence({runDir})
  const physicalReport=await readFile(await safeEvidenceFile(runDir,'report.md'))
  if(review?.report_sha256!==sha256(physicalReport))fail('report_sha256 does not match current report digest')
  parseReportSections(physicalReport.toString('utf8'))
  if(review?.version === 2) {
    review=decodeResult(REVIEW_SCHEMA,review)
    if(review.evidence_sha256!==manifest.sha256)fail('evidence_sha256 does not match physical evidence digest')
    if(review.written_file!==undefined && review.written_file!==resolve(runDir,'成稿审查.json'))fail('written_file must identify this review artifact')
    if(!inputLedger)fail('v2 raw review validation requires original input ledger')
    reconcileReview({ledger:inputLedger,review,snapshot:{report_sha256:review.report_sha256,evidence_sha256:manifest.sha256}})
  } else review=await validateLegacyReviewRecord({runDir,review,manifest})
  await validateEvidenceQuotes({runDir,review,manifest})
  return review
}

/** Only a committed independent v2 Review with current physical evidence authorizes delivery. */
export async function validateThesisReview(runDir) {
  const root=await realpath(resolve(runDir))
  try { await safeEvidenceFile(root,'.codex-workflow/review/HEAD.json') } catch(error) {
    if(error.code==='ENOENT')fail('v2 Store proof/HEAD required for delivery; legacy reviews are diagnostic only')
    throw error
  }
  const store=await openReviewStore({runDir:root})
  const state=await store.read()
  if(!state?.review || state.review.version!==2)fail('v2 Store proof/HEAD required for delivery; legacy reviews are diagnostic only')
  const manifest=JSON.parse(await readFile(await safeEvidenceFile(root,'.codex-workflow/review/'+state.commit.refs.evidence.path),'utf8'))
  await loadEvidenceContext({runDir:root,manifest})
  const transcripts=manifest.sources.filter(source=>source.transcript).map(source=>({source:source.path,...source.transcript,...(source.pdf_origin?{pdf_origin:source.pdf_origin}:{})}))
  const fresh=await snapshotEvidence({runDir:root,transcripts})
  if(fresh.sha256!==manifest.sha256)fail('physical evidence snapshot digest mismatch')
  const inputLedger=JSON.parse(await readFile(await safeEvidenceFile(root,'.codex-workflow/review/'+state.commit.refs.review_input_ledger.path),'utf8'))
  await validateReviewRecord({runDir:root,review:state.review,manifest:fresh,inputLedger})
  const snapshot={report_sha256:sha256(await readFile(await safeEvidenceFile(root,'report.md'))),evidence_sha256:fresh.sha256}
  await store.assertDeliverable({snapshot})
  return state.review
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
