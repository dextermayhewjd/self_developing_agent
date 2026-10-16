import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { runThesis, prepareData, lensNames } from '../../tools/codex_workflow/thesis.mjs'
import { reportFixture, writeReviewFixture } from './fixtures/review-fixture.mjs'

async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), 'thesis-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const args = { symbol: '00700', date: '20261015', root }
  const run = join(root, 'reports/00700_thesis_20261015')
  const events = []
  const make = async file => { await mkdir(join(file, '..'), { recursive: true }); await writeFile(file, '内容'.repeat(160)) }
  const runWorkflow = async (options = {}) => {
    if (options.review_only) { events.push('review-only'); return { content_review: await writeReviewFixture(run) } }
    events.push('research')
    for (const name of lensNames) {
      await make(join(run, `findings/${name}.md`))
      await make(join(run, `核查/${name}.md`))
    }
    await make(join(run, '疑惑.md'))
    await make(join(run, 'report.md'))
    await writeFile(join(run, 'report.md'), reportFixture())
    await writeReviewFixture(run)
    return { checked_total: 5 }
  }
  const runtime = { agent: async (prompt, options) => {
    events.push(options.label)
    const written_file = join(root, 'positions/00700.md')
    await make(written_file)
    await writeFile(written_file, '---\n最近更新: 2026-10-15\n---\n' + '档案'.repeat(150))
    return { written_file }
  } }
  return { root, args, run, events, make, runWorkflow, runtime }
}

test('data warnings proceed; missing core fields collect once and then validate again', async t => {
  const { root } = await setup(t)
  const calls = []
  const codes = [1, 0, 2]
  const result = await prepareData({ root, symbol: '00700', runCommand: async (cmd, args) => {
    calls.push(args[0].split('/').at(-1)); return { code: codes.shift(), stdout: 'warning', stderr: '' }
  } })
  assert.deepEqual(calls, ['validate.py', 'run_pipeline.py', 'validate.py'])
  assert.ok(result.warnings.length > 0)
})

test('updates position before gate and converts PDF only after passing gate', async t => {
  const f = await setup(t)
  const command = async (cmd, argv) => {
    const script = argv[0].split('/').at(-1)
    f.events.push(script)
    if (script === 'md_to_pdf.py') await f.make(join(f.root, 'reports/pdf/00700_thesis_20261015.pdf'))
    return { code: 0, stdout: '', stderr: '' }
  }
  const summary = await runThesis({ ...f, prepared: { warnings: ['data warning'] }, runCommand: command })
  assert.deepEqual(f.events, ['research', '更新档案', 'check_thesis.py', 'md_to_pdf.py'])
  assert.equal(summary.gate_exit_code, 0)
  assert.equal(summary.pdf.status, 'generated')
  assert.ok(summary.warnings.includes('data warning'))
})

test('failed gates permit at most two repairs and never run PDF', async t => {
  const f = await setup(t)
  let gates = 0
  await assert.rejects(runThesis({ ...f, prepared: { warnings: [] }, runCommand: async (cmd, argv) => {
    assert.equal(argv[0].split('/').at(-1), 'check_thesis.py')
    gates++
    return { code: 1, stdout: 'hard gate failed', stderr: '' }
  } }), /hard gate/i)
  assert.equal(gates, 3)
  assert.equal(f.events.filter(x => x.startsWith('修复硬门')).length, 2)
})

test('a complete existing report is independently reviewed without repeating research', async t => {
  const f = await setup(t)
  await f.runWorkflow(); await f.runtime.agent('', { label: '更新档案' }); f.events.length = 0
  const summary = await runThesis({ ...f, noPdf: true, prepared: { warnings: [] }, runCommand: async () => ({ code: 0, stdout: '', stderr: '' }) })
  assert.deepEqual(f.events, ['review-only', '更新档案'])
  assert.equal(summary.reused, true)
  assert.equal(summary.pdf.status, 'skipped')
})

test('failed delivery stage cannot reuse a date-only partial position even if the old gate passes', async t => {
  const f = await setup(t)
  await f.runWorkflow(); await f.runtime.agent('', { label: '更新档案' }); f.events.length = 0
  await runThesis({ ...f, allowReuse: false, noPdf: true, prepared: { warnings: [] }, runCommand: async () => ({ code: 0, stdout: '', stderr: '' }) })
  assert.deepEqual(f.events, ['research', '更新档案'])
})

test('missing or stale content review blocks position update and PDF delivery', async t => {
  const f = await setup(t)
  const runWorkflow = async (...args) => {
    await f.runWorkflow(...args)
    await writeFile(join(f.run, 'report.md'), reportFixture('审查后被改动'))
    return {}
  }
  await assert.rejects(runThesis({ ...f, runWorkflow, prepared: { warnings: [] },
    runCommand: async () => { throw new Error('must not reach gate or PDF') } }), /digest|sha256/i)
  assert.deepEqual(f.events, ['research'])
})

test('hard-gate repair is followed by fresh content review and synchronized position', async t => {
  const f = await setup(t)
  const agent = f.runtime.agent
  f.runtime.agent = async (prompt, options) => {
    if (options.label.startsWith('修复硬门')) await writeFile(join(f.run, 'report.md'), reportFixture('硬门修订内容'))
    return agent(prompt, options)
  }
  let gates = 0
  const result = await runThesis({ ...f, prepared: { warnings: [] }, runCommand: async (cmd, argv) => {
    const script = argv[0].split('/').at(-1)
    f.events.push(script)
    if (script === 'check_thesis.py') return { code: ++gates === 1 ? 1 : 0, stdout: 'fix', stderr: '' }
    await f.make(join(f.root, 'reports/pdf/00700_thesis_20261015.pdf'))
    return { code: 0, stdout: '', stderr: '' }
  } })
  assert.deepEqual(f.events, ['research', '更新档案', 'check_thesis.py', '修复硬门:1', 'review-only', '更新档案:硬门1', 'check_thesis.py', 'md_to_pdf.py'])
  assert.equal(result.content_review.verdict, 'pass')
  assert.match(await readFile(join(f.run, 'report.md'), 'utf8'), /硬门修订内容/)
})
