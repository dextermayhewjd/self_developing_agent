import { readFile } from 'node:fs/promises'

export async function loadWorkflow(path) {
  const source = (await readFile(path, 'utf8')).replace(/^export\s+const\s+meta/m, 'const meta')
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
  const fn = new AsyncFunction('args', 'budget', 'agent', 'parallel', 'pipeline', 'phase', 'log', 'workflow', source)
  return (args, runtime) => fn(args, runtime.budget, runtime.agent, runtime.parallel,
    runtime.pipeline, runtime.phase, runtime.log, runtime.workflow)
}

export function createRuntime({ runAgent, jobs = 3, signal, emit = () => {} } = {}) {
  if (!Number.isInteger(jobs) || jobs < 1) throw new Error('jobs must be a positive integer')
  const controller = new AbortController()
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal
  const waiters = []
  const tasks = new Set()
  let running = 0
  combined.addEventListener('abort', () => {
    for (const waiter of waiters.splice(0)) waiter.reject(combined.reason)
  }, { once: true })
  async function work(prompt, options = {}) {
    combined.throwIfAborted()
    if (running >= jobs) await new Promise((resolve, reject) => waiters.push({ resolve, reject }))
    combined.throwIfAborted()
    running++
    try {
      return await runAgent(prompt, options, combined)
    } catch (error) {
      controller.abort(error)
      throw error
    } finally {
      running--
      waiters.shift()?.resolve()
    }
  }
  function agent(prompt, options) {
    const task = work(prompt, options)
    tasks.add(task)
    task.then(() => tasks.delete(task), () => tasks.delete(task))
    return task
  }
  return {
    agent,
    signal: combined,
    abort: reason => controller.abort(reason),
    drain: () => Promise.allSettled([...tasks]),
    parallel: thunks => Promise.all(thunks.map(thunk => Promise.resolve().then(thunk))),
    pipeline: (items, ...stages) => Promise.all(items.map(async (item, index) => {
      let value = item
      for (const stage of stages) value = await stage(value, item, index)
      return value
    })),
    phase: name => emit({ type: 'phase', name }),
    log: message => emit({ type: 'log', message }),
    workflow: () => { throw new Error('Nested workflow calls are not used by the three supported scripts') },
    budget: { total: null, spent: () => 0, remaining: () => Infinity },
  }
}
