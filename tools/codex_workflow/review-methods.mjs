import {readFile, mkdir, open, lstat, realpath} from 'node:fs/promises'
import {join,relative,isAbsolute} from 'node:path'
import {canonicalJson,sha256} from './review-contracts.mjs'

const methodPaths = [
 'equity-thesis-cn/writing_contract.md','equity-thesis-cn/framework.md','equity-thesis-cn/style_guide.md',
 'financial-redflags-cn/SKILL.md','equity-thesis-cn/lenses/尽调.md','equity-thesis-cn/lenses/产业.md',
 'equity-thesis-cn/lenses/竞争.md','equity-thesis-cn/lenses/战略驱动.md',
].map(path=>'.codex/skills/'+path)
const rubric = `Apply the supplied current native writing, framework, style and all five lens methods in full.
Semantic coverage includes every consequential finding, rebuttal, uncertainty, limitation and rating-changing item in every lens. One finding per lens is only a format floor, never a completeness target.
covered must preserve the finding's substance, qualification and limitations. excluded requires a specific evidence-based reason; omitted material cannot simply be relabeled excluded. An unrelated exact quote is not semantic coverage. Contradictions and omitted consequential findings must link to open tasks.
Recover every original doubt: explain its evidence, resolution or remaining uncertainty and effect on the judgment. Check unsupported claims, reference-system strength, units, periods, comparability and whether weak/private references have been used as external proof. Preserve uncertainty and downgrade judgment when support is insufficient.
Independent full review checks opening and all twelve sections, all lens findings, rebuttals and source limitations; it must independently assess every acceptance condition. Unified revision applies these same methods to repair tasks without inventing evidence or closing tasks.`

/** Host freezes exact required methods; isolated workers receive bytes, never paths to read. */
export async function freezeReviewMethods({root,runDir}) {
 const documents=[]
 for(const path of methodPaths) {
  let bytes
  try {
   const file=join(root,path),info=await lstat(file),physical=await realpath(file),rel=relative(await realpath(root),physical)
   if(!info.isFile()||info.isSymbolicLink()||rel.startsWith('..')||isAbsolute(rel))throw Error('unsafe method path: '+path)
   bytes=await readFile(file)
  } catch(error) { if(error.code==='ENOENT')throw Error('Required native method missing: '+path);throw error }
  const text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes)
  if(!text.trim())throw Error('Required native method empty: '+path)
  documents.push({path,sha256:sha256(bytes),text})
 }
 const content={version:1,documents,rubric},methodology={...content,sha256:sha256(canonicalJson(content))}
 const directory=join(runDir,'.codex-workflow/review'),path=join(directory,'methodology.json')
 let existing
 try {existing=JSON.parse(await readFile(path,'utf8'))}catch(error){if(error.code!=='ENOENT')throw error}
 if(existing) {
  if(canonicalJson(existing)!==canonicalJson(methodology))throw Error('Frozen native methodology changed or conflicts with current required methods')
  return existing
 }
 await mkdir(directory,{recursive:true})
 const file=await open(path,'wx',0o444)
 try {await file.writeFile(canonicalJson(methodology));await file.sync()}finally{await file.close()}
 return methodology
}
