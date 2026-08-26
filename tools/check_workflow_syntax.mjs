// Workflow 脚本体由运行时包进 async 函数执行，故顶层 return / await 合法，
// 而 `node --check` 按 ES module 解析必然报 "Illegal return statement"。
// 这里剥掉 export 前缀后用 AsyncFunction 构造器验语法，与运行时的包裹方式一致。
import { readFileSync } from 'node:fs'
const path = process.argv[2]
const src = readFileSync(path, 'utf8').replace(/^export\s+const\s+meta/m, 'const meta')
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
try {
  new AsyncFunction('args', 'budget', 'agent', 'parallel', 'pipeline', 'phase', 'log', 'workflow', src)
  console.log(`语法 OK: ${path}`)
} catch (e) {
  console.error(`语法错误: ${path}\n  ${e.name}: ${e.message}`)
  process.exit(1)
}
