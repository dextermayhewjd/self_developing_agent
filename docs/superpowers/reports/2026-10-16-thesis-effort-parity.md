# Claude / Codex 判断稿强度对齐校正（2026-10-16）

本次移除局部修订 Proposal 自动指定 `effort: low` 的分支。局部修订仍是 UTF-8 最多 32 KiB、最多两个目标节的只读任务，由 host 校验并应用精确补丁，再由另一调用完整独立审查裁定。上下文有界不再意味着自动降低推理强度。

## 审计结论与映射

本次控制器只读核对了 Claude 工作流、当前设置及本机 Claude Code 2.1.293 的有效优先级：显式阶段 effort 存在时使用该值；其余阶段继承所选模型/会话设置。在已保存配置内，每模型 effort 优先于 legacy 根级 effort；显式环境、会话或权限设置仍可进一步覆盖。当前设置不能证明历史研究当时采用的 effort，三个历史样本没有记录该字段。

| 范围 | 核对结果 / 本次处理 |
| --- | --- |
| Claude thesis `盘点` | 显式 low；Codex 原有相应提示保留 |
| Claude peer `盘点`、`读配置` | 显式 low；Codex 原有相应提示保留 |
| Claude 其余实质研究、修订、审查阶段 | 无额外阶段 effort，继承模型/会话设置 |
| 当前 Claude 保存设置 | Opus 5/5.5 为 xhigh，当前选中的 Fable 5.1 为 high；根级 legacy xhigh 不覆盖每模型设置 |
| 当前 Codex 只读解析 | CLI 0.162.1，gpt-6.1-sol / openai / xhigh；无 CLI 或阶段覆盖 |
| 本次 Codex 映射 | 移除自动局部 low，继承阶段的冻结解析结果；用户明确选择对齐 Opus 研究基线 xhigh；保留原本已为 xhigh 的 Codex 有效默认，无须改写任何用户全局设置。Fable high 单列为当前 Claude 保存设置 |

Codex 运行时没有新增 `.claude` 依赖。没有增加模型选择器、跨平台配置读取或全阶段 `--effort` 强制覆盖。模型和 effort 仍分别按 CLI → 完整阶段/同类前缀 → 脚本提示 → 文件 default → 冻结有效默认解析；切换模型且未指定强度时使用该模型目录默认值。

所选 Opus xhigh 基线适用于继承强度的实质阶段；上述 helper 显式 low 保留，不以统一 CLI effort 覆盖它们。局部、完整修订和独立审查分别使用合法阶段名 `问题修订`、`修订成稿`、`成稿审查`。例如冻结默认 xhigh、无其他覆盖/default 时三者均为 xhigh；显式 `stages.问题修订.effort=high` 只改变局部提案，审查仍为 xhigh。统一 CLI 覆盖仍优先。

## 代码与回归

- `tools/codex_workflow/review-coordinator.mjs`：exchange 不再因为 local 路径注入 low，并删除多余的 local 参数。任务路由、预算、上下文边界、host 应用和 receipt 校验不变。
- `tools/probe_thesis_review_task.mjs`：以实际 `问题修订:` 标签、attempt 的 `local_patch` 结果和 32 KiB 上下文边界证明局部路线；以冻结 resolver 校验实际 worker 的 model、effort、provider。完整路线即使用同样 effort，也不能冒充局部路线；合法完整路线 receipt 仍保留。
- 真实 coordinator → runtime → backend → 子进程 fixture → Store 测试覆盖继承 xhigh、只支持 xhigh 不支持 low 的模型、单阶段 high 覆盖，以及局部切换模型的目录默认 high；断言独立的字面期望与子进程收到的实际 argv。保留独立审查、host 补丁、只读、日志与 receipt 断言。
- 三份当前指南、README 和单张 change map 同步；40 个节点、46 条边、颜色和已实施/后续建议拓扑完全保留。历史设计/计划/实施记录只追加日期校正链接，原始真实探针摘要没有重写。

## 验证证据

所有原始日志保存在 `.superpowers/sdd/2026-10-16-thesis-effort-parity/snapshots/effort-parity/`。

1. RED：`node --test tests/codex_workflow/review-probe.test.mjs tests/codex_workflow/review-coordinator.test.mjs`，33 tests / 28 pass / 5 fail。实际失败分别包括强制 low、xhigh-only 模型被不支持的 low 阻断、显式 high 已执行却被探针误判，以及另一个模型的默认强度被 low 阻断（`red.tap`）。
2. GREEN：加入 config/backend 的相同范围为 73/73（`green.tap`）。增加真实 argv 断言后的一次测试数据遗漏导致 72/73，缺的是 alternate-model case 的预期 model 字段，生产行为正确；补齐该字段后的最终相同命令为 73/73、零失败/跳过（`focused-ultimate.tap`；中间结果完整保留于 `focused-final.tap`）。
3. 最终 `npm test`：329 tests / 329 pass / 0 fail / 0 skip，exit 0，36.79s（`npm-test.tap`），仅跑一次全量。`node tools/check_codex_native.mjs` exit 0；以下三条实际静态命令均 exit 0、model_calls=0：`node tools/run_codex_workflow.mjs equity-thesis --symbol 000001 --date 20261016 --check`；`node tools/run_codex_workflow.mjs peer-comparability --args-file /tmp/task7b-check-peers.json --check`；`node tools/run_codex_workflow.mjs calibrate-equity-thesis --date 20261016 --check`（对应 `native-check.json`、`check-equity.json`、`check-peer.json`、`check-calibrate.json`）。本次没有重跑未改动的 Python 套件。
4. 指南由控制器做独立 reference-only RED/GREEN 阅读；旧文档误答局部 low 并遗漏辅助强度/合法标签，新文档正确答继承及覆盖，且指出文件 default 的适用条件（任务目录 `guide-baseline.md`、`guide-green.md`）。
5. change-map model 与基线只差修订节点的一行强度标签；drawio/SVG XML 可解析，PNG 1440×3170，PDF 单页 1080×2377.5pt，嵌入 NotoSansCJKsc regular/bold，渲染后目视检查文字可读。六份受保护的报告、PDF、档案 hash 均未改变。
6. 独立审查已通过需求符合性与代码质量两项检查，没有 Critical、Important 或 Minor 发现；同时核对冻结配置解析、指南和 PNG/PDF 图示。审查记录为任务目录 `review-report.md`，未重复运行测试或真实推理。

## 历史与范围边界

[上一批实施记录](2026-10-16-thesis-review-task-system-implementation.md) 中实际 `xhigh/low/xhigh` 是当时真实运行的历史证据；本次保留原值，不宣称它已经使用新的继承规则。本次实际模型调用 0 次、真实股票研究 0 次；process fixture 验证接口/调度/证明，不证明真实研究质量，也不证明所有模型的跨平台同名 effort 计算量等价。生产 worker 的只读/审批参数保持原样。

本次原先干净的源码、测试、新审计记录及历史文档追加说明分批提交；现有 dirty native migration、当前指南、README 和图通过完整任务前后快照审阅，保留原工作区状态。无 merge、push 或清理工作区。
