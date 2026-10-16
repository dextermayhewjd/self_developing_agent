import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { createRuntime, loadWorkflow } from '../../tools/codex_workflow/runtime.mjs'
import { transportSchema, decodeResult } from '../../tools/codex_workflow/schema.mjs'

const lenses = ['财务排雷', '尽调', '产业', '竞争', '战略驱动']
const validator = async run => (await import('../../tools/check_thesis_review.mjs')).validateThesisReview(run)
const reportTemplate = `# 判断型报告
## 〇、开篇结论
判断：现金流可支持投入。
## 一、公司简介
收入结构仍需跟踪。
## 二、股权架构
股权稳定，控制权未发生变化。
## 三、高管信息
管理层经验与业务相符，激励效果待验证。
## 四、财务全景表
现金流可支持投入。持续性依赖回款与资本开支。
## 五、产品与行业空间
主营需求平稳，第二曲线空间无法确认。
## 六、商业模式
收入依赖持续交付，需观察客户续约。
## 七、竞争格局
竞争优势尚在，但价格压力会影响盈利。
## 八、募投项目 / 重大资本开支
投资进度需与现金回收匹配。
## 九、公司发展目标及战略规划
扩张目标尚未成为已证实的收入。
## 十、未来业绩驱动因素
回款与新产品验证共同决定增长持续性。
## 十一、估值、赔率、概率分析
可比口径不足，暂不判断估值折价是否成立。
## 十二、评分
B：支持条件是回款稳定；反证条件是现金投入持续超过回收。
`

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'thesis-review-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const args = { root, symbol: '00700', date: '20261016' }
  const run = join(root, 'reports/00700_thesis_20261016')
  const put = async (file, body) => {
    await mkdir(join(run, file, '..'), { recursive: true })
    await writeFile(join(run, file), body)
  }
  const report = reportTemplate
  await put('report.md', report)
  await put('疑惑.md', '估值原型：稳态现金流型\n现金流能否支持投入？')
  for (const lens of lenses) {
    await put(`findings/${lens}.md`, `${lens}关键发现：现金流可支持投入。\n另一个风险仍需跟踪。`)
    await put(`核查/${lens}.md`, '确认无误：现金流可支持投入。')
  }
  await put('参照系/板块基准.md', '同业现金流稳定。')
  const review = {
    written_file: join(run, '成稿审查.json'),
    report_sha256: createHash('sha256').update(report).digest('hex'),
    verdict: 'pass',
    reviewed_sources: ['疑惑.md', ...lenses.flatMap(l => [`findings/${l}.md`, `核查/${l}.md`]), '参照系/板块基准.md'],
    sections: Array.from({ length: 12 }, (_, i) => ({ section: i + 1, status: 'pass', evidence: '已核对该节的依据与结论。' })),
    coverage: lenses.map(lens => ({ lens, findings: [{ finding: `${lens}现金流判断`, source: `findings/${lens}.md`, source_quote: '现金流可支持投入。', disposition: 'covered', report_quote: '现金流可支持投入。', exclusion_reason: '' }] })),
    blocking_issues: [],
  }
  const save = () => put('成稿审查.json', JSON.stringify(review))
  await save()
  return { root, args, run, put, review, save }
}

test('accepts evidence bound to actual files and normalizes whitespace in quotations', async t => {
  const f = await fixture(t)
  f.review.coverage[0].findings[0].report_quote = '现金流可\n 支持投入。'
  await f.save()
  assert.equal((await validator(f.run)).verdict, 'pass')
  const result = spawnSync(process.execPath, ['tools/check_thesis_review.mjs', f.run], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
})

test('rejects missing or malformed review artifacts and stale report digests', async t => {
  const f = await fixture(t)
  await rm(join(f.run, '成稿审查.json'))
  await assert.rejects(validator(f.run))
  await f.put('成稿审查.json', '{bad json')
  await assert.rejects(validator(f.run))
  await f.save()
  await f.put('report.md', '改后的报告')
  await assert.rejects(validator(f.run), /sha256|digest|摘要/i)
})

test('checks actual report sections instead of trusting twelve claims in the review', async t => {
  for (const report of [
    '判断：现金流可支持投入。',
    reportTemplate.replace('## 十二、评分', '## 十一、评分'),
    reportTemplate.replace('## 十二、评分', '### 十二、评分'),
    reportTemplate.replace('## 十二、评分', '```md\n## 十二、评分\n```'),
  ]) {
    const f = await fixture(t)
    await f.put('report.md', report)
    f.review.report_sha256 = createHash('sha256').update(report).digest('hex')
    await f.save()
    await assert.rejects(validator(f.run), /section|十二节|标题/i)
  }
})

test('accepts standard Arabic-numbered section titles without using report length as a gate', async t => {
  const f = await fixture(t)
  const titles = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十', '十一', '十二']
  let report = reportTemplate
  for (let i = 0; i < titles.length; i++) report = report.replace(`## ${titles[i]}、`, `## ${i + 1}. `)
  await f.put('report.md', report)
  f.review.report_sha256 = createHash('sha256').update(report).digest('hex')
  await f.save()
  assert.equal((await validator(f.run)).verdict, 'pass')
})

test('rejects incomplete, duplicate and inconsistent review coverage', async t => {
  const mutations = [
    r => { r.unexpected_field = 'untrusted' },
    r => { r.written_file = '/tmp/other-review.json' },
    r => { r.report_sha256 = 'not-a-real-hash' },
    r => r.sections.pop(),
    r => { r.sections[11].section = 1 },
    r => { r.sections[0].evidence = '' },
    r => r.coverage.pop(),
    r => { r.coverage[4].lens = '尽调' },
    r => { r.coverage[0].findings = [] },
    r => { r.reviewed_sources.pop() },
    r => { r.blocking_issues = ['估值缺依据'] },
    r => { r.sections[0].status = 'revise' },
    r => { r.coverage[0].findings[0].disposition = 'omitted' },
    r => { r.coverage[0].findings[0].disposition = 'contradicted' },
    r => { r.coverage[0].findings[0].disposition = 'unknown' },
    r => { r.verdict = 'revise' },
  ]
  for (const mutate of mutations) {
    const f = await fixture(t)
    mutate(f.review)
    await f.save()
    await assert.rejects(validator(f.run))
  }
})

test('rejects fabricated quotations and unjustified exclusion', async t => {
  for (const key of ['source_quote', 'report_quote']) {
    const f = await fixture(t)
    f.review.coverage[0].findings[0][key] = '原文中没有的内容'
    await f.save()
    await assert.rejects(validator(f.run), /quote|引用/i)
  }
  const f = await fixture(t)
  Object.assign(f.review.coverage[0].findings[0], { disposition: 'excluded', report_quote: '' })
  await f.save()
  await assert.rejects(validator(f.run), /exclu|排除/i)
  f.review.coverage[0].findings[0].exclusion_reason = '已被核查否定，不能作为结论依据。'
  await f.save()
  assert.equal((await validator(f.run)).verdict, 'pass')
})

test('accepts an honest revise verdict but CLI blocks delivery', async t => {
  const f = await fixture(t)
  f.review.verdict = 'revise'
  f.review.sections[0].status = 'revise'
  f.review.blocking_issues = ['第一节需补入现金流限制。']
  await f.save()
  assert.equal((await validator(f.run)).verdict, 'revise')
  const result = spawnSync(process.execPath, ['tools/check_thesis_review.mjs', f.run], { encoding: 'utf8' })
  assert.equal(result.status, 1)
})

test('confines evidence to approved run sources, including symlink targets', async t => {
  for (const source of ['../outside.md', '/etc/passwd', 'report.md', 'findings/../report.md', 'findings\\..\\report.md']) {
    const f = await fixture(t)
    f.review.coverage[0].findings[0].source = source
    await f.save()
    await assert.rejects(validator(f.run), /source|path|来源|路径/i)
  }
  const f = await fixture(t)
  const target = join(f.root, 'outside.md')
  await writeFile(target, '现金流可支持投入。')
  await rm(join(f.run, 'findings/财务排雷.md'))
  await symlink(target, join(f.run, 'findings/财务排雷.md'))
  await assert.rejects(validator(f.run), /source|path|symlink|来源|路径/i)
})

async function execute(t, { reviewOnly = true, verdicts = ['pass'], malicious = false } = {}) {
  const f = await fixture(t)
  const stages = []
  let reviewIndex = 0
  const runtime = createRuntime({ runAgent: async (prompt, options) => {
    stages.push(options.label)
    if (options.label.startsWith('成稿审查:')) {
      transportSchema(options.schema)
      f.review.verdict = verdicts[reviewIndex++] ?? 'revise'
      f.review.sections[0].status = f.review.verdict
      f.review.blocking_issues = f.review.verdict === 'pass' ? [] : ['补充现金流限制。']
      f.review.report_sha256 = createHash('sha256').update(await readFile(join(f.run, 'report.md'))).digest('hex')
      if (malicious) f.review.coverage[0].findings[0].disposition = 'omitted'
      await f.save()
      return decodeResult(options.schema, structuredClone(f.review))
    }
    if (options.label.startsWith('修订成稿:')) {
      await f.put('report.md', (await readFile(join(f.run, 'report.md'), 'utf8')) + '补充：收入结构仍需跟踪。\n')
      return { written_file: join(f.run, 'report.md'), rating: 'C', decisive_variable: '现金流限制' }
    }
    if (options.label === '盘点') return { has_doubt: true, findings_done: lenses, checked_done: lenses, bench_done: ['板块基准'] }
    if (options.label === '补参照系') return { items: [] }
    if (options.label === '成稿') return { written_file: join(f.run, 'report.md'), rating: 'B', decisive_variable: '现金流' }
    throw new Error(`Unexpected research stage: ${options.label}`)
  } })
  const workflow = await loadWorkflow(new URL('../../.claude/workflows/equity-thesis.mjs', import.meta.url))
  return { ...f, stages, result: workflow({ ...f.args, review_only: reviewOnly }, runtime) }
}

test('review_only reviews actual existing report without starting any research stages', async t => {
  const f = await execute(t)
  const result = await f.result
  assert.deepEqual(f.stages, ['成稿审查:0'])
  assert.equal(result.content_review.verdict, 'pass')
  assert.equal(result.report.written_file, join(f.run, 'report.md'))
  await validator(f.run)
})

test('normal workflow independently reviews the completed manuscript', async t => {
  const f = await execute(t, { reviewOnly: false })
  const result = await f.result
  assert.deepEqual(f.stages, ['盘点', '补参照系', '成稿', '成稿审查:0'])
  assert.equal(result.symbol, '00700')
  assert.equal(result.content_review.verdict, 'pass')
})

test('revision uses at most two rounds and each mutated manuscript gets a new review', async t => {
  const f = await execute(t, { verdicts: ['revise', 'revise', 'pass'] })
  const result = await f.result
  assert.deepEqual(f.stages, ['成稿审查:0', '修订成稿:1', '成稿审查:1', '修订成稿:2', '成稿审查:2'])
  assert.equal(result.content_review.verdict, 'pass')
  assert.equal((await validator(f.run)).report_sha256, result.content_review.report_sha256)
})

test('normal workflow returns the final revised rating instead of stale first-draft metadata', async t => {
  const f = await execute(t, { reviewOnly: false, verdicts: ['revise', 'pass'] })
  const result = await f.result
  assert.equal(result.report.rating, 'C')
  assert.equal(result.report.decisive_variable, '现金流限制')
})

test('third failed review blocks completion and cannot cause a third revision', async t => {
  const f = await execute(t, { verdicts: ['revise', 'revise', 'revise'] })
  await assert.rejects(f.result, /review|审查/i)
  assert.deepEqual(f.stages, ['成稿审查:0', '修订成稿:1', '成稿审查:1', '修订成稿:2', '成稿审查:2'])
})

test('a worker cannot label omitted findings as passing', async t => {
  const f = await execute(t, { malicious: true })
  await assert.rejects(f.result, /review|审查/i)
})
