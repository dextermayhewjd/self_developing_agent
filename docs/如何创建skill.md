# 如何创建 Skill

> 原文：**The Complete Guide to Building Skills for Claude**（Anthropic，2026-01-27，共 33 页）
> 来源：https://resources.anthropic.com/hubfs/The-Complete-Guide-to-Building-Skill-for-Claude.pdf
> 本文按原书**逐页**整理，每一页对应下面的一个小节；正文为中文转述，YAML / 代码 / 示例片段保持英文原样，链接为 PDF 内嵌的真实地址。

## 页码索引

| 页 | 内容 |
|---|---|
| [1](#第-1-页封面) | 封面 |
| [2](#第-2-页目录) | 目录 |
| [3](#第-3-页introduction引言) | Introduction 引言 |
| [4](#第-4-页第-1-章扉页fundamentals) | 第 1 章扉页：Fundamentals |
| [5](#第-5-页什么是-skill核心设计原则mcp-构建者视角) | 什么是 skill / 核心设计原则 / MCP 构建者视角 |
| [6](#第-6-页mcp-与-skills-如何配合为什么这对你的-mcp-用户重要) | MCP 与 Skills 如何配合 |
| [7](#第-7-页第-2-章扉页planning-and-design) | 第 2 章扉页：Planning and design |
| [8](#第-8-页从用例出发用例分类-1文档与资产创作) | 从用例出发 / 分类 1 |
| [9](#第-9-页用例分类-2--3定义成功标准) | 分类 2、3 / 定义成功标准 |
| [10](#第-10-页技术要求目录结构硬性规则yaml-frontmatter) | 技术要求 / 目录结构 / frontmatter |
| [11](#第-11-页可选字段安全限制description-字段怎么写) | 可选字段 / 安全限制 / description |
| [12](#第-12-页反面-description写正文指令推荐结构模板) | 反面 description / 正文模板 |
| [13](#第-13-页指令写作最佳实践) | 指令写作最佳实践 |
| [14](#第-14-页第-3-章扉页testing-and-iteration) | 第 3 章扉页：Testing and iteration |
| [15](#第-15-页测试的三个层级触发测试) | 测试层级 / 触发测试 |
| [16](#第-16-页功能测试性能对比使用-skill-creator) | 功能测试 / 性能对比 / skill-creator |
| [17](#第-17-页如何调用-skill-creator根据反馈迭代) | 调用 skill-creator / 迭代 |
| [18](#第-18-页第-4-章扉页distribution-and-sharing) | 第 4 章扉页：Distribution and sharing |
| [19](#第-19-页当前分发模式开放标准通过-api-使用-skills) | 分发模式 / 开放标准 / API |
| [20](#第-20-页api-前置条件推荐做法定位与表述) | 推荐做法 / 定位与表述 |
| [21](#第-21-页第-5-章扉页patterns-and-troubleshooting) | 第 5 章扉页：Patterns and troubleshooting |
| [22](#第-22-页问题优先-vs-工具优先模式-1顺序编排) | 问题优先 vs 工具优先 / 模式 1 |
| [23](#第-23-页模式-2多-mcp-协同模式-3迭代打磨) | 模式 2、3 |
| [24](#第-24-页模式-4上下文感知选工具模式-5领域智能) | 模式 4、5 |
| [25](#第-25-页排障上传失败不触发触发过头) | 排障：上传 / 触发 |
| [26](#第-26-页排障收窄范围mcp-连接指令不被遵守) | 排障：MCP / 指令不被遵守 |
| [27](#第-27-页排障上下文过大) | 排障：上下文过大 |
| [28](#第-28-页第-6-章扉页resources-and-references) | 第 6 章扉页：Resources and references |
| [29](#第-29-页官方文档示例-skill工具与支持) | 官方文档 / 示例 / 支持 |
| [30](#第-30-页参考-a快速检查清单) | 参考 A：快速检查清单 |
| [31](#第-31-页参考-byaml-frontmatter-全字段) | 参考 B：YAML frontmatter |
| [32](#第-32-页参考-c完整-skill-示例) | 参考 C：完整示例 |
| [33](#第-33-页封底) | 封底 |

---

## 第 1 页：封面

**The Complete Guide to Building Skills for Claude**
（《为 Claude 构建 Skills 的完整指南》）

---

## 第 2 页：目录

| 章节 | 原书页码 |
|---|---|
| Introduction（引言） | 3 |
| Fundamentals（基础） | 4 |
| Planning and design（规划与设计） | 7 |
| Testing and iteration（测试与迭代） | 14 |
| Distribution and sharing（分发与共享） | 18 |
| Patterns and troubleshooting（模式与排障） | 21 |
| Resources and references（资源与参考） | 28 |

---

## 第 3 页：Introduction（引言）

**skill 是什么。** skill 是一组指令——打包成一个普通文件夹——用来教会 Claude 如何处理特定任务或工作流。它是定制 Claude 最有力的方式之一：与其在每次对话里重新解释你的偏好、流程和领域知识，不如教 Claude 一次，之后每次都受益。

**什么时候有用。** 当你有可复用的工作流时 skill 最有价值：按规格生成前端设计、用统一方法论做研究、按团队风格指南产出文档、编排多步流程。它们与 Claude 的内置能力（代码执行、文档创作）配合良好。对做 MCP 集成的人来说，skill 又加了一层：把「原始的工具访问」变成可靠、优化过的工作流。

**本指南覆盖什么。** 从规划、结构，到测试、分发的全部内容。无论你是给自己、给团队还是给社区做 skill，都能找到可落地的模式和真实案例。

**你会学到（What you'll learn）：**

- skill 结构的技术要求与最佳实践
- 独立 skill 与 MCP 增强型工作流的模式
- 我们在不同用例中观察到行之有效的模式
- 如何测试、迭代、分发你的 skill

**适合谁（Who this is for）：**

- 希望 Claude 稳定遵循特定工作流的开发者
- 希望 Claude 遵循特定工作流的重度用户
- 希望在组织内统一 Claude 使用方式的团队

**本指南的两条路径（Two Paths Through This Guide）：**
做**独立 skill**？重点看 Fundamentals、Planning and Design，以及用例分类 1–2。要**增强 MCP 集成**？看「Skills + MCP」一节和分类 3。两条路径共享同样的技术要求，但你可以只挑与自己场景相关的部分。

**你能得到什么：** 读完后，你能在一次坐下的时间内做出一个可用的 skill。用 skill-creator 构建并测试第一个能跑的 skill，预计约 **15–30 分钟**。

Let's get started.

---

## 第 4 页：第 1 章扉页 —— Fundamentals

Chapter 1 · **Fundamentals**（基础）

---

## 第 5 页：什么是 skill / 核心设计原则 / MCP 构建者视角

### What is a skill?（skill 是什么）

一个 skill 就是一个文件夹，包含：

- **SKILL.md（必需）**：带 YAML frontmatter 的 Markdown 指令
- **scripts/（可选）**：可执行代码（Python、Bash 等）
- **references/（可选）**：按需加载的文档
- **assets/（可选）**：产出中用到的模板、字体、图标

### Core design principles（核心设计原则）

**Progressive Disclosure（渐进式披露）** —— skill 采用三层系统：

- **第一层（YAML frontmatter）**：始终加载进 Claude 的 system prompt。只提供刚好够用的信息，让 Claude 知道每个 skill 该在什么时候用，而不必把全部内容塞进上下文。
- **第二层（SKILL.md 正文）**：当 Claude 认为该 skill 与当前任务相关时才加载。包含完整指令与指导。
- **第三层（链接文件）**：打包在 skill 目录中的额外文件，Claude 可以按需自行导航、发现。

这种渐进式披露在保留专业能力的同时把 token 消耗降到最低。

**Composability（可组合性）** —— Claude 可以同时加载多个 skill。你的 skill 应当能与其他 skill 良好共处，不要假设自己是唯一可用的能力。

**Portability（可移植性）** —— skill 在 Claude.ai、Claude Code 和 API 上表现一致。做一次，各个界面都能用，无需修改——前提是环境支持该 skill 所需的依赖。

### For MCP Builders: Skills + Connectors（给 MCP 构建者）

> 💡 只做不涉及 MCP 的独立 skill？直接跳到 Planning and Design，之后随时可以回来看这一节。

如果你已经有一个能跑的 MCP server，最难的部分你已经做完了。**skill 是叠在上面的知识层**——把你早就懂的工作流和最佳实践沉淀下来，让 Claude 能稳定地照做。

**厨房类比（The kitchen analogy）：**

- **MCP 提供专业厨房**：工具、食材、设备的访问权。
- **Skills 提供菜谱**：一步步告诉你如何做出有价值的成果。

---

## 第 6 页：MCP 与 Skills 如何配合 / 为什么这对你的 MCP 用户重要

两者合在一起，用户不必自己搞清楚每一步，就能完成复杂任务。

### 如何配合（How they work together）

| MCP（连接性） | Skills（知识） |
|---|---|
| 把 Claude 连到你的服务（Notion、Asana、Linear 等） | 教会 Claude 如何有效使用你的服务 |
| 提供实时数据访问与工具调用 | 沉淀工作流与最佳实践 |
| **Claude 能做什么**（What Claude can do） | **Claude 该怎么做**（How Claude should do it） |

### 为什么这对你的 MCP 用户重要

**没有 skill 时：**

- 用户接上了你的 MCP，却不知道下一步做什么
- 收到「怎么用你们的集成做 X」这类支持工单
- 每次对话都从零开始
- 因为每个人的提示词都不一样，结果不一致
- 真正的问题是缺工作流指导，用户却怪你的 connector

**有 skill 时：**

- 预置工作流在需要时自动激活
- 工具调用一致、可靠
- 最佳实践嵌入每一次交互
- 你的集成上手门槛更低

---

## 第 7 页：第 2 章扉页 —— Planning and design

Chapter 2 · **Planning and design**（规划与设计）

---

## 第 8 页：从用例出发 / 用例分类 1：文档与资产创作

### Start with use cases（先定用例）

**写任何代码之前，先明确 2–3 个具体用例**，说明你的 skill 要让用户完成什么。

**一个好的用例定义长这样：**

```
Use Case: Project Sprint Planning
Trigger: User says "help me plan this sprint" or "create
sprint tasks"
Steps:
1. Fetch current project status from Linear (via MCP)
2. Analyze team velocity and capacity
3. Suggest task prioritization
4. Create tasks in Linear with proper labels and estimates
Result: Fully planned sprint with tasks created
```

**问自己四个问题：**

- 用户想完成什么？
- 这需要哪些多步骤工作流？
- 需要哪些工具（内置的还是 MCP）？
- 应该把哪些领域知识或最佳实践嵌进去？

### Common skill use case categories（常见用例分类）

Anthropic 观察到三类常见用例：

#### Category 1: Document & Asset Creation（文档与资产创作）

**用于：** 产出一致、高质量的成果，包括文档、演示文稿、应用、设计、代码等。

**真实案例：** [frontend-design](https://github.com/anthropics/skills/tree/main/skills/frontend-design) skill（另可参考 [docx](https://github.com/anthropics/skills/tree/main/skills/docx)、[pptx](https://github.com/anthropics/skills/tree/main/skills/pptx)、[xlsx](https://github.com/anthropics/skills/tree/main/skills/xlsx)、[pdf](https://github.com/anthropics/skills/tree/main/skills/pdf) 的 skill）

> "Create distinctive, production-grade frontend interfaces with high design quality. Use when building web components, pages, artifacts, posters, or applications."

**关键手法：**

- 内嵌风格指南与品牌规范
- 用模板结构保证产出一致
- 收尾前跑质量检查清单
- 不需要外部工具——只用 Claude 的内置能力

---

## 第 9 页：用例分类 2 / 3 + 定义成功标准

#### Category 2: Workflow Automation（工作流自动化）

**用于：** 需要统一方法论的多步流程，包括跨多个 MCP server 的协同。

**真实案例：** [skill-creator](https://github.com/anthropics/skills/blob/main/skills/skill-creator/SKILL.md) skill

> "Interactive guide for creating new skills. Walks the user through use case definition, frontmatter generation, instruction writing, and validation."

**关键手法：**

- 带校验关卡（validation gates）的分步工作流
- 常见结构的模板
- 内置的复查与改进建议
- 迭代打磨循环

#### Category 3: MCP Enhancement（MCP 增强）

**用于：** 为 MCP server 提供的工具访问补上工作流指导。

**真实案例：** [sentry-code-review](https://github.com/getsentry/sentry-for-claude/tree/main/skills) skill（来自 Sentry）

> "Automatically analyzes and fixes detected bugs in GitHub Pull Requests using Sentry's error monitoring data via their MCP server."

**关键手法：**

- 按顺序编排多次 MCP 调用
- 嵌入领域专长
- 提供用户本来必须自己说明的上下文
- 对常见 MCP 问题做错误处理

### Define success criteria（定义成功标准）

怎么知道你的 skill 起作用了？

> 这些是**期望值**，是粗略基准而非精确阈值。追求严谨，但要接受其中有一部分是「凭手感」的判断。Anthropic 正在开发更稳健的度量指导与工具。

**定量指标（Quantitative metrics）：**

- **在 90% 的相关查询上触发**
  - 怎么测：跑 10–20 条应该触发的测试查询，统计其中有多少次是自动加载、多少次需要显式调用。
- **用 X 次工具调用完成工作流**
  - 怎么测：同一任务分别在开启 / 关闭 skill 的情况下做一遍，统计工具调用次数和总 token 消耗。
- **每个工作流 0 次失败的 API 调用**
  - 怎么测：测试时监控 MCP server 日志，跟踪重试率与错误码。

**定性指标（Qualitative metrics）：**

- **用户不需要提示 Claude 下一步做什么**
  - 怎么评：测试时留意你需要纠偏或澄清的频次；向 beta 用户收集反馈。
- **工作流无需用户纠正即可完成**
  - 怎么评：同一请求跑 3–5 次，对比产出的结构一致性与质量。
- **跨会话结果一致**
  - 怎么评：新用户能否在几乎没有指导的情况下一次跑通？

---

## 第 10 页：技术要求 / 目录结构 / 硬性规则 / YAML frontmatter

### Technical requirements（技术要求）

**文件结构：**

```
your-skill-name/
├── SKILL.md                  # Required - main skill file
├── scripts/                  # Optional - executable code
│    ├── process_data.py      # Example
│    └── validate.sh          # Example
├── references/               # Optional - documentation
│    ├── api-guide.md         # Example
│    └── examples/            # Example
└── assets/                   # Optional - templates, etc.
     └── report-template.md   # Example
```

### Critical rules（硬性规则）

**SKILL.md 命名：**

- 必须**恰好**是 `SKILL.md`（大小写敏感）
- 不接受任何变体（`SKILL.MD`、`skill.md` 等）

**skill 文件夹命名：**

- 用 kebab-case：`notion-project-setup` ✅
- 不能有空格：`Notion Project Setup` ❌
- 不能用下划线：`notion_project_setup` ❌
- 不能有大写：`NotionProjectSetup` ❌

**不要放 README.md：**

- skill 文件夹里不要放 `README.md`
- 所有文档写进 `SKILL.md` 或 `references/`
- 注意：通过 GitHub 分发时，你仍然需要一个**仓库级**的 README 给人看——见「分发与共享」一章。

### YAML frontmatter: The most important part（最重要的部分）

YAML frontmatter 决定 Claude 是否加载你的 skill。**这一段必须写对。**

**最小必需格式：**

```yaml
---
name: your-skill-name
description: What it does. Use when user asks to [specific
phrases].
---
```

起步只需要这些。

**字段要求：**

`name`（必需）：

- 只能 kebab-case
- 不能有空格或大写
- 应与文件夹名一致

`description`（必需）：

- **必须同时包含**：
  - 这个 skill 做什么
  - 什么时候用它（触发条件）
- 不超过 1024 字符
- 不能有 XML 标签（`<` 或 `>`）
- 写进用户可能真的说出口的具体任务
- 相关的话，提到文件类型

---

## 第 11 页：可选字段 / 安全限制 / description 字段怎么写

### 可选字段

`license`（可选）：

- 做开源 skill 时使用
- 常见：MIT、Apache-2.0

`compatibility`（可选）：

- 1–500 字符
- 说明环境要求：例如面向的产品、需要的系统包、网络访问需求等

`metadata`（可选）：

- 任意自定义键值对
- 建议包含：`author`、`version`、`mcp-server`
- 示例：

```yaml
metadata:
  author: ProjectHub
  version: 1.0.0
  mcp-server: projecthub
```

### Security restrictions（安全限制）

**frontmatter 中禁止：**

- XML 尖括号（`<` `>`）
- 名字中带 "claude" 或 "anthropic" 的 skill（保留字）

**为什么：** frontmatter 会出现在 Claude 的 system prompt 里，恶意内容可能注入指令。

### Writing effective skills —— The description field（description 字段）

引用 Anthropic 的 [engineering blog](https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills)：

> "This metadata...provides just enough information for Claude to know when each skill should be used without loading all of it into context."

这就是渐进式披露的第一层。

**结构：**

```
[What it does] + [When to use it] + [Key capabilities]
```

**好的 description 示例：**

```
# Good - specific and actionable
description: Analyzes Figma design files and generates
developer handoff documentation. Use when user uploads .fig
files, asks for "design specs", "component documentation", or
"design-to-code handoff".


# Good - includes trigger phrases
description: Manages Linear project workflows including sprint
planning, task creation, and status tracking. Use when user
mentions "sprint", "Linear tasks", "project planning", or asks
to "create tickets".


# Good - clear value proposition
description: End-to-end customer onboarding workflow for
PayFlow. Handles account creation, payment setup, and
subscription management. Use when user says "onboard new
customer", "set up subscription", or "create PayFlow account".
```

---

## 第 12 页：反面 description / 写正文指令 / 推荐结构模板

**不好的 description 示例：**

```
# Too vague
description: Helps with projects.


# Missing triggers
description: Creates sophisticated multi-page documentation
systems.


# Too technical, no user triggers
description: Implements the Project entity model with
hierarchical relationships.
```

### Writing the main instructions（写正文指令）

frontmatter 之后，用 Markdown 写真正的指令。

**推荐结构（Recommended structure）：**
按你的 skill 调整这个模板，把方括号部分替换成你自己的内容。

````markdown
---
name: your-skill
description: [...]
---


# Your Skill Name


## Instructions


### Step 1: [First Major Step]
Clear explanation of what happens.

Example:
```bash
python scripts/fetch_data.py --project-id PROJECT_ID
```
Expected output: [describe what success looks like]

(Add more steps as needed)


## Examples

### Example 1: [common scenario]

User says: "Set up a new marketing campaign"

Actions:
1. Fetch existing campaigns via MCP
2. Create new campaign with provided parameters

Result: Campaign created with confirmation link

(Add more examples as needed)


## Troubleshooting

### Error: [Common error message]

Cause: [Why it happens]

Solution: [How to fix]

(Add more error cases as needed)
````

---

## 第 13 页：指令写作最佳实践

### Be Specific and Actionable（具体、可执行）

✅ 好：

```
Run `python scripts/validate.py --input {filename}` to check
data format.
If validation fails, common issues include:
- Missing required fields (add them to the CSV)
- Invalid date formats (use YYYY-MM-DD)
```

❌ 差：

```
Validate the data before proceeding.
```

### Include error handling（写进错误处理）

```markdown
## Common Issues


### MCP Connection Failed
If you see "Connection refused":
1. Verify MCP server is running: Check Settings > Extensions
2. Confirm API key is valid
3. Try reconnecting: Settings > Extensions > [Your Service] >
Reconnect
```

### Reference bundled resources clearly（清楚地引用附带资源）

```markdown
Before writing queries, consult `references/api-patterns.md`
for:
- Rate limiting guidance
- Pagination patterns
- Error codes and handling
```

### Use progressive disclosure（用渐进式披露）

`SKILL.md` 只保留核心指令，把详细文档挪到 `references/` 并链接过去。（三层系统的机制见「核心设计原则」。）

---

## 第 14 页：第 3 章扉页 —— Testing and iteration

Chapter 3 · **Testing and iteration**（测试与迭代）

---

## 第 15 页：测试的三个层级 / 触发测试

skill 可以按不同的严格程度来测：

- **在 Claude.ai 里手工测**——直接跑查询、观察行为。迭代快，零配置。
- **在 Claude Code 里脚本化测**——把测试用例自动化，改动后可重复验证。
- **通过 skills API 程序化测**——搭评测套件，对固定测试集系统性地跑。

选与你的质量要求和 skill 曝光度相匹配的方式。一个小团队内部用的 skill，和一个部署给数千企业用户的 skill，测试需求完全不同。

> **Pro Tip：先在单个任务上迭代，再扩大范围**
>
> 我们发现最有效的 skill 作者会**先在一个有挑战性的任务上反复迭代，直到 Claude 成功**，然后把成功的做法提炼成 skill。这利用了 Claude 的上下文内学习（in-context learning），比一上来就广撒网测试的信号更快。有了能跑的基础之后，再扩展到多个测试用例来覆盖面。

### Recommended Testing Approach（推荐的测试方式）

根据早期经验，有效的 skill 测试通常覆盖三块：

#### 1. Triggering tests（触发测试）

**目标：** 确保 skill 在该加载的时候加载。

**测试用例：**

- ✅ 在显而易见的任务上触发
- ✅ 在换了说法的请求上触发
- ❌ 在无关话题上不触发

**示例测试集：**

```
Should trigger:
- "Help me set up a new ProjectHub workspace"
- "I need to create a project in ProjectHub"
- "Initialize a ProjectHub project for Q4 planning"


Should NOT trigger:
- "What's the weather in San Francisco?"
- "Help me write Python code"
- "Create a spreadsheet" (unless ProjectHub skill handles
sheets)
```

---

## 第 16 页：功能测试 / 性能对比 / 使用 skill-creator

#### 2. Functional tests（功能测试）

**目标：** 验证 skill 产出正确。

**测试用例：** 产出合法、API 调用成功、错误处理有效、边界情况覆盖。

**示例：**

```
Test: Create project with 5 tasks
Given: Project name "Q4 Planning", 5 task descriptions
When: Skill executes workflow
Then:
   - Project created in ProjectHub
   - 5 tasks created with correct properties
   - All tasks linked to project
   - No API errors
```

#### 3. Performance comparison（性能对比）

**目标：** 证明 skill 相对基线确实带来改进。用「定义成功标准」里的指标。一次对比大致长这样：

```
Without skill:
- User provides instructions each time
- 15 back-and-forth messages
- 3 failed API calls requiring retry
- 12,000 tokens consumed

With skill:
- Automatic workflow execution
- 2 clarifying questions only
- 0 failed API calls
- 6,000 tokens consumed
```

### Using the skill-creator skill

**skill-creator**（在 Claude.ai 通过 plugin directory 提供，也可下载给 Claude Code 用）可以帮你构建和迭代 skill。如果你已有 MCP server 并且清楚自己排前 2–3 的工作流，通常能在一次坐下的时间里做出并测好一个可用 skill——常常 15–30 分钟。

**创建 skill：**

- 从自然语言描述生成 skill
- 产出格式正确、带 frontmatter 的 SKILL.md
- 建议触发短语与结构

**复查 skill：**

- 指出常见问题（description 太笼统、缺触发词、结构问题）
- 识别潜在的触发过多 / 触发不足风险
- 根据 skill 声明的用途建议测试用例

**迭代改进：**

- 用过之后遇到边界情况或失败，把这些例子带回 skill-creator
- 例：*"Use the issues & solution identified in this chat to improve how the skill handles [specific edge case]"*

---

## 第 17 页：如何调用 skill-creator / 根据反馈迭代

**调用方式：**

```
"Use the skill-creator skill to help me build a skill for
[your use case]"
```

> **注意：** skill-creator 帮你设计和打磨 skill，但**不会**执行自动化测试套件，也不产出量化评测结果。

### Iteration based on feedback（根据反馈迭代）

skill 是活文档，要按以下信号持续迭代：

**触发不足（Undertriggering）的信号：**

- 该加载时没加载
- 用户在手动启用它
- 有人来问「什么时候该用这个」

> **解法：** 给 description 增加细节与层次——尤其可以补上技术术语类的关键词。

**触发过头（Overtriggering）的信号：**

- 无关查询也会加载
- 用户把它关掉
- 对它的用途感到困惑

> **解法：** 加负向触发条件（negative triggers），把范围写得更具体。

**执行层面的问题（Execution issues）：**

- 结果不稳定
- API 调用失败
- 需要用户纠正

> **解法：** 改进指令，补充错误处理。

---

## 第 18 页：第 4 章扉页 —— Distribution and sharing

Chapter 4 · **Distribution and sharing**（分发与共享）

---

## 第 19 页：当前分发模式 / 开放标准 / 通过 API 使用 Skills

skill 让你的 MCP 集成更完整。用户在比较 connector 时，**带 skill 的那个通向价值的路径更短**，这就是你相对纯 MCP 方案的优势。

### 当前分发模式（2026 年 1 月）

**个人用户如何获得 skill：**

1. 下载 skill 文件夹
2. 打包成 zip（如需）
3. 在 Claude.ai 里通过 Settings > Capabilities > Skills 上传
4. 或者放进 Claude Code 的 skills 目录

**组织级 skill：**

- 管理员可在整个 workspace 部署 skill（2025 年 12 月 18 日上线）
- 自动更新
- 集中管理

### An open standard（一个开放标准）

Anthropic 已把 [Agent Skills](https://agentskills.io/home) 作为开放标准发布。和 MCP 一样，我们认为 skill 应当在不同工具和平台间可移植——同一个 skill 在 Claude 上能用，在别的 AI 平台上也该能用。当然，有些 skill 会刻意吃满某个平台的能力，作者可以在 `compatibility` 字段里注明。我们一直在与生态中的成员共同推进这个标准，早期采用情况令人振奋。

### Using skills via API（通过 API 使用 skill）

面向程序化场景——构建应用、agent 或利用 skill 的自动化流水线——API 提供了对 skill 管理与执行的直接控制。

**关键能力：**

- `/v1/skills` 端点用于列出与管理 skill
- 通过 Messages API 请求里的 `container.skills` 参数把 skill 加进去
- 通过 Claude Console 做版本控制与管理
- 可配合 Claude Agent SDK 构建自定义 agent

**什么时候用 API、什么时候用 Claude.ai：**

| 用例 | 最佳载体 |
|---|---|
| 终端用户直接使用 skill | Claude.ai / Claude Code |
| 开发期的手工测试与迭代 | Claude.ai / Claude Code |
| 个人的、临时性的工作流 | Claude.ai / Claude Code |
| 程序化使用 skill 的应用 | API |
| 规模化的生产部署 | API |
| 自动化流水线与 agent 系统 | API |

---

## 第 20 页：API 前置条件 / 推荐做法 / 定位与表述

> **注意：** API 中使用 skill 需要 **Code Execution Tool beta**，它提供 skill 运行所需的安全环境。

实现细节见：

- [Skills API Quickstart](https://docs.claude.com/en/docs/agents-and-tools/agent-skills/quickstart)
- [Create Custom skills](https://docs.claude.com/en/api/skills/create-skill)
- [Skills in the Agent SDK](https://docs.claude.com/en/docs/agent-sdk/skills)

### Recommended approach today（当下推荐的做法）

先把 skill 托管在 GitHub 上：公开仓库、清晰的 README（**给人看的**，与 skill 文件夹分开——skill 文件夹里不应有 README.md）、带截图的用法示例。然后在你的 MCP 文档里加一节，链到这个 skill，说明为什么两者一起用有价值，并给出快速上手指南。

1. **托管到 GitHub**
   - 开源 skill 用公开仓库
   - README 写清安装步骤
   - 提供用法示例与截图
2. **在你的 MCP 仓库里写文档**
   - 从 MCP 文档链到 skill
   - 说明两者合用的价值
   - 提供快速上手指南
3. **写一份安装指南**

```markdown
## Installing the [Your Service] skill

1. Download the skill:
    - Clone repo: `git clone https://github.com/yourcompany/
      skills`
    - Or download ZIP from Releases

2. Install in Claude:
    - Open Claude.ai > Settings > skills
    - Click "Upload skill"
    - Select the skill folder (zipped)

3. Enable the skill:
    - Toggle on the [Your Service] skill
    - Ensure your MCP server is connected

4. Test:
    - Ask Claude: "Set up a new project in [Your Service]"
```

### Positioning your skill（怎么讲你的 skill）

你怎么描述 skill，决定了用户是否理解它的价值、是否真的会去试。在 README、文档或对外宣传里写它时，记住这些原则。

**讲结果，不要讲功能：**

✅ 好：

```
"The ProjectHub skill enables teams to set up complete project
workspaces in seconds — including pages, databases, and
templates — instead of spending 30 minutes on manual setup."
```

❌ 差：

```
"The ProjectHub skill is a folder containing YAML frontmatter
and Markdown instructions that calls our MCP server tools."
```

**突出 MCP + skills 的组合叙事：**

```
"Our MCP server gives Claude access to your Linear projects.
Our skills teach Claude your team's sprint planning workflow.
Together, they enable AI-powered project management."
```

---

## 第 21 页：第 5 章扉页 —— Patterns and troubleshooting

Chapter 5 · **Patterns and troubleshooting**（模式与排障）

---

## 第 22 页：问题优先 vs 工具优先 / 模式 1：顺序编排

这些模式来自早期使用者和内部团队做出的 skill。它们代表我们看到行之有效的常见做法，**不是强制模板**。

### Choosing your approach: Problem-first vs tool-first（问题优先 vs 工具优先）

把它想成逛家得宝（Home Depot）。你可能带着问题进门——「我要修厨房橱柜」——店员给你指该用哪些工具；也可能是你挑了把新电钻，问它怎么用在你的活儿上。

skill 也一样：

- **问题优先（Problem-first）：** "I need to set up a project workspace" → 你的 skill 按正确顺序编排正确的 MCP 调用。用户描述想要的结果，skill 负责工具。
- **工具优先（Tool-first）：** "I have Notion MCP connected" → 你的 skill 教 Claude 最优工作流和最佳实践。用户已有访问权，skill 提供专业度。

大多数 skill 会偏向其中一边。想清楚哪种框架符合你的用例，有助于从下面的模式里挑对。

### Pattern 1: Sequential workflow orchestration（顺序工作流编排）

**何时用：** 用户需要按特定顺序走的多步流程。

**示例结构：**

```markdown
## Workflow: Onboard New Customer


### Step 1: Create Account
Call MCP tool: `create_customer`
Parameters: name, email, company


### Step 2: Setup Payment
Call MCP tool: `setup_payment_method`
Wait for: payment method verification


### Step 3: Create Subscription
Call MCP tool: `create_subscription`
Parameters: plan_id, customer_id (from Step 1)


### Step 4: Send Welcome Email
Call MCP tool: `send_email`
Template: welcome_email_template
```

**关键手法：**

- 明确的步骤顺序
- 步骤之间的依赖
- 每一阶段都有校验
- 失败时的回滚指令

---

## 第 23 页：模式 2：多 MCP 协同 / 模式 3：迭代打磨

### Pattern 2: Multi-MCP coordination（多 MCP 协同）

**何时用：** 工作流横跨多个服务。

**示例：设计到开发的交接**

```markdown
### Phase 1: Design Export (Figma MCP)
1. Export design assets from Figma
2. Generate design specifications
3. Create asset manifest


### Phase 2: Asset Storage (Drive MCP)
1. Create project folder in Drive
2. Upload all assets
3. Generate shareable links


### Phase 3: Task Creation (Linear MCP)
1. Create development tasks
2. Attach asset links to tasks
3. Assign to engineering team


### Phase 4: Notification (Slack MCP)
1. Post handoff summary to #engineering
2. Include asset links and task references
```

**关键手法：**

- 阶段划分清晰
- MCP 之间的数据传递
- 进入下一阶段前先校验
- 集中式错误处理

### Pattern 3: Iterative refinement（迭代打磨）

**何时用：** 产出质量会随迭代提升。

**示例：报告生成**

```markdown
## Iterative Report Creation


### Initial Draft
1. Fetch data via MCP
2. Generate first draft report
3. Save to temporary file


### Quality Check
1. Run validation script: `scripts/check_report.py`
2. Identify issues:
    - Missing sections
    - Inconsistent formatting
    - Data validation errors


### Refinement Loop
1. Address each identified issue
2. Regenerate affected sections
3. Re-validate
4. Repeat until quality threshold met


### Finalization
1. Apply final formatting
2. Generate summary
3. Save final version
```

**关键手法：**

- 明确的质量标准
- 迭代式改进
- 校验脚本
- **知道什么时候停止迭代**

---

## 第 24 页：模式 4：上下文感知选工具 / 模式 5：领域智能

### Pattern 4: Context-aware tool selection（上下文感知的工具选择）

**何时用：** 同样的结果，但根据上下文该用不同工具。

**示例：文件存储**

```markdown
## Smart File Storage


### Decision Tree
1. Check file type and size
2. Determine best storage location:
    - Large files (>10MB): Use cloud storage MCP
    - Collaborative docs: Use Notion/Docs MCP
    - Code files: Use GitHub MCP
    - Temporary files: Use local storage


### Execute Storage
Based on decision:
- Call appropriate MCP tool
- Apply service-specific metadata
- Generate access link


### Provide Context to User
Explain why that storage was chosen
```

**关键手法：**

- 清晰的决策标准
- 兜底选项
- 对选择保持透明

### Pattern 5: Domain-specific intelligence（领域专属智能）

**何时用：** 你的 skill 提供的是超出工具访问之外的专业知识。

**示例：金融合规**

```markdown
## Payment Processing with Compliance


### Before Processing (Compliance Check)
1. Fetch transaction details via MCP
2. Apply compliance rules:
   - Check sanctions lists
   - Verify jurisdiction allowances
   - Assess risk level
3. Document compliance decision


### Processing
IF compliance passed:
  - Call payment processing MCP tool
  - Apply appropriate fraud checks
  - Process transaction
ELSE:
  - Flag for review
  - Create compliance case


### Audit Trail
- Log all compliance checks
- Record processing decisions
- Generate audit report
```

**关键手法：**

- 领域专长嵌进逻辑里
- 先合规、后行动
- 完整的文档记录
- 清晰的治理

---

## 第 25 页：排障 —— 上传失败 / 不触发 / 触发过头

### Skill won't upload（skill 传不上去）

**错误：** "Could not find SKILL.md in uploaded folder"
**原因：** 文件名不是严格的 `SKILL.md`
**解法：**

- 改名为 `SKILL.md`（大小写敏感）
- 用 `ls -la` 确认能看到 `SKILL.md`

**错误：** "Invalid frontmatter"
**原因：** YAML 格式问题
**常见错法：**

```yaml
# Wrong - missing delimiters
name: my-skill
description: Does things


# Wrong - unclosed quotes
name: my-skill
description: "Does things


# Correct
---
name: my-skill
description: Does things
---
```

**错误：** "Invalid skill name"
**原因：** 名字里有空格或大写

```yaml
# Wrong
name: My Cool Skill


# Correct
name: my-cool-skill
```

### Skill doesn't trigger（skill 不触发）

**症状：** skill 从来不自动加载
**修法：** 改写 `description` 字段，好坏示例见「The description field」。

**快速检查表：**

- 是不是太笼统了？（"Helps with projects" 是不行的）
- 有没有包含用户真的会说的触发短语？
- 相关的话，有没有提到相应的文件类型？

**调试办法：** 直接问 Claude：*"When would you use the [skill name] skill?"* Claude 会把 description 复述回来，据此看缺了什么再调整。

### Skill triggers too often（触发过头）

**症状：** 无关查询也会加载

**解法 1：加负向触发条件**

```
description: Advanced data analysis for CSV files. Use for
statistical modeling, regression, clustering. Do NOT use for
simple data exploration (use data-viz skill instead).
```

---

## 第 26 页：排障 —— 收窄范围 / MCP 连接 / 指令不被遵守

**解法 2：写得更具体**

```
# Too broad
description: Processes documents


# More specific
description: Processes PDF legal documents for contract review
```

**解法 3：澄清适用范围**

```
description: PayFlow payment processing for e-commerce. Use
specifically for online payment workflows, not for general
financial queries.
```

### MCP connection issues（MCP 连接问题）

**症状：** skill 加载了，但 MCP 调用失败

**检查表：**

1. **确认 MCP server 已连接**
   - Claude.ai：Settings > Extensions > [Your Service]
   - 应显示 "Connected" 状态
2. **检查认证**
   - API key 有效且未过期
   - 已授予恰当的权限 / scope
   - OAuth token 已刷新
3. **单独测 MCP**
   - 让 Claude 直接调 MCP（绕开 skill）
   - "Use [Service] MCP to fetch my projects"
   - 如果这一步就失败，问题在 MCP 而不在 skill
4. **核对工具名**
   - skill 里引用的 MCP 工具名是否正确
   - 查 MCP server 文档
   - **工具名大小写敏感**

### Instructions not followed（指令不被遵守）

**症状：** skill 加载了，但 Claude 不照做

**常见原因：**

1. **指令太啰嗦**
   - 保持简洁
   - 用要点和编号列表
   - 把详细参考挪到独立文件
2. **指令被埋了**
   - 关键指令放最上面
   - 用 `## Important` 或 `## Critical` 标题
   - 必要时重复关键点
3. **语言含糊**

```
# Bad
Make sure to validate things properly


# Good
CRITICAL: Before calling create_project, verify:
- Project name is non-empty
- At least one team member assigned
- Start date is not in the past
```

> **进阶手法：** 对关键校验，考虑打包一个脚本用程序去做检查，而不是靠语言指令。**代码是确定性的，语言解释不是。** 这个模式的例子见 Office skills。

4. **模型「偷懒」** —— 加上明确的鼓励：

```markdown
## Performance Notes
- Take your time to do this thoroughly
- Quality is more important than speed
- Do not skip validation steps
```

> **注意：** 把这段加在**用户提示词**里，比放在 SKILL.md 里更有效。

---

## 第 27 页：排障 —— 上下文过大

### Large context issues

**症状：** skill 显得慢，或回答质量下降

**原因：**

- skill 内容太大
- 同时启用的 skill 太多
- 所有内容被一次性加载，没走渐进式披露

**解法：**

1. **优化 SKILL.md 体积**
   - 详细文档挪到 `references/`
   - 用链接代替内联
   - **SKILL.md 控制在 5,000 词以内**
2. **减少启用的 skill 数量**
   - 评估你是不是同时启用了超过 20–50 个 skill
   - 建议按需选择性启用
   - 考虑把相关能力打成 skill "packs"

---

## 第 28 页：第 6 章扉页 —— Resources and references

Chapter 6 · **Resources and references**（资源与参考）

---

## 第 29 页：官方文档 / 示例 skill / 工具与支持

如果你在做第一个 skill，先看 Best Practices Guide，再按需查 API 文档。

### Official Documentation（官方文档）

**Anthropic 资源：**

- [Best Practices Guide](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices)
- [Skills Documentation](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview)
- [API Reference](https://platform.claude.com/docs/en/api/overview)
- [MCP Documentation](https://modelcontextprotocol.io)

**博客文章：**

- [Introducing Agent Skills](https://claude.com/blog/skills)
- [Engineering Blog: Equipping Agents for the Real World](https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills)
- [Skills Explained](https://www.claude.com/blog/skills-explained)
- [How to Create Skills for Claude](https://www.claude.com/blog/how-to-create-skills-key-steps-limitations-and-examples)
- [Building Skills for Claude Code](https://www.claude.com/blog/building-skills-for-claude-code)
- [Improving Frontend Design through Skills](https://www.claude.com/blog/improving-frontend-design-through-skills)

### Example skills（示例 skill）

**公开 skill 仓库：**

- GitHub: [anthropics/skills](https://github.com/anthropics/skills)
- 包含 Anthropic 制作、可供你改造的 skill

### Tools and Utilities（工具）

**skill-creator skill：**

- 内置于 Claude.ai，也可用于 Claude Code
- 能从描述生成 skill
- 能复查并给出改进建议
- 用法：*"Help me build a skill using skill-creator"*

**校验：**

- skill-creator 可以评估你的 skill
- 问它：*"Review this skill and suggest improvements"*

### Getting Support（获取支持）

**技术问题：**

- 一般性问题：[Claude Developers Discord](https://discord.com/invite/6PPFFzqPDZ) 社区论坛

**Bug 反馈：**

- GitHub Issues：[anthropics/skills/issues](https://github.com/anthropics/skills/issues)
- 请附上：skill 名称、错误信息、复现步骤

---

## 第 30 页：参考 A —— 快速检查清单

用这张清单在上传前后验收你的 skill。想更快起步，可以先用 skill-creator 生成初稿，再对照这张表逐条查漏。

**Before you start（动手前）**

- [ ] 明确了 2–3 个具体用例
- [ ] 确定了要用的工具（内置或 MCP）
- [ ] 读过本指南和示例 skill
- [ ] 规划好了文件夹结构

**During development（开发中）**

- [ ] 文件夹名是 kebab-case
- [ ] 存在 SKILL.md 文件（拼写完全正确）
- [ ] YAML frontmatter 有 `---` 分隔符
- [ ] `name` 字段：kebab-case、无空格、无大写
- [ ] `description` 同时说明了 **WHAT** 和 **WHEN**
- [ ] 任何位置都没有 XML 标签（`<` `>`）
- [ ] 指令清晰、可执行
- [ ] 包含错误处理
- [ ] 提供了示例
- [ ] references 链接清楚

**Before upload（上传前）**

- [ ] 在显而易见的任务上测过触发
- [ ] 在换了说法的请求上测过触发
- [ ] 确认无关话题不会触发
- [ ] 功能测试通过
- [ ] 工具集成可用（如适用）
- [ ] 已压缩为 .zip

**After upload（上传后）**

- [ ] 在真实对话里测试
- [ ] 监控触发不足 / 触发过头
- [ ] 收集用户反馈
- [ ] 迭代 description 与指令
- [ ] 更新 metadata 里的 version

---

## 第 31 页：参考 B —— YAML frontmatter 全字段

**必需字段：**

```yaml
---
name: skill-name-in-kebab-case
description: What it does and when to use it. Include specific
trigger phrases.
---
```

**所有可选字段：**

```yaml
name: skill-name
description: [required description]
license: MIT # Optional: License for open-source
allowed-tools: "Bash(python:*) Bash(npm:*) WebFetch" # Optional:
Restrict tool access
metadata: # Optional: Custom fields
  author: Company Name
  version: 1.0.0
  mcp-server: server-name
  category: productivity
  tags: [project-management, automation]
  documentation: https://example.com/docs
  support: support@example.com
```

### Security notes（安全说明）

**允许：**

- 任何标准 YAML 类型（字符串、数字、布尔、列表、对象）
- 自定义 metadata 字段
- 长 description（最多 1024 字符）

**禁止：**

- XML 尖括号（`<` `>`）——安全限制
- 在 YAML 中执行代码（使用安全 YAML 解析）
- 以 "claude" 或 "anthropic" 开头命名的 skill（保留）

---

## 第 32 页：参考 C —— 完整 skill 示例

想看体现本指南各种模式的、完整可用于生产的 skill：

- **Document Skills** —— PDF、DOCX、PPTX、XLSX 创作
  （[pdf](https://github.com/anthropics/skills/tree/main/skills/pdf)、[docx](https://github.com/anthropics/skills/tree/main/skills/docx)、[pptx](https://github.com/anthropics/skills/tree/main/skills/pptx)、[xlsx](https://github.com/anthropics/skills/tree/main/skills/xlsx)）
- **[Example Skills](https://github.com/anthropics/skills/tree/main/skills)** —— 各种工作流模式
- **[Partner Skills Directory](https://www.claude.com/connectors)** —— 查看 Asana、Atlassian、Canva、Figma、Sentry、Zapier 等合作伙伴的 skill

这些仓库会持续更新，包含比本指南更多的示例。克隆下来、按你的用例改造、当模板用。

---

## 第 33 页：封底

[claude.ai](http://claude.ai)
