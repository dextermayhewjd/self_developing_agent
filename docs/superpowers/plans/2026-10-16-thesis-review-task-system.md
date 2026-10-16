# 判断稿审查任务系统 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把独立审查发现的问题交给具有必要上下文的轻量 Codex worker，并由 host 安全应用、独立复核和恢复，沿用当前 CLI 入口。

**Architecture:** 保留确定性 Node 编排器和研究流程；成稿后的循环移到 host 协调层。文件 ledger 保存任务，HEAD 指向完整事务，worker 只提案，完整独立审查决定关闭和放行。

**Tech Stack:** Node.js >=22、ES modules、现有 Ajv/schema/runtime/backend、Codex CLI、node:test；不新增服务、数据库或调度器。

**Spec:** [已确认设计](../specs/2026-10-16-thesis-review-task-system-design.md)。冲突以设计为准。

## Global Constraints

- 入口仍为现有 `$thesis-wf` 和 CLI，运行资源位于 `.codex`。
- 实现继续使用当前已隔离的 `sda-dev` linked worktree，不创建另一份工作树，不处理其他未提交修改。
- host 是 ledger 与候选报告的唯一应用者；审查员返回判断，修订 worker 返回提案。
- 首版按任务顺序派发、校验与应用，复用现有有界 runtime，不增加一套调度器。
- 首版局部包上限为 UTF-8 32 KiB、最多两个目标章节；不通过静默截断满足上限。
- 默认 low 推理强度，沿用当前模型和提供者；最终独立审查使用原审查阶段配置。
- 使用 read-only sandbox，移除 `--approve-for-me`，以 `--ask-for-approval never` 禁止提权请求；不回退扩大权限。
- 默认最多两轮修订，对应最多三次有效完整审查；绝对修订上限为 N 时，对应最多 N+1 次有效完整审查。
- `--review-max-rounds N` 为绝对上限；N 为正整数，上限 10，不允许小于已消耗轮数。
- 不自动改写先前 300209 报告与档案，不启动另一轮真实股票研究；业务识别、同业范围和成稿前写作规划留待下一批。

## Review Focus

1. 人工修改当前报告后恢复：保留原文件并报告冲突，不能用历史版本覆盖。（Task 2）
2. 多任务批次中断：不重复应用已完成补丁，不把半个批次送去复审。（Task 2、7）
3. 中文、CRLF、代码围栏及重复引文：按字节限制上下文，准确识别章节，拒绝歧义锚点。（Task 4）
4. PNG/PDF 被更换或转录尚未目视核验：失效的是证据授权，不能误报图片引文造假或跳过附件。（Task 3）
5. 已有初稿但没有档案/研究阶段未全部成功：恢复审查而不是重跑研究，且不能把旧状态当作零额度。（Task 6、7）

---

## 文件职责与共享合同

新增模块均放在 `tools/codex_workflow/`：`review-contracts.mjs` 定义模型输出合同；`review-ledger.mjs` 管任务流转；`review-store.mjs` 管版本事务、attempt 与恢复；`review-evidence.mjs` 管证据类型和摘要；`review-proposals.mjs` 管上下文和精确补丁；`review-coordinator.mjs` 管阶段和预算；`thesis-inputs.mjs` 管原始输入与派生登记。不得让模块反向依赖 CLI 入口。

统一字段：`report_sha256`、`evidence_sha256`、`input_ledger_sha256`、`output_ledger_sha256`。摘要均为小写 SHA-256；物理文件按原始字节计算，结构化对象采用固定键序列化。序列化函数 `canonicalJson(value): string` 与 `sha256(bytes): string` 由 `review-contracts.mjs` 导出，所有模块复用。

- `Snapshot = { report_sha256, evidence_sha256 }`。
- `Ledger = { version:2, next_task_number, tasks, budget, active_attempt_id, terminal_reason }`；budget 含 `max_rounds`、`used_rounds`、`valid_reviews` 与追加的扩额记录。
- `Task` 使用设计第 5 节字段；`acceptance_criteria`、`locations`、`evidence_refs` 为数组；位置含 `section:1..12`；历史只追加。
- `Review` 保留十二节、五路 coverage 和完整 `reviewed_sources`，增加 `version:2`、`review_id`、Snapshot、`input_ledger_sha256`、`new_issues`、`task_dispositions`、`visual_attestations`。review_id 由 host 在调用前分配，worker 必须回传原值。新问题含本次唯一 `issue_key`、Task 除 host ID/历史/状态以外的必填字段，并关联章节/coverage，host 才分配 RT ID；旧任务处置 `{task_id,status:'open'|'resolved',reason,kind,blocks_delivery}` 必须唯一覆盖全部旧 ID，kind/blocks_delivery 改动须说明理由。
- `Receipt = { review_id, report_sha256, evidence_sha256, input_ledger_sha256, output_ledger_sha256 }`；归档后不可修改。原始 Review 不输出自由文字 blocking_issues；兼容 `成稿审查.json` 的该字段由 host 根据入账后的未解决阻断任务生成，且不能冒充另一份原始审查。
- `Proposal` 采用设计第 6 节字段；`acceptance_checks` 为 `{task_id,criterion_index,response}[]`，须覆盖每个验收条件；`evidence_refs` 标明来源和快照，不接受 worker 的“已关闭”状态。
- `EvidenceManifest = { version:2, sources, sha256 }`；source 含 `path`、`type`、原始字节 `sha256` 与可选 `transcript`、`pdf_origin`。转录保存在 review 控制目录；目视 attestations 放在 Review，不能混入证据摘要造成循环。
- `Attempt = { id, state, task_ids, cursor, base_snapshot, current_snapshot, results }`；state 为 `collecting|applying|finalized|reviewing`。固定顺序、预算预留、任务结果与当前版本在同一已提交状态中恢复。

测试可扩展 `tests/codex_workflow/fixtures/review-fixture.mjs`；新 fixture 和旧格式 fixture 分开命名，不默默把旧审查转换成可信 v2。每项先记录失败输出，再实现，再运行拥有该改动的测试。提交前检查暂存 diff，仅提交本项新增文件/改动；已有修改按 hunk 处理，不能 `git add .`。

### Task 1: 结构化合同与任务状态机

**Files:** Create `tools/codex_workflow/review-contracts.mjs`, `tools/codex_workflow/review-ledger.mjs`; Create `tests/codex_workflow/review-ledger.test.mjs`; Modify `tests/codex_workflow/fixtures/review-fixture.mjs`。

**Interfaces:** 导出 `REVIEW_SCHEMA`、`PROPOSAL_SCHEMA`、`TRANSCRIPT_SCHEMA`、`canonicalJson`、`sha256`；`createLedger({maxRounds=2}): Ledger`；`reconcileReview({ledger,review,snapshot}): {ledger,receipt}`；`markAwaitingReview({ledger,taskIds,snapshot,attemptId}): Ledger`；`unresolvedBlockers(ledger): Task[]`。纯函数不写文件、不调用模型。

- [ ] **Step 1 — 写失败测试。** 断言首个 ID 为 `RT-000001`，同问题措辞变化保留 ID；worker 应用后状态是 `awaiting_review` 而非 `resolved`；独立处置才关闭，复发重开并保留历史。增加以下断言对应的测试：

  ```js
  assert.equal(createLedger({maxRounds:2}).budget.max_rounds, 2)
  assert.equal(unresolvedBlockers(watchOnlyLedger).length, 0)
  assert.throws(() => reconcileReview(missingOldIdCase), /missing.*RT-000001/)
  assert.throws(() => reconcileReview(duplicateIdCase), /duplicate/)
  assert.throws(() => reconcileReview(unexplainedDowngradeCase), /reason/)
  ```

  同时覆盖未知 ID、删除已关闭任务、disclosure 准确披露后可关闭、同一 issue_key 去重与相冲突问题定义拒绝、错误 Snapshot/ledger 绑定拒绝；验 schema 可经现有 `transportSchema` 转换。
- [ ] **Step 2 — 确认失败。** `node --test tests/codex_workflow/review-ledger.test.mjs`；预期新 API 缺失；排除 fixture/语法错误。
- [ ] **Step 3 — 实现上述导出。** host 单调分配 ID；类别变更需要独立理由；后续审查完整处置旧任务；`blocking_issues` 为派生显示值，verdict 与章节/coverage/阻断状态一致。
- [ ] **Step 4 — 验证。** 同一命令全部通过；同输入不得被 mutate；JSON schema 的枚举、required、additionalProperties 明确。
- [ ] **Step 5 — 提交。** 仅提交本任务合同、状态机和对应测试，提交信息 `feat: define thesis review task contracts`。

### Task 2: 版本事务、修订批次与崩溃恢复

**Files:** Create `tools/codex_workflow/review-store.mjs`, `tests/codex_workflow/review-store.test.mjs`。

**Interfaces:** 消费 Task 1 类型/摘要；`openReviewStore({runDir,maxRounds,emit,failpoint}): Promise<Store>`。Store 提供 `initialize({reportBytes,evidence})`、`recover()`、`read()`、`commitReview({review,ledger,receipt,evidence})`、`beginAttempt({taskIds,snapshot})`、`checkpointAttempt({attemptId,taskId,result,reportBytes,ledger,evidence})`、`finalizeAttempt({attemptId,reason})`、`setMaxRounds(value)`、`assertDeliverable({snapshot})`；异步返回已提交 `{ledger,snapshot,attempt,review,receipt,commit}`。failpoint 仅为可注入的 I/O 断点，无业务分支。

- [ ] **Step 1 — 写失败测试。** 实际临时目录模拟不可变对象、commit、HEAD 与 materialize 各断点；HEAD 前中断保留上一版本，HEAD 后恢复新版本，缺对象/错误 SHA 拒绝。人工稿不匹配前序和当前 SHA 时保持原字节并报冲突。断言两任务首项完成后恢复 `cursor===1`，首项不重用，`used_rounds===1`；默认额度用尽后 reopen 仍为 2，显式扩到 3 只记一次，3 次修订最多 4 次有效审查。pass 后任务/报告/来源变化均使放行失败。
- [ ] **Step 2 — 确认失败。** `node --test tests/codex_workflow/review-store.test.mjs`；预期 Store 接口不存在。
- [ ] **Step 3 — 实现 Store。** 复用外层 run lock；遵守设计的不可变对象→commit→原子 HEAD→兼容入口顺序。commit 保存完整摘要引用、前序 commit、attempt 快照。先预留预算再派单；业务无进展终止保留明确原因。`assertDeliverable` 检查 receipt 输出 ledger、当前 Snapshot、最新独立 pass 与零阻断，不能用审查输入 ledger SHA 匹配输出。
- [ ] **Step 4 — 验证。** 上述测试及 `node --test tests/codex_workflow/state.test.mjs` 通过，所有恢复断点不丢任务、不覆盖人工稿。
- [ ] **Step 5 — 提交。** 本模块与测试；`feat: persist review versions and resumable attempts`。

### Task 3: 有类型的证据快照与图片核验链

**Files:** Create `tools/codex_workflow/review-evidence.mjs`, `tests/codex_workflow/review-evidence.test.mjs`; Modify `tools/check_thesis_review.mjs`, `tests/codex_workflow/review.test.mjs`。

**Interfaces:** `snapshotEvidence({runDir,transcripts=[]}): Promise<EvidenceManifest>`；`prepareEvidence({runDir,runtime,store}): Promise<EvidenceManifest>`；`validateEvidenceQuotes({runDir,review,manifest}): Promise<void>`。导出 `validateReviewRecord({runDir,review,manifest,inputLedger})` 校验原始结果但不授权交付；保留 `validateThesisReview(runDir)` 作为最新交付证明入口，返回经 Task 2 完整绑定验证的 v2 审查。

- [ ] **Step 1 — 写失败测试。** PNG 含非 UTF-8 字节，断言 SHA 等于 `sha256(originalBuffer)`；带有效双摘要目视记录的真实转录引文通过；缺转录返回明确待补状态，未核验转录拒绝作为已核引文；换原图、转录或 PDF 任一字节即失效。纯图片不要求伪造 PDF 页码；有 PDF 来源须校验页序/印刷页映射。文本仍做逐字引用、完整来源和十二节/五路验证；未知类型、路径逃逸、symlink 和遗漏附件明确拒绝。
- [ ] **Step 2 — 确认失败。** `node --test tests/codex_workflow/review-evidence.test.mjs tests/codex_workflow/review.test.mjs`；保留当前 PNG 被按文本匹配的复现。
- [ ] **Step 3 — 实现证据 API。** 缺转录时通过 `TRANSCRIPT_SCHEMA` 提取候选并归档；完整审查获得原图和候选，视觉核对记录绑定两者 SHA。PDF 先用现有本地工具产生带出处的文本/页图视图，仍保留原件摘要；工具失败或类型未支持时停止并说明缺口，不跳过。来源摘要不包含审查状态。legacy 结果可诊断，不能以旧 pass 授权新交付；v2 依赖 Store 证明。
- [ ] **Step 4 — 验证。** 上述命令全部通过；冻结 300209 的 PNG 案例在临时目录重放，区分“缺视觉核验”与“引文不在转录”，不改历史文件。
- [ ] **Step 5 — 提交。** 证据适配、checker 与对应测试；`fix: bind thesis reviews to typed evidence snapshots`。

### Task 4: 必要上下文包与 host 精确补丁

**Files:** Create `tools/codex_workflow/review-proposals.mjs`, `tests/codex_workflow/review-proposals.test.mjs`。

**Interfaces:** 消费 Task 1/3；`buildTaskContext({reportBytes,task,ledger,evidence,sourceTexts}): {route,context,context_bytes,reason}`；`buildFullRevisionContext({reportBytes,tasks,ledger,evidence,sourceTexts}): object`；`applyProposal({reportBytes,proposal,taskIds,allowedSections,snapshot,ledger}): {reportBytes,applications}`。均不写文件；context 内联原文，保留来源路径/哈希及验收条件。

- [ ] **Step 1 — 写失败测试。** 中文上下文按 `Buffer.byteLength(JSON.stringify(context),'utf8')` 计数；32 KiB 边界以内且最多两节才 local；超过边界不截断。第 11/12 节、承重假设/估值锚/概率/市值区间、三节联动、未明确范围、证据冲突均升级；缺证据走 `needs_evidence`。期间、单位、正负号及“不确定/未披露”等原文不丢失。CRLF/围栏内伪标题不误分节；其他节的重复文本不能充当本节锚点。同节重锚、空 before、重叠、越界、过期 report/evidence、缺验收响应和未知任务均拒绝，原输入字节不变。
- [ ] **Step 2 — 确认失败。** `node --test tests/codex_workflow/review-proposals.test.mjs`。
- [ ] **Step 3 — 实现 API。** 局部包含完整目标章节、必要邻段、任务引用证据完整段落及报告约束原文；无法确定必要范围时升级，不由 host 编造财务摘要。补丁按指定章节唯一精确锚应用，保持十二节有序；full revision 解除局部大小/节数限制，但保持精确锚、版本和 host 单写约束。
- [ ] **Step 4 — 验证。** 同一命令通过，正常补丁只改变预期字节；合法 `needs_evidence|escalate` 不抛运行异常，不假装已应用。
- [ ] **Step 5 — 提交。** 上下文/补丁模块与测试；`feat: build bounded task contexts and validate proposals`。

### Task 5: 只读 proposal worker 与冻结配置

**Files:** Modify `tools/codex_workflow/backend.mjs`, `tools/codex_workflow/config.mjs`, `tests/codex_workflow/backend.test.mjs`, `tests/codex_workflow/config.test.mjs`, `tests/codex_workflow/fixtures/fake-codex.mjs`。

**Interfaces:** 现有 `runtime.agent(prompt,options)` 增加 `options.contract='proposal'`；模型输出仍直接解码为 `Proposal`。同一中性只读执行模式也服务转录提取与完整独立审查，用 `options.contract='evidence_extract'|'review'` 选择专用前言；`options.images` 为 host 核准的绝对图片路径数组。新增基础阶段 `问题修订`、`证据转录`；`问题修订:RT-000001:A-0001` 用现有 prefix 机制解析基础阶段，不允许任意动态键进入配置。

- [ ] **Step 1 — 写失败测试。** 捕获真实 backend 构造的 argv/stdin：read-only、never、neutral cwd、禁项目技能/项目文档、web disabled、agents disabled，且没有 approve-for-me、全文写文件指令或项目 prelude。CLI 的 output-last-message 路径由 host 给出；图片通过 `--image` 传入；unsupported 模式不降权重试。日志包含实际 contract/sandbox/model/effort，临时 cwd 在成功与失败都清理。断言动态任务默认 low，CLI > 明确阶段 > options > defaults；review 不被 local 默认 low 覆盖，未支持 low 明确报错。
- [ ] **Step 2 — 确认失败。** `node --test tests/codex_workflow/backend.test.mjs tests/codex_workflow/config.test.mjs`。
- [ ] **Step 3 — 实现 contract 分支与配置。** 复用现有 blind 的上下文隔离和技能库存完整性检查，保留 provider/auth；不用 blind 的 workspace-write 参数。局部协调调用传 `effort:'low'`，完整修订继续用原 `修订成稿` 配置，最终审查用 `成稿审查` 配置；所有调用保留进程注册、唯一日志目录和 schema 重试。
- [ ] **Step 4 — 验证。** 上述测试通过，普通研究和现有 blind 行为回归通过；准确描述为上下文隔离，不能声称读取 ACL 或完整网络隔离。
- [ ] **Step 5 — 提交。** 仅本任务后端/配置改动及测试；`feat: run proposal workers in read-only Codex contexts`。

### Task 6: 原始输入清单、派生登记与旧状态诊断

**Files:** Create `tools/codex_workflow/thesis-inputs.mjs`, `tests/codex_workflow/thesis-inputs.test.mjs`; Modify `tools/run_codex_workflow.mjs`, `tools/codex_workflow/state.mjs`, `tests/codex_workflow/cli.test.mjs`, `tests/codex_workflow/state.test.mjs`。

**Interfaces:** `resolveThesisInputManifest({root,symbol,previousManifest,derivedRegistry}): Promise<{version,originals,derived,unclassified}>`；`diagnoseLegacyReviewState({runDir,inputManifest}): Promise<{migratable,reasons,usedRounds,proofs}>`；`workflowFingerprint(root,name,args,config,{inputManifest}={})` 保持返回摘要字符串。持久清单位于 `.codex-workflow/input-manifest.json`，派生登记含路径、生成阶段和生成时摘要。

- [ ] **Step 1 — 写失败测试。** aggregate/原始年报任意字节变化改变签名；登记的同业计算、benchmark_peers、check_sources 不改变原始签名，但仍进入各自阶段依赖摘要；新未分类文件明确列出路径并拒绝复用；方法变化仍失效。旧 v1 缺来源证明或额度记录时只读诊断失败，原 fingerprint/文件不改；证据完整可重建额度才迁移。reset 整体归档旧 review store；普通恢复不能由 stage artifact 回滚当前已提交报告。
- [ ] **Step 2 — 确认失败。** `node --test tests/codex_workflow/thesis-inputs.test.mjs tests/codex_workflow/state.test.mjs tests/codex_workflow/cli.test.mjs`。
- [ ] **Step 3 — 实现。** 锁内 prepareData 后、fingerprint 前分类快照。依据现有 pipeline 明确原始文件合同，aggregate 仍算研究原始输入；禁止将整个 data 排除。成稿阶段写独立 `初稿.md`，stage 缓存/回滚仅拥有初稿，review Store 接管 `report.md`，后续 host 状态不受普通 stage succeeded/失败清理支配。旧调用缺 v2 元数据应诊断而非默默初始化零预算。
- [ ] **Step 4 — 验证。** 上述测试通过；冻结 300209 数据复制到临时目录，仅加入已登记派生产物时可继续；增原始输入或改方法明确阻止旧复用。
- [ ] **Step 5 — 提交。** 原始输入/恢复改动及测试；`fix: separate thesis inputs from derived workflow state`。

### Task 7: host 协调循环与 CLI/交付整合

**Files:** Create `tools/codex_workflow/review-coordinator.mjs`, `tests/codex_workflow/review-coordinator.test.mjs`; Modify `.codex/workflows/equity-thesis.mjs`, `tools/codex_workflow/thesis.mjs`, `tools/run_codex_workflow.mjs`, `tests/codex_workflow/thesis.test.mjs`, `tests/codex_workflow/cli.test.mjs`, `tests/codex_workflow/review.test.mjs`。

**Interfaces:** `coordinateThesisReview({root,args,runtime,store,reason='initial',signal,emit}): Promise<{review,receipt,ledgerPath,snapshot}>`；`reviewStages` 导出供 `--check` 静态校验的 `{label,phase,schema}[]`。`runThesis` 增可注入 `coordinateReview`、`reviewStore`、`reviewMaxRounds`；CLI config 增 `reviewMaxRounds` 与 `provided['review-max-rounds']`，不放入研究 args/fingerprint。

- [ ] **Step 1 — 写失败测试。** fake backend 完成“审查 → 两个稳定任务 → 顺序局部提案 → host 应用 → 一次独立全审 → pass”，断言只用一轮修订，复审读取全文、全部底稿与全部旧 ID；新问题可新增，worker 自评不能关闭。mid-batch 重启只执行第二项，不提前复审；schema/传输重试不算有效语义轮次；needs_evidence 无可执行编辑时落检查点而非反复全审。已有候选/无档案的 `review_only` 研究调用数为 0；当前 receipt 仍有效的重复交付不重复消耗语义审查数。CLI 测 2 默认、1/10 可用、0/11/小数/小于已用拒绝、恢复沿用和显式扩额不重置。review/证据失效、硬门最终失败或 PDF 转换失败后，既有档案/PDF 的 SHA 保持原值；遇并发人工编辑则保留人工文件并报冲突。
- [ ] **Step 2 — 确认失败。** `node --test tests/codex_workflow/review-coordinator.test.mjs tests/codex_workflow/thesis.test.mjs tests/codex_workflow/cli.test.mjs tests/codex_workflow/review.test.mjs`。
- [ ] **Step 3 — 实现协调状态机。** 完整独立审查→validateReviewRecord→reconcile→Store commit；有阻断则持久预留 attempt，按固定顺序建 context/调用/归档/验证应用/检查点；批次 finalized 后才完整复核。局部升级交完整修订提案，缺证据保留限制。复用当前 runtime；静态阶段导出覆盖所有 schema，但 `--check` 不创建 Store、不读真实数据、不调用模型。
- [ ] **Step 4 — 接入现有链路。** research workflow 删除内联 reviewManuscript，仅研究与写 `初稿.md`；host 在初稿后 initialize，resume/reuse/review_only 调用同一协调层。区分候选就绪与交付就绪，不以 position 或 state.canReuse 迫使重跑研究。报告/底稿相关硬门修复也须走 host 提案和同一修订额度；若需修改证据而提案合同不足，明确 needs_evidence，不让 worker 直接改底稿。纯档案修复可沿用档案阶段；纯 PDF 重试不耗语义预算。交付过程记录旧档案/PDF 的备份与 host 本次写入 SHA，失败仅回滚仍匹配本次写入 SHA 的文件，不能覆盖人工编辑；恢复也执行相同所有权检查。交付前再次验证当前 receipt/Snapshot，候选与旧交付分别保存。
- [ ] **Step 5 — 验证。** Step 2 命令全部通过；随后 `npm test`，失败按名称定位修正；三条 workflow 的 `--check` 均显示 `model_calls:0` 且不写真实产物。
- [ ] **Step 6 — 提交。** 协调器、流程入口与测试；`feat: coordinate thesis review tasks and guarded delivery`。

### Task 8: 可观察性、原生合同、流程图与真实小探针

**Files:** Modify `tools/audit_codex_workflow.mjs`, `tests/codex_workflow/audit.test.mjs`, `README.md`, `docs/codex-workflow.md`, `.codex/skills/equity-thesis-cn/{orchestration,writing_contract}.md`, `.codex/skills/thesis-wf/SKILL.md`, `.codex/skills/debug-equity-thesis/SKILL.md`, `docs/diagrams/thesis-workflow/thesis-workflow-change-map.{drawio,svg,png,pdf}`; Create `tools/probe_thesis_review_task.mjs`, `tests/codex_workflow/review-probe.test.mjs`, `debug/thesis_review_task_probe_20261016/summary.md`（实际日志置同目录，不提交凭据或大体积 rollout）。

**Interfaces:** `auditCodexWorkflow` 增 `review_tasks` 摘要：分类/状态计数、未关闭阻断 ID、当前报告/证据/receipt 绑定、attempt/额度/终止原因、实际轻量 worker model/effort/context_bytes。probe CLI 支持 `--output-dir`，默认创建临时虚构 run，调用生产 coordinator/backend，不允许接收真实 symbol。

- [ ] **Step 1 — 写失败测试。** 审计器对 stage succeeded 但 open blocking 判 incomplete，open watch 不误阻断，缺 ledger/receipt/实际配置明确标缺证；probe fake backend 产出一条可追溯提案，经 host 应用和另一调用独立审查通过，保留实际执行元数据。probe 只接虚构 fixture，不能覆盖真实 run。
- [ ] **Step 2 — 确认失败。** `node --test tests/codex_workflow/audit.test.mjs tests/codex_workflow/review-probe.test.mjs`。
- [ ] **Step 3 — 实现审计与 probe。** 读取 Store 证明而非按阶段成功数推测质量；真实 probe 使用一个虚构局部遗漏、low proposal worker 和独立 reviewer，记录实际模型/effort/UTF-8 字节数/只读参数/输出及 receipt。不替真实研究作质量声明。若 CLI 探针失败，保留日志并定位真实原因，不能以 fake pass 代替。
- [ ] **Step 4 — 更新合同与图。** 按 `writing-skills` 复核技能改动。单张上下流程图沿用蓝=保留、橙=修改、绿=新增，明确标注本批已实施审查任务区与后续研究建议；draw.io/SVG/PNG/PDF 内容同步。说明 CLI 续跑、扩额、needs_evidence、旧状态诊断及证据核验边界。
- [ ] **Step 5 — 最终验证与独立审查。** `npm test`；`node tools/check_codex_native.mjs`；三条 `--check`；`node tools/probe_thesis_review_task.mjs --output-dir debug/thesis_review_task_probe_20261016`。检查图 XML、PNG、PDF 可打开；独立 reviewer 对最终任务改动做 spec/quality 审查，修正后只重跑覆盖改动的检查。记录真实探针与冻结回放的证据，不引用旧测试计数冒充本批结果。
- [ ] **Step 6 — 提交与交付。** 只提交本任务文件/改动，`docs: document and verify thesis review task workflow`。不 merge/push，不启动真实股票研究；交付说明已实现链路、验证结果、当前 CLI 用法和仍在下一批的研究改动。

## 实施顺序与完成条件

按 1→2→3→4→5→6→7→8 实施；每项 TDD、自查后由独立 reviewer 检查 spec 与质量，再推进依赖项。实施子 agent 获得该任务 brief、相关接口和必要文件，不继承完整会话，也不自行派发额外 reviewer。保留持久实施 ledger，防止压缩上下文后重做。

完成须同时满足：最新完整独立审查才可关闭任务；host 唯一写报告；额度/批次/提交可恢复；图片引文链验证明确；CLI 真实合成探针有日志；全量 Node 与原生检查通过；原报告/档案完整性保持。fake pass、页数增长和阶段数不构成真实研究验收。

## 计划自查记录

设计 1–7 节对应 Tasks 1/2/4/5/7；证据合同对应 Task 3；轮次和恢复对应 Tasks 2/6/7；原生集成及交付对应 Tasks 6–8；冻结回放和真实探针对应 Tasks 3/6/8。Review Focus 五项已落实到各任务失败测试；跨任务统一使用相同 Snapshot/ledger/receipt 字段及接口。尚未修改产品代码或执行真实研究。
