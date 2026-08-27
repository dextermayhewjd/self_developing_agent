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

try {
  new AsyncFunction('args', 'budget', 'agent', 'parallel', 'pipeline', 'phase', 'log', 'workflow', src)
  console.log(`语法 OK: ${path}`)
} catch (e) {
  console.error(`语法错误: ${path}\n  ${e.name}: ${e.message}`)
  process.exit(1)
}
