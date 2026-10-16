import { readFile, readdir, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'

const lenses = ['财务排雷', '尽调', '产业', '竞争', '战略驱动']
export const reportFixture = (body = '内容') => ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十', '十一', '十二']
  .map(title => `## ${title}、章节\n\n${body}\n`).join('\n')

export async function writeReviewFixture(run) {
  const report = await readFile(join(run, 'report.md'), 'utf8')
  const reviewed_sources = ['疑惑.md']
  async function visit(dir) {
    let entries
    try { entries = await readdir(join(run, dir), { withFileTypes: true }) }
    catch (error) { if (error.code === 'ENOENT') return; throw error }
    for (const entry of entries) {
      const path = `${dir}/${entry.name}`
      if (entry.isDirectory()) await visit(path)
      else reviewed_sources.push(path)
    }
  }
  for (const dir of ['findings', '核查', '参照系']) await visit(dir)
  const review = {
    written_file: join(run, '成稿审查.json'),
    report_sha256: createHash('sha256').update(report).digest('hex'),
    verdict: 'pass', reviewed_sources,
    sections: Array.from({ length: 12 }, (_, i) => ({ section: i + 1, status: 'pass', evidence: 'fixture section evidence' })),
    coverage: await Promise.all(lenses.map(async lens => ({ lens, findings: [{
      finding: 'fixture finding', source: `findings/${lens}.md`,
      source_quote: (await readFile(join(run, `findings/${lens}.md`), 'utf8')).split('\n').find(line => line.trim()),
      disposition: 'covered', report_quote: report.split('\n').find(line => line.trim()), exclusion_reason: '',
    }] }))),
    blocking_issues: [],
  }
  await writeFile(review.written_file, JSON.stringify(review))
  return review
}

// Synthetic v2 contracts are deliberately separate from the legacy on-disk fixture.
export const reviewLensesV2 = ['财务排雷', '尽调', '产业', '竞争', '战略驱动']
export const snapshotFixtureV2 = { report_sha256: 'a'.repeat(64), evidence_sha256: 'b'.repeat(64) }
export function issueFixtureV2(overrides = {}) {
  return {
    issue_key: 'cash-flow-limit', kind: 'blocking', blocks_delivery: true,
    description: '现金流限制未披露', locations: [{ section: 3 }],
    evidence_refs: [{ source: 'findings/财务排雷.md', source_sha256: 'c'.repeat(64), evidence_sha256: 'b'.repeat(64), quote: '现金流依赖回款。' }],
    acceptance_criteria: ['第三节明确说明回款限制'], route: 'local_patch', ...overrides,
  }
}
export function reviewFixtureV2({ ledgerSha256, reviewId = 'RV-000001', snapshot = snapshotFixtureV2, ...overrides } = {}) {
  return {
    version: 2, review_id: reviewId, ...snapshot, input_ledger_sha256: ledgerSha256,
    verdict: 'pass', reviewed_sources: ['疑惑.md', ...reviewLensesV2.map(lens => `findings/${lens}.md`)],
    sections: Array.from({ length: 12 }, (_, i) => ({ section: i + 1, status: 'pass', evidence: '已核对章节证据', issue_keys: [], task_ids: [] })),
    coverage: reviewLensesV2.map(lens => ({ lens, findings: [{ finding: '回款影响现金流', source: `findings/${lens}.md`, source_quote: '现金流依赖回款。', disposition: 'covered', report_quote: '现金流依赖回款。', exclusion_reason: '', issue_keys: [], task_ids: [] }] })),
    new_issues: [], task_dispositions: [], visual_attestations: [], ...overrides,
  }
}

/** Disposable test setup: genuine first v2 proof, or reuse an unchanged proof.
 * Does not repair, reset or adopt a direct writer edit to the canonical report. */
export async function writeStoreReviewFixtureV2(run) {
  const { snapshotEvidence } = await import('../../../tools/codex_workflow/review-evidence.mjs')
  const { openReviewStore } = await import('../../../tools/codex_workflow/review-store.mjs')
  const { reconcileReview } = await import('../../../tools/codex_workflow/review-ledger.mjs')
  const { canonicalJson, sha256 } = await import('../../../tools/codex_workflow/review-contracts.mjs')
  const candidate = await readFile(join(run, 'report.md'))
  const evidence = await snapshotEvidence({runDir:run})
  const store = await openReviewStore({runDir:run})
  const state = await store.read() ?? await store.initialize({reportBytes:candidate,evidence})
  if(state.review?.verdict==='pass')return state.review
  const review=reviewFixtureV2({ledgerSha256:sha256(canonicalJson(state.ledger)),reviewId:'RV-fixture-1',snapshot:state.snapshot,
    reviewed_sources:evidence.sources.map(source=>source.path),
    coverage:await Promise.all(reviewLensesV2.map(async lens=>({lens,findings:[{finding:'fixture finding',source:`findings/${lens}.md`,source_quote:(await readFile(join(run,`findings/${lens}.md`),'utf8')).split('\n').find(line=>line.trim()),disposition:'covered',report_quote:candidate.toString('utf8').split('\n').find(line=>line.trim()),exclusion_reason:''}]}))),
  })
  const result=reconcileReview({ledger:state.ledger,review,snapshot:state.snapshot})
  await store.commitReview({review,...result,evidence})
  return review
}
