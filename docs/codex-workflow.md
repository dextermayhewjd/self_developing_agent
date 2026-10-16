# 在 Codex CLI 中运行研究 workflow

执行器使用本机 `codex exec`。Codex 的工作流定义、技能和研究指南独立位于 `.codex/`，运行时不读取 `.claude/`。共享数据工具仍位于 `tools/`。支持 Node.js 22；开发验证使用 Codex CLI 0.162.1。

## 原生入口与目录

`.codex/skills/` 是技能正文及参考资料的唯一来源；`.agents/skills/` 中的相对目录链接接入 Codex 的技能发现机制，两处不是两份副本。`.codex/workflows/` 保存三条确定性流程；它们由本仓库执行器加载，并非 Codex 内置的 `Workflow` API。

| 入口 | 用途 |
|---|---|
| `$thesis-wf`、`$equity-thesis-cn` | 同一条完整判断型研究流程 |
| `$equity-report-cn` | 按八节模板生成结构化数据报告及 PDF |
| `$financial-redflags-cn` | 独立财务排雷；亦供判断稿财务阶段使用 |
| `$calibrate-equity-thesis` | 五篇底稿的方法校准，交付诊断和待人工采纳的改写稿 |
| `$debug-equity-thesis` | 审计既有 Codex 运行；明确要求重跑时才启动研究 |

所有研究方法已从当前 Claude 版本迁入，后续修改 Codex 方法请编辑 `.codex/skills/`。历史 Claude 版本保留，二者不自动互相覆盖。迁移改变工作流与方法指纹，旧运行不能静默续用；`--reset` 仍须由用户授权，归档旧产物后重跑，不能为了迁移自动重写已有报告。

## 安装与检查

在仓库根运行：

```bash
npm ci
node tools/check_codex_native.mjs
node tools/run_codex_workflow.mjs equity-thesis --symbol 00700 --check
```

`--check` 只加载脚本、检查 schema 并用合成结果演练控制流，不读取真实 Codex 配置、不调用模型、不获取行情、不写业务产物。它不代表真实研究质量已经验收。

实际研究还需要：已登录的 Codex CLI、数据工具所需的 Python 环境、PDF 工具所需的转换依赖，以及当前权限允许的本地文件/网络访问。优先使用仓库 `.venv/bin/python`，没有则使用 `python3`。不会自动安装 Python 业务依赖。

## 两种启动方式

在 Codex CLI 对话中：

```text
$thesis-wf 00700 20261015
```

仓库 skill 正文位于 `.codex/skills/thesis-wf/`，通过 `.agents/skills/thesis-wf/` 发现。若当前会话尚未刷新技能清单，重新打开仓库的 Codex CLI，或明确让 Codex 读取该 `SKILL.md` 后使用执行器。

在终端中：

```bash
node tools/run_codex_workflow.mjs equity-thesis --symbol 00700 --date 20261015
```

日期省略时使用本机当天日期。代码必须是 A 股六位或港股五位，允许 `00700.HK`。传给执行器时不要丢掉前导零。

可选参数：

| 参数 | 用途 |
|---|---|
| `--root PATH` | 指定另一份包含本项目工具与 workflow 的工作区；默认当前执行器所在仓库 |
| `--jobs N` | 同时运行的 Codex worker 数量，默认 3 |
| `--model NAME` | 显式统一覆盖所有阶段的模型 |
| `--effort LEVEL` | 显式统一覆盖所有阶段的推理强度；可用值以本机模型目录为准 |
| `--stage-config PATH` | 从 JSON 文件设置默认模型/强度及指定阶段的覆盖 |
| `--review-max-rounds N` | 累计修订轮次绝对上限，默认 2，整数 1..10；不重置已耗额度 |
| `--no-pdf` | 仍须通过硬门，但不生成 PDF，并明确记录该状态 |
| `--check` | 无模型控制流与 schema 检查 |
| `--reset` | 归档此 workflow 记录的旧产物后重新执行；不删除持仓档案 |

### 阶段配置与冻结

真实执行前，执行器读取本机 Codex 的有效配置与模型目录，解析具体模型和推理强度。没有覆盖时使用有效默认配置。无法解析模型或强度、模型不在可用目录中、强度不受该模型支持时明确失败，不猜测替代值。

阶段文件的结构如下，`model` 与 `effort` 都可单独省略；占位值需替换为本机可用配置：

```json
{
  "default": { "model": "<默认模型>", "effort": "<默认强度>" },
  "stages": {
    "成稿": { "model": "<成稿模型>" },
    "成稿审查": { "effort": "<审查强度>" },
    "挖掘:产业": { "model": "<产业挖掘模型>", "effort": "<产业挖掘强度>" }
  }
}
```

```bash
node tools/run_codex_workflow.mjs equity-thesis --symbol 00700 --stage-config /path/config.json
```

模型与强度分别按字段解析：显式 CLI 参数优先，其次 `stages` 的完整阶段标签，再其次为同类阶段标签（如 `挖掘`）；随后采用脚本的阶段提示、文件 `default` 和有效默认配置。`default` 是未指定阶段参数时的回退，例如要覆盖脚本为盘点显式设置的 low，应使用 `stages.盘点` 或 CLI。若切换至另一模型且没有更高优先级的强度设置，使用该模型在目录中的默认强度。阶段名必须准确，未知标签或字段会报错。局部提案使用合法标签 `问题修订`；完整修订和独立审查分别归入 `修订成稿`、`成稿审查`，无需按 RT ID 或轮次配置。`stages.问题修订.effort=high` 仅覆盖局部提案，不改变独立审查，CLI 仍优先。配置文件不是模型能力排行榜，具体选用什么模型由使用者及本机可用目录决定。

解析结果保存在运行目录的 `.codex-workflow/execution-config.json`，同时写入 `state.json` 的 `invocation.executionConfig`，记录配置来源、Codex CLI 版本及解析所需的模型信息，不保存鉴权或完整用户配置。每个 worker 都显式传入模型、推理强度和模型提供者，并在自身的 `execution.json` 及事件日志中记录采用的值。

续跑使用原运行已冻结的配置，只检查当前 CLI 版本，不重新解析今天的模型默认值。使用原参数再次执行也会沿用旧快照；用户后来修改本机默认模型、强度或模型目录，不会改变旧运行。只有实际改变 CLI 覆盖或阶段配置内容才要求 `--reset`。Codex CLI 版本变化也要求 `--reset`，避免新旧执行环境混用。阶段标签覆盖目前面向 `equity-thesis`；两个辅助 workflow 可使用统一模型与强度设置。脚本显式 low 仅用于 thesis 的盘点和 peer 的盘点、读配置；其余阶段没有强度提示，按上述优先级继承。冻结有效默认 xhigh、无 CLI/阶段覆盖且无文件 default 时：局部提案、完整修订、完整独立审查均为 xhigh；上述辅助阶段为 low。

## 执行语义

执行器依次完成数据验证、脚本研究、独立成稿审查、档案更新、硬门、PDF。五个方向分别执行“挖掘 → 核查”，一个方向完成即可核查；板块基准与它们并行。它不会把三份辅助流程强行串成一次更大的研究。

阶段 worker 是独立的 Codex CLI 进程。它们读取同一工作区，以文件交换全文，以 JSON 交换摘要；不会出现在当前对话的原生子代理列表中。终端会持续显示阶段事件，完整 JSONL 和错误输出保存在日志目录。这里没有 Claude `/workflows` 进度树。

研究开始时读取上一期持仓档案。研究 workflow 仅写 `初稿.md`，host 独占建立和修改 `report.md`、ledger 与 receipt。独立审查收到完整十二节、全五路底稿、核查、参照系、疑惑及全部附件，不接收修订者自评。审查新增问题由 host 分配稳定 RT ID；修订者只返回 Proposal，host 校验后应用，任务进入 awaiting_review，只有另一次完整独立审查能关闭或重开任务。

任务分 blocking / disclosure / watch；交付看 `blocks_delivery` 和当前状态，不要求所有观察项都查明。局部包按 UTF-8 最多 32 KiB、最多两个目标章节，保留目标整节、引用来源全文及审查指定的跨节判断约束；范围不足转完整修订，不静默截断。局部 worker 的模型、强度和提供者沿用 `问题修订` 的冻结解析结果，不自动降为 low；完整修订与最终完整审查分别使用 `修订成稿`、原 `成稿审查` 配置，实际采用值见 execution.json。

默认最多两轮修订、三次有效完整审查。`--review-max-rounds N` 是从首次运行起累计的绝对上限，合法值 1..10，不能低于已消耗轮数；省略时保留已有额度，显式扩额追加历史，不重置 RT ID、轮数或有效审查次数。已经存在当前 pass 且无修复需求时，扩额延期，不改写 receipt。技术硬门修改报告也写入任务账本、消耗同一修订额度，再由独立完整审查裁定。仅修档案/PDF 不消耗语义审查额度。

交付必须同时满足：最新独立 Review pass、无未关闭阻断、无活跃 attempt/停止原因、报告与物理证据快照一致，receipt 精确绑定输入/输出账本 SHA。档案和 PDF 先写到 host 指定的事务暂存位置，硬门通过后按相同 receipt 提交；每次正式发布前重新核对原始输入与证明。失败恢复只回滚可证明由 host 写入的字节，人工变动保留并报冲突。`node tools/check_thesis_review.mjs RUN` 检查当前 v2 证明；它属于正常验证/恢复路径，可能补回 Store 显示文件。只读调查使用下面的 audit 命令。

生成报告不等于所有证据可靠：未披露、未查到、弱参照系及数据警告继续按研究规则呈现。schema 通过也不等于事实核实通过。

## 产物与恢复

主流程：

```text
reports/<代码>_thesis_<日期>/
  疑惑.md
  findings/*.md
  核查/*.md
  参照系/*.md
  初稿.md                         # 初始 writer 输出
  report.md                        # host 独占应用的候选稿
  成稿审查.json                     # 带 receipt 的兼容显示文件
  .codex-workflow/
    state.json
    execution-config.json
    events.jsonl
    result.json
    agents/<阶段-唯一ID>/
      execution.json
      prompt-*.txt
      schema.json
      events-*.jsonl
      stderr-*.txt
      result-*.json
    input-manifest.json            # 原始输入与派生产物登记
    review/
      HEAD.json                    # 指向不可变提交，证明入口
      ledger.json                  # 可恢复显示，不能手改计数
      evidence-manifest.json
      commits/ ledgers/ reports/ reviews/ receipts/ attempts/
      transcripts/ exchanges/      # 候选转录、请求/响应与摘要
    delivery/journal.json          # 档案/PDF 提交及恢复证据
    quarantine/
positions/<代码>.md
reports/pdf/<代码>_thesis_<日期>.pdf
```

日志中包含完整研究提示和结果，随 `.codex-workflow/` 一起由 git 忽略。不要将其作为公开报告发布。

中断后使用原代码、原报告日和原参数续跑。有 v2 Store 或初稿且原始 input-manifest 完整时，直接恢复审查与交付；缺个股档案或旧研究阶段 failed 不会触发重新研究。固定批次按已提交 cursor 续跑，不重复应用补丁，也不把半批报告送去完整复审。通用研究阶段仍有各自事务恢复。

例如已消耗两轮，要把累计额度扩到三轮（剩余一轮）：

```bash
node tools/audit_codex_workflow.mjs reports/<代码>_thesis_<原日期> --json
node tools/run_codex_workflow.mjs equity-thesis --symbol <代码> --date <原日期> --review-max-rounds 3
```

无需 `--reset`。显式要求仅审查时，可将 `{"review_only":true}` 写入新的临时 JSON，并在同一命令追加 `--args-file /tmp/review-only.json`；没有候选稿会失败，不启动研究。额度只能放 CLI 的 `--review-max-rounds`，不能放 args 文件。初稿续跑仍需要原始输入清单；缺失或变动时明确拒绝且不重新抓取。

停止原因：`budget_exhausted` 可在授权的累计上限内显式扩额续跑；`needs_evidence` 表示当前证据无法继续，重复运行或扩额不会补证；`no_safe_edit` 表示没有安全可应用补丁。当前没有自动采集/重置证据的恢复入口。外部改过 report.md、PNG/PDF 或转录时保留原文件并报告快照/人工编辑冲突；不能改 SHA、删 HEAD 或手调 ledger 将旧 pass 绑定新字节。本批不提供自动采用外部改稿的接口。

旧 v1 状态的诊断只重建可证的历史轮数与最终 verdict；即使可重建也需要未来显式导入，不自动铸造 v2 receipt 或把额度算作零。CLI 的 legacy refusal 在准备数据/状态恢复前发生。不要用 `--reset` 绕过用户只授权续跑的请求。

同一股票即使报告日期不同，也不能同时运行两个执行器；不同股票可分别运行。同业 workflow 共用制度缓存，因此也串行执行。中断留下的锁仅在本机主进程及记录的 worker 进程组均已退出时回收；如果仍有孤立 worker，启动会失败并提示进程记录位置，不会让新旧进程同时写文件。

脚本、研究指南、显式模型选项或阶段配置、研究参数、Codex CLI 版本改变时，旧状态不会被悄悄复用；执行器要求另行授权归档重跑。原始输入（包括年报 PDF）或派生来源改变时，候选续跑在任何新取数之前拒绝。累计额度与 review_only 不改变研究指纹。本机默认配置变化则按上述冻结规则处理。运行中生成的 `peers_curated.json` 不计入输入指纹。校准流程也检查原始 PDF 内容。归档后仍保留旧文件可查，不是永久删除。成稿审查及修订产物同样受阶段事务与依赖失效规则管理，不能用失效审查授权新报告。

## 辅助 workflow

将业务参数放入 JSON 文件，例如 `/tmp/peer-args.json`：

```json
{"variety":"钨","archetype":"耗竭资源型","anchor":"03858","seed":"600549"}
```

```bash
node tools/run_codex_workflow.mjs peer-comparability --args-file /tmp/peer-args.json
node tools/run_codex_workflow.mjs calibrate-equity-thesis --args-file /tmp/calibration-args.json
```

校准无额外参数时可省略 `--args-file`，日期可用 `--date YYYYMMDD` 指定。默认使用技能协议列出的五篇人工 PDF；自定义来源通过 `--args-file` 配置。没有原始 PDF 就不能做新的盲抽与原文抽查。

来源配置支持 `source_dir`（默认五个文件所在目录）和 `documents`（恰好五项，每项含 `code`、`file`、`pages`）。`file` 可以是绝对路径，也可以相对 `source_dir`；例如只移动默认五篇的位置可传 `{"source_dir":"/path/to/pdfs"}`。首次发布证据后生成来源及内容 SHA 清单；更换文件或证据内容不能复用旧缓存。迁移来的六份 Markdown 是明确标记的旧底稿缓存，不伪称已重新读取 PDF。

原生校准包含完整链：五份盲抽、独立归纳、规则测绘、对撞、原文抽查、诊断报告及 before/after 改写稿。五份动作清单与方法清单全部齐备且来源符合时才复用；自定义来源不能误用默认样本缓存。只依赖底稿的证据保存在 `.codex/skills/calibrate-equity-thesis/evidence/`，本轮输出在 `reports/calibrate_<日期>/`，完整机器结果在其 `.codex-workflow/result.json`。新增建议须至少三份适用样本支持，删除建议须零命中且适用分母至少三，分母为零不提案；原文抽查后才输出建议。执行器不自动修改研究方法。

## Codex 日志审计

```bash
node tools/audit_codex_workflow.mjs reports/300209_thesis_20261016
node tools/audit_codex_workflow.mjs reports/300209_thesis_20261016 --json
```

审计只读状态、控制器事件、各阶段工具记录及 Store 不可变证明，不恢复、不补写被审计运行的显示文件。缺 ledger 显示、receipt、实际执行配置或发生人工冲突会明确标缺证。`review_tasks` 给出分类/状态计数、未关闭阻断 ID、当前 report/evidence/输入输出 ledger/receipt 绑定、attempt cursor、额度与停止原因，以及实际 worker model/effort/context_bytes；阶段 succeeded 不能替代证明。默认输出 Markdown，`--json` 输出机器结果；退出 1 表示日志不完整、阶段失败或登记产物缺失，退出 2 表示调用错误。记录完整时也可能有待人工复核的行为警告。PDF 阅读、下载、检索等信号只用于定位，不是对事实正确性或模型理解程度的证明。参照系查自身数据的检查从运行状态和报告读取标的标识，也可用 `--symbol CODE --company NAME` 指定；未取得标识时明确标为未执行。Claude 旧日志解析器不参与 Codex 审计。

行业池默认位于 `.codex/skills/equity-report-cn/competitor_pool.json`；共享数据工具支持环境变量 `SDA_COMPETITOR_POOL` 指向另一个明确的池文件，不再隐式读取 `.claude`。

## 权限与边界

研究及档案等普通 worker 保持既有 workspace-write 参数。proposal / review / evidence_extract 使用 `--sandbox read-only` 与 `--ask-for-approval never`，移除 `--approve-for-me`。不会自动添加禁用沙箱或绕过审批的选项。外层 Node 只执行本仓库 workflow 和确定性业务工具，权限仍受启动它的终端/宿主环境限制。

校准的盲抽与归纳使用中性临时工作目录，关闭项目指令注入、额外开发者指令与检索，并显式禁用已发现的技能，避免被审计方法进入初始上下文。共享隔离路径还设置 `features.multi_agent=false`、`features.multi_agent_v2=false`；CLI 0.162.1 的 `features list` 验证两项有效值为 false，旧 `agents.enabled=false` 对该版本无效。skills/list 必须覆盖请求 cwd、errors 为空且条目路径/数组结构合法，才允许只读角色启动；记录的是本次库存快照，并非 OS 读取白名单或对后续插件变化的保证。这个措施隔离上下文；文件系统权限仍由 Codex 沙箱决定，不是操作系统级的只读白名单。模型提供者和鉴权配置继续沿用冻结配置。

非交互 worker 遇到必须人工回答的问题、缺权限、缺登录或缺依赖，可能失败。具体原因在对应阶段的 stderr 与 JSONL 日志中；解决原因后用相同参数续跑。不要因为一次失败直接扩大权限。

## 验证记录

- Node 回归覆盖结构化契约、调度、进程异常、锁与恢复、真实脚本续跑、CLI 检查、档案和硬门/PDF 顺序，以及原生路径、校准全链和审计器。
- 原有 Python 回归使用项目 `.venv/bin/python -B -m unittest discover -s tests`；不要用缺少业务依赖的系统 Python 混淆结果。
- 三份真实 `.mjs` 的无模型演练不代表三份流程的真实研究输出都已经验收。
- 两个真实 Codex CLI 探针通过：临时文件写入及 JSON 返回；嵌套中文枚举、可选 null 和数组长度约束。
- 迁移前已有 `301248` 和 `300209` 完整运行，后者实际执行配置冻结及两轮成稿修订。原生迁移另做无 Claude 隔离验收；旧报告成功记录不等于本次所有新能力的真实研究验收，也不证明不同模型质量等价。
- 2026-10-16 原生迁移验收：六个技能经本机 `skills/list` 发现；三条工作流无模型检查通过；无 `.claude` 测试目录完成校准首次执行及六份证据复用；Node 96 项、Python 172 项回归通过。Python 存在原数据工具的文件未关闭 `ResourceWarning`，未产生测试失败。
- 新的盲阶段配置经真实 `codex exec` 小探针验证，使用 `gpt-6.1-sol / low` 返回预期 JSON；57 个已发现技能被禁用。该探针不研究股票、不改业务文件，不能替代整票质量验收。盲提示与协议模板的连续汉字、标题、加粗术语及专用词隔离检查通过。

历史适配方案见 [原设计](superpowers/specs/2026-10-15-codex-workflow-design.md)；审查机制见 [执行配置与成稿审查设计](superpowers/specs/2026-10-16-thesis-parity-design.md)；当前目录与验收约定见 [原生迁移设计](superpowers/specs/2026-10-16-codex-native-migration-design.md)。

## 本批审查任务与合成探针

```bash
node tools/probe_thesis_review_task.mjs --output-dir debug/thesis_review_task_probe_20261016
```

该命令调用生产 coordinator/backend，在全新虚构 fixture 中执行首次完整审查 → 继承冻结强度的有界局部提案 → host 应用 → 另一调用完整独立审查；不接受 symbol，拒绝已有目录及真实股票运行路径。输出实际配置、技能库存、有效功能开关、UTF-8 字节数、只读参数、模型结果、host 应用摘要与 receipt。真实失败保留 stderr/JSONL/summary，不扩大权限或用 fake pass 替代。复跑需另取全新输出目录。最终实际结果与本批测试见 [实施记录](superpowers/reports/2026-10-16-thesis-review-task-system-implementation.md)。

[单张改动图](diagrams/thesis-workflow/thesis-workflow-change-map.svg) 的蓝/橙/绿分别表示保留/修改/新增，节点另标“本批已实施”与“后续建议”。业务识别、同业选择和成稿前写作规划仍在下一批；本批没有启动另一轮真实股票研究。

2026-10-16 强度校正：已移除局部提案自动 low；历史真实探针记录保持原值，当前行为与本次零真实模型调用的验证见 [强度对齐审计](superpowers/reports/2026-10-16-thesis-effort-parity.md)。
