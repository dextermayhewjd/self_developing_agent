// Optional historical replay, outside npm's default test glob:
// node tests/codex_workflow/fixtures/replay-frozen-evidence.mjs /absolute/path/to/竞争_H1_p13.png
// Uses the previously visually inspected table fragments. Never grants delivery authority.
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, copyFile, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { snapshotEvidence, validateEvidenceQuotes } from '../../../tools/codex_workflow/review-evidence.mjs'
import { canonicalJson, sha256 } from '../../../tools/codex_workflow/review-contracts.mjs'
import { reportFixture } from './review-fixture.mjs'

if (process.argv.length !== 3) throw new Error('usage: node replay-frozen-evidence.mjs <original-PNG-path>')
const original = resolve(process.argv[2])
const runDir = await mkdtemp(join(tmpdir(), 'optional-frozen-evidence-'))
try {
  const source = '核查/source.png'
  const path = '.codex-workflow/review/transcripts/T-manual.json'
  await mkdir(join(runDir, '核查'), { recursive: true })
  await mkdir(join(runDir, '.codex-workflow/review/transcripts'), { recursive: true })
  await copyFile(original, join(runDir, source))
  await writeFile(join(runDir, '疑惑.md'), '历史证据引用复现')
  await writeFile(join(runDir, 'report.md'), reportFixture())
  const candidate = { version: 2, source, source_sha256: sha256(await readFile(join(runDir, source))), method: 'manual',
    text: '公允价值变动损益 -9,193,678.56 对应的外币借款确认了汇兑收益840万元。 是否具有可持续性：否\n营业外收入 8,942,514.78 主要系无需支付的款项。 是否具有可持续性：否' }
  const bytes = canonicalJson(candidate)
  await writeFile(join(runDir, path), bytes)
  const manifest = await snapshotEvidence({ runDir, transcripts: [{ source, path, sha256: sha256(bytes) }] })
  const binary = manifest.sources.find(item => item.path === source)
  const finding = { source, source_quote: '主要系无需支付的款项。', report_quote: '' }
  const review = { reviewed_sources: manifest.sources.map(item => item.path), visual_attestations: [], coverage: [{ findings: [finding] }] }
  await assert.rejects(validateEvidenceQuotes({ runDir, manifest, review }), error => error.code === 'EVIDENCE_PENDING' && /visual/i.test(error.message))
  review.visual_attestations = [{ source, source_sha256: binary.sha256, transcript_path: path, transcript_sha256: binary.transcript.sha256, method: 'visual', status: 'verified', reason: 'Deterministic replay of previously inspected original; no new delivery verdict.' }]
  await validateEvidenceQuotes({ runDir, manifest, review })
  finding.source_quote = '不存在于逐字稿的值'
  await assert.rejects(validateEvidenceQuotes({ runDir, manifest, review }), /source_quote.*transcript/i)
  console.log('Optional historical replay: missing visual => pending; bound quote => valid; absent quote => rejected. No delivery proof created.')
} finally { await rm(runDir, { recursive: true, force: true }) }
