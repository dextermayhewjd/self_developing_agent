# 审查任务系统实施记录（2026-10-16）

本批实现稳定 RT 任务、Store 不可变版本与 receipt、二进制证据授权、精确 host 补丁、累计轮次与固定批次恢复、原始输入分类及暂存交付。原生入口仍为 $thesis-wf / CLI，运行资源位于 .codex，不依赖 .claude。业务识别、同业范围和写作前规划留待后续；没有启动新的真实股票研究。

Task 8 最终代码已通过下列验证；真实合成探针分次记录，最终独立审查由 controller 执行。工作树包含迁移前已有 dirty/untracked 文件，这些保持未暂存；任务 commit 不是完整迁移快照。

## 已观察到的验证

- backend/config RED：40 项，30 pass / 10 fail，复现旧功能开关无效与 skills/list 未校验 cwd/errors/shape；GREEN 40/40。
- audit RED：9 项，7 pass / 2 fail，复现缺 v2 任务摘要与缺显示文件仍报完整；audit + Store GREEN 57/57。
- probe RED：audit+probe 11 项，9 pass / 2 fail（模块尚未实现）；GREEN 11/11。外部进程 fixture 仅替换模型响应，其余生产 coordinator/backend/Store/精确补丁/receipt 真实执行。
- 最终 `npm test`：299/299、零失败/跳过，exit0，33.92秒（`npm-test-ultimate.tap`）。最终 probe 进程测试5/5；前一阶段覆盖 ledger/coordinator/audit/backend/config 的 focused92/92。原生布局检查exit0；三条实际 CLI --check 均exit0 / model_calls:0。两条冻结回放exit0：图片授权/转录引用边界与11个原始输入 SHA 均验证，未创建旧报告交付凭据。
- 图 drawio/SVG 可解析，单图40节点46边；PNG1440×3170，PDF1页且 CJK 字体嵌入，实际打开渲染并目视检查。六项受保护 report/position/PDF 的原始 SHA 全部未变。Python 无改动，沿用 Task 7b 已记录的项目虚拟环境175项结果，不冒充本批重跑。

## 操作与边界

累计扩额：用原代码/日期重跑，追加 --review-max-rounds 3 表示从首次起总共三轮；省略保留既有额度。已有候选和原始清单时直接恢复审查/交付；review_only 可由 args JSON 显式要求，缺候选拒绝。needs_evidence/no_safe_edit 保留未决；旧 v1 只诊断，无自动导入。人工改稿、证据替换均保留原字节并报冲突，本批无自动采用入口。

auditCodexWorkflow 通过纯 inspectReviewStore 验证 HEAD/object/hash/receipt 与显示差异，不 recover/materialize。正常运行与 check_thesis_review 的恢复行为保留。skills/list 完整标志验证请求 cwd、entry.errors 与数组/绝对路径；它不构成 OS ACL 或对后装插件的承诺。共享隔离工作进程关闭 features.multi_agent 与 features.multi_agent_v2，普通工作进程配置保持。

真实小探针命令：node tools/probe_thesis_review_task.mjs --output-dir debug/thesis_review_task_probe_20261016。它只建虚构 SYNTHETIC fixture，拒绝 symbol 和已有目录；真实失败保留日志，不用模拟通过替代，不扩大生产只读权限。

图源：.superpowers/sdd/2026-10-16-thesis-review-task-system/create-thesis-change-map.mjs 与 thesis-change-map-injection.js；同步输出 docs/diagrams/thesis-workflow/thesis-workflow-change-map.{drawio,svg,png,pdf} 及 -model.json。蓝保留/橙修改/绿新增，另以节点文字区分本批与后续。

## 全部实施裁定与误判成本

以下逐行保留 progress.md 中全部 Ruling 原文与顺序。原记录未写成本者在此补充，属于实施者对风险的明确解释。

1. 原文：

> Ruling: Existing dirty/untracked migration files must remain outside new task commits. New clean files may be committed; changes to preexisting dirty files stay in working tree and are included in per-task snapshot diff packages. This preserves the user's unrelated edits while allowing complete code review; final report must not imply the task commits alone contain the entire current native migration.

若错，任务提交混入已有迁移或用户修改，无法安全审查或回退；因此完整交付还依赖工作树与快照，不能只检出本批 commit。

2. 原文：

> Ruling: One implementer at a time, independent fresh review after each task. Parallel delegation limited to read-only independent discovery/verification to avoid shared-state conflicts.

若错，串行实现可能延长耗时；并行写同一工作区会产生更高的状态冲突与审查失真风险。

3. 原文：

> Ruling: budget.review_ids and budget.extensions are append-only fields. Task-less reviews still need exactly-once review-ID accounting; reconcile owns valid_reviews, Store owns used_rounds. Input ledger hash precedes reconciliation; receipt output hash follows it.

若错，账本变大且事件归属需跨模块维护；漏计会超额或重复签收，须保留 exactly-once 回归。

4. 原文：

> Ruling: Task 7 delivery protection needs narrow CLI staging extensions: optional --position path on tools/check_thesis.py and --output path on tools/md_to_pdf.py (existing defaults preserved), plus a focused delivery journal module/tests if needed. This is necessary to know host-written SHA before canonical publication and safely recover late gate/PDF failures; do not let worker write canonical position/PDF. Existing dirty PDF edits remain preserved outside task commits.

若错，额外 journal 与暂存 CLI 增加维护成本；路径、receipt 或回滚归属出错会影响正式档案/PDF，需精确路径与 SHA 检查。

5. 原文：

> Ruling: Use one shared pure section parser for quote validation and patch scoping instead of duplicating the current checker regex. Task 3 may add review-sections.mjs exporting parseReportSections(reportText): [{section,start,end,text,heading}] (JS string offsets), including CRLF/fence handling and exactly 1..12 validation. Task 4 imports it for exact chapter ranges; add tests in owning evidence/proposal tests.

若错，共享 parser 会同时影响引文与补丁；严格十二节也可能拒绝旧稿，须保留 CRLF/围栏/歧义回归。

6. 原文：

> Ruling: Store checkpoint is a final outcome per fixed task/group. Intermediate escalation/rejection proposals are archived, then full revision handled before final checkpoint. Atomic group marks each member and advances cursor to first unfinished member; same finalized result replay idempotent, changed replay rejected.

若错，中间提案归档和组提交增加恢复复杂度；cursor/幂等错误会重复补丁或漏任务。

7. 原文：

> Ruling: A report-changing hard-gate failure after a semantic pass must become a host-registered technical task from the independent checker (stable RT ID, gate-origin history), without charging another full semantic review before repair. Task 7 may add registerGateIssue({ledger,feedback,snapshot,gateId}) to review-ledger.mjs and optional gateFeedback to coordinator; it invalidates old receipt, reserves same normal revision budget, then proposal -> full independent review -> gate. Never let host close the task or count the checker as a full semantic review. Pure position-only fixes leave report/task Snapshot unchanged.

若错，技术门的任务分类可能扩大语义预算消耗；不能把 checker 冒充完整审查或让 host 自关任务。

8. 原文：

> Ruling: Task 3 v2 delivery verifier must not be weakened for legacy controller mocks. Explicit v2 fixtures create real Store proofs and may reuse still-current receipts. Tests that directly overwrite report through a fake worker can become negative stale-proof/ownership tests; do not reset Store or simulate hidden host commits inside model fake merely to preserve obsolete positive expectations. Task 7 restores positive hard-gate repair coverage through actual host proposal/coordinator integration.

若错，旧测试需要重写、通过数短期下降；放松证明则会产生真实的旧 pass 授权新稿漏洞。

9. 原文：

> Ruling: Task7 is split into independently reviewed 7a (coordinator and gate task registration unit) and 7b (workflow/runner/thesis/delivery journal/Python staging integration). Same approved scope; sequential implementers. Task7 completes only after both gates.

若错，拆成 7a/7b 增加交接与独立审查成本；单侧通过不能宣称集成完成。

10. 原文：

> Ruling: Task4 may extend issue/task with optional judgment_constraints:[{section,quote}] (independently reviewed exact report quotations). Avoid unconditionally injecting full chapters1/11/12, which would force nearly all natural 30-page local tasks above32KiB. Builder expands exact relevant constraint paragraphs; absent/ambiguous necessary scope escalates, explicit[] states no cross-chapter constraints. Preserve full target chapters, source-wide limits and no silent truncation. Add realistic large unrelated-chapter regression. Task7 reviewer prompt must fill this optional field for locally routed issues.

若错，约束选择依赖独立 reviewer 正确识别相关判断；缺失/歧义必须升级，不能省掉必要跨节上下文。

11. 原文：

> Ruling: Task4 applyProposal default local mode restricts refs to selected-task reviewed refs; explicit full mode may accept additional current in-context sources with evidence/sourceTexts digest/transcript/exact-quote validation. No new/out-of-context sources, no missing selected task ref coverage. API exact option names documented by implementer for7a.

若错，full/local 两套引用规则增加校验负担；边界遗漏会接受上下文外来源或遗失必要引用。

12. 原文：

> Ruling: BOM physical-source mismatch fixed narrowly in shared evidence decoder with regression, rather than pure context byte reconstruction.

若错，共享 decoder 的 BOM 语义影响全部证据；必须按原始字节保留摘要并测试，不重建字节掩盖问题。

13. 原文：

> Ruling: Legacy diagnosis is read-only eligibility/proof reconstruction, with no automatic v1-to-v2 import in this batch — spec constrains any automatic import but does not mandate it, and Store deliberately has no trusted legacy-import API. Even eligible diagnoses require explicit future import; CLI refuses before preparation/state mutation and reports reconstructed rounds/final verdict. Cost if wrong: older runs need a separate audited import step rather than immediate continuation; this avoids silently minting new receipt or zero quota. Task7 must preserve this boundary.

原记录已列成本：旧运行需单独审计的导入步骤，不能立即继续；避免静默签新 receipt 或零额度。

14. 原文：

> Ruling: Task6 may change the initial writer to 初稿.md now, with a narrow host-only draft-to-report bridge solely while the old inline review path exists without a v2Store. Task7b removes that bridge together with inline review. Cost if wrong: transition integration needs rework; existing committed Store report must never be overwritten.

原记录已列成本：过渡集成可能返工；已提交 Store 报告必须始终不被覆盖。过渡桥已由 7b 删除。

15. 原文：

> Ruling: Coordinator may revalidate current evidence between patches using an internal evidence-only projection of the last immutable independent Review — retain complete source inventory/visual attestations/source quotations/all evidence refs, omit only historical report/location quotes. Current report legitimately differs after host patches; Store retains original raw-review/report/ledger proof. Projection must never be archived as raw Review, committed, re-signed, used to close tasks or authorize delivery; new full Review always receives raw validation. Cost if wrong: an incorrectly constructed projection could omit evidence checks, so regressions must prove source/attestation tampering still rejects and no projection authorizes pass.

原记录已列成本：投影若构造错误可能漏证据检查；保留原始证明并测试 source/attestation 篡改不能通过，投影不得授权 pass。

16. 原文：

> Ruling: Task8 must replace ineffective isolated-worker agents.enabled=false with locally verified features.multi_agent=false and features.multi_agent_v2=false — codex0.162.1 features list with oldflag reports multi_agent=true, both featureflags report false. Extend backend/tests in Task8 and verify effective values before realprobe; ordinary workers unchanged. Cost if wrong: older/different CLI may reject/ignore featurekeys, so currentCLI compatibility is explicitly tested and failures cannot trigger permission widening. No inference was run for this discovery.

原记录已列成本：不同/旧 CLI 可能拒绝或忽略键；本机有效值需实际验证，失败不能扩大权限。

17. 原文：

> Ruling: Task8 first real CLI probe is a behavioral RED: final reviewer emitted resolved kind=blocking with blocks_delivery=false and strict host validation correctly rejected it after a durable host patch. Clarify production reviewer prompt that resolution changes status, not kind/blocks_delivery; retain strict validators and untouched raw model response. Add real failure-summary observability regression, then perform one necessary full real retry in debug/thesis_review_task_probe_20261016_retry1; preserve first logs and link both results. Cost: one additional bounded synthetic initial-review/proposal/final-review sequence; no real-stock research, quota reset or permission widening.

误判成本：原文已明确额外真实调用与验证成本。若误把解决状态当作分类降级，会产生无效最终 Review；窄修提示并保持严格验证，重跑仍需真实模型调用，不能保证一次通过。

18. 原文：

> Ruling: Real retry1 independently described a chapter-3 omission using incidental review-process wording containing 全文, correctly triggering the conservative full-revision route instead of the synthetic probe target local-low route. Preserve that run and routing policy. Clarify only the fictional fixture issue description, keep full independent review coverage and conditional issue detection, then allow one fresh real retry2 if no unrelated failure is discovered. Cost: an additional bounded three-call synthetic sequence and a more explicit fixture prompt; this proves transport/host/task orchestration, not natural stock-task routing or research quality.

原文明确额外验证成本。若误判：把保守升级当成路由缺陷会扩大局部修订风险；只收紧合成问题描述会增加一次真实试验但保留生产边界，结果仍须实际验收。

## 三次真实合成 CLI 执行

1. [首次原始 summary](../../../debug/thesis_review_task_probe_20261016/summary.md)：exit1。实际初审→low提案→host应用→完整复审，gpt-6.1-sol/openai、xhigh/low/xhigh，context_bytes5718/3008/7831；最终模型返回 resolved/blocking/false，严格拒绝 `kind conflicts with blocks_delivery`，最终 receipt 无。原始 summary 不改；[独立只读诊断](../../../debug/thesis_review_task_probe_20261016/failure-inspection.json) 记录 host 补丁、1轮/1次有效审查和 prior_receipt，并绑定原始summary SHA。生产提示新增合法 resolved/blocking/true 示例，validator 保持严格。

2. [retry1 原始 summary](../../../debug/thesis_review_task_probe_20261016_retry1/summary.md)：exit1，仅因未命中 synthetic local-low 场景。真实完整审查已通过，1轮/2次有效审查，host 应用一次，当前合法 receipt 为 `RV-ae4e051a-662b-4d90-b991-0cd72c1454b6`；report SHA `6879f417065c3b1e0e30b9d3522510011a9dd9b758b768f6e3a6fb8afeec09ac`。任务描述夹带“全文”使既有保守 router 升级 full_revision，实际 xhigh/xhigh/xhigh、context5718/7690/8330。原始 summary 将场景失败与审查接受混用的措辞没有回写；[另存纯检查说明](../../../debug/thesis_review_task_probe_20261016_retry1/receipt-inspection.json) 实际验证当前物理证据、原始 Review、显示与 receipt 并说明差异。随后增加真实进程回归，修正未来 summary，router不变。

3. [retry2 最终真实 summary](../../../debug/thesis_review_task_probe_20261016_retry2/summary.md)：**exit0 / passed**。仅收紧虚构fixture的问题描述为第三节局部遗漏；十二节/五路/全部附件的独立审查要求、条件裁定、router与validator均保留。真实三次调用为 gpt-6.1-sol/openai、xhigh/low/xhigh；context_bytes7200/2925/8983，prompt_bytes8772/3502/10555。host 精确应用一次，报告由4784fb15…变为6879f417…（704字节），独立审查不接收提案自评，1轮/2次有效审查，RT-000001 resolved，无停止原因、无活跃批次。最终receipt如下，全部字节/证据与账本均由真实生产路径验证。

```json
{
  "evidence_sha256": "857a246dcd443f23b0436e5c7d90b6802d4083315d278f52f04af35ec8dc4a5e",
  "input_ledger_sha256": "86c224fdaafc6ffb6bf67c9fce72f663c0fd3acf95464474eb0f4052b51098e5",
  "output_ledger_sha256": "b2afdd9ee78f8f0d25a28a6eb33e7667d37007e1b17cb95ad85dac9022b877d1",
  "report_sha256": "6879f417065c3b1e0e30b9d3522510011a9dd9b758b768f6e3a6fb8afeec09ac",
  "review_id": "RV-f3fbff13-c310-4572-a00a-efa839c4cfe6"
}
```

三次均为 Codex CLI0.162.1，当前提供者/登录配置沿用；不换模型、不扩大权限。两项 multi_agent 有效值均为 false；技能库存为当次实际快照64，隔离worker禁用64项，但不声称 OS 读白名单或后装插件永久保证。原始日志保留在各自目录的 agents、fixture Store/exchanges、events.jsonl；任务快照保存 RED/GREEN 与真实命令输出。现金费用未由 CLI 提供，不能编造金额；实际 token 使用保留在 JSONL/events 中。

实际 CLI 累计用量（从各次原始 turn.completed 汇总，非估算费用）：

| 运行 | 调用数 | input_tokens | cached_input_tokens | output_tokens | reasoning_output_tokens |
|---|---:|---:|---:|---:|---:|
| 首次合同拒绝 | 3 | 42166 | 0 | 6183 | 1836 |
| retry1 full 路径 | 3 | 43973 | 0 | 6597 | 1722 |
| retry2 local-low 通过 | 3 | 43008 | 0 | 6200 | 2077 |

全部三次均只写全新虚构fixture，首次失败与第二次形态不符均保留原summary，不冒充通过。代码/测试最后修改后完整Node299/299；随后未改代码。最终审查由独立controller派发，相关结论以其报告为准。
