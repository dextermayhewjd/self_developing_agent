import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, copyFile, readdir, rm, writeFile, readFile, access } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArguments, inspectWorkflow } from '../../tools/run_codex_workflow.mjs'
import { openState } from '../../tools/codex_workflow/state.mjs'

test('CLI preserves HK leading zeros and rejects unsafe inputs and impossible dates', () => {
  const p = parseArguments(['equity-thesis', '--symbol', '00700.HK', '--date', '20261015'])
  assert.equal(p.args.symbol, '00700')
  assert.equal(p.args.date, '20261015')
  for (const date of ['20260230', '20261301', '2026101']) {
    assert.throws(() => parseArguments(['equity-thesis', '--symbol', '00700', '--date', date]), /date/i)
  }
  assert.throws(() => parseArguments(['equity-thesis', '--symbol', '../00700']), /symbol/i)
  assert.throws(() => parseArguments(['equity-thesis', '--symbol', '00700', '--jobs', '0']), /jobs/i)
})

test('all three real workflows can be checked without writing business artifacts', async t => {
  const root = await mkdtemp(join(tmpdir(), 'workflow-check-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, '.claude/workflows'), { recursive: true })
  const sourceRoot = fileURLToPath(new URL('../../.claude/workflows/', import.meta.url))
  for (const name of ['equity-thesis', 'peer-comparability', 'calibrate-equity-thesis']) {
    await copyFile(join(sourceRoot, `${name}.mjs`), join(root, `.claude/workflows/${name}.mjs`))
    const summary = await inspectWorkflow({ root, name, args: { symbol: '00700', date: '20261015', variety: '钨', archetype: '耗竭资源型', root } })
    assert.ok(summary.stages.length >= 3, name)
  }
  assert.deepEqual(await readdir(root), ['.claude'])
})

test('startup computes the actual source fingerprint before saving resumable state', async t => {
  const root = await mkdtemp(join(tmpdir(), 'workflow-start-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const { workflowFingerprint } = await import('../../tools/run_codex_workflow.mjs')
  assert.equal(typeof workflowFingerprint, 'function')
  await mkdir(join(root, '.claude/workflows'), { recursive: true })
  await mkdir(join(root, '.claude/skills/example'), { recursive: true })
  await writeFile(join(root, '.claude/workflows/peer-comparability.mjs'), 'return {}')
  const guide = join(root, '.claude/skills/example/SKILL.md')
  await writeFile(guide, 'v1')
  const first = await workflowFingerprint(root, 'peer-comparability', { variety: '钨' }, {})
  assert.match(first, /^[a-f0-9]{64}$/)
  const state = await openState({ dir: join(root, '.codex-workflow'), artifactRoots: [root], fingerprint: async () => first })
  assert.equal(state.data.fingerprint, first)
  await state.close()
  await writeFile(guide, 'v2')
  assert.notEqual(await workflowFingerprint(root, 'peer-comparability', { variety: '钨' }, {}), first)
})

test('real CLI launches its backend, reuses success, rejects stale inputs and resets explicitly', async t => {
  const root = await mkdtemp(join(tmpdir(), 'codex cli integration '))
  t.after(() => rm(root, { recursive: true, force: true }))
  for (const dir of ['.claude/workflows', '.claude/skills/example', 'bin']) await mkdir(join(root, dir), { recursive: true })
  const workflow = `return await agent('fixture', {label:'fixture', schema:{type:'object',required:['written_file'],properties:{written_file:{type:'string'}}}})`
  await writeFile(join(root, '.claude/workflows/peer-comparability.mjs'), workflow)
  const guide = join(root, '.claude/skills/example/SKILL.md')
  await writeFile(guide, 'guide-v1')
  const params = join(root, 'args.json')
  await writeFile(params, JSON.stringify({ variety: '钨', archetype: '耗竭资源型' }))
  await writeFile(join(root, 'bin/codex'), `#!/usr/bin/env node
const fs = require('node:fs'); const path = require('node:path'); const a=process.argv.slice(2);
fs.readFileSync(0); const root=a[a.indexOf('--cd')+1]; const out=path.join(root,'data/_peers/钨/fixture.md');
fs.writeFileSync(out,'valid fixture'); fs.appendFileSync(path.join(root,'counter'),'called\\n');
fs.writeFileSync(a[a.indexOf('--output-last-message')+1],JSON.stringify({written_file:out}));
`, { mode: 0o755 })
  const cli = fileURLToPath(new URL('../../tools/run_codex_workflow.mjs', import.meta.url))
  const argv = [cli, 'peer-comparability', '--root', root, '--args-file', params]
  const options = { env: { ...process.env, PATH: `${join(root, 'bin')}:${process.env.PATH}` } }
  const call = () => promisify(execFile)(process.execPath, argv, options)
  const first = JSON.parse((await call()).stdout)
  assert.equal(first.workflow, 'peer-comparability')
  await call()
  assert.equal((await readFile(join(root, 'counter'), 'utf8')).trim(), 'called')
  await writeFile(guide, 'guide-v2')
  await assert.rejects(call(), /changed.*reset/)
  await promisify(execFile)(process.execPath, [...argv, '--reset'], options)
  assert.equal((await readFile(join(root, 'counter'), 'utf8')).trim(), 'called\ncalled')
  await assert.rejects(access(join(root, 'data/_peers/钨/.codex-workflow/run.lock')), { code: 'ENOENT' })
})
