import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile, unlink, rm, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { openState, acquireRunLock } from '../../tools/codex_workflow/state.mjs'

async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), 'workflow-state-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const output = join(root, 'result.md')
  const config = { dir: join(root, '.codex-workflow'), fingerprint: 'v1', artifactRoots: [root],
    artifactsFor: () => [output] }
  return { root, output, config }
}

test('lock excludes concurrent runs and release permits the next run', async t => {
  const { config } = await setup(t)
  const state = await openState(config)
  await assert.rejects(openState(config), /already running/i)
  await state.close()
  await (await openState(config)).close()
})

test('validated success replays across sessions, missing artifact forces recomputation', async t => {
  const { config, output } = await setup(t)
  let calls = 0
  const runner = async () => { calls++; await writeFile(output, 'complete'); return { written_file: output } }
  let state = await openState(config)
  await state.run('prompt', { label: 'stage' }, runner)
  await state.close()
  state = await openState(config)
  assert.deepEqual(await state.run('prompt', { label: 'stage' }, runner), { written_file: output })
  assert.equal(calls, 1)
  await unlink(output)
  await state.run('prompt', { label: 'stage' }, runner)
  assert.equal(calls, 2)
  await state.close()
})

test('failed or interrupted output is quarantined before inventory can treat it as complete', async t => {
  const { config, output } = await setup(t)
  let state = await openState(config)
  await assert.rejects(state.run('prompt', { label: 'stage' }, async () => {
    await writeFile(output, 'partial'.repeat(100))
    throw new Error('interrupted')
  }), /interrupted/)
  await state.close()
  state = await openState(config)
  await assert.rejects(readFile(output), { code: 'ENOENT' })
  await state.close()
})

test('changed workflow fingerprint requires explicit reset', async t => {
  const { config, output } = await setup(t)
  let state = await openState(config)
  await state.run('prompt', { label: 'stage' }, async () => {
    await writeFile(output, 'complete')
    return { written_file: output }
  })
  await state.close()
  await assert.rejects(openState({ ...config, fingerprint: 'v2' }), /changed.*reset/i)
  state = await openState({ ...config, fingerprint: 'v2', reset: true })
  await assert.rejects(readFile(output), { code: 'ENOENT' })
  await state.close()
})

test('output claims cannot escape artifact roots through paths or symlinks', async t => {
  const { config, root } = await setup(t)
  const outside = await mkdtemp(join(tmpdir(), 'outside-workflow-'))
  t.after(() => rm(outside, { recursive: true, force: true }))
  await writeFile(join(outside, 'out.md'), 'outside')
  await symlink(outside, join(root, 'link'))
  const state = await openState({ ...config, artifactsFor: () => [] })
  await assert.rejects(state.run('x', { label: 'bad' }, async () => ({ written_file: join(root, 'link/out.md') })), /outside.*artifact/i)
  await state.close()
})

test('explicit reset archives legacy artifacts and records invocation for reproducible resume', async t => {
  const { config, output } = await setup(t)
  await writeFile(output, 'legacy Claude output')
  const invocation = { name: 'equity-thesis', args: { symbol: '00700', date: '20261015' }, noPdf: true }
  let state = await openState({ ...config, invocation })
  await state.close()
  state = await openState({ ...config, invocation, reset: true, resetArtifacts: [output] })
  await assert.rejects(readFile(output), { code: 'ENOENT' })
  assert.deepEqual(state.data.invocation, invocation)
  await state.close()
})

test('failed position update restores the previous persistent file', async t => {
  const { root } = await setup(t)
  const run = join(root, 'report')
  const position = join(root, 'position.md')
  await writeFile(position, 'previous complete position')
  const state = await openState({ dir: join(run, '.codex-workflow'), fingerprint: 'v1',
    artifactRoots: [run, position], artifactsFor: () => [position] })
  await assert.rejects(state.run('update', { label: '更新档案' }, async () => {
    await writeFile(position, '最近更新: 2026-10-15\npartial')
    throw new Error('worker interrupted')
  }), /interrupted/)
  assert.equal(await readFile(position, 'utf8'), 'previous complete position')
  assert.equal(state.canReuse(), false)
  await state.close()
})

test('missing upstream output invalidates and removes downstream artifacts before inventory', async t => {
  const { root, config } = await setup(t)
  const paths = { dig: join(root, 'find.md'), check: join(root, 'check.md'), report: join(root, 'report.md') }
  const settings = { ...config, artifactsFor: label => [paths[label]],
    dependents: label => ({ dig: ['check', 'report'], check: ['report'] }[label] ?? []) }
  let state = await openState(settings)
  for (const label of ['dig', 'check', 'report']) await state.run(label, { label }, async () => {
    await writeFile(paths[label], 'round 1'); return { written_file: paths[label] }
  })
  await state.close()
  await unlink(paths.dig)
  state = await openState(settings)
  await assert.rejects(readFile(paths.check), { code: 'ENOENT' })
  await assert.rejects(readFile(paths.report), { code: 'ENOENT' })
  assert.equal(state.canReuse(), false)
  await state.close()
})

test('dead parent lock is not reclaimed while a registered detached worker survives', async t => {
  const { root } = await setup(t)
  const module = new URL('../../tools/codex_workflow/state.mjs', import.meta.url).href
  const code = `import {spawn} from 'node:child_process'; import {acquireRunLock,createProcessRegistry} from ${JSON.stringify(module)};
const registry=createProcessRegistry(${JSON.stringify(root)}); await acquireRunLock(${JSON.stringify(root)},{processesFile:registry.path});
const child=spawn(process.execPath,['-e','setTimeout(()=>{},30000)'],{detached:true,stdio:'ignore'});registry.started(child.pid);console.log(child.pid);process.exit(0);`
  const result = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', code])
  const pid = Number(result.stdout.trim())
  t.after(() => { try { process.kill(-pid, 'SIGKILL') } catch {} })
  await assert.rejects(acquireRunLock(root), /worker.*running/i)
})
