// Optional local historical diagnostic, deliberately outside the default *.test.mjs
// suite: node tests/codex_workflow/fixtures/replay-thesis-inputs.mjs --root . \
//   --manifest debug/300209_native_retest_20261016/test-manifest.json
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { parseArgs } from 'node:util'
import { sha256 } from '../../../tools/codex_workflow/review-contracts.mjs'
import { createThesisInputTracker } from '../../../tools/codex_workflow/thesis-inputs.mjs'
import { workflowFingerprint } from '../../../tools/run_codex_workflow.mjs'

const { values } = parseArgs({ options: { root: { type: 'string', default: '.' }, manifest: { type: 'string' } } })
if (!values.manifest) throw new Error('Specify --manifest PATH to an independently frozen original-input manifest')
const sourceRoot = resolve(values.root), manifestPath = resolve(sourceRoot, values.manifest)
const frozen = JSON.parse(await readFile(manifestPath, 'utf8'))
assert.match(frozen.symbol, /^(?:\d{5}|\d{6})$/)
const root = await mkdtemp(join(tmpdir(), 'thesis-original-replay-'))
const put = async (path, bytes) => { await mkdir(join(path, '..'), { recursive: true }); await writeFile(path, bytes) }
try {
  await put(join(root, '.codex/workflows/equity-thesis.mjs'), 'return {}')
  await mkdir(join(root, '.codex/skills'), { recursive: true })
  const verified = []
  for (const [path, expected] of Object.entries(frozen.raw_inputs)) {
    assert.ok(!path.includes('\\') && path.split('/').every(part => part && part !== '.' && part !== '..') && !path.startsWith('/'), 'Unsafe frozen original path')
    const bytes = await readFile(join(sourceRoot, 'data', frozen.symbol, path))
    assert.equal(sha256(bytes), expected, path)
    await put(join(root, 'data', frozen.symbol, path), bytes)
    verified.push({ path, sha256: expected })
  }
  const tracker = await createThesisInputTracker({ root, symbol: frozen.symbol, runDir: join(root, 'reports/replay') })
  const fingerprint = () => workflowFingerprint(root, 'equity-thesis', { symbol: frozen.symbol }, {}, { inputManifest: tracker.manifest })
  const original = await fingerprint(), before = await tracker.beforeStage('板块基准')
  await put(join(root, 'data', frozen.symbol, 'benchmark_peers/computed.json'), 'fixture derived')
  await tracker.afterStage('板块基准', before)
  await tracker.assertCurrent()
  assert.equal(await fingerprint(), original)
  assert.equal(tracker.manifest.originals.length, verified.length)
  console.log(JSON.stringify({ manifest: manifestPath, symbol: frozen.symbol, verified_originals: verified, original_fingerprint_stable: true }, null, 2))
} finally { await rm(root, { recursive: true, force: true }) }
