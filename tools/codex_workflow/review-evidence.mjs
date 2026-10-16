import { readFile, readdir, lstat, realpath, mkdir, open, mkdtemp, rm } from 'node:fs/promises'
import { resolve, relative, isAbsolute, sep, extname, dirname, join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { canonicalJson, sha256, TRANSCRIPT_SCHEMA } from './review-contracts.mjs'
import { decodeResult } from './schema.mjs'
import { parseReportSections } from './review-sections.mjs'

const exec = promisify(execFile)
const control = '.codex-workflow/review'
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const nonempty = value => typeof value === 'string' && value.trim().length > 0
const fail = message => { throw new Error(`Evidence: ${message}`) }
const pending = message => { const error = new Error(`Evidence pending: ${message}`); error.code = 'EVIDENCE_PENDING'; throw error }
const same = (a,b) => canonicalJson(a) === canonicalJson(b)
function fields(value, required, optional=[]) {
  return value && typeof value === 'object' && !Array.isArray(value) && required.every(k=>Object.hasOwn(value,k)) && Object.keys(value).every(k=>required.includes(k)||optional.includes(k))
}
function relativePath(path) {
  if (!nonempty(path) || path.includes('\\') || path.includes('\0') || isAbsolute(path) || path.split('/').some(p=>!p||p==='.'||p==='..')) fail(`invalid path: ${path}`)
  return path
}
function sourcePath(path) {
  relativePath(path)
  if (path !== '疑惑.md' && !/^(findings|核查|参照系)\/.+/.test(path)) fail(`invalid source path: ${path}`)
  return path
}
const inRoot = (root,path) => { const rel=relative(root,path); return rel!=='..'&&!rel.startsWith(`..${sep}`)&&!isAbsolute(rel) }
export async function safeEvidenceFile(runDir, path) {
  relativePath(path)
  const root=await realpath(resolve(runDir))
  let current=root
  for(const part of path.split('/')) {
    current=resolve(current,part)
    if((await lstat(current)).isSymbolicLink()) fail(`path contains symlink: ${path}`)
  }
  if(!inRoot(root,await realpath(current)) || !(await lstat(current)).isFile()) fail(`path is not a confined regular file: ${path}`)
  return current
}
async function safeDirectory(root,path) {
  relativePath(path)
  let current=root
  for(const part of path.split('/')) {
    current=join(current,part)
    try { await mkdir(current) } catch(error) { if(error.code!=='EEXIST') throw error }
    const info=await lstat(current)
    if(info.isSymbolicLink()||!info.isDirectory()) fail(`unsafe control directory path: ${path}`)
  }
  return current
}
async function archive(root,path,bytes) {
  await safeDirectory(root,dirname(path))
  try {
    const file=await open(join(root,path),'wx',0o600)
    try { await file.writeFile(bytes);await file.sync() } finally { await file.close() }
  } catch(error) {
    if(error.code!=='EEXIST') throw error
    if(!(await readFile(await safeEvidenceFile(root,path))).equals(Buffer.from(bytes))) fail(`immutable archive collision: ${path}`)
  }
}
async function inventory(root) {
  const files=['疑惑.md']
  await safeEvidenceFile(root,'疑惑.md')
  async function visit(dir) {
    let info
    try { info=await lstat(join(root,dir)) } catch(error) { if(error.code==='ENOENT')return;throw error }
    if(info.isSymbolicLink()||!info.isDirectory()) fail(`invalid source directory path: ${dir}`)
    for(const entry of await readdir(join(root,dir),{withFileTypes:true})) {
      const path=`${dir}/${entry.name}`
      if(entry.isDirectory()) await visit(path)
      else { await safeEvidenceFile(root,path);files.push(path) }
    }
  }
  for(const dir of ['findings','核查','参照系']) await visit(dir)
  return files.sort()
}
function utf8(bytes,path) {
  try { return new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes) } catch { fail(`invalid UTF-8 text: ${path}`) }
}
function sourceType(path,bytes) {
  const ext=extname(path).toLowerCase()
  if(['.md','.txt','.json','.csv','.tsv','.html','.xml','.yaml','.yml'].includes(ext)) { utf8(bytes,path);return 'text' }
  if(ext==='.pdf' && bytes.subarray(0,5).toString()==='%PDF-') return 'pdf'
  if((ext==='.png' && bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) ||
    (['.jpg','.jpeg'].includes(ext)&&bytes[0]===255&&bytes[1]===216) ||
    (ext==='.webp'&&bytes.subarray(0,4).toString()==='RIFF'&&bytes.subarray(8,12).toString()==='WEBP')) return 'image'
  fail(`unsupported attachment type or signature: ${path}`)
}
async function descriptorBytes(root,descriptor,area) {
  if(!fields(descriptor,['path','sha256'])||!digest(descriptor.sha256)) fail(`invalid ${area} descriptor`)
  relativePath(descriptor.path)
  if(!descriptor.path.startsWith(`${control}/${area}/`)) fail(`invalid ${area} path: ${descriptor.path}`)
  const bytes=await readFile(await safeEvidenceFile(root,descriptor.path))
  if(sha256(bytes)!==descriptor.sha256) fail(`${area} sha256 digest mismatch: ${descriptor.path}`)
  return bytes
}
async function readTranscript(root,source) {
  const bytes=await descriptorBytes(root,source.transcript,'transcripts')
  const transcript=decodeResult(TRANSCRIPT_SCHEMA,JSON.parse(utf8(bytes,source.transcript.path)))
  if(transcript.source!==source.path||transcript.source_sha256!==source.sha256||!nonempty(transcript.text)) fail(`transcript source digest binding mismatch: ${source.path}`)
  return transcript.text
}
async function validateOrigin(root,source,byPath) {
  if(!source.pdf_origin) return
  const origin=source.pdf_origin
  if(source.type==='pdf') {
    if(!fields(origin,['pages'])||!Array.isArray(origin.pages)||!origin.pages.length) fail(`invalid PDF page mapping: ${source.path}`)
    let count
    try {
      const {stdout}=await exec('pdfinfo',[await safeEvidenceFile(root,source.path)],{maxBuffer:1024*1024})
      count=Number(/^Pages:\s+(\d+)/m.exec(stdout)?.[1])
    } catch(error) { fail(`PDF page inventory unavailable: ${source.path}: ${error.message}`) }
    if(origin.pages.length!==count)fail(`PDF page count differs from page inventory: ${source.path}`)
    for(const [index,page] of origin.pages.entries()) {
      if(!fields(page,['page_index','printed_page','text','image'])||page.page_index!==index+1||(page.printed_page!==null&&!nonempty(page.printed_page))) fail(`invalid PDF page order/printed page mapping: ${source.path}`)
      await descriptorBytes(root,page.text,'views');await descriptorBytes(root,page.image,'views')
    }
  } else {
    if(source.type!=='image'||!fields(origin,['source','source_sha256','page_index','printed_page'])) fail(`invalid PDF image origin: ${source.path}`)
    sourcePath(origin.source)
    const pdf=byPath.get(origin.source)
    const page=pdf?.pdf_origin?.pages?.[origin.page_index-1]
    if(!pdf||pdf.type!=='pdf'||pdf.sha256!==origin.source_sha256||!Number.isInteger(origin.page_index)||!page||origin.printed_page!==page.printed_page||source.sha256!==page.image.sha256) fail(`PDF image page origin mismatch: ${source.path}`)
  }
}
/** transcripts: [{source,path,sha256,pdf_origin?}]; body is exact TRANSCRIPT_SCHEMA JSON. */
export async function snapshotEvidence({runDir,transcripts=[]}) {
  const root=await realpath(resolve(runDir))
  if(!Array.isArray(transcripts)) fail('transcripts must be an array')
  const hints=new Map()
  for(const hint of transcripts) {
    if(!fields(hint,['source','path','sha256'],['pdf_origin'])) fail('invalid transcript hint')
    sourcePath(hint.source)
    if(hints.has(hint.source)) fail(`duplicate transcript source: ${hint.source}`)
    hints.set(hint.source,hint)
  }
  const sources=[]
  for(const path of await inventory(root)) {
    const bytes=await readFile(await safeEvidenceFile(root,path))
    const source={path,type:sourceType(path,bytes),sha256:sha256(bytes)}
    const hint=hints.get(path)
    if(hint) {
      if(source.type==='text') fail(`text source cannot have binary transcript: ${path}`)
      source.transcript={path:hint.path,sha256:hint.sha256}
      if(hint.pdf_origin)source.pdf_origin=structuredClone(hint.pdf_origin)
      await readTranscript(root,source);hints.delete(path)
    }
    sources.push(source)
  }
  if(hints.size) fail(`transcript source absent from inventory: ${[...hints.keys()].join(', ')}`)
  const byPath=new Map(sources.map(s=>[s.path,s]))
  for(const source of sources) await validateOrigin(root,source,byPath)
  return {version:2,sources,sha256:sha256(canonicalJson({version:2,sources}))}
}
async function checkManifest({runDir,manifest}) {
  if(!fields(manifest,['version','sources','sha256'])||manifest.version!==2||!Array.isArray(manifest.sources)||manifest.sha256!==sha256(canonicalJson({version:2,sources:manifest.sources}))) fail('invalid evidence manifest digest')
  const root=await realpath(resolve(runDir))
  if(!same(manifest.sources.map(s=>s.path).sort(),await inventory(root))||new Set(manifest.sources.map(s=>s.path)).size!==manifest.sources.length) fail('manifest source inventory differs from physical attachments')
  const sourceTexts=Object.create(null), images=[]
  const byPath=new Map(manifest.sources.map(s=>[s.path,s]))
  for(const source of manifest.sources) {
    if(!fields(source,['path','type','sha256'],['transcript','pdf_origin']))fail('invalid source descriptor')
    sourcePath(source.path)
    const bytes=await readFile(await safeEvidenceFile(root,source.path))
    if(sha256(bytes)!==source.sha256)fail(`source sha256 digest mismatch: ${source.path}`)
    if(sourceType(source.path,bytes)!==source.type)fail(`source type mismatch: ${source.path}`)
    await validateOrigin(root,source,byPath)
    if(source.type==='text') {
      if(source.transcript||source.pdf_origin)fail(`invalid text source metadata: ${source.path}`)
      sourceTexts[source.path]=utf8(bytes,source.path)
    } else {
      if(source.transcript)sourceTexts[source.path]=await readTranscript(root,source)
      if(source.type==='image') images.push(await safeEvidenceFile(root,source.path))
      else if(source.pdf_origin) for(const page of source.pdf_origin.pages) images.push(await safeEvidenceFile(root,page.image.path))
    }
  }
  return {sourceTexts,images}
}
/** Candidate text only. Trust requires validateEvidenceQuotes against the independent Review. */
export async function loadEvidenceContext(options) { return checkManifest(options) }

/** All attachments need visual verification, even when not quoted by coverage. */
export async function validateEvidenceQuotes({runDir,review,manifest}) {
  const {sourceTexts}=await checkManifest({runDir,manifest})
  if(!Array.isArray(review.reviewed_sources)||!same([...review.reviewed_sources].sort(),manifest.sources.map(s=>s.path).sort()))fail('reviewed_sources must uniquely include the full source inventory')
  const attestations=review.visual_attestations??[]
  if(!Array.isArray(attestations))fail('invalid visual attestations')
  const byPath=new Map(manifest.sources.map(s=>[s.path,s]))
  const attested=new Set()
  for(const attestation of attestations) {
    if(!fields(attestation,['source','source_sha256','transcript_path','transcript_sha256','method','status','reason']))fail('invalid visual attestation')
    const source=byPath.get(attestation.source)
    if(!source||source.type==='text'||!source.transcript||attested.has(source.path)||source.sha256!==attestation.source_sha256||source.transcript.path!==attestation.transcript_path||source.transcript.sha256!==attestation.transcript_sha256||attestation.method!=='visual'||!['verified','mismatch'].includes(attestation.status)||!nonempty(attestation.reason))fail('visual attestation source/transcript digest mismatch or duplicate')
    if(attestation.status!=='verified')pending(`visual mismatch requires corrected transcript: ${source.path}`)
    attested.add(source.path)
  }
  for(const source of manifest.sources.filter(s=>s.type!=='text')) {
    if(!source.transcript)pending(`missing transcript for ${source.path}`)
    if(source.type==='pdf'&&!source.pdf_origin)pending(`missing PDF page views for ${source.path}`)
    if(!attested.has(source.path))pending(`missing independent visual verification for ${source.path}`)
  }
  function quote(sourcePath,quote,label) {
    const source=byPath.get(sourcePath)
    if(!source)fail(`unknown source reference: ${sourcePath}`)
    if(!nonempty(quote)||!sourceTexts[sourcePath]?.includes(quote))fail(`${label} not found in ${source.type==='text'?'source':'transcript'}: ${sourcePath}`)
    return source
  }
  for(const coverage of review.coverage??[])for(const finding of coverage.findings??[])quote(finding.source,finding.source_quote,'source_quote')
  const report=await readFile(await safeEvidenceFile(runDir,'report.md'),'utf8')
  const sections=parseReportSections(report)
  for(const coverage of review.coverage??[])for(const finding of coverage.findings??[]) {
    if(finding.report_quote && !report.includes(finding.report_quote))fail('report_quote not found in current report')
  }
  for(const issue of review.new_issues??[]) {
    for(const location of issue.locations??[])if(location.quote && !sections.find(s=>s.section===location.section)?.text.includes(location.quote))fail('location quote not found in specified report section')
    for(const ref of issue.evidence_refs??[]) {
      const source=quote(ref.source,ref.quote,'reference quote')
      if(ref.source_sha256!==source.sha256||ref.evidence_sha256!==manifest.sha256)fail('reference source/evidence digest mismatch')
      if(source.transcript) {
        if(ref.transcript_path!==source.transcript.path||ref.transcript_sha256!==source.transcript.sha256)fail('reference transcript digest mismatch')
      } else if(ref.transcript_path!==undefined||ref.transcript_sha256!==undefined)fail('text reference cannot invent transcript')
    }
  }
}
async function pdfViews(root,source) {
  const path=await safeEvidenceFile(root,source.path)
  const dir=`${control}/views/P-${source.sha256}`
  await safeDirectory(root,dir)
  try {
    const {stdout}=await exec('pdfinfo',[path],{maxBuffer:1024*1024})
    const count=Number(/^Pages:\s+(\d+)/m.exec(stdout)?.[1])
    if(!Number.isInteger(count)||count<1)fail(`PDF page count unavailable: ${source.path}`)
    const pages=[]
    for(let page_index=1;page_index<=count;page_index++) {
      const {stdout:text}=await exec('pdftotext',['-f',String(page_index),'-l',String(page_index),'-layout',path,'-'],{encoding:'buffer',maxBuffer:32*1024*1024})
      const textPath=`${dir}/page-${page_index}.txt`
      await archive(root,textPath,text)
      const imagePath=`${dir}/page-${page_index}.png`
      // Poppler writes only into a host-created, checked control directory.
      const temp=await mkdtemp(join(root,dir,'render-'))
      try {
        await exec('pdftoppm',['-f',String(page_index),'-l',String(page_index),'-singlefile','-scale-to','2000','-png',path,join(temp,'page')],{maxBuffer:1024*1024})
        await archive(root,imagePath,await readFile(join(temp,'page.png')))
      } finally { await rm(temp,{recursive:true,force:true}) }
      pages.push({page_index,printed_page:null,text:{path:textPath,sha256:sha256(text)},image:{path:imagePath,sha256:sha256(await readFile(await safeEvidenceFile(root,imagePath)))}})
    }
    return {pages}
  } catch(error) { fail(`PDF preparation failed for ${source.path}: ${error.message}`) }
}
/** Extracts candidates only; final independent review must see images + candidates. */
export async function prepareEvidence({runDir,runtime,store}) {
  const root=await realpath(resolve(runDir))
  const initial=await snapshotEvidence({runDir:root})
  const transcripts=[]
  for(const source of initial.sources.filter(s=>s.type!=='text')) {
    const cachePath=`${control}/prepared/P-${sha256(source.path)}-${source.sha256}.json`
    let hint
    try { hint=JSON.parse(await readFile(await safeEvidenceFile(root,cachePath),'utf8')) } catch(error) { if(error.code!=='ENOENT')throw error }
    if(!hint) {
      const origin=source.type==='pdf'?await pdfViews(root,source):undefined
      const images=source.type==='image'?[await safeEvidenceFile(root,source.path)]:await Promise.all(origin.pages.map(page=>safeEvidenceFile(root,page.image.path)))
      if(!runtime?.agent)pending(`transcript extraction runtime required for ${source.path}`)
      const prompt=`Extract an exact candidate transcript from ALL attached original/page images. This is unverified text, not independent visual approval. Preserve numbers, signs, units and table relationships. Do not invent printed page labels. Return only TRANSCRIPT_SCHEMA for source ${source.path}, source_sha256 ${source.sha256}.`
      const transcript=decodeResult(TRANSCRIPT_SCHEMA,await runtime.agent(prompt,{label:`证据转录:${source.path}`,schema:TRANSCRIPT_SCHEMA,contract:'evidence_extract',images}))
      if(transcript.source!==source.path||transcript.source_sha256!==source.sha256||!nonempty(transcript.text))fail(`candidate transcript binding mismatch: ${source.path}`)
      if(transcript.method!=='model')fail(`candidate extraction method must be model: ${source.path}`)
      const bytes=canonicalJson(transcript)
      hint={source:source.path,path:`${control}/transcripts/T-${sha256(bytes)}.json`,sha256:sha256(bytes)}
      if(origin)hint.pdf_origin=origin
      await archive(root,hint.path,bytes)
      await archive(root,cachePath,canonicalJson(hint))
    }
    transcripts.push(hint)
  }
  // Store owns version commits. Preparation does not mutate ledger or authorize evidence.
  void store
  return snapshotEvidence({runDir:root,transcripts})
}
