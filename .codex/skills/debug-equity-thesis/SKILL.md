---
name: debug-equity-thesis
description: 当用户要求审计 Codex 判断稿工作流是否按设计运行、排查缺少底稿或阶段失败，或比较修改前后的运行行为时使用。普通报告阅读和方法论校准不使用本技能。
---

# Codex 判断稿行为调试

审计执行行为：阶段是否实际启动、依赖顺序是否正确、研究与成稿是否守住分工、完整文件是否交接、审查与硬门是否完成。能生成报告不等于按设计运行，结构检查通过也不等于金融事实正确。

调试分两段：已授权的运行自动留下产物和事件；本技能读取这些痕迹，定位偏离后再验证改动。用户只要求检查现有运行时，直接审计，不重新生成报告。

## 读取现有运行

确定本技能真实路径所属仓库根，以及用户指定的 `reports/<代码>_thesis_<日期>/`。若未指定日期，先列出该代码的现有运行目录，不用当天日期猜出一个新任务。执行：

```bash
node <仓库根>/tools/audit_codex_workflow.mjs <运行目录>
node <仓库根>/tools/audit_codex_workflow.mjs <运行目录> --json
```

第一个命令打印可读审计，第二个给结构化结果。退出 0 表示未发现记录完整性错误；退出 1 表示不完整、阶段失败或产物缺失；退出 2 表示调用错误。退出 0 仍可能含需要人工复核的行为警告。

审计读取 Store HEAD/不可变对象并核对摘要与 receipt，绝不恢复或补写缺失显示文件。`review_tasks` 的 open_blocking_ids、budget、attempt、terminal_reason 与当前快照才是审查进度证据；阶段 succeeded 与旧 pass 不足以授权当前稿。缺实际 model/effort/context_bytes 标为缺证。

实际证据包括：

- `.codex-workflow/events.jsonl`：阶段开始、完成、缓存、失效与阶段提示。
- `.codex-workflow/state.json`、`result.json`、`execution-config.json`：阶段状态、交付状态和冻结配置。
- `.codex-workflow/agents/*/prompt-*.txt`、`events-*.jsonl`、`result-*.json`、`execution.json`：每次阶段的输入、工具调用、结构化输出和运行配置。
- `疑惑.md`、五份 `findings/`、五份 `核查/`、`参照系/`、`成稿审查.json`、`report.md`、个股档案：产物痕迹。

对每个结论标明事件或文件证据。审计器的搜索、PDF、下载信号是启发式；间接脚本、动态路径和外部工具可能漏检。不能把“没匹配到”写成“没有发生”，缺日志也不能算通过。

## 检查表

| 检查项 | 应观察到的行为 | 偏离信号 |
|---|---|---|
| 阶段覆盖 | 立疑、五路挖掘及各自核查、板块基准、补参照系、成稿、审查、交付 | 缺方向、失败后误报完成或塌成一个阶段 |
| 时序 | 每路挖掘后核查；全部核查后补参照系；成稿后独立审查 | 读尚未完成文件、先 PDF 后硬门、旧审查授权新稿 |
| 成稿输入 | 完整五份 findings、五份核查、全部参照系及疑惑 | 只看摘要、漏读底稿、重复挖年报或联网 |
| 核查边界 | 回原始材料核对数字，区分未披露与未查到 | 搜索替代原件、没有改错痕迹 |
| 文件交接 | 工作进程写完整文件，执行器核对结果 | 只有返回摘要、空文件、路径漂移 |
| 疑惑销账 | 开篇疑惑与正文回答对应 | 无疑惑文件、悄悄遗忘答不出的问题 |
| 档案与交付 | 档案报告日一致，审查绑定当前 SHA，硬门无失败 | 档案未更新、报告改动后沿用旧 pass |

阶段正常情况下，编排器不亲自重挖年报。不要沿用旧的“必须恰好 spawn 五次”或“父会话工具数小于某值”判断：当前执行器还包含五路独立核查、参照系、审查与修订，实际阶段数随条件变化。应与 [原生编排合同](../equity-thesis-cn/orchestration.md) 和本次冻结配置对照。

## 用户明确要求新一轮调试运行时

先保留基线审计，再运行：

```bash
node <仓库根>/tools/run_codex_workflow.mjs equity-thesis --symbol <代码> --date <YYYYMMDD> --root <仓库根>
```

这会启动真实研究；只审计现有日志不需要此步。若当前代码和日期已有运行，默认续跑；使用 `--reset` 会归档既有产物，只有用户授权重跑时使用。用户只需要行为探针时，优先使用已有合成验证，或在临时副本中测试，不重写真实报告。

需要测技能路由而非只测脚本时，用全新 `codex exec` 上下文接收通常的 `$thesis-wf` 请求。不得把预期步骤或“应该派几个 agent”等答案写进测试提示。测试前检查该工作区的 `AGENTS.md`、技能正文和配置是否额外泄露了答案；保留这些环境信息，以区分技能作用与先前会话污染。遵循当前权限，不加入权限绕过参数。

进程可能运行很久。持续轮询原进程并读取阶段事件，不因终端返回会话 ID 就宣布完成；不要用任意短的墙钟超时推断工作流失效。

## 修改与对比

采用“观察基线 → 定位偏离 → 修改一处 → 复跑 → 对比”的循环。一次只改一个可解释的行为或合同；同时改多处会失去归因。修改前后都保存审计、相关 prompt、事件证据和一句变更说明到用户指定的调试目录，例如 `debug/<代码>_<轮次>/`。

优先修职责、输入和文件交接，不只堆叠“不得越权”散文禁令：旧实验中单加禁令没有阻止重挖，限制综合阶段输入才降低重复取证。检查文件存在时用仓库根构造的绝对路径，与写文件的相对 cwd 分离，避免同一错误坐标系自证成功。

方法论对不对属于 [calibrate-equity-thesis](../calibrate-equity-thesis/SKILL.md)；修改方法后可用本技能检查是否实际执行。最终报告区分：已证实的行为、启发式风险信号、无法由现有日志判断的部分。

## v2 证明与二进制引文诊断

先读 audit JSON，再读取 `RUN/.codex-workflow/review/HEAD.json` 的 `{path,sha256}`，按 HEAD.path 读取并验证 commit，再沿 commit.refs 核对不可变 ledger/evidence/review/receipt；`ledger.json`、`evidence-manifest.json`、`成稿审查.json` 只是显示，不能手改。检查 report/evidence/input_ledger/output_ledger 四个摘要、旧任务全部处置与当前未关闭阻断。报告被人工修改时保留文件并报冲突，不覆盖、不重新签旧审查；本批无外部改稿自动采用入口。`check_thesis_review.mjs` 属正常验证/恢复路径，可能补显示文件，故仅调查时用 audit。

遇到 PNG/PDF 的 `source_quote not found` 或缺少目视证明，先看 evidence manifest 中 source 的 type、原始 SHA、transcript.path/SHA 与 PDF 的 pdf_origin 页图登记。转录位于 review/transcripts；核对原图或全部登记 PDF 页，检查 Review.visual_attestations 是否绑定 source 与 transcript 摘要。PDF page-view 摘要保存在 manifest.pdf_origin；Review.evidence_sha256 绑定整个 manifest，间接绑定页图，attestation 本身没有 page-view 字段。候选转录不是目视授权：原文件、页图或转录被换会令证据授权失效，不能仅据此断言引文造假。保留错误和字节，不跳过附件、不靠更换引文或删 attestation 强过。核查图片内容与验证摘要是两个步骤；缺视觉证明可能先抛 EVIDENCE_PENDING，报告待补证明；持久 needs_evidence 以实际账本/停止记录为准，禁止手调 ledger。证据改变则报快照冲突，本批不自动补证/采用新证据。

有初稿但缺档案时，使用原代码/原日期续跑，直接恢复审查/交付；已用两轮且授权累计三轮时追加 `--review-max-rounds 3`。该值是累计绝对上限，不是再加三轮；详见 [入口与恢复](../thesis-wf/SKILL.md)。旧 v1 只有只读历史诊断，无自动导入或零额度续跑。

只验证接口且用户授权真实小探针时，可执行 `node <仓库根>/tools/probe_thesis_review_task.mjs --output-dir <全新调试目录>`，保留真实失败日志；该入口仅建虚构 fixture，拒绝 symbol/已有目录，不能替真实研究做质量声明。
