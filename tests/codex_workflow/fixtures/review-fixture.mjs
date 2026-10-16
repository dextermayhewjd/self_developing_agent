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
