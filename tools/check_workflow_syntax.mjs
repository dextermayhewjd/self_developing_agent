// Workflow 脚本体由运行时包进 async 函数执行，故顶层 return / await 合法，
// 而 `node --check` 按 ES module 解析必然报 "Illegal return statement"。
// 这里剥掉 export 前缀后用 AsyncFunction 构造器验语法，与运行时的包裹方式一致。
import { readFileSync } from 'node:fs'
const path = process.argv[2]
const src = readFileSync(path, 'utf8').replace(/^export\s+const\s+meta/m, 'const meta')
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
// meta 必须是纯字面量——Workflow 运行时静态解析它，任何拼接/变量/函数调用都会被拒。
// 实测教训：只验 JS 语法会放行 `whenToUse: 'a' + 'b'`，跑时才报
// "meta must be a pure literal: non-literal node type in meta: BinaryExpression"。
// 做法：先剥掉注释与字符串字面量，剩下的骨架里不该出现 + 、模板串、展开、函数调用。
const metaMatch = src.match(/const\s+meta\s*=\s*\{[\s\S]*?\n\}/)
if (metaMatch) {
  const skeleton = metaMatch[0]
    .replace(/\/\/[^\n]*/g, '')
    .replace(/'(?:\\.|[^'\\])*'/g, "''")
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
  const offenders = []
  if (skeleton.includes('+')) offenders.push('字符串拼接 +')
  if (skeleton.includes('`')) offenders.push('模板字符串')
  if (skeleton.includes('...')) offenders.push('展开运算符')
  if (/\w\s*\(/.test(skeleton)) offenders.push('函数调用')
  if (offenders.length) {
    console.error(`meta 非纯字面量: ${path}`)
    console.error(`  发现：${offenders.join('、')}。Workflow 运行时会拒绝加载。`)
    process.exit(1)
  }
}

let fn
try {
  fn = new AsyncFunction('args', 'budget', 'agent', 'parallel', 'pipeline', 'phase', 'log', 'workflow', src)
} catch (e) {
  console.error(`语法错误: ${path}\n  ${e.name}: ${e.message}`)
  process.exit(1)
}

// 烟测：把所有 hook 桩掉，真跑一遍脚本体。
// 语法校验抓不到 ReferenceError——重命名漏改一处变量、拼错字段名，都是合法 JS，
// 只有真跑才炸。实测教训：peer-comparability 重命名 SYMBOL→SEED 漏了模板串里那处，
// 语法 OK 而运行时 6ms 就崩在 "SYMBOL is not defined"。
// 用法：check_workflow_syntax.mjs <file> --smoke '<argsJSON>'
const smokeIdx = process.argv.indexOf('--smoke')
if (smokeIdx !== -1) {
  const smokeArgs = process.argv[smokeIdx + 1] ? JSON.parse(process.argv[smokeIdx + 1]) : {}
  const stubAgent = async () => ({})
  const stub = {
    agent: stubAgent,
    parallel: async (thunks) => Promise.all(thunks.map((t) => t())),
    pipeline: async (items, ...stages) =>
      Promise.all(items.map(async (it, i) => {
        let acc = it
        for (const st of stages) acc = await st(acc, it, i)
        return acc
      })),
    phase: () => {},
    log: () => {},
    workflow: async () => ({}),
    budget: { total: null, spent: () => 0, remaining: () => Infinity },
  }
  try {
    await fn(smokeArgs, stub.budget, stub.agent, stub.parallel, stub.pipeline, stub.phase, stub.log, stub.workflow)
    console.log(`语法 OK + 烟测通过: ${path}`)
  } catch (e) {
    console.error(`烟测失败: ${path}\n  ${e.name}: ${e.message}`)
    console.error('  （桩函数返回空对象，故只报运行期引用/结构问题，业务逻辑错不在此范围）')
    process.exit(1)
  }
} else {
  console.log(`语法 OK: ${path}`)
}
