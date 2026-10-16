---
name: equity-report-cn
description: 输入 A 股 6 位代码（如 688981、600519），生成结构化中文股票研究报告。自动跑数据流水线 → 写报告草稿 → 转 PDF（剥附录、强制 SC 字形）。仅供研究参考、不构成投资建议。
---

# A 股股票研究报告生成器

## 触发与输入

用户调用形式：`/equity-report-cn <6位代码>` 或自然语言"帮我生成 688981 的研报"。

支持的代码：
- 60xxxx（上交所主板）、68xxxx（科创板）
- 00xxxx（深交所主板）、30xxxx（创业板）
- 8xxxxx（北交所）

## 运行环境：单轮非交互（先读这段，它约束下面所有步骤）

本技能由 openclaw 的 equity-research 插件通过

```
claude-deepseek --print "/equity-report-cn <代码>"
```

拉起 —— **一次性单轮、无人值守、`bypassPermissions`**。调用方唯一读取的成功信号是
「`reports/pdf/{SYMBOL}_{YYYYMMDD}.pdf` 有没有落地」，它读不懂正文里的任何请示。

由此三条不可违反：

1. **禁止向用户提问、禁止给选项让用户拍板、禁止等待确认。** 没有第二轮，任何
   「回复一句即可」都等于永久挂起，插件最终报 `no_pdf_produced`。
2. 所有分歧按本文件既定规则**自行裁决**。本文件没写到的情形，一律取「照常出报告
   ＋ 在缺失项里如实标注」，不取「停下来问」。
3. 只有 `validate.py` exit 1（约束 7 的四项核心数据缺失）才允许不出报告，且必须
   打印缺失清单后**直接结束**，不附任何征询。

> 2026-08-22、08-23 两次 300877（金春股份）请求就栽在这里：该股无券商研报覆盖，
> 校验失败后本技能停下来问「继续标注无覆盖 / 严格停止」，无人能答，两次都空手而归。
> 而它的核心数据其实全齐。

## 执行流程（严格按顺序）

### 步骤 1：数据采集（必须先于写作）

```bash
.venv/bin/python tools/run_pipeline.py <SYMBOL>
```

该脚本会按顺序运行：

所有数据按股票代码分目录存放，统一布局：

```
data/{SYMBOL}/
├── aggregate.json       # 汇总（核心阶段产物，下游读取入口）
├── basic.json           # 行情/估值/财务/资金流/两融/龙虎榜/基准指数原始
├── governance.json      # 十大股东 / 研报 / 限售解禁原始
├── news.json            # 公告 / 新闻 / 业绩快报原始
├── annual.json          # 年报关键段落 + 最新半年报分产品表（扩展）
├── peers.json           # 同业对照（扩展）
├── earnings_call.json   # 业绩说明会 / IR / 关键事项公告正文 / 互动易问答（扩展）
└── annual_pdf/{art_code}.pdf  # 年报与半年报 PDF 全文（常态缓存，annual.json 的 pdf_local 指向它）
```

**核心阶段**
- 行情、估值、5 年三表、季度数据、十大股东、研报（含 EPS 共识）、公告、新闻、业绩快报、资金流
- 两融余额（`margin_recent`）、龙虎榜（`lhb_recent`）、限售解禁队列（`restricted_release`）、
  同板块宽基指数（`benchmark_index`）、共识 EPS 是否存在（`consensus_eps_available`）
- 季度窗口、十大股东季末、公告窗口一律由数据与当天日期推出（公告从上一年 1 月 1 日起），不写死年份
- 其中**只有约束 7 的四项（最新季报 / 5 年财务 / 价格历史 / 十大股东）是"必须成功"**；
  研报、公告、新闻、业绩快报、资金流缺失只产生警告，由步骤 2 的退出码裁定，不要自行加码
- 三个分类原始文件落到 `data/{SYMBOL}/{basic,governance,news}.json`，再汇总到 `data/{SYMBOL}/aggregate.json`

**扩展阶段**（独立运行，失败不阻断核心）
- `fetch_annual_pdf.py` → `data/{SYMBOL}/annual.json`：年报关键段落（业务分部 / 客户集中度 / Capex / 风险 / 战略 / 董监高报酬）；最新半年报比最新年报新时，另抽其分产品表到 `semiannual`。**PDF 原文常态缓存**到 `data/{SYMBOL}/annual_pdf/{art_code}.pdf`，`annual.json` 不保留全文，仅以 `pdf_local` 指向 PDF 路径，下游需全文请直接读 PDF。
- `fetch_peers.py` → `data/{SYMBOL}/peers.json`：同业对照。行业池（`competitor_pool.json`）命中用池内名单；未命中回退到东财行业排名近邻，`peer_source` 标明来源
- `fetch_earnings_call.py` → `data/{SYMBOL}/earnings_call.json`：业绩说明会 / 投资者关系活动 / 月度经营 / 回购进展 / 重大合同 / 会计政策变更 / 对外投资 / 限售股上市流通的公告正文，外加深市互动易已回复问答（`irm_qa`）

### 步骤 2：数据校验

```bash
.venv/bin/python tools/validate.py <SYMBOL>
```

校验对象为 `data/{SYMBOL}/aggregate.json`。按退出码**确定性**分支，不得询问：

| 退出码 | 含义 | 动作 |
|---|---|---|
| `0` | 核心字段齐备 | 继续步骤 3 |
| `2` | 非核心字段缺失 / 数据警告 | **继续步骤 3**。把 stdout 的每一条警告原样落进报告末尾「附：自动化流程缺失项」表格，正文对应位置标"未取得，原因：xxx" |
| `1` | 核心字段缺失（= 约束 7 的四项） | **停止**。打印缺失清单后直接结束，不出报告、不征询、不降级 |

**`exit 2` 是常态，不是异常。** 无券商研报覆盖、当年无公告、拿不到主营描述都会走
这条路，一律照常出报告 —— 判断依据只有退出码，不要自己重新评估"这个字段是不是
其实挺重要"。

`exit 2` 的警告还包括两类，处理同上：
- **新鲜度**：「最新季报过期」「十大流通股东早于最新财报期」「行情日期不一致」—— 数据有但旧或不同步。
  照常出报告，1.1、1.5、3.3、6.3 节首行写明各项数据分别截至哪一天；不得从外部来源补数。
- **取数失败**：「basic.fund_flow 取数失败：…」这类原始层 errors，对应正文标"未取得，原因：接口取数失败"。

> 2026-09-15 的 301557 就是反例：季度窗口、十大股东季末、公告起点三处写死的日期同时过期，
> 26Q1/26Q2、半年报股东名单、2025 年公告全部缺失，校验却 exit 0，报告整段用旧数据写成。

### 步骤 3：读取数据并生成报告

读 `data/{SYMBOL}/aggregate.json`；`annual.json` 的 `semiannual`（最新半年报分产品表）与 `earnings_call.json` 的关键事项公告正文**存在时必读**，`peers.json` 读前先看 `peer_source`（字段用法见 `data_contract.md`）。按 `template.md` 的 8 节骨架填充，遵循 `reasoning_protocol.md` 的推理协议与 `style_guide.md` 的语言规范。

输出到：`reports/{SYMBOL}_{YYYYMMDD}.md`

### 步骤 4：自检

报告生成后，自检：
- 所有 `{{占位符}}` 已替换
- 判断性陈述末尾带 `[H/M/L]` 标记
- 数据缺失项显式标"未取得，原因：xxx"，无空表格

### 步骤 5：转 PDF（必跑）

自检通过后，运行：

```bash
.venv/bin/python tools/md_to_pdf.py <SYMBOL>
```

该脚本会：
1. 读取 `reports/{SYMBOL}_{YYYYMMDD}.md`；
2. **保留末尾"附：自动化流程缺失项"表格** —— 交付出去的就是 PDF，缺口清单必须跟着一起到读者手上，不能只留在 .md 里；
3. 把开头 4 行（公司名称/副标题/报告日期/分析师）提升为 pandoc YAML 元数据，渲染真·标题页；
4. 用 `tools/pdf_header.tex` 作为 LaTeX preamble（`ctexart` + 强制 SC 字形 + Noto CJK SC + DejaVu 西文 + 彩色章节标题 + booktabs 表格 + 引用块 tcolorbox + 页眉脚），通过 `pandoc --pdf-engine=xelatex` 生成 PDF；
5. 输出到 `reports/pdf/{SYMBOL}_{YYYYMMDD}.pdf`。

**注意**：PDF 与 .md 内容一致，均含完整附录。曾经 PDF 会剥掉"自动化流程缺失项"表格，导致收报告的人看不到这份报告到底缺了什么 —— 已改为保留，勿回退。脚本依赖 `pandoc + texlive-xetex + texlive-lang-chinese`，缺则脚本会用清晰错误信息退出；本地未装时执行 `sudo apt install -y pandoc texlive-xetex texlive-lang-chinese`。

## 强制约束（7 条，违反任何一条即失败）

1. **零编造**：所有数字必须来自 `data/{SYMBOL}/` 下的流水线产物：`aggregate.json` 为主，`annual.json` / `peers.json` / `earnings_call.json` 为辅；aggregate 未汇总的三表科目（最新一期资产负债表、现金流量表、营业成本等）可读原始层 `basic.json` 的 `report_*` 表，须写明报告期（映射见 `data_contract.md`）。JSON 为 null 的字段必须明示"未取得"，不得编造、推算、或从训练数据中取。
2. **置信度强制标记**：所有判断性句子以 `[H/M/L]` 结尾。`H` = 数据直接支撑；`M` = 推理合理但需验证；`L` = 弱证据，需人工 review。
3. **时间戳**：每节首行可 trace 到"基于 YYYY-MM-DD 收盘数据"。报告日 = `data.report_date`。
4. **CY 口径**：A 股使用日历年（CY）口径，不混用 FY。季度营收用单季差分（已在数据层处理），不直接用累计数。
5. **复权口径**：股价历史一律前复权（qfq）。
6. **共识预期给区间**：研报 EPS 预测给区间（如 `0.71–0.86`）+ 中位（`0.77`），不给单点估计。
   **豁免**：看 `aggregate.json` 的 `research_coverage` —— 为 `"none"`（已核实无任何券商
   研报覆盖）时，"共识预期"一节写「无券商覆盖，无 EPS 预测 / 评级 / 目标价」，本条不适用；
   为 `"unknown"`（研报接口取数失败）时写「未取得，原因：研报接口取数失败」；
   为 `"covered"` 但 `consensus_eps_available` 为 false（有研报、无任何 EPS 预测，常见于新股覆盖研报）时
   写「未取得，原因：覆盖研报未给出盈利预测」并列出机构 / 标题 / 日期。
   三种措辞不可互换：已核实无覆盖 / 我们没拿到 / 有人覆盖但没给数。
7. **拒绝降级生成**：核心数据（最新季报 / 5 年财务 / 价格历史 / 十大股东）任一缺失，**不出报告**，返回缺失清单。
   这四项的机器口径就是 `tools/validate.py` 的 `REQUIRED_PATHS`，**两者必须一致，改一边就要改另一边**。
   **反向同样成立**：不在这四项里的字段（研报共识、近期公告、主营描述、资金流、北向持股……）
   缺失一律**不阻断**，照常出报告并如实标注。曾经 `validate.py` 把研报共识也列进
   `REQUIRED_PATHS`，与本条冲突，导致无券商覆盖的小盘股一律出不了报告 —— 已修正，勿回退。

## 文件清单

| 文件 | 用途 |
|---|---|
| `SKILL.md`（本文件） | 总入口、执行流程、7 条约束 |
| `template.md` | 8 节骨架 + 占位符 |
| `reasoning_protocol.md` | 合成推理顺序、可证伪先于结论 |
| `style_guide.md` | 中文金融术语、单位（亿元）、CY 口径 |
| `data_contract.md` | 占位符 → JSON 字段的映射 |
| `../../tools/md_to_pdf.py` | 步骤 5：生成 PDF（含完整附录） |
| `../../tools/pdf_header.tex` | LaTeX preamble：强制 SC 字形 + 排版美化 |

## 已知限制（必须在报告"附：缺失项"中明示）

- **北向个股持股**：2024-08 后监管层停止公开每日个股北向持股数据（akshare/东财/Wind 各源数据均停在该日期附近）。这是**结构性限制**，无法通过换源解决。报告中此项标"未取得，原因：监管口径调整 (2024-08 起)"。
- **无券商研报覆盖**：小盘股常见（如 300877 金春股份），东财 reportapi 返回 `hits=0`。
  `run_pipeline.py` 会把它记成 `research_coverage="none"` 并落空数组 —— **这是客观事实，
  不是取数故障**，照常出报告，"共识预期"节按约束 6 的豁免写。
- **上市不足三年**：`price_history_points` 的 3 年 / 2 年前为 null，以上市首日收盘作起点，写明"上市不足三年"。
- **沪市 / 北交所互动问答**：`stock_irm_cninfo` 只覆盖深交所互动易；上证e互动（`stock_sns_sseinfo`）实测返回空。
  沪市与北交所的 `irm_qa` 恒为空，属结构性限制。
- **同业是"行业近邻"而非"同品种"**：`peer_source="eastmoney_industry_neighbors"` 时，名单来自东财同行比较的
  排名近邻窗口（如 301557 拿到的是塔筒 / 轴承 / 主机厂，不是罩体厂），估值对比须注明口径，结论置信度最高 M。
- **分部 / 报酬表抽取依赖年报模板措辞**：关键词未命中时 `business_segments` / `management_pay` 为空，
  写"未取得，原因：报告正文未抽取到"，并在附表建议人工读 `pdf_local` 指向的 PDF。
- **客户名称**：年报通常只披露"第一名…第五名"，无法补齐。
- **董监高逐笔增减持**：未接入（全市场表 17 万行、约 70 秒；深交所接口在 akshare 1.18.60 损坏），
  以公告列表中有无增减持公告替代，写明口径。
- **资金流**：`stock_individual_fund_flow` 走 push2his，本机偶发不通，失败时按取数失败警告处理。
- **CEO 公开访谈 / 业绩说明会全文 / 行业装机量与价格**：无可用接口，可用 WebSearch 但需人工挑选。
- 其他缺失项见 `validate.py` 的警告与各 fetcher 的执行结果

## 免责声明

每份报告末尾必须包含：
> 本报告为"输入股票代码 → 自动生成研报"工程化流水线输出，数据均来自公开源（akshare、东方财富、上交所等）。判断性陈述末尾以 [H/M/L] 标记置信度。**不构成投资建议**。
