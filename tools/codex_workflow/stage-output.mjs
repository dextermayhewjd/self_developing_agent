import { lstat, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, resolve } from 'node:path'

const fail = reason => { throw new Error('Exclusive output violation: ' + reason) }

// The path is selected by the host, never inferred from model output. Refuse
// observed aliases before backups, ownership registration and later recovery.
export async function validateExclusiveOutputPath(path, { mustExist = false } = {}) {
  if (typeof path !== 'string' || !isAbsolute(path) || resolve(path) !== path) fail('expected a canonical absolute path')
  let current = path
  for (;;) {
    let info
    try { info = await lstat(current) }
    catch (error) {
      if (error.code !== 'ENOENT') throw error
      if (mustExist && current === path) fail('missing staged file: ' + path)
      current = dirname(current)
      continue
    }
    if (current === path && (!info.isFile() || info.nlink !== 1 || (mustExist && !info.size))) fail('staged file is not a private regular file: ' + path)
    if (await realpath(current) !== current) fail('symlink or ancestor alias: ' + path)
    return path
  }
}

export async function validateExclusiveOutput(result, path) {
  if (!result || typeof result !== 'object' || Array.isArray(result) ||
      Object.keys(result).length !== 1 || !Object.hasOwn(result, 'written_file') || result.written_file !== path) {
    fail('result must contain only written_file equal to the host-selected path: ' + path)
  }
  await validateExclusiveOutputPath(path, { mustExist: true })
  return result
}
