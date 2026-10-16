import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, copyFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import * as evidence from '../../tools/codex_workflow/review-evidence.mjs'
import { parseReportSections } from '../../tools/codex_workflow/review-sections.mjs'
import { reportFixture, reviewFixtureV2 } from './fixtures/review-fixture.mjs'
import { canonicalJson, sha256 } from '../../tools/codex_workflow/review-contracts.mjs'
import { createLedger, reconcileReview } from '../../tools/codex_workflow/review-ledger.mjs'
import { openReviewStore } from '../../tools/codex_workflow/review-store.mjs'
import { validateReviewRecord, validateThesisReview } from '../../tools/check_thesis_review.mjs'

const binary = Buffer.from([137,80,78,71,13,10,26,10,255,254,128,0])
async function fixture(t) {
  const runDir = await mkdtemp(join(tmpdir(), 'typed-evidence-'))
  t.after(() => rm(runDir, { recursive: true, force: true }))
  const put = async (path, bytes) => { await mkdir(join(runDir,path,'..'),{recursive:true}); await writeFile(join(runDir,path),bytes) }
  await put('疑惑.md','现金流依赖回款。')
  for (const lens of ['财务排雷','尽调','产业','竞争','战略驱动']) await put(`findings/${lens}.md`,'现金流依赖回款。')
  await put('report.md',reportFixture('现金流依赖回款。'))
  return {runDir,put}
}
async function transcript(f, source='核查/table.png', text='收入 67,157,134.15 元') {
  const value={version:2,source,source_sha256:sha256(await readFile(join(f.runDir,source))),text,method:'manual'}
  const path='.codex-workflow/review/transcripts/T-test.json'
  await f.put(path,canonicalJson(value))
  return {source,path,sha256:sha256(await readFile(join(f.runDir,path)))}
}
function attestation(source) { return {source:source.path,source_sha256:source.sha256,transcript_path:source.transcript.path,transcript_sha256:source.transcript.sha256,method:'visual',status:'verified',reason:'逐格核对原图与候选转录一致。'} }
async function reviewFor(f, manifest) {
  const ledger=createLedger()
  return {ledger,review:reviewFixtureV2({ledgerSha256:sha256(canonicalJson(ledger)),snapshot:{report_sha256:sha256(await readFile(join(f.runDir,'report.md'))),evidence_sha256:manifest.sha256},reviewed_sources:manifest.sources.map(s=>s.path)})}
}

test('binary SHA uses original bytes; missing transcript has actionable pending state',async t=>{
  const f=await fixture(t); await f.put('核查/table.png',binary)
  const manifest=await evidence.snapshotEvidence(f)
  const source=manifest.sources.find(s=>s.path==='核查/table.png')
  assert.equal(source.type,'image')
  assert.equal(source.sha256,createHash('sha256').update(binary).digest('hex'))
  assert.notEqual(source.sha256,sha256(binary.toString('utf8')))
  await assert.rejects(evidence.validateEvidenceQuotes({...f,manifest,review:{reviewed_sources:manifest.sources.map(s=>s.path),visual_attestations:[],coverage:[]}}),e=>e.code==='EVIDENCE_PENDING'&&/transcript/i.test(e.message))
})

test('candidate transcript is untrusted until a separate double-bound visual record; exact quotes then pass',async t=>{
  const f=await fixture(t); await f.put('核查/table.png',binary)
  const tr=await transcript(f); const manifest=await evidence.snapshotEvidence({...f,transcripts:[tr]})
  const {review}=await reviewFor(f,manifest)
  review.coverage[0].findings.push({finding:'收入',source:'核查/table.png',source_quote:'67,157,134.15',disposition:'excluded',report_quote:'',exclusion_reason:'原图收入与结论无关'})
  await assert.rejects(evidence.validateEvidenceQuotes({...f,manifest,review}),e=>e.code==='EVIDENCE_PENDING'&&/visual/i.test(e.message))
  const source=manifest.sources.find(s=>s.type==='image'); review.visual_attestations=[attestation(source)]
  await evidence.validateEvidenceQuotes({...f,manifest,review})
  const ctx=await evidence.loadEvidenceContext({...f,manifest})
  assert.equal(ctx.sourceTexts['核查/table.png'],'收入 67,157,134.15 元')
  assert.deepEqual(ctx.images,[join(f.runDir,'核查/table.png')])
  review.coverage[0].findings.at(-1).source_quote='不存在'
  await assert.rejects(evidence.validateEvidenceQuotes({...f,manifest,review}),/source_quote.*transcript/i)
})

test('source/transcript tamper, mismatched attestation, duplicate attestations and omitted attachments reject',async t=>{
  for (const kind of ['source','transcript','attestation','duplicate','inventory']) {
    const f=await fixture(t); await f.put('核查/table.png',binary)
    const tr=await transcript(f); const manifest=await evidence.snapshotEvidence({...f,transcripts:[tr]}); const {review}=await reviewFor(f,manifest)
    review.visual_attestations=[attestation(manifest.sources.find(s=>s.type==='image'))]
    if(kind==='source') await f.put('核查/table.png',Buffer.concat([binary,Buffer.from([1])]))
    if(kind==='transcript') await f.put(tr.path,(await readFile(join(f.runDir,tr.path)))+' ')
    if(kind==='attestation') review.visual_attestations[0].source_sha256='a'.repeat(64)
    if(kind==='duplicate') review.visual_attestations.push(structuredClone(review.visual_attestations[0]))
    if(kind==='inventory') review.reviewed_sources.pop()
    await assert.rejects(evidence.validateEvidenceQuotes({...f,manifest,review}),/digest|sha256|attestation|inventory/i)
  }
})

test('unknown attachments, invalid UTF-8 text, path escapes and symlink aliases are never skipped',async t=>{
  for(const [path,bytes] of [['核查/file.docx',binary],['核查/file.md',binary]]) {
    const f=await fixture(t);await f.put(path,bytes);await assert.rejects(evidence.snapshotEvidence(f),/unsupported|UTF-8/i)
  }
  const f=await fixture(t);await f.put('核查/table.png',binary)
  await assert.rejects(evidence.snapshotEvidence({...f,transcripts:[{source:'核查/table.png',path:'../outside.json',sha256:'a'.repeat(64)}]}),/path/i)
  await symlink(join(f.runDir,'疑惑.md'),join(f.runDir,'findings/alias.md'))
  await assert.rejects(evidence.snapshotEvidence(f),/symlink/i)
})

test('text quotes remain exact and issue references bind source, transcript and evidence snapshots',async t=>{
  const f=await fixture(t);const manifest=await evidence.snapshotEvidence(f);const {review}=await reviewFor(f,manifest)
  await evidence.validateEvidenceQuotes({...f,manifest,review})
  review.coverage[0].findings[0].source_quote='现金流依赖\n回款。'
  await assert.rejects(evidence.validateEvidenceQuotes({...f,manifest,review}),/source_quote/i)
  review.coverage[0].findings[0].source_quote='现金流依赖回款。'
  review.new_issues=[{evidence_refs:[{source:'疑惑.md',source_sha256:'a'.repeat(64),evidence_sha256:manifest.sha256,quote:'现金流依赖回款。'}]}]
  await assert.rejects(evidence.validateEvidenceQuotes({...f,manifest,review}),/reference|digest/i)
})

test('shared section parser keeps CRLF offsets, ignores fenced headings and rejects duplicate twelve',()=>{
  const report=reportFixture('中文\r\n```md\r\n## 十二、伪造标题\r\n```').replaceAll('\n','\r\n')
  const sections=parseReportSections(report)
  assert.equal(sections.length,12)
  for(const s of sections) assert.equal(report.slice(s.start,s.end),s.text)
  assert.match(sections[0].heading,/一/)
  assert.equal(sections[11].end,report.length)
  assert.throws(()=>parseReportSections(report+'\r\n## 十二、重复'),/1\.\.12|十二节/)
})

test('prepareEvidence archives candidate only, passes raw images through read-only contract, reuses bound transcript',async t=>{
  const f=await fixture(t); await f.put('核查/table.png',binary)
  let calls=0
  const runtime={agent:async(prompt,options)=>{
    calls++
    assert.equal(options.contract,'evidence_extract')
    assert.deepEqual(options.images,[join(f.runDir,'核查/table.png')])
    return {version:2,source:'核查/table.png',source_sha256:sha256(binary),text:'收入 67,157,134.15 元',method:'model'}
  }}
  const manifest=await evidence.prepareEvidence({...f,runtime})
  assert.equal(calls,1)
  const source=manifest.sources.find(s=>s.type==='image')
  assert.ok(source.transcript.path.startsWith('.codex-workflow/review/transcripts/'))
  const value=JSON.parse(await readFile(join(f.runDir,source.transcript.path),'utf8'))
  assert.equal(value.text,'收入 67,157,134.15 元')
  await assert.rejects(evidence.validateEvidenceQuotes({...f,manifest,review:{reviewed_sources:manifest.sources.map(s=>s.path),visual_attestations:[],coverage:[]}}),/visual/i)
  const second=await evidence.prepareEvidence({...f,runtime})
  assert.equal(calls,1)
  assert.equal(second.sha256,manifest.sha256)
})

function simplePdf() {
  const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>','<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>','<< /Length 39 >>\nstream\nBT /F1 12 Tf 20 100 Td (Revenue 100) Tj ET\nendstream']
  let pdf='%PDF-1.4\n';const offsets=[0]
  objects.forEach((o,i)=>{offsets.push(Buffer.byteLength(pdf));pdf+=`${i+1} 0 obj\n${o}\nendobj\n`})
  const xref=Buffer.byteLength(pdf); pdf+=`xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(x=>String(x).padStart(10,'0')+' 00000 n \n').join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;return pdf
}

test('PDF preparation retains raw digest and complete page views, and invalidates any changed byte or page mapping',async t=>{
  const f=await fixture(t); const pdf=Buffer.from(simplePdf());await f.put('核查/source.pdf',pdf)
  const manifest=await evidence.prepareEvidence({...f,runtime:{agent:async()=>({version:2,source:'核查/source.pdf',source_sha256:sha256(pdf),text:'Revenue 100',method:'model'})}})
  const source=manifest.sources.find(s=>s.type==='pdf')
  assert.equal(source.sha256,sha256(pdf)); assert.equal(source.pdf_origin.pages.length,1)
  assert.deepEqual(source.pdf_origin.pages.map(p=>[p.page_index,p.printed_page]),[[1,null]])
  const ctx=await evidence.loadEvidenceContext({...f,manifest});assert.equal(ctx.images.length,1)
  const {review}=await reviewFor(f,manifest);review.visual_attestations=[attestation(source)]
  await evidence.validateEvidenceQuotes({...f,manifest,review})
  const changed=structuredClone(manifest);changed.sources.find(s=>s.type==='pdf').pdf_origin.pages[0].page_index=2
  changed.sha256=sha256(canonicalJson({version:2,sources:changed.sources}))
  await assert.rejects(evidence.loadEvidenceContext({...f,manifest:changed}),/page/i)
  await f.put('核查/source.pdf',Buffer.concat([pdf,Buffer.from('\n')]))
  await assert.rejects(evidence.validateEvidenceQuotes({...f,manifest,review}),/digest|sha256/i)
})

test('raw valid v2 review is not delivery authority; only current physical snapshot + Store receipt authorize',async t=>{
  const f=await fixture(t); const manifest=await evidence.snapshotEvidence(f);const {review,ledger}=await reviewFor(f,manifest)
  await validateReviewRecord({...f,manifest,review,inputLedger:ledger})
  await f.put('成稿审查.json',JSON.stringify(review))
  await assert.rejects(validateThesisReview(f.runDir),/v2|Store|proof|HEAD/i)
  await rm(join(f.runDir,'成稿审查.json')) // remove explicitly untrusted raw scratch artifact
  const store=await openReviewStore(f);await store.initialize({reportBytes:await readFile(join(f.runDir,'report.md')),evidence:manifest})
  const result=reconcileReview({ledger,review,snapshot:{report_sha256:review.report_sha256,evidence_sha256:manifest.sha256}})
  await store.commitReview({review,...result,evidence:manifest})
  assert.equal((await validateThesisReview(f.runDir)).review_id,review.review_id)
  await f.put('疑惑.md','改动后的证据')
  await assert.rejects(validateThesisReview(f.runDir),/evidence|digest|sha256|Snapshot/i)
})

test('frozen 300209 PNG replay distinguishes missing visual verification from absent transcript quote',async t=>{
  const f=await fixture(t);await mkdir(join(f.runDir,'核查'),{recursive:true})
  const source='核查/竞争_H1_p13.png'
  await copyFile('debug/300209_native_retest_20261016/new-run/'+source,join(f.runDir,source))
  const tr=await transcript(f,source,'行云科技股份有限公司2026年半年度报告全文\n服务器业务 67,157,134.15 1,330,088.49 98.02%\n四、非主营业务分析\n公允价值变动损益 -9,193,678.56 对应的外币借款确认了汇兑收益840万元。 是否具有可持续性：否\n营业外收入 8,942,514.78 主要系无需支付的款项。 是否具有可持续性：否\n印刷页码：13')
  const manifest=await evidence.snapshotEvidence({...f,transcripts:[tr]});const {review}=await reviewFor(f,manifest)
  review.coverage[0].findings.push({finding:'原图核查',source,source_quote:'主要系无需支付的款项。',disposition:'excluded',report_quote:'',exclusion_reason:'测试'})
  await assert.rejects(evidence.validateEvidenceQuotes({...f,manifest,review}),e=>e.code==='EVIDENCE_PENDING'&&/visual/i.test(e.message))
  review.visual_attestations=[attestation(manifest.sources.find(s=>s.path===source))]
  await evidence.validateEvidenceQuotes({...f,manifest,review})
  review.coverage[0].findings.at(-1).source_quote='不存在于逐字稿的值'
  await assert.rejects(evidence.validateEvidenceQuotes({...f,manifest,review}),e=>e.code!=='EVIDENCE_PENDING'&&/source_quote.*transcript/i.test(e.message))
})

test('PDF inventory cannot omit a page, map an unrelated image, or accept changed page-view bytes',async t=>{
  const f=await fixture(t);const pdf=Buffer.from(simplePdf());await f.put('核查/source.pdf',pdf)
  const manifest=await evidence.prepareEvidence({...f,runtime:{agent:async()=>({version:2,source:'核查/source.pdf',source_sha256:sha256(pdf),text:'Revenue 100',method:'model'})}})
  const source=manifest.sources.find(s=>s.type==='pdf')
  const missing=structuredClone(manifest);missing.sources.find(s=>s.type==='pdf').pdf_origin.pages.push({...source.pdf_origin.pages[0],page_index:2})
  missing.sha256=sha256(canonicalJson({version:2,sources:missing.sources}))
  await assert.rejects(evidence.loadEvidenceContext({...f,manifest:missing}),/page.*count|page.*inventory/i)
  await f.put('核查/unrelated.png',binary)
  const tr=await transcript(f,'核查/unrelated.png')
  const pdfHint={source:source.path,...source.transcript,pdf_origin:source.pdf_origin}
  await assert.rejects(evidence.snapshotEvidence({...f,transcripts:[pdfHint,{...tr,pdf_origin:{source:source.path,source_sha256:source.sha256,page_index:1,printed_page:null}}]}),/image.*origin|page.*image/i)
  await rm(join(f.runDir,'核查/unrelated.png'))
  const page=source.pdf_origin.pages[0]
  await f.put(page.image.path,Buffer.concat([await readFile(join(f.runDir,page.image.path)),Buffer.from([1])]))
  await assert.rejects(evidence.loadEvidenceContext({...f,manifest}),/views.*digest/i)
})

test('review receipt output-ledger mutation blocks delivery; uncommitted legacy pass cannot replace latest proof',async t=>{
  const f=await fixture(t);const manifest=await evidence.snapshotEvidence(f);const {review,ledger}=await reviewFor(f,manifest)
  const store=await openReviewStore(f);await store.initialize({reportBytes:await readFile(join(f.runDir,'report.md')),evidence:manifest})
  await store.commitReview({review,...reconcileReview({ledger,review,snapshot:{report_sha256:review.report_sha256,evidence_sha256:manifest.sha256}}),evidence:manifest})
  const cli=spawnSync(process.execPath,['tools/check_thesis_review.mjs',f.runDir],{encoding:'utf8'})
  assert.equal(cli.status,0,cli.stderr)
  await store.setMaxRounds(3)
  await assert.rejects(validateThesisReview(f.runDir),/ledger|receipt/i)
})

test('PDF conversion errors and missing candidate extraction fail closed without dropping attachments',async t=>{
  const f=await fixture(t);await f.put('核查/broken.pdf','%PDF-1.4\ninvalid')
  await assert.rejects(evidence.prepareEvidence({...f,runtime:{agent:async()=>assert.fail('no model after failed PDF tool')}}),/PDF preparation failed/)
  await rm(join(f.runDir,'核查/broken.pdf'));await f.put('核查/table.png',binary)
  await assert.rejects(evidence.prepareEvidence(f),e=>e.code==='EVIDENCE_PENDING')
})

test('committed image proof invalidates when only transcript bytes or original image bytes change',async t=>{
  for(const target of ['image','transcript']) {
    const f=await fixture(t);await f.put('核查/table.png',binary)
    const tr=await transcript(f);const manifest=await evidence.snapshotEvidence({...f,transcripts:[tr]})
    const {review,ledger}=await reviewFor(f,manifest)
    review.visual_attestations=[attestation(manifest.sources.find(s=>s.type==='image'))]
    await validateReviewRecord({...f,manifest,review,inputLedger:ledger})
    const store=await openReviewStore(f);await store.initialize({reportBytes:await readFile(join(f.runDir,'report.md')),evidence:manifest})
    await store.commitReview({review,...reconcileReview({ledger,review,snapshot:{report_sha256:review.report_sha256,evidence_sha256:manifest.sha256}}),evidence:manifest})
    assert.equal((await validateThesisReview(f.runDir)).verdict,'pass')
    const path=target==='image'?'核查/table.png':tr.path
    await f.put(path,Buffer.concat([await readFile(join(f.runDir,path)),Buffer.from([32])]))
    await assert.rejects(validateThesisReview(f.runDir),/sha256|digest/i)
  }
})

test('v2 delivery checks control-directory symlinks before Store recovery',async t=>{
  const f=await fixture(t)
  const outside=await mkdtemp(join(tmpdir(),'evidence-outside-'))
  t.after(()=>rm(outside,{recursive:true,force:true}))
  await symlink(outside,join(f.runDir,'.codex-workflow'))
  await assert.rejects(validateThesisReview(f.runDir),/symlink/i)
})

test('model extraction cannot label its own candidate as a manual or OCR transcript',async t=>{
  const f=await fixture(t);await f.put('核查/table.png',binary)
  await assert.rejects(evidence.prepareEvidence({...f,runtime:{agent:async()=>({version:2,source:'核查/table.png',source_sha256:sha256(binary),text:'收入 100',method:'manual'})}}),/method|model/i)
})
