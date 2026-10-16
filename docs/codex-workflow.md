# 在 Codex CLI 中运行研究 workflow

执行器使用本机 `codex exec`，不调用 Claude。业务脚本、研究指南、数据与报告格式继续共用本仓库的现有版本。支持 Node.js 22；开发验证使用 Codex CLI 0.162.1。

## 安装与检查

在仓库根运行：

```bash
npm ci
node tools/run_codex_workflow.mjs equity-thesis --symbol 00700 --check
```

`--check` 只加载脚本、检查 schema 并用合成结果演练控制流，不读取真实 Codex 配置、不调用模型、不获取行情、不写业务产物。它不代表真实研究质量已经验收。

实际研究还需要：已登录的 Codex CLI、数据工具所需的 Python 环境、PDF 工具所需的转换依赖，以及当前权限允许的本地文件/网络访问。优先使用仓库 `.venv/bin/python`，没有则使用 `python3`。不会自动安装 Python 业务依赖。

## 两种启动方式

在 Codex CLI 对话中：

```text
$thesis-wf 00700 20261015
```

仓库 skill 位于 `.agents/skills/thesis-wf/`。若当前会话还没有发现新增 skill，重新打开仓库的 Codex CLI，或明确让 Codex读取该 `SKILL.md` 后使用执行器。

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
| `--no-pdf` | 仍须通过硬门，但不生成 PDF，并明确记录该状态 |
| `--check` | 无模型控制流与 schema 检查 |
| `--reset` | 归档此 workflow 记录的旧产物后重新执行；不删除持仓档案 |

### 阶段配置与冻结

真实执行前，执行器读取本机 Codex 的有效配置与模型目录，解析具体模型和推理强度。没有覆盖时使用有效默认配置；共享脚本中的 Claude 模型别名不能直接作为 Codex 模型使用。无法解析模型或强度、模型不在可用目录中、强度不受该模型支持时明确失败，不猜测替代值。

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

模型与强度分别按字段解析：显式 CLI 参数优先，其次 `stages` 的完整阶段标签，再其次为同类阶段标签（如 `挖掘`）；随后采用共享脚本的阶段提示、文件 `default` 和有效默认配置。`default` 是未指定阶段参数时的回退，例如要覆盖共享脚本为盘点设置的强度，应使用 `stages.盘点` 或 CLI。若切换至另一模型且没有更高优先级的强度设置，使用该模型在目录中的默认强度。阶段名必须准确，未知标签或字段会报错。审查与修订的轮次归入 `成稿审查`、`修订成稿`，无需按轮次配置。配置文件不是模型能力排行榜，具体选用什么模型由使用者及本机可用目录决定。

解析结果保存在运行目录的 `.codex-workflow/execution-config.json`，同时写入 `state.json` 的 `invocation.executionConfig`，记录配置来源、Codex CLI 版本及解析所需的模型信息，不保存鉴权或完整用户配置。每个 worker 都显式传入模型、推理强度和模型提供者，并在自身的 `execution.json` 及事件日志中记录采用的值。

续跑使用原运行已冻结的配置，只检查当前 CLI 版本，不重新解析今天的模型默认值。使用原参数再次执行也会沿用旧快照；用户后来修改本机默认模型、强度或模型目录，不会改变旧运行。只有实际改变 CLI 覆盖或阶段配置内容才要求 `--reset`。Codex CLI 版本变化也要求 `--reset`，避免新旧执行环境混用。阶段标签覆盖目前面向 `equity-thesis`；两个辅助 workflow 可使用统一模型与强度设置。

## 执行语义

执行器依次完成数据验证、脚本研究、独立成稿审查、档案更新、硬门、PDF。五个方向分别执行“挖掘 → 核查”，一个方向完成即可核查；板块基准与它们并行。它不会把三份辅助流程强行串成一次更大的研究。

阶段 worker 是独立的 Codex CLI 进程。它们读取同一工作区，以文件交换全文，以 JSON 交换摘要；不会出现在当前对话的原生子代理列表中。终端会持续显示阶段事件，完整 JSONL 和错误输出保存在日志目录。这里没有 Claude `/workflows` 进度树。

研究开始时读取上一期持仓档案。成稿后，共享 workflow 派独立 worker 阅读完整 findings、核查、参照系、疑惑和写作指南，逐节审查十二节内容，核对五个方向的关键发现是否保留、遗漏、矛盾或有理由排除。审查写入 `RUN/成稿审查.json`，包含 `source_quote`、`report_quote` 与具体修订要求，用 `report_sha256` 绑定当前报告。研究深度不以字数或 PDF 页数评判。

审查不合格时，最多做两轮仅使用现有证据的成稿修订，每轮再交由独立 worker 复审。缺外部证据就保留限制，不编造证据，也不悄悄启动新一轮采集。两轮后仍不合格，停止档案与 PDF 交付。

交付前执行 `node tools/check_thesis_review.mjs RUN`，其中 `RUN` 为本次报告目录。检查器验证十二节/五方向覆盖、审查状态、引用是否存在于对应底稿及报告、当前报告 SHA 是否匹配；失败就阻止交付。检查通过后更新档案，再执行 `check_thesis.py`。硬门失败最多做两轮限定修复，仍失败就退出；凡修复改变了报告，都必须重新独立审查、通过同一检查器、重新更新档案，再过硬门。不能沿用旧版本报告的 `pass`。仅在这些检查允许交付后执行 `md_to_pdf.py --md ...`。

生成报告不等于所有证据可靠：未披露、未查到、弱参照系及数据警告继续按研究规则呈现。schema 通过也不等于事实核实通过。

## 产物与恢复

主流程：

```text
reports/<代码>_thesis_<日期>/
  疑惑.md
  findings/*.md
  核查/*.md
  参照系/*.md
  report.md
  成稿审查.json
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
    quarantine/
positions/<代码>.md
reports/pdf/<代码>_thesis_<日期>.pdf
```

日志中包含完整研究提示和结果，随 `.codex-workflow/` 一起由 git 忽略。不要将其作为公开报告发布。

中断后用相同参数重启。每个修改阶段先备份其允许写入的文件；失败时恢复旧版本，新建的半成品移到 `quarantine/`。如果进程被强行杀死，下次启动会先恢复未完成的事务，再让共享脚本盘点。某份 findings 丢失时，它对应的核查、参照系补充、报告与档案更新也会失效重跑，不会把新发现配上旧报告。首次读取既有 Claude 产物时仍按原脚本规则盘点，这些旧文件没有 Codex 成功记录。

同一股票即使报告日期不同，也不能同时运行两个执行器；不同股票可分别运行。同业 workflow 共用制度缓存，因此也串行执行。中断留下的锁仅在本机主进程及记录的 worker 进程组均已退出时回收；如果仍有孤立 worker，启动会失败并提示进程记录位置，不会让新旧进程同时写文件。

脚本、研究指南、显式模型选项或阶段配置、参数、Codex CLI 版本或主流程原始数据（包括年报 PDF）改变时，旧状态不会被悄悄复用；执行器要求明确使用 `--reset`。本机默认配置变化则按上述冻结规则处理。运行中生成的 `peers_curated.json` 不计入输入指纹。校准流程也检查原始 PDF 内容。归档后仍保留旧文件可查，不是永久删除。成稿审查及修订产物同样受阶段事务与依赖失效规则管理，不能用失效审查授权新报告。

## 辅助 workflow

将业务参数放入 JSON 文件，例如 `/tmp/peer-args.json`：

```json
{"variety":"钨","archetype":"耗竭资源型","anchor":"03858","seed":"600549"}
```

```bash
node tools/run_codex_workflow.mjs peer-comparability --args-file /tmp/peer-args.json
node tools/run_codex_workflow.mjs calibrate-equity-thesis --args-file /tmp/calibration-args.json
```

校准无额外参数时可省略 `--args-file`。原始 PDF 输入仍由共享校准脚本指定；没有源文件就不能做真实盲抽。辅助 workflow 的完整结构化返回保存到其 `.codex-workflow/result.json`，终端只显示摘要。校准脚本列出的后续人工审计/归纳落盘待办仍需按其技能流程处理，不能把脚本执行成功当成整项方法论审计完成。

## 权限与边界

worker 默认使用 `--approve-for-me`（workspace-write 与自动审批）。不会自动添加禁用沙箱或绕过审批的选项。外层 Node 只执行本仓库 workflow 和确定性业务工具，权限仍受启动它的终端/宿主环境限制。

非交互 worker 遇到必须人工回答的问题、缺权限、缺登录或缺依赖，可能失败。具体原因在对应阶段的 stderr 与 JSONL 日志中；解决原因后用相同参数续跑。不要因为一次失败直接扩大权限。

## 验证记录

- Node 回归覆盖结构化契约、调度、进程异常、锁与恢复、真实共享脚本续跑、CLI 检查、档案和硬门/PDF 顺序；本轮新增配置冻结和独立审查的针对性验证，具体通过情况以本轮测试输出为准。
- 原有 Python 回归使用项目 `.venv/bin/python -B -m unittest discover -s tests`；不要用缺少业务依赖的系统 Python 混淆结果。
- 三份真实 `.mjs` 的无模型演练不代表三份流程的真实研究输出都已经验收。
- 两个真实 Codex CLI 探针通过：临时文件写入及 JSON 返回；嵌套中文枚举、可选 null 和数组长度约束。
- 执行器已有 `301248` 的真实股票完整成功运行记录。本轮新增的配置冻结与独立成稿审查尚未做整票实跑，不能把此前成功记录当成新增机制的真实研究验收。

详细迁移对照见 [原设计](superpowers/specs/2026-10-15-codex-workflow-design.md)；新增机制见 [执行配置与成稿审查设计](superpowers/specs/2026-10-16-thesis-parity-design.md)。
