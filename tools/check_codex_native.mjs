#!/usr/bin/env node
import { access, readFile, readdir, realpath } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const nativeSkills = ['thesis-wf', 'equity-thesis-cn', 'equity-report-cn', 'financial-redflags-cn', 'calibrate-equity-thesis', 'debug-equity-thesis']
export const nativeWorkflows = ['equity-thesis', 'peer-comparability', 'calibrate-equity-thesis']

export async function checkNativeLayout(root) {
  root = resolve(root)
  const errors = [], skills = [], workflows = []
  async function exists(path) { try { await access(path); return true } catch { return false } }
  async function markdown(path) {
    const source = await readFile(path, 'utf8')
    const body = source.replace(/^```[^\n]*\n[\s\S]*?^```\s*$/gm, '')
    for (const match of body.matchAll(/\[[^\]]*\]\(([^\n)]+)\)/g)) {
      let target = match[1].trim().replace(/^<|>$/g, '')
      if (/^(?:[a-z][a-z\d+.-]*:|#)/i.test(target)) continue
      target = target.split('#')[0]
      if (!target || target.includes('<') || target.includes('{')) continue
      try { target = decodeURIComponent(target) } catch { /* Keep the literal path. */ }
      const destination = resolve(dirname(path), target)
      if (destination.includes('/.claude/')) errors.push(`${path}: runtime reference to .claude: ${target}`)
      else if (!await exists(destination)) errors.push(`${path}: unresolved local reference: ${target}`)
    }
  }
  async function references(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) await references(path)
      else if (entry.isFile() && entry.name.endsWith('.md')) await markdown(path)
    }
  }
  for (const name of nativeSkills) {
    const canonical = join(root, '.codex/skills', name), manifest = join(canonical, 'SKILL.md')
    if (!await exists(manifest)) { errors.push(`missing skill: ${manifest}`); continue }
    const source = await readFile(manifest, 'utf8')
    if (!source.startsWith('---\n') || !new RegExp(`^name:\\s*["']?${name}["']?\\s*$`, 'm').test(source) || !/^description:\s*\S/m.test(source)) {
      errors.push(`invalid skill manifest: ${manifest}`)
    }
    try {
      if (await realpath(join(root, '.agents/skills', name)) !== await realpath(canonical)) errors.push(`wrong discovery target: ${name}`)
    } catch { errors.push(`missing discovery link: ${name}`) }
    await references(canonical)
    skills.push({ name, path: manifest })
  }
  for (const name of nativeWorkflows) {
    const path = join(root, '.codex/workflows', `${name}.mjs`)
    if (!await exists(path)) { errors.push(`missing workflow: ${path}`); continue }
    const source = await readFile(path, 'utf8')
    if (/\.claude\//.test(source)) errors.push(`${path}: dependency on .claude`)
    workflows.push({ name, path })
  }
  return { ok: errors.length === 0, root, skills, workflows, errors }
}

async function main() {
  if (process.argv.length > 3) throw new Error('Usage: node tools/check_codex_native.mjs [ROOT]')
  const root = process.argv[2] ?? resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const result = await checkNativeLayout(root)
  console.log(JSON.stringify(result, null, 2))
  if (!result.ok) process.exitCode = 1
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 2 })
}
