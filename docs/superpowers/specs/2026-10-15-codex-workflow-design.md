# Codex CLI workflow 执行器设计与 Claude 对照

日期：2026-10-15。状态：待用户审核，尚未实现。

## 目标与范围

用户希望在当前 Codex CLI 中复用本仓库的复杂 Claude workflow。交付物是可执行的 Codex 工作流，不是让主模型读完步骤后自行安排执行的提示词。

保留 `.claude/workflows/` 的三份业务脚本及 `.claude/skills/` 的研究规则作为共同来源。新增 Node.js 执行器，把脚本使用的运行时函数接到 `codex exec`；完整交付路径首先覆盖 `equity-thesis`。`peer-comparability`、`calibrate-equity-thesis` 同时获得脚本执行能力，但不添加原脚本没有调用的研究阶段。

在 `sda-dev` 开发，不修改生产目录、不切生产分支，不覆盖现有未提交改动。不会因为开发验收自动生成一份真实股票研报；真实研报需要用户指定标的。

## 已核实的本机条件

- Codex CLI：`0.162.1`；Node.js：`v22.23.3`。
- `codex exec --help` 列出 `--output-schema`、`--json`、`--output-last-message`、`--cd`、`--model`、`--sandbox` 和 `--approve-for-me`。
- 三份 workflow 已通过仓库现有 `check_workflow_syntax.mjs --smoke`。这个检查使用空返回桩，不调用模型，不能证明真实工具调用或研究质量。
- 当前项目没有 `.agents/skills/` 或现成的 Codex workflow 执行器。
- 当前会话提供多代理工具，但没有 Claude 的 `Workflow` 工具。CLI 执行器不依赖当前会话是否暴露多代理工具。

## 逐项对照

| Claude 现状 | Codex 实现决策 | 保留的语义或明确差异 |
|---|---|---|
| `.claude/commands/thesis-wf.md` 是入口 | 新建 `.agents/skills/thesis-wf/SKILL.md`，调用本地执行器 | Codex 中使用 `$thesis-wf`；不承诺注册同名 `/thesis-wf` 内建命令 |
| `Workflow({scriptPath,args})` | 本地 Node 入口选择仓库内白名单脚本，显式传入 `args.root` | 不经过 Claude，不请求 Anthropic 模型 |
| 运行时包装脚本体，支持顶层 `return` | 沿用现有语法检查器的 AsyncFunction 包装边界 | 只执行本地可信仓库脚本，不接受远程脚本 URL |
| `agent(prompt,{schema,label,phase,...})` | 独立 `codex exec` 进程；提示词经 stdin；结果经单独 JSON 文件读取 | 每个阶段有独立模型上下文，全文继续落到业务文件 |
| `parallel(thunks)` | Promise 调度；在实际启动 worker 的边界限流 | 保持输入对应的返回顺序 |
| `pipeline(items,...stages)` | 每个 item 独立顺序通过各阶段，不设置整批阶段屏障 | 一个方向挖掘结束即可核查，不等另外四个方向 |
| `phase()`、`log()`、`/workflows` | 终端进度和 JSONL 事件日志 | 不复刻 Claude 的 `/workflows` 进度树 UI |
| `model: 'haiku', effort: 'low'` | 模型由 Codex 入口配置；不把 Claude 模型别名传给 Codex | 首版只使用一个明确选择的 Codex 模型；保留阶段 effort 提示，允许入口统一覆盖 |
| JSON Schema 返回契约 | 转为 Codex 可接受的严格 schema，返回后再按原始契约校验 | 枚举、必填、数组上下限不得丢失；可选字段不能被当成必填业务数据 |
| `Read/Bash/WebSearch` 写在提示词中 | worker 公共指令说明对应本机文件、终端、检索能力 | 不全局替换研究文档，也不把提示词禁令宣传成工具级隔离 |
| 盘点已有文件后跳过阶段 | 保留磁盘产物续跑，补充本执行器的阶段成功记录 | 新执行器失败的半成品不能因为大于 200 字节就算完成 |
| `resumeFromRunId` 依赖 Claude 会话目录 | 不依赖 Claude journal；日志与成功记录位于 run 目录 | 换 Codex 会话仍能定位同一报告目录 |
| 更新档案、硬门校验、PDF 只列在返回的“编排器待办” | 外层 thesis 命令实际依次执行这些动作 | `report.md` 写出来不等于 workflow 已交付 |
| `tools/audit_run.py` 读取 Claude stream-json | 新执行器写独立日志及最终摘要 | 不把 Codex JSONL 喂给旧解析器并宣称审计通过 |

## 对照中发现的实际差异

1. 旧 `equity-thesis-cn/SKILL.md` 的散文编排仍写着“所有 findings 齐后核查”；实际 `.mjs` 使用逐项流水线。Codex 以脚本控制流为准，避免退回旧编排。
2. 读往期档案是 skill 的步骤 0，但主 workflow 的立疑提示词没有携带这项要求。外层执行器给立疑、成稿阶段补充档案路径及读取要求，保留旧估值锚、假设记分板、未决疑问和人工注入信息。
3. `BENCHMARK` 提示词要求联网证据带原文和日期，但 schema 的 `verbatim`、`fetched_date` 并非必填。传输 schema 的适配不能声称已经保证这些业务条件；外层需对联网条目进行条件校验。
4. 原脚本允许部分 agent 返回空值后继续。新后端对于进程失败、无 JSON、schema 不合格抛出带阶段名的异常，避免把执行失败当成合法的“无数据”。合法的空数组仍按原 schema 处理。
5. `peer-comparability` 注释说可作为板块基准数据源，但当前 `equity-thesis.mjs` 并没有调用它。首版不自动增加这一轮研究及其成本。
6. 校准脚本的原始 PDF 路径位于仓库外，输出位于 `/tmp/doc-digest`。执行器预检该依赖；缺文件就明确失败，不把它归因为 Codex 不支持 workflow。

## 执行结构

```text
当前 Codex CLI 中的 $thesis-wf / 终端命令
  → Node 外层：校验参数与数据
  → 共享 equity-thesis.mjs
      → 盘点 → 立疑
      → 五条“挖掘→核查”流水线 + 板块基准
      → 补参照系 → 成稿
  → 更新 positions/<symbol>.md
  → check_thesis.py；失败则限定修复并重新校验
  → 校验通过后生成 PDF
  → 摘要：产物路径、门禁结果、问题销账及核实数量
```

Node 控制阶段顺序；模型负责研究、判断与写作。每个 worker 不得再次启动整套 thesis workflow。默认同时运行 3 个 worker，可通过 `--jobs` 调整；限流放在 `agent()` 内，不占用等待子阶段的调度槽，避免嵌套 parallel 死锁。

### CLI 接口

以下是实现后的接口约定，目前不能作为已存在命令执行：

```bash
# 完整研究交付；日期省略时使用本机当天日期
node tools/run_codex_workflow.mjs equity-thesis --symbol 601678 --date 20261015

# 静态检查与无模型演练：不取数、不写业务产物、不生成 PDF
node tools/run_codex_workflow.mjs equity-thesis --symbol 601678 --check

# 辅助 workflow 的参数存入 JSON 文件，root 由入口补入
node tools/run_codex_workflow.mjs peer-comparability --args-file /tmp/peer-args.json
node tools/run_codex_workflow.mjs calibrate-equity-thesis --args-file /tmp/calibrate-args.json
```

公共选项：`--root`、`--jobs`、`--model`、`--effort`。thesis 另支持 `--no-pdf`，跳过时结果必须明确标记 PDF 未生成。模型默认沿用已配置的 Codex 模型；不自动选择新模型或改写用户全局配置。

Codex skill 用法为 `$thesis-wf 601678 20261015`。本会话由 skill 调用终端执行器并跟踪进度；底层 worker 是本机独立 Codex CLI 进程，不保证显示在当前会话的原生子代理列表中。

### 参数、进程与权限

- A 股代码必须为 6 位，港股为 5 位，允许港股 `.HK` 后缀，保留前导零。日期严格检查日历有效性。
- root 从入口位置解析为仓库绝对路径，再显式传给 workflow。用户给定 root 必须包含对应脚本及工具。
- 所有子进程使用参数数组启动，不经 shell 拼接提示词、代码、品种名称或文件路径。
- 默认使用 `workspace-write` 和自动审批审查；不添加绕过沙箱参数，不修改用户全局 Codex 配置。
- 网络、认证和外部目录受本机实际权限约束。拒绝时报告失败阶段与错误，不静默改成宽权限重跑。
- 同一 workflow 产物目录加运行锁，拒绝两个进程同时写同一份报告或同一品种台账；不同标的可分别运行。
- 接到中断时停止排队任务、终止已启动 worker 并写入中断状态，保留已完成的业务产物。

### Schema、结果与失败

schema 适配单独成模块，支持当前三份脚本实际使用的对象、数组、字符串、数值、整数、布尔、enum、required、minItems/maxItems。未知结构在检查阶段报错，不静默删除约束。

Codex 严格传输层使用封闭对象；原来可选的字段允许 null。结果回传业务代码前去掉“原本可选但返回 null”的字段，再校验原契约。枚举节点缺失 type 时，从当前明确的字符串枚举推导类型。字段顺序与中文枚举值保持原样。

本地校验使用标准 JSON Schema 校验器；在实现阶段锁定依赖版本并提交 lockfile。传输约束不能替代本地业务校验。比如联网证据缺原文/抓取日期、written_file 指向不存在文件、返回路径超出本次允许产物范围，均不能标记阶段成功。

每次尝试使用独立的 prompt/schema/result/log 文件，避免把上次成功输出当成本次结果。模型进程退出异常立即报告；格式问题允许一次有明确错误反馈的修复尝试，再失败就停止。不会无限重试。

### 磁盘状态、续跑与日志

thesis 的运行状态放在 `reports/<symbol>_thesis_<date>/.codex-workflow/`。辅助 workflow 的日志放在各自固定输出目录内的 `.codex-workflow/`，校准使用 `/tmp/doc-digest/.codex-workflow/`。

记录脚本摘要、参数、阶段开始/结束、实际模型选项、退出码、结果文件及已声明产物。只有进程成功、JSON 合格且所需产物存在，才写阶段成功记录。

已有 Claude 产物保持可复用：沿用原脚本盘点规则，但在启动前排除本执行器已知失败/中断阶段的产物；向用户说明导入的旧产物没有 Codex 阶段成功凭据。发生脚本或研究指南变化时不自动信任历史成功记录，提示明确重跑选择，避免混用两版规则。

恢复依据是业务产物和阶段记录，不是 `codex exec resume --last`。旧成功阶段无须重读几百页材料；未完成阶段重跑。报告已通过后再次启动应先验证现有报告和档案，能直接交付则不再研究。

### 完整交付与硬门

1. 运行 `tools/validate.py`。退出 0 继续，2 带警告继续，1 调数据管道后再校验；其他退出码是工具错误。
2. 把警告写入运行上下文，要求成稿明确披露。研究 worker 读取已有档案。
3. 执行 workflow 并核对五份 findings、五份核查和报告存在；参照系允许业务定义的“无外部证据”结果，但不能把执行失败冒充空结果。
4. 单独 worker 更新档案，并检查 `最近更新` 与报告日一致。
5. 真正执行 `check_thesis.py`。退出 1 时根据反馈修复报告/档案，最多 2 轮，然后失败退出；不自动降低门槛。退出 2 表示软警告，保留并披露。
6. 门禁通过后才调用 `md_to_pdf.py --md ...`；未选择 `--no-pdf` 时，PDF 失败意味着完整交付失败。
7. 输出路径、硬门结果、PDF 状态、核实和疑惑销账统计；明确区分本轮新增与历史累计。

## 代码组织

- `tools/run_codex_workflow.mjs`：CLI 参数与统一退出状态。
- `tools/codex_workflow/runtime.mjs`：脚本加载、阶段调度、并发限制与取消。
- `tools/codex_workflow/backend.mjs`：Codex 子进程、JSONL 和结构化结果。
- `tools/codex_workflow/schema.mjs`：schema 适配和结果验证。
- `tools/codex_workflow/state.mjs`：锁、阶段成功记录、恢复与产物校验。
- `tools/codex_workflow/thesis.mjs`：数据预检、档案、硬门、PDF 的业务外层。
- `.agents/skills/thesis-wf/SKILL.md`：当前 Codex CLI 的薄入口，明确不得手工重编排。
- `tests/codex_workflow/*.test.mjs`：Node 原生测试；进程测试的假 CLI 仅放测试目录。
- `docs/codex-workflow.md`：操作说明、完整对照、故障恢复与验收范围。

## 验收

首先编写并观察失败测试，再实现：

- 三份真实脚本都可加载，schema 均通过适配检查；不会向 Codex 发送 haiku/sonnet。
- 慢速第二项不阻塞第一项进入核查；结果顺序稳定；同时启动 worker 不超过 jobs。
- schema 的中文枚举、可选字段、空结果、最小数组长度和证据条件得到验证。
- 假 CLI 的非零退出、无 JSON、格式错误、写错产物路径不会被当成完成。
- 中断后有字节的半成品不能被复用；已成功阶段可续跑；同目录第二次运行被锁拦截。
- 使用临时目录验证“档案 → 硬门 → PDF”的顺序，硬门失败时 PDF 永远不执行。
- `--check` 不调用模型、数据管道或 PDF，不写真实研究目录。
- 真实 Codex 的最小隔离探针验证结构化返回和本地文件写入，使用临时目录，不取行情、不生成真实研报。
- 运行现有 Python 回归测试，报告未通过项；对既有用户改动导致的失败不擅自修改业务实现。

完成时明确区分离线测试、真实 CLI 探针、完整研报三种证据。没有用户指定标的并完成真实全流程，不宣称研究质量或完整研报链路已验收。

## 资料

- [Codex 非交互执行](https://learn.chatgpt.com/docs/non-interactive-mode)：脚本调用、JSONL、结构化结果和权限。
- [Codex skills](https://learn.chatgpt.com/docs/build-skills)：`.agents/skills/` 和 `$skill` 入口。
- [Codex 子代理](https://learn.chatgpt.com/docs/agent-configuration/subagents)：原生子代理能力和权限继承，用于说明它与本方案的进程执行器边界。
