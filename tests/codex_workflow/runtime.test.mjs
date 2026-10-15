import test from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { createRuntime, loadWorkflow } from '../../tools/codex_workflow/runtime.mjs'

test('pipeline starts checking a fast item while another is still digging and preserves order', async () => {
  const events = []
  const runtime = createRuntime({ jobs: 2, runAgent: async (prompt) => {
    if (prompt === 'dig:slow') await delay(35)
    events.push(prompt)
    return prompt
  } })
  const results = await runtime.pipeline(['slow', 'fast'],
    item => runtime.agent(`dig:${item}`),
    (prior, item) => runtime.agent(`check:${item}`))
  assert.deepEqual(results, ['check:slow', 'check:fast'])
  assert.ok(events.indexOf('check:fast') < events.indexOf('dig:slow'))
})

test('nested parallel limits running workers without holding scheduler slots', async () => {
  let active = 0, maximum = 0
  const runtime = createRuntime({ jobs: 2, runAgent: async () => {
    maximum = Math.max(maximum, ++active)
    await delay(5)
    active--
    return 'ok'
  } })
  await runtime.parallel([() => runtime.parallel(Array.from({ length: 6 }, () => () => runtime.agent('x')))])
  assert.equal(maximum, 2)
  assert.throws(() => createRuntime({ jobs: 0 }), /jobs/)
})

test('worker failure cancels queued workers and surfaces the original failure', async () => {
  const started = []
  const runtime = createRuntime({ jobs: 1, runAgent: async prompt => {
    started.push(prompt)
    throw new Error('denied')
  } })
  await assert.rejects(runtime.parallel([() => runtime.agent('first'), () => runtime.agent('queued')]), /denied/)
  assert.deepEqual(started, ['first'])
})

test('loads the existing trusted script wrapper with top-level return', async () => {
  const workflow = await loadWorkflow(new URL('../../.claude/workflows/equity-thesis.mjs', import.meta.url))
  const runtime = createRuntime({ runAgent: async () => ({}) })
  const result = await workflow({ symbol: '00700', date: '20261015', root: '/tmp/test' }, runtime)
  assert.equal(result.symbol, '00700')
  assert.equal(result.run_dir, '/tmp/test/reports/00700_thesis_20261015')
})
