---
name: debug-equity-thesis
description: 调试 equity-thesis-cn（或任何编排式 skill）的行为。在隔离的全新上下文里跑一遍、录下全程、把黑盒转录审计成可读报告（自发 spawn 了没、编排器有没有越权重做、产物齐不齐、过没过校验），支持"改 skill → 重跑 → 对比"的迭代循环。
---

# 调试 equity-thesis-cn

## 为什么需要它

编排式 skill 是黑盒：你看到最终报告，看不到**编排器到底怎么执行的**——自发 spawn 了没？派完活是不是保持轻量？还是塌成单体、或越权重做子 agent 的活？"能跑出报告"不等于"按设计跑"。

这个 skill 把行为**可观测**：在隔离上下文跑一遍、录全程、审计成可读报告。这样才能一次次迭代地提升 equity-thesis-cn，而不是盲改。

**核心方法**：行为的 RED-GREEN——先看它现在怎么跑（可能有缺陷），改 skill，再跑，对比行为有没有变好。

## 两个阶段（是步骤，不是两个 skill）

调试天然分两半，但**不该拆成两个 skill**——它们总是连着用，而且"跑+留痕"是 equity-thesis-cn 跑起来的免费副产物，不是独立技能：

- **阶段一 · 跑 + 留痕（机械，自动）**：跑一遍 equity-thesis-cn，两样痕迹自动留下——
  - **产物痕迹** = run 文件夹（`reports/{SYMBOL}_thesis_*/` 的 疑惑/findings/report）+ 更新的 `positions/`。
  - **行为痕迹** = 会话转录 jsonl（Claude Code 自动录在 `~/.claude/projects/<项目>/<uuid>.jsonl`）。
- **阶段二 · 审计 + 改（判断，这才是本 skill 的活）**：读痕迹 → 定位偏离 → 改一处 prompt → 重跑 → 对比。

## 迭代循环

```
1 跑一遍(留痕自动)  →  2 审计转录  →  3 找出偏离设计的行为
                                        ↓
        6 对比新旧审计  ←  5 重跑  ←  4 改 skill 堵这个偏离
```

每轮把转录 + 审计存进 `debug/{SYMBOL}_{轮次}/`，这样能跨轮对比、保留 context。

**两种跑法都留痕，审计器都能读：**
- **交互 auto mode**（推荐日常用）：无墙钟限制、能跑完、你全程看得见。转录自动录进会话 jsonl，跑完 `python tools/audit_run.py --latest {SYMBOL}` 直接审。
- **headless 隔离**（要绝对干净、可复现时用）：`claude -p "..." --output-format stream-json > log.jsonl`，`audit_run.py log.jsonl {SYMBOL}` 审。隔离最彻底但注意别设太短的 timeout（thinking 重时 20 分钟可能不够）。

## 步骤 1：隔离跑一遍（关键是"隔离"）

**为什么必须隔离**：如果测试 agent 带着你和它讨论架构的上下文，它是从对话里知道要 spawn 的，不是从 skill——测试就废了。必须全新上下文，只能从 skill 本身知道怎么做。

**为什么用 headless 子进程而不是 Agent 工具**：Agent 工具派出的子 agent 多半没有 Task 工具、无法再 spawn，会被迫单体做（假阴性）。headless `claude -p` 有完整工具集、零对话记忆、且正是生产 `--print` 的运行方式。

先做污染排查：

```bash
# 项目级 CLAUDE.md / 项目记忆 有没有描述架构？有就会污染测试
ls CLAUDE.md AGENTS.md 2>/dev/null
grep -rl "orchestrat\|子 agent\|spawn\|编排" \
  ~/.claude/projects/-home-hongshi-projects-sda-dev/memory/ 2>/dev/null
```

再跑（数据先备好，跳过 run_pipeline 只为省时，不影响 spawn 行为；prompt 里**绝不提子 agent/spawn/架构**）：

```bash
OUT=<scratchpad>/spawn-test-{SYMBOL}.jsonl
timeout 1200 claude -p "请使用 equity-thesis-cn skill，为 {SYMBOL}（{公司名}）生成判断型研究报告，报告日 {日期}。数据已在 data/{SYMBOL}/，跳过 run_pipeline 与 validate；不要生成 PDF。" \
  --permission-mode bypassPermissions \
  --output-format stream-json --verbose \
  > "$OUT" 2>&1 &
```

后台跑，`Read` 那个 jsonl 可随时看进度——**转录是实时写入的，不是黑盒**。

## 步骤 2：审计

```bash
python tools/audit_run.py <transcript.jsonl> {SYMBOL}
```

输出：工具时间线（中间过程）+ 小结（spawn 几个/哪些 lens、派活前后的挖掘调用数、产物齐不齐、校验器结果）。

## 步骤 3：对照"好行为"检查表

| 检查项 | 好 | 坏（要改 skill） |
|---|---|---|
| 自发 spawn | 5 个子 agent，覆盖全花名册 | 0 个（塌成单体）或漏 lens |
| 派活后是否轻量 | 派活后挖掘调用 <15 | 几十上百次（**越权重做子 agent 的活**） |
| findings 落盘 | 5 份 findings/*.md | 空（子 agent 没写文件，或没等它们） |
| 立疑→销账 | 疑惑.md 有 + report 里"现在回答开篇" | 无脊椎 |
| 产物 | 疑惑/findings/report/档案齐 | 缺项 |
| 校验器 | 退出 0 | 1（硬伤） |

## 步骤 4：改 skill 堵偏离

审计发现的每个坏行为，对应改一处 skill 文字，然后回步骤 1 重跑，用步骤 2 的审计对比。**一次只改一处**，否则分不清哪处起作用。

## 已知偏离（迭代起点，改一个划掉一个）

- [x] **findings 不落盘** → round3 修好。改法：让**编排器**收到子 agent 返回后自己 Write 到 `findings/{名}.md`，不指望子 agent 自写（子 agent 常写不成）。效果：findings 0→5。
- [~] **编排器越权重挖年报**：round1=257、round2 加禁令反升到 299（**prose 禁令无效，印证 writing-skills**）、round3 改"综合只读 findings、砍年报可及性"→真越权降到 60（−75%）。**部分修复，未清零**——残留 60 次年报/WebSearch。
- [ ] **跑太慢、撞墙钟**：round3 在 1200s 超时（num_turns 仅 33、thinking 重），综合没写完、report 未出。下一步二选一：① 测试放宽 timeout 到 2400s 确认能跑完；② 让编排器更果断（砍"其他"类冗余调用 + 残留越权），在预算内收敛。
  - 注：这是当前**唯一挡住产出完整报告**的问题。findings/越权两条已基本解决。

## 迭代记录（三轮）

| 轮次 | 改了什么 | findings | 真越权 | report | 结论 |
|---|---|---|---|---|---|
| round1 | 基线 | 0 | ~257 | 无 | — |
| round2 | 步骤3 加"分工边界"禁令 | 0 | 299 | 无 | 禁令失败，反更糟 |
| round3 | 编排器落盘 + 综合只读 findings | 5 | 60 | 无 | 落盘修好、越权−75%，但撞超时 |

## 保留 context 反复迭代

每轮存 `debug/{SYMBOL}_{轮次}/`：`transcript.jsonl` + `audit.txt`（`audit_run.py` 的输出重定向进去）+ 一行"这轮改了什么"。跨轮 `diff` 审计小结，就能看出改动有没有让行为变好。

## 这套方法可泛化

隔离跑 + 转录审计，适用于任何"靠模型自发编排"的 skill，不止 equity-thesis-cn。`audit_run.py` 的 spawn/越权/产物三类指标是通用的。
