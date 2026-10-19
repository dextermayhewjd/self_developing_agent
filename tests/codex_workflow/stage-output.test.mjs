import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, link, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { openState } from '../../tools/codex_workflow/state.mjs'

async function fixture(t) {
 const root=await mkdtemp(join(tmpdir(),'exclusive-output-'));t.after(()=>rm(root,{recursive:true,force:true}))
 const evidence=join(root,'findings/产业.md'),stage=join(root,'.codex-workflow/delivery/tx/position.md')
 await mkdir(join(evidence,'..'),{recursive:true});await mkdir(join(stage,'..'),{recursive:true})
 await writeFile(evidence,'research source');await writeFile(stage,'staged position')
 const config={dir:join(root,'.codex-workflow'),fingerprint:'fixture',artifactRoots:[root],artifactsFor:()=>[stage]}
 return {root,evidence,stage,config}
}
for(const mode of ['top-level','nested'])test(mode+' wrong claim cannot acquire ownership or quarantine research evidence on reopen',async t=>{
 const f=await fixture(t),state=await openState(f.config)
 let failure
 try {await state.run('position',{label:'更新档案',exclusiveOutputPath:f.stage},async()=>mode==='top-level'?{written_file:f.evidence}:{written_file:f.stage,nested:{written_file:f.evidence}})}catch(error){failure=error}
 await state.close();await rm(f.stage,{force:true})
 const reopened=await openState(f.config);await reopened.close()
 assert.equal(await readFile(f.evidence,'utf8').catch(error=>error.code),'research source')
 assert.match(failure?.message??'',/exclusive output/i)
 const record=JSON.parse(await readFile(join(f.config.dir,'state.json'),'utf8')).stages['更新档案']
 assert.ok(!record.artifacts.includes(f.evidence));assert.ok(!record.outputs.includes(f.evidence))
})
for(const alias of ['file-symlink','parent-symlink','hardlink'])test('exclusive output rejects '+alias+' before worker execution or backup',async t=>{
 const f=await fixture(t);await rm(f.stage)
 if(alias==='parent-symlink') {await rm(join(f.stage,'..'),{recursive:true});await symlink(join(f.evidence,'..'),join(f.stage,'..'));await writeFile(join(f.evidence,'..','position.md'),'another source')}
 else if(alias==='file-symlink')await symlink(f.evidence,f.stage)
 else await link(f.evidence,f.stage)
 const state=await openState(f.config);let calls=0
 try {await assert.rejects(state.run('position',{label:'更新档案',exclusiveOutputPath:f.stage},async()=>{calls++;return {written_file:f.stage}}),/exclusive output/i)}finally{await state.close()}
 assert.equal(calls,0);assert.equal(await readFile(f.evidence,'utf8'),'research source')
})
test('valid staging uses only host-selected path; policy survives reopening and blocks parent alias recovery',async t=>{
 const f=await fixture(t),state=await openState({...f.config,artifactsFor:()=>[f.evidence]})
 await state.run('position',{label:'更新档案',exclusiveOutputPath:f.stage},async()=>({written_file:f.stage}))
 const record=state.data.stages['更新档案'];assert.equal(record.exclusiveOutputPath,f.stage)
 assert.deepEqual(record.artifacts,[f.stage]);assert.deepEqual(record.outputs,[f.stage])
 await state.close()
 await rename(join(f.stage,'..'),join(f.stage,'..')+'-saved');await symlink(join(f.evidence,'..'),join(f.stage,'..'))
 await assert.rejects(openState(f.config),/exclusive output/i)
 assert.equal(await readFile(f.evidence,'utf8'),'research source')
})
test('exclusive output changes stage cache identity while ordinary research retains nested claims',async t=>{
 const f=await fixture(t),state=await openState(f.config);let calls=0
 await state.run('same',{label:'custom',exclusiveOutputPath:f.stage},async()=>{calls++;return {written_file:f.stage}})
 const first=state.data.stages.custom.key,next=join(f.stage,'..','next.md');await writeFile(next,'next output')
 await state.run('same',{label:'custom',exclusiveOutputPath:next},async()=>{calls++;return {written_file:next}})
 assert.notEqual(state.data.stages.custom.key,first);assert.equal(calls,2)
 await state.run('ordinary',{label:'research'},async()=>({written_file:f.stage,nested:{written_file:f.evidence}}))
 assert.ok(state.data.stages.research.artifacts.includes(f.evidence));await state.close()
})

test('worker interruption after replacing staging parent cannot restore through an evidence alias',async t=>{
 const f=await fixture(t),state=await openState(f.config)
 await assert.rejects(state.run('position',{label:'更新档案',exclusiveOutputPath:f.stage},async()=>{
  await rename(join(f.stage,'..'),join(f.stage,'..')+'-saved')
  await symlink(join(f.evidence,'..'),join(f.stage,'..'))
  throw Error('worker interrupted')
 }),/exclusive output/i)
 await state.close()
 await assert.rejects(openState(f.config),/exclusive output/i)
 assert.equal(await readFile(f.evidence,'utf8'),'research source')
})
test('persisted exclusive policy rejects widened ownership before invalidation',async t=>{
 const f=await fixture(t),state=await openState(f.config)
 await state.run('position',{label:'更新档案',exclusiveOutputPath:f.stage},async()=>({written_file:f.stage}))
 await state.close()
 const path=join(f.config.dir,'state.json'),data=JSON.parse(await readFile(path,'utf8'))
 data.stages['更新档案'].outputs.push(f.evidence)
 await writeFile(path,JSON.stringify(data));await rm(f.stage)
 await assert.rejects(openState(f.config),/exclusive output/i)
 assert.equal(await readFile(f.evidence,'utf8'),'research source')
})
