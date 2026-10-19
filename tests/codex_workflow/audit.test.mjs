import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

async function fixture(t, { label = '成稿', complete = true, command = 'cat findings/产业.md', malformed = false } = {}) {
  const run = await mkdtemp(join(tmpdir(), 'codex-audit-'))
  t.after(() => rm(run, { recursive: true, force: true }))
  const control = join(run, '.codex-workflow'), worker = join(control, 'agents', 'stage-1')
  await mkdir(worker, { recursive: true })
  await writeFile(join(run, 'report.md'), 'complete report')
  await writeFile(join(control, 'state.json'), JSON.stringify({ completed: complete ? '2026-10-16' : undefined,
    invocation: { name: 'fixture' }, stages: { [label]: { status: complete ? 'succeeded' : 'failed', artifacts: [join(run, 'report.md')] } } }))
  await writeFile(join(control, 'result.json'), '{}')
  await writeFile(join(control, 'events.jsonl'), JSON.stringify({ type: 'agent.started', label, directory: '/old/location/agents/stage-1' }) + '\n')
  const item = { id: 'call-1', type: 'command_execution', command, status: 'completed', exit_code: 0 }
  await writeFile(join(worker, 'events-0.jsonl'), [
    JSON.stringify({ type: 'item.started', item: { ...item, status: 'in_progress' } }),
    JSON.stringify({ type: 'item.completed', item }),
    JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 100, output_tokens: 20 } }),
    ...(malformed ? ['not valid JSON'] : []),
  ].join('\n'))
  return run
}

test('audits Codex command events once, including archives moved from the original root', async t => {
  const { auditCodexWorkflow } = await import('../../tools/audit_codex_workflow.mjs')
  const result = await auditCodexWorkflow(await fixture(t))
  assert.equal(result.status, 'complete')
  assert.equal(result.stages[0].tools.length, 1)
  assert.equal(result.stages[0].tools[0].kind, 'read')
  assert.equal(result.stages[0].usage.input_tokens, 100)
  assert.equal(result.behaviour_proven, false)
})

test('flags fresh evidence retrieval by writer without mistaking ordinary findings reads for it', async t => {
  const { auditCodexWorkflow } = await import('../../tools/audit_codex_workflow.mjs')
  const result = await auditCodexWorkflow(await fixture(t, { command: 'pdftotext data/300209/annual_pdf/a.pdf -' }))
  assert.ok(result.findings.some(x => x.code === 'writer-source-retrieval'))
  const normal = await auditCodexWorkflow(await fixture(t, { command: 'sed -n 1,300p findings/产业.md' }))
  assert.ok(!normal.findings.some(x => x.code === 'writer-source-retrieval'))
})

test('failed stages, corrupt logs and missing logs cannot become a clean completed audit', async t => {
  const { auditCodexWorkflow } = await import('../../tools/audit_codex_workflow.mjs')
  const failed = await auditCodexWorkflow(await fixture(t, { complete: false }))
  assert.equal(failed.status, 'incomplete')
  assert.ok(failed.findings.some(x => x.code === 'stage-not-complete'))
  const corrupted = await auditCodexWorkflow(await fixture(t, { malformed: true }))
  assert.equal(corrupted.status, 'incomplete')
  assert.ok(corrupted.findings.some(x => x.code === 'invalid-jsonl'))
  const run = await fixture(t)
  await rm(join(run, '.codex-workflow', 'agents'), { recursive: true })
  const missing = await auditCodexWorkflow(run)
  assert.equal(missing.status, 'incomplete')
  assert.ok(missing.findings.some(x => x.code === 'worker-log-missing'))
})

test('verification source downloads are distinguished from new web searches', async t => {
  const { classifyTool } = await import('../../tools/audit_codex_workflow.mjs')
  assert.equal(classifyTool({ type: 'command_execution', command: 'curl https://example.org/original.pdf -o source.pdf' }).kind, 'download')
  assert.equal(classifyTool({ type: 'web_search', action: { type: 'search', queries: ['subject'] } }).kind, 'search')
  assert.equal(classifyTool({ type: 'web_search', action: { type: 'open_page', url: 'https://example.org/original.pdf' } }).kind, 'open')
})

test('a successful resumed stage does not inherit failure from a superseded attempt directory', async t => {
  const { auditCodexWorkflow } = await import('../../tools/audit_codex_workflow.mjs')
  const run = await fixture(t)
  const control = join(run, '.codex-workflow')
  const previous = join(control, 'agents', 'interrupted')
  await mkdir(previous)
  await writeFile(join(previous, 'events-0.jsonl'), JSON.stringify({ type: 'thread.started' }) + '\n')
  await writeFile(join(control, 'events.jsonl'), [
    { type: 'agent.started', label: '成稿', directory: '/old/agents/interrupted' },
    { type: 'agent.started', label: '成稿', directory: '/old/agents/stage-1' },
    { type: 'agent.completed', label: '成稿', directory: '/old/agents/stage-1' },
  ].map(JSON.stringify).join('\n'))
  const result = await auditCodexWorkflow(run)
  assert.equal(result.status, 'complete')
  assert.equal(result.stages.find(s => s.directory.endsWith('/interrupted')).status, 'superseded')
  assert.ok(!result.findings.some(f => f.code === 'worker-incomplete'))
  await rm(join(control, 'agents/stage-1'), { recursive: true })
  const missingLatest = await auditCodexWorkflow(run)
  assert.equal(missingLatest.status, 'incomplete')
  assert.ok(missingLatest.findings.some(f => f.code === 'stage-trace-unavailable'))
})

test('one missing current worker trace makes an otherwise completed run incomplete', async t => {
  const { auditCodexWorkflow } = await import('../../tools/audit_codex_workflow.mjs')
  const run = await fixture(t)
  const control = join(run, '.codex-workflow')
  const state = JSON.parse(await (await import('node:fs/promises')).readFile(join(control, 'state.json'), 'utf8'))
  state.stages['核查:产业'] = { status: 'succeeded', artifacts: [] }
  await writeFile(join(control, 'state.json'), JSON.stringify(state))
  const result = await auditCodexWorkflow(run)
  assert.equal(result.status, 'incomplete')
  assert.ok(result.findings.some(f => f.code === 'stage-trace-unavailable' && f.severity === 'error'))
})

test('benchmark self lookup detection preserves peer-intent exceptions and exact ticker boundaries', async t => {
  const { detectSelfLookup, auditCodexWorkflow } = await import('../../tools/audit_codex_workflow.mjs')
  assert.equal(detectSelfLookup('300209 2026年净利润', { symbol: '300209' }), true)
  assert.equal(detectSelfLookup('300209 同行净利润对比', { symbol: '300209' }), false)
  assert.equal(detectSelfLookup('1300209 净利润', { symbol: '300209' }), false)
  assert.equal(detectSelfLookup('行云科技 营收', { company: '行云科技' }), true)
  const run = await fixture(t, { label: '补参照系' })
  const worker = join(run, '.codex-workflow/agents/stage-1/events-0.jsonl')
  await writeFile(worker, [
    { type: 'item.completed', item: { id: 's1', type: 'web_search', query: '300209 2026年净利润', action: { type: 'search' } } },
    { type: 'turn.completed', usage: {} },
  ].map(JSON.stringify).join('\n'))
  const result = await auditCodexWorkflow(run, { symbol: '300209' })
  assert.ok(result.findings.some(f => f.code === 'benchmark-self-lookup'))
})

async function reviewAuditFixture(t, {kind='watch'}={}) {
 const run=await fixture(t,{label:'成稿审查'});
 const {readFile}=await import('node:fs/promises');
 const {reportFixture,reviewFixtureV2,reviewLensesV2,issueFixtureV2}=await import('./fixtures/review-fixture.mjs');
 const {openReviewStore}=await import('../../tools/codex_workflow/review-store.mjs');
 const {snapshotEvidence}=await import('../../tools/codex_workflow/review-evidence.mjs');
 const {canonicalJson,sha256}=await import('../../tools/codex_workflow/review-contracts.mjs');
 const {reconcileReview}=await import('../../tools/codex_workflow/review-ledger.mjs');
 await mkdir(join(run,'findings'));
 await writeFile(join(run,'report.md'),reportFixture('现金流依赖回款。'));
 await writeFile(join(run,'疑惑.md'),'虚构问题');
 for(const lens of reviewLensesV2)await writeFile(join(run,'findings',lens+'.md'),'现金流依赖回款。');
 const statePath=join(run,'.codex-workflow/state.json');
 const state=JSON.parse(await readFile(statePath));state.invocation.name='equity-thesis';await writeFile(statePath,JSON.stringify(state));
 const store=await openReviewStore({runDir:run});const evidence=await snapshotEvidence({runDir:run});
 const initial=await store.initialize({reportBytes:await readFile(join(run,'report.md')),evidence});
 const review=reviewFixtureV2({ledgerSha256:sha256(canonicalJson(initial.ledger)),snapshot:initial.snapshot,
  new_issues:[issueFixtureV2({kind,blocks_delivery:kind==='blocking',judgment_constraints:[],evidence_refs:[],route:'needs_evidence'})],verdict:kind==='blocking'?'revise':'pass'});
 review.sections[2].issue_keys=['cash-flow-limit'];
 await store.commitReview({review,...reconcileReview({ledger:initial.ledger,review,snapshot:initial.snapshot}),evidence});
 await writeFile(join(run,'.codex-workflow/agents/stage-1/execution.json'),JSON.stringify({contract:'review',model:'actual-model',effort:'xhigh',context_bytes:200,sandbox:'read-only',approval:'never'}));
 return {run,store};
}

test('review task proof overrides succeeded stages: watch passes, blocking remains incomplete',async t=>{
 const {auditCodexWorkflow}=await import('../../tools/audit_codex_workflow.mjs');
 const watch=await auditCodexWorkflow((await reviewAuditFixture(t)).run);
 assert.equal(watch.status,'complete');assert.equal(watch.review_tasks.by_kind.watch,1);
 assert.deepEqual(watch.review_tasks.open_blocking_ids,[]);
 assert.equal(watch.review_tasks.workers[0].model,'actual-model');
 const blocking=await auditCodexWorkflow((await reviewAuditFixture(t,{kind:'blocking'})).run);
 assert.equal(blocking.status,'incomplete');assert.deepEqual(blocking.review_tasks.open_blocking_ids,['RT-000001']);
 assert.equal(blocking.review_tasks.budget.valid_reviews,1);
});

test('audit reports missing proof and actual execution metadata without repairing displays or human report',async t=>{
 const {auditCodexWorkflow}=await import('../../tools/audit_codex_workflow.mjs');
 const {readFile}=await import('node:fs/promises');
 const {run}=await reviewAuditFixture(t);
 const ledger=join(run,'.codex-workflow/review/ledger.json');await rm(ledger);
 await rm(join(run,'.codex-workflow/agents/stage-1/execution.json'));
 let audit=await auditCodexWorkflow(run);
 assert.equal(audit.status,'incomplete');assert.ok(audit.findings.some(f=>f.code==='review-display-missing'));
 assert.ok(audit.findings.some(f=>f.code==='review-execution-missing'));
 await assert.rejects(readFile(ledger),{code:'ENOENT'});
 const human=Buffer.from('人工修改，审计不能覆盖');await writeFile(join(run,'report.md'),human);
 audit=await auditCodexWorkflow(run);
 assert.ok(audit.findings.some(f=>f.code==='review-display-conflict'));
 assert.deepEqual(await readFile(join(run,'report.md')),human);
 await assert.rejects(readFile(ledger),{code:'ENOENT'});
 await rm(join(run,'.codex-workflow/review/HEAD.json'));
 audit=await auditCodexWorkflow(run);assert.ok(audit.findings.some(f=>f.code==='review-proof-missing'));
});

test('audit explicitly reports missing receipt and corrupt immutable proof without trusting display pass',async t=>{
 const {auditCodexWorkflow}=await import('../../tools/audit_codex_workflow.mjs')
 const {readFile,chmod}=await import('node:fs/promises')
 const {run,store}=await reviewAuditFixture(t)
 const state=await store.read(),receipt=join(run,'.codex-workflow/review',state.commit.refs.receipt.path)
 await rm(receipt)
 const audit=await auditCodexWorkflow(run)
 assert.equal(audit.status,'incomplete');assert.ok(audit.findings.some(f=>f.code==='review-proof-invalid'&&/missing immutable/.test(f.message)))
 assert.equal(JSON.parse(await readFile(join(run,'成稿审查.json'))).verdict,'pass')
});

test('audit distinguishes pending independent review after legitimate host patch from tampered physical evidence',async t=>{
 const {auditCodexWorkflow}=await import('../../tools/audit_codex_workflow.mjs')
 const {readFile}=await import('node:fs/promises')
 const {markAwaitingReview}=await import('../../tools/codex_workflow/review-ledger.mjs')
 const {sha256}=await import('../../tools/codex_workflow/review-contracts.mjs')
 const {run,store}=await reviewAuditFixture(t,{kind:'blocking'})
 let state=await store.read()
 state=await store.beginAttempt({taskIds:['RT-000001'],snapshot:state.snapshot})
 const reportBytes=Buffer.from((await readFile(join(run,'report.md'),'utf8')).replace('现金流依赖回款。','现金流依赖回款。修复限制。'))
 const snapshot={...state.snapshot,report_sha256:sha256(reportBytes)}
 const ledger=markAwaitingReview({ledger:state.ledger,taskIds:['RT-000001'],snapshot,attemptId:state.attempt.id})
 await store.checkpointAttempt({attemptId:state.attempt.id,taskId:'RT-000001',result:{status:'applied',task_ids:['RT-000001']},reportBytes,ledger,evidence:await (await import('../../tools/codex_workflow/review-evidence.mjs')).snapshotEvidence({runDir:run})})
 const head=await readFile(join(run,'.codex-workflow/review/HEAD.json')),report=await readFile(join(run,'report.md'))
 let audit=await auditCodexWorkflow(run)
 assert.ok(audit.findings.some(f=>f.code==='review-pending-rereview'))
 assert.ok(!audit.findings.some(f=>f.code==='review-evidence-invalid'))
 assert.deepEqual(await readFile(join(run,'.codex-workflow/review/HEAD.json')),head)
 assert.deepEqual(await readFile(join(run,'report.md')),report)
 await writeFile(join(run,'findings/财务排雷.md'),'tampered evidence')
 audit=await auditCodexWorkflow(run)
 assert.ok(audit.findings.some(f=>f.code==='review-evidence-invalid'))
 assert.deepEqual(await readFile(join(run,'.codex-workflow/review/HEAD.json')),head)
})
