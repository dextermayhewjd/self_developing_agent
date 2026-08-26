# 参照系接地（Benchmark Grounding）Task 8 验收记录

- 执行日期：2026-08-26
- 执行环境：`/home/hongshi/projects/sda-dev`（git worktree，分支 `dev`）
- 执行时 HEAD：`7a49279`（Task 1–7 全部提交已含）
- 对照文档：`docs/superpowers/specs/2026-08-26-benchmark-grounding-design.md`（下称「Spec」）、
  `.superpowers/sdd/2026-08-26-benchmark-grounding/task-8-brief.md`（下称「brief」）

## 0. 范围裁决（Ruling T8-1，复述供后人对照）

brief 原定 Step 4「重跑 03858 判断稿」**未执行**。原因：

- 本 worktree 的 `data/` 下只有 `600549`（Task 3 实跑遗留），没有 `data/03858/`，无法跑
  `run_pipeline_hk.py` 产出 03858 的数据层。
- 同类一次完整判断稿实跑（601678）成本量级为 93.8 分钟、12 个 agent、197 万 token，
  属生产级动作，裁定不在开发 worktree 里发起。

Step 5 的硬门双向验证相应改为**用合成 run 目录**验证「有合规声明→放行、删掉声明→拦住」，
不依赖 Step 4 的真实产出。Step 3 改用 `600549 --terms 钨` 代替 03858。详见下文对应节。

---

## Step 1：全量单元测试 —— 实测通过

命令：
```
python3 -m unittest discover -s tests -v
```
输出（尾部）：
```
----------------------------------------------------------------------
Ran 69 tests in 0.704s

OK
```
结论：**全绿，69/69。** brief 写的「约 27 个测试」是旧估计——Task 2–7 陆续新增了
`test_benchmark_parse.py`、`test_check_thesis_benchmark.py`、`test_discover_peers.py`
等文件，测试数量已涨到 69，这是任务推进中的正常膨胀，不是异常。

---

## Step 2：数据层探针 —— 实测：已知故障，非本次引入

命令：
```
.venv/bin/python tools/probe_endpoints.py
```
输出（节选）：
```
第一层：主机可达性（打真实 API 路径）
  ✗ [关键] push2.eastmoney.com                RemoteDisconnected: Remote end closed connection without response 0.1s
  ✗ [关键] push2his.eastmoney.com             RemoteDisconnected: Remote end closed connection without response 0.0s
  ✓ [关键] datacenter.eastmoney.com           HTTP 200                     0.0s
  ✓ [关键] datacenter-web.eastmoney.com       HTTP 200                     0.2s
  ✓ [关键] money.finance.sina.com.cn          HTTP 200                     0.1s
  ✓ [关键] basic.10jqka.com.cn                HTTP 200                     0.1s
  ✓ [关键] www1.hkexnews.hk                   HTTP 200                     2.8s

第二层：akshare 端到端
  ✗ [关键] A股 历史行情          stock_zh_a_hist                    ProxyError push2his...
  ✗ [关键] A股 个股信息          stock_individual_info_em           ProxyError push2...
  ✓ [关键] A股 财务摘要          stock_financial_abstract           80 行
  ✓ [关键] A股 估值指标          stock_value_em                     2099 行
  ✓ [关键] A股 主营介绍          stock_zyjs_ths                     1 行
  ✓ [关键] 港股 证券概况          stock_hk_security_profile_em       1 行
  ✗ [可选] 板块 概念列表          stock_board_concept_name_em        ProxyError ...push2...
  ✗ [可选] 板块 行业列表          stock_board_industry_name_em       ProxyError ...push2...

结论：关键接口不可用 4 项
EXIT=1
```
结论：`push2.eastmoney.com` / `push2his.eastmoney.com` 全族不通（主机层 2 项 + akshare
端到端层 2 项关键 + 2 项可选，均可归因于同一族故障），退出码 1。**`datacenter` /
`sina` / `10jqka` 三个关键通道全部可达**，未触发「停下」条件。这与用户预先告知的
「生产与开发均实测 6/6 失败」一致，按已知既存故障记录，不阻塞后续步骤。

---

## Step 3：同业检索端到端 —— 实测通过（对象改为 600549，非 03858）

`data/03858/` 不存在，按裁决改用 `600549 --terms 钨`，跑两阶段。

**第一阶段（候选）：**
```
.venv/bin/python tools/discover_peers.py 600549 --terms 钨 --force
```
输出：
```
品种词：['钨']
通道：①  候选 5 条，keep 全部为 null，等待 --confirm 回填。
  000657 中钨高新  hint=主营含「钨」
  002378 章源钨业  hint=主营含「钨」
  002842 翔鹭钨业  hint=主营含「钨」
  600397 江钨装备  hint=主营描述未命中任何品种词（含前缀+尾字校验）
  688778 厦钨新能  hint=主营描述未命中任何品种词（含前缀+尾字校验）
EXIT=0
```

**第二阶段（确认，含标的自身 600549 + 三家同业，共 4 家，按 brief 指定清单）：**
```
.venv/bin/python tools/discover_peers.py 600549 --confirm 600549,000657,002378,002842
```
输出：
```
确认清单：['600549', '000657', '002378', '002842']
确认同业 4 家（另有 2 条留在产物里 keep=False）
中位数 PE_TTM=33.20173383  PB=9.386121085  PS=3.71660248  样本数 PE=4/PB=4/PS=4
EXIT=0
```

结论：**中位数 PE_TTM≈33.20、PB≈9.39，与 Spec 第九节实测基线（PE≈33.23、PB≈9.39）
几乎完全一致**（PE 偏离 0.1%，当日行情小幅漂移，量级完全吻合）。`600549/000657/
002378/002842` 四家全部 `keep: true`，`600397`（江钨装备）与 `688778`（厦钨新能）
候选阶段 hint 未命中品种词、确认阶段未入清单，`keep: false`，符合两阶段设计
（候选阶段 `keep` 恒为 `null`，只有 `--confirm` 产生 `keep: true/false`）。

产物路径：`data/600549/peers_curated.json`（`data/` 整体在 `.gitignore` 里，
本次改动不会出现在 `git status`）。此文件在 Task 3 时已由实跑生成过一次
（仅 3 家确认同业），本次 Step 3 用 `--force` 重跑候选、再用 4 家清单 `--confirm`
覆盖了它——覆盖前后都是同一个 gitignore 掉的产物目录，不影响仓库状态。

**未覆盖点**：本节验证的是 `discover_peers.py` 工具本身的候选/确认/中位数计算逻辑，
不是 Task 5 板块基准 agent 调用它的真实链路（agent 自己选品种词 → 传 `--terms` →
读主营节选判断 → `--confirm`）——那条链路只在 Task 5 的桩函数烟测里验证过控制流，
从未在真实 LLM 编排下跑过，见下方 Step 4 一节。

---

## Step 4：重跑 03858 判断稿 —— 未执行

**为什么没跑**：
1. 本 worktree `data/` 下没有 `data/03858/`，`/thesis-wf` 依赖的数据层产物不存在，
   直接跑会在数据管线阶段失败或需要先跑一遍生产级的 `run_pipeline_hk.py`。
2. 即使补了数据，一次完整判断稿实跑是生产级动作——同类的 601678 那次实测
   93.8 分钟、12 个 agent、197 万 token。裁定这类开销不该在开发 worktree 里
   为了「验收」而发起。

**它本来要验证什么（未覆盖的接缝）**：
Task 1–7 的每个组件都各自验证过——`valuation_archetypes.md` 的解析器有单元测试
（Task 1）、`benchmark_lib.py` 的五档格式有单元测试（Task 2）、`discover_peers.py`
的候选/确认逻辑有单元测试 + 本次 Step 3 的真实调用（Task 3）、`check_thesis.py`
硬约束 7 有单元测试 + 本次 Step 5 的合成夹具双向验证（Task 4）、workflow 的控制流
有桩函数烟测（Task 5）、`audit_overreach.py` 的「查自己」判据有单元测试（Task 6）、
skill 文档同步有一致性自检（Task 7）。

但**没有任何一步让这些组件在一次真实的、由 LLM 驱动的判断稿生成里首尾相连地跑一遍**：
板块基准 agent 会不会真的调用 `discover_peers.py` 并传出合理的品种词、核查 agent
会不会真的按五档（而不是残留的旧四档习惯）写出 `核查/*.md`、补参照系 agent 会不会
真的从核查产物里读出悬空条目并联网补上、成稿 agent 会不会真的在开篇结论下写出
格式合规、内容对应的 `> **参照系声明**` 块。Task 5 报告的桩函数烟测只验证了「脚本
不崩溃、prompt 里没有插值错误」，不验证「LLM 真的按 prompt 要求产出了对的内容」——
这正是 Step 4 要验证、而本次没有验证的部分。

**在生产环境补做需要什么条件**：
- 数据：需要 `data/03858/` 完整数据层（跑 `python3 tools/run_pipeline_hk.py 03858`
  或等效命令产出 `aggregate.json` 等），或选择一个已有完整数据层的标的
  （如 `data/` 下已有数据的其他代码）作为替代验证对象。
- 预算：参照 601678 先例，预留同一量级——约 90–100 分钟、10+ 个 agent 调用、
  近 200 万 token；需在生产目录（非本 dev worktree）里发起，因为「本仓工作目录
  即生产环境」的既有约束（见用户 memory `openclaw-production-coupling`）。
- 命令：`/thesis-wf 03858 <当日日期>`（或对应标的的等效调用），完成后立即执行
  brief 原 Step 5/6 的硬门检查，但检查对象改成真实产出的 `reports/03858_thesis_
  <日期>/report.md`，而不是本次用的合成夹具——这样才能确认「合规声明」是 agent
  真实写出来的，不是人工按 brief 格式手填的。
- 验收标准对照：这正是 Spec 第十一节验收标准 3、4 两条（「重跑 03858，`参照系/
  板块基准.md` 产出」「重跑 03858，`report.md` 开篇结论下存在声明块」）尚未实测
  验证的部分，详见文末「验收标准逐条核对」。

---

## Step 5：硬门双向验证 —— 实测通过（合成夹具，非真实 03858 重跑）

按裁决，在 `reports/TEST8888_thesis_20260826/` 下手工构造了产物目录（`参照系/
板块基准.md` 五条不同强度、`findings/` 五份占位、`疑惑.md`、`report.md` 十二节
骨架+开篇合规声明块、`positions/TEST8888.md` 最近更新=报告日）。构造细节：

- `参照系/板块基准.md` 用全角竖线 `｜`（U+FF5C）分隔，强度串照抄
  `tools/benchmark_lib.py` 的 `STRENGTHS`（含一条 `[私有基准]`：
  `市值 / 测试模型 NPV ｜ 1.80–2.20 倍 ｜ ... ｜ 2026-08-26`）。
- `report.md` 开篇结论下的声明块逐句点名该私有基准 `what`（`「市值 / 测试模型
  NPV」`），降级措辞（`无法回答`）与它同句，块内每行以 `>` 开头、无空行。

**正例：**
```
python3 tools/check_thesis.py TEST8888 reports/TEST8888_thesis_20260826/report.md
```
输出：
```
通过：全部硬约束满足。
EXIT=0
```

**反例（复制一份，只删掉参照系声明块整段，其余原封不动）：**
```
python3 tools/check_thesis.py TEST8888 reports/TEST8888_thesis_20260826/report.nodecl.md
```
输出：
```
[FAIL] 开篇结论缺「> **参照系声明**」块——核心两点各压在哪个数上必须写明

不合格：1 项硬约束违反。
EXIT=1
```

结论：**双向行为验证通过**——有合规声明放行（0），只删声明块即被拦（1），错误信息
精确指向「开篇结论缺「> **参照系声明**」块」，与预期完全一致。测试过程中未触发任何
其他硬约束（说明夹具本身构造合规，不是靠 Ruling 侥幸躲过其他检查项）。

**这一步验证的边界要说清楚**：本节证明的是 `check_thesis.py` 硬约束 7 的
**解析与判定逻辑**是对的——给定一份格式合规的声明块会放行、拿掉会拦住。它**不
证明**真实的 equity-thesis-cn 编排（成稿 agent）在一次真实运行中会写出这样的
声明块——那是 Step 4 未验证的部分。

**清理**：测试完毕后已删除 `reports/TEST8888_thesis_20260826/`（含
`report.nodecl.md`）与 `positions/TEST8888.md`，`git status --short` 确认无
`TEST8888` 相关残留（`data/` 与临时目录本身也不在版本控制范围内，删除前后
git 状态一致）。

---

## Step 6：旧 run 向后兼容回归 —— 实测通过

```
python3 tools/check_thesis.py 03858 reports/03858_thesis_20260821/report.md
```
输出：
```
通过：全部硬约束满足。
EXIT=0
```
该 run 目录下确认没有 `参照系/` 子目录（`ls` 核实：只有 `findings`、`report.md`、
`核查`、`疑惑.md`），因此 `benchmark_lib.parse_benchmarks` 返回 `None`，硬约束 7
整体跳过。

结论：**退出码与 Task 4 报告（`task-4-report.md`）里记录的实施前基线完全一致**——
该报告 Step 5 明确写着「改动前先跑一次……EXIT=0」「改动后再跑一次……EXIT=0，
输出与退出码完全一致」。本次 Task 8 的独立复测复现了同一结果，向后兼容确认成立。

---

## 验收标准（Spec 第十一节）逐条核对

| # | 标准 | 状态 | 说明 |
|---|---|---|---|
| 1 | 15 段原型齐全、五份底稿与 03858 可归入某原型 | 未在本次复测 | Task 1 报告中已验证，本次 Task 8 未重复跑 |
| 2 | 板块基准 agent 调 `discover_peers.py` 对 03858 产出四家钨业同业，中位数 PE≈33/PB≈9.4 | **部分实测通过** | 用 600549 替代 03858 验证了工具本身（PE 33.20/PB 9.39，对齐基线）；agent 真实调用链路未验证（无 03858 数据、Step 4 未跑） |
| 3 | 重跑 03858，`参照系/板块基准.md` 有值或明确记未取得 | **未验证** | Step 4 未执行，无真实产出可查 |
| 4 | 重跑 03858，声明块存在且硬门对未声明版本 1、已声明版本 0 | **硬门逻辑侧实测通过（合成夹具）；agent 产出侧未验证** | Step 5 证明了 check_thesis.py 本身的判定正确；成稿 agent 是否真的会写出这样的声明块，仍是设计意图，未经真实一跑验证 |
| 5 | `probe_endpoints.py` 在生产目录跑一次，push2 状态有定论 | **在开发目录跑通，未在生产目录复核** | 本次只在 sda-dev 跑；用户已预先告知「生产与开发均实测 6/6 失败」，视为已有既存结论，未重复在生产目录跑 |

---

## 总体结论

- **实测通过、有真实输出支撑**：Step 1（单元测试全绿）、Step 2（探针已知故障不阻塞）、
  Step 3（`discover_peers.py` 工具本身在 600549 上复现 Spec 基线）、Step 5（硬门
  双向判定逻辑用合成夹具验证）、Step 6（向后兼容回归复现 Task 4 记录的基线）。
- **未执行、只是设计意图**：Step 4 整段（真实一跑 03858）；由此连带，验收标准
  2 的「agent 真实调用链路」部分、标准 3、标准 4 的「agent 产出侧」部分都**没有
  真实运行验证**，只有各组件的单元测试/桩函数烟测支撑。
- **最大的剩余顾虑**：`立疑 → 挖掘 → 核查（五档）→ 板块基准 → 补参照系 → 成稿
  （声明块）` 这条链路从未在真实 LLM 编排下完整跑过一次。各接缝单独测过，但没有
  证据表明它们接在一起时不会出现新的失配（例如 Task 5 报告自己记录的剩余顾虑：
  「续跑时补参照系会静默空跑」「核查落盘格式与补参照系解析器是同一格式的两个
  消费者，改一处不改另一处会静默失配」）。补齐这一验证需要在生产环境跑一次
  真实 `/thesis-wf 03858 <日期>`（或替代标的），预算参照 601678 先例
  （约 90–100 分钟、10+ agent、约 200 万 token）。
- push2 主机族故障是既存问题（Spec 第八节已记录），非本次改动引入，不影响
  本次验收结论。
