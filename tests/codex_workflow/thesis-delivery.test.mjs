import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beginDelivery, recoverDelivery } from '../../tools/codex_workflow/thesis-delivery.mjs'
async function fixture(t) {
 const root=await mkdtemp(join(tmpdir(),'delivery-')); t.after(()=>rm(root,{recursive:true,force:true}))
 const runDir=join(root,'run'); await mkdir(runDir); const position=join(root,'position.md'),pdf=join(root,'report.pdf')
 await writeFile(position,'old position'); await writeFile(pdf,'old pdf'); return {runDir,targets:{position,pdf}}
}
test('staged delivery preserves old bytes until publish and commits both outputs',async t=>{
 const f=await fixture(t),tx=await beginDelivery(f)
 assert.equal(await readFile(tx.staged.position,'utf8'),'old position')
 await writeFile(tx.staged.position,'new position'); await writeFile(tx.staged.pdf,'new pdf')
 assert.equal(await readFile(f.targets.position,'utf8'),'old position')
 await tx.publish({guard:async()=>{}})
 await recoverDelivery(f)
 assert.equal(await readFile(f.targets.position,'utf8'),'new position'); assert.equal(await readFile(f.targets.pdf,'utf8'),'new pdf')
})
test('crash after publication before progress is recovered twice without overwriting old bytes',async t=>{
 const f=await fixture(t),tx=await beginDelivery(f)
 await writeFile(tx.staged.position,'new position'); await writeFile(tx.staged.pdf,'new pdf')
 await assert.rejects(tx.publish({guard:async()=>{},emit:async()=>{throw Error('crash')}}),/crash/)
 await recoverDelivery(f); await recoverDelivery(f)
 assert.equal(await readFile(f.targets.position,'utf8'),'old position'); assert.equal(await readFile(f.targets.pdf,'utf8'),'old pdf')
})
test('recovery preserves human replacement and retains journal conflict',async t=>{
 const f=await fixture(t),tx=await beginDelivery(f)
 await writeFile(tx.staged.position,'new'); await writeFile(tx.staged.pdf,'new')
 await assert.rejects(tx.publish({guard:async()=>{},emit:async()=>{throw Error('crash')}}))
 await writeFile(f.targets.position,'manual')
 await assert.rejects(recoverDelivery(f),/conflict.*position/)
 await assert.rejects(recoverDelivery(f),/conflict.*position/)
 assert.equal(await readFile(f.targets.position,'utf8'),'manual')
})
test('late guard failure rolls back owned writes and absence, preserving manual creation',async t=>{
 const f=await fixture(t); await rm(f.targets.pdf)
 const tx=await beginDelivery(f); await writeFile(tx.staged.position,'new'); await writeFile(tx.staged.pdf,'pdf')
 let checks=0
 await assert.rejects(tx.publish({guard:async()=>{if(++checks===3)throw Error('stale')}}),/stale/)
 await tx.rollback()
 assert.equal(await readFile(f.targets.position,'utf8'),'old position'); await assert.rejects(readFile(f.targets.pdf),{code:'ENOENT'})
})
test('baseline conflict before publication preserves human edits',async t=>{
 const f=await fixture(t),tx=await beginDelivery(f)
 await writeFile(tx.staged.position,'new'); await writeFile(tx.staged.pdf,'new'); await writeFile(f.targets.pdf,'manual pdf')
 await assert.rejects(tx.publish({guard:async()=>{}}),/conflict/)
 await assert.rejects(tx.rollback(),/conflict/)
 assert.equal(await readFile(f.targets.position,'utf8'),'old position'); assert.equal(await readFile(f.targets.pdf,'utf8'),'manual pdf')
})

for(const interruption of [1,2])test('reopen after publication '+interruption+' restores initially absent targets idempotently',async t=>{
 const f=await fixture(t);await rm(f.targets.position);await rm(f.targets.pdf)
 const tx=await beginDelivery(f);await writeFile(tx.staged.position,'new');await writeFile(tx.staged.pdf,'new pdf');let calls=0
 await assert.rejects(tx.publish({guard:async()=>{},emit:async()=>{if(++calls===interruption)throw Error('crash')}}),/crash/)
 await recoverDelivery(f);await recoverDelivery(f)
 await assert.rejects(readFile(f.targets.position),{code:'ENOENT'});await assert.rejects(readFile(f.targets.pdf),{code:'ENOENT'})
})
test('prepared journal recovers without publication; later manual deletion is a conflict',async t=>{
 const f=await fixture(t);await beginDelivery(f);await recoverDelivery(f);await recoverDelivery(f)
 const tx=await beginDelivery(f);await writeFile(tx.staged.position,'new');await writeFile(tx.staged.pdf,'new pdf')
 await assert.rejects(tx.publish({guard:async()=>{},emit:async()=>{throw Error('crash')}}))
 await rm(f.targets.position)
 await assert.rejects(recoverDelivery(f),/conflict/);await assert.rejects(readFile(f.targets.position),{code:'ENOENT'})
})
test('partial recovery can retry after preserving a human conflict on the other target',async t=>{
 const f=await fixture(t),tx=await beginDelivery(f);await writeFile(tx.staged.position,'new');await writeFile(tx.staged.pdf,'new pdf');let n=0
 await assert.rejects(tx.publish({guard:async()=>{},emit:async()=>{if(++n===2)throw Error('crash')}}))
 await writeFile(f.targets.pdf,'manual pdf')
 await assert.rejects(recoverDelivery(f),/conflict/)
 assert.equal(await readFile(f.targets.position,'utf8'),'old position');assert.equal(await readFile(f.targets.pdf,'utf8'),'manual pdf')
 await writeFile(f.targets.pdf,'old pdf');await recoverDelivery(f);await recoverDelivery(f)
 assert.equal(await readFile(f.targets.position,'utf8'),'old position')
})
