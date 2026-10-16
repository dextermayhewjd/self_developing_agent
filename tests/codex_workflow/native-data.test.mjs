import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, cp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

test('peer collection loads native assets in a workspace that has no Claude directory', async t => {
  const root = await mkdtemp(join(tmpdir(), 'native-peer-data-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'tools'))
  for (const name of ['fetch_peers.py', 'lib.py']) {
    await cp(fileURLToPath(new URL(`../../tools/${name}`, import.meta.url)), join(root, 'tools', name))
  }
  const pool = join(root, '.codex/skills/equity-report-cn/competitor_pool.json')
  await mkdir(join(pool, '..'), { recursive: true })
  await writeFile(pool, JSON.stringify({ '测试行业': { stars: ['600519'], labels: {} }, _unknown_fallback: { stars: [], labels: {} } }))
  const python = fileURLToPath(new URL('../../.venv/bin/python', import.meta.url))
  const script = 'import sys; sys.path.insert(0, sys.argv[1]); import fetch_peers; print(fetch_peers.lookup_pool("测试行业")["stars"][0])'
  const env = { ...process.env }; delete env.SDA_COMPETITOR_POOL
  const first = await promisify(execFile)(python, ['-B', '-c', script, join(root, 'tools')], { env })
  assert.equal(first.stdout.trim(), '600519')
  const custom = join(root, 'custom.json')
  await writeFile(custom, JSON.stringify({ '测试行业': { stars: ['000001'] }, _unknown_fallback: { stars: [] } }))
  const second = await promisify(execFile)(python, ['-B', '-c', script, join(root, 'tools')], { env: { ...env, SDA_COMPETITOR_POOL: custom } })
  assert.equal(second.stdout.trim(), '000001')
})
