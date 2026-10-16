import { open, mkdir, readFile, rename, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { sha256 } from './review-contracts.mjs'

const read = async path => { try { return await readFile(path) } catch (e) { if (e.code === 'ENOENT') return null; throw e } }
const digest = bytes => bytes === null ? null : sha256(bytes)
async function syncDir(path) { const fd=await open(path,'r'); try { await fd.sync() } finally { await fd.close() } }
async function atomic(path, bytes) {
  await mkdir(dirname(path),{recursive:true})
  const tmp=path+'.'+randomUUID()+'.tmp',fd=await open(tmp,'wx',0o600)
  try { await fd.writeFile(bytes); await fd.sync() } finally { await fd.close() }
  await rename(tmp,path); await syncDir(dirname(path))
}
const location = runDir => join(runDir,'.codex-workflow/delivery/journal.json')
const save = (path,journal) => atomic(path,JSON.stringify(journal,null,2)+'\n')

// Caller holds the per-symbol run lock. Hash checks preserve observed external
// edits; an arbitrary editor racing rename is outside filesystem CAS guarantees.
export async function recoverDelivery({runDir,targets}) {
  const path=location(runDir),bytes=await read(path)
  if (!bytes) return
  const journal=JSON.parse(bytes)
  if (journal.phase === 'committed' || journal.phase === 'rolled_back') return
  const conflicts=[]
  for (const item of journal.targets) {
    if (targets?.[item.name] !== item.path) throw Error('Delivery journal target mismatch: '+item.path)
    const current=digest(await read(item.path))
    if (current===item.before) continue
    if (!item.after || current!==item.after) { conflicts.push(item.path); continue }
    if (item.before===null) { await unlink(item.path); await syncDir(dirname(item.path)) }
    else {
      const backup=await read(item.backup)
      if (digest(backup)!==item.before) throw Error('Delivery backup digest mismatch: '+item.path)
      await atomic(item.path,backup)
    }
  }
  if (conflicts.length) throw Error('Delivery recovery conflict: '+conflicts.join(', '))
  journal.phase='rolled_back'; await save(path,journal)
}

export async function beginDelivery({runDir,targets,snapshot,receipt}) {
  await recoverDelivery({runDir,targets})
  const journalPath=location(runDir),directory=join(dirname(journalPath),randomUUID())
  await mkdir(directory,{recursive:true})
  const journal={version:1,phase:'prepared',snapshot,receipt,targets:[]},staged={}
  for (const [name,path] of Object.entries(targets)) {
    const bytes=await read(path),backup=join(directory,name+'.before'),stage=join(directory,name+(name==='pdf'?'.pdf':'.md'))
    if(bytes!==null) await atomic(backup,bytes)
    if(name==='position' && bytes!==null) await atomic(stage,bytes)
    staged[name]=stage
    journal.targets.push({name,path,backup,staged:stage,before:digest(bytes),after:null,published:false})
  }
  await save(journalPath,journal)
  return {staged,journalPath,
    rollback:()=>recoverDelivery({runDir,targets}),
    async publish({guard,snapshot=journal.snapshot,receipt=journal.receipt,emit=async()=>{}}) {
      journal.snapshot=snapshot; journal.receipt=receipt
      // Validate every target before the first publication, including an absent PDF.
      for(const item of journal.targets) {
        if(digest(await read(item.path))!==item.before) throw Error('Delivery publication conflict: '+item.path)
        const bytes=await read(item.staged)
        if(!bytes?.length) throw Error('Missing or empty staged output: '+item.staged)
        item.after=digest(bytes)
      }
      journal.phase='publishing'; await save(journalPath,journal)
      for(const item of journal.targets) {
        await guard()
        if(digest(await read(item.path))!==item.before) throw Error('Delivery publication conflict: '+item.path)
        const bytes=await read(item.staged)
        if(digest(bytes)!==item.after) throw Error('Staged output changed: '+item.staged)
        await atomic(item.path,bytes)
        await emit({type:'delivery_published',path:item.path,sha256:item.after})
        item.published=true; await save(journalPath,journal)
      }
      await guard()
      for(const item of journal.targets) if(digest(await read(item.path))!==item.after) throw Error('Delivery commit conflict: '+item.path)
      journal.phase='committed'; await save(journalPath,journal)
    },
  }
}
