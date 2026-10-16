import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'native-layout-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  for (const name of ['thesis-wf', 'equity-thesis-cn', 'equity-report-cn', 'financial-redflags-cn', 'calibrate-equity-thesis', 'debug-equity-thesis']) {
    await mkdir(join(root, '.codex/skills', name), { recursive: true })
    await mkdir(join(root, '.agents/skills'), { recursive: true })
    await writeFile(join(root, '.codex/skills', name, 'SKILL.md'), `---\nname: ${name}\ndescription: fixture\n---\n`)
    await symlink(`../../.codex/skills/${name}`, join(root, '.agents/skills', name))
  }
  await mkdir(join(root, '.codex/workflows'))
  for (const name of ['equity-thesis', 'peer-comparability', 'calibrate-equity-thesis']) await writeFile(join(root, '.codex/workflows', name + '.mjs'), 'return {}')
  return root
}

test('native layout check succeeds without any Claude directory', async t => {
  const { checkNativeLayout } = await import('../../tools/check_codex_native.mjs')
  const result = await checkNativeLayout(await fixture(t))
  assert.equal(result.ok, true)
  assert.equal(result.skills.length, 6)
})

test('native layout check reports a broken discovery link and an unresolved local reference', async t => {
  const { checkNativeLayout } = await import('../../tools/check_codex_native.mjs')
  const root = await fixture(t)
  await rm(join(root, '.agents/skills/thesis-wf'))
  await writeFile(join(root, '.codex/skills/thesis-wf/SKILL.md'), '---\nname: thesis-wf\ndescription: fixture\n---\n[Guide](missing.md)')
  const result = await checkNativeLayout(root)
  assert.equal(result.ok, false)
  assert.ok(result.errors.some(e => e.includes('discovery')))
  assert.ok(result.errors.some(e => e.includes('missing.md')))
})

test('native layout check rejects residual runtime paths into the Claude directory', async t => {
  const { checkNativeLayout } = await import('../../tools/check_codex_native.mjs')
  const root = await fixture(t)
  await writeFile(join(root, '.codex/workflows/equity-thesis.mjs'), 'const SKILL = `${args.root}/.claude/skills`; return {}')
  const result = await checkNativeLayout(root)
  assert.equal(result.ok, false)
  assert.ok(result.errors.some(e => e.includes('.claude')))
})
