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
├── basic.json           # 行情/估值/财务/资金流原始
├── governance.json      # 十大股东 / 研报原始
├── news.json            # 公告 / 新闻 / 业绩快报原始
├── annual.json          # 年报正文 + 关键段落（扩展）
├── peers.json           # 同业对照（扩展）
├── earnings_call.json   # 业绩说明会 / IR / 月度经营 / 回购（扩展）
└── annual_pdf/{art_code}.pdf  # 年报 PDF 全文（常态缓存，annual.json 的 annual_meta.pdf_local 指向它）
```

**核心阶段**
- 行情、估值、5 年三表、季度数据、十大股东、研报（含 EPS 共识）、公告、新闻、业绩快报、资金流
- 其中**只有约束 7 的四项（最新季报 / 5 年财务 / 价格历史 / 十大股东）是"必须成功"**；
  研报、公告、新闻、业绩快报、资金流缺失只产生警告，由步骤 2 的退出码裁定，不要自行加码
- 三个分类原始文件落到 `data/{SYMBOL}/{basic,governance,news}.json`，再汇总到 `data/{SYMBOL}/aggregate.json`

**扩展阶段**（独立运行，失败不阻断核心）
- `fetch_annual_pdf.py` → `data/{SYMBOL}/annual.json`：年报关键段落（业务分部 / 客户集中度 / Capex / 风险 / 战略）。**PDF 原文常态缓存**到 `data/{SYMBOL}/annual_pdf/{art_code}.pdf`，`annual.json` 不再保留全文，仅以 `annual_meta.pdf_local` 指向 PDF 路径，下游需全文请直接读 PDF。
- `fetch_peers.py` → `data/{SYMBOL}/peers.json`：同业对照（行业池 from `competitor_pool.json`）
- `fetch_earnings_call.py` → `data/{SYMBOL}/earnings_call.json`：业绩说明会 / 投资者关系活动 / 月度经营 / 回购进展 全文

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

### 步骤 3：读取数据并生成报告

读 `data/{SYMBOL}/aggregate.json`（必要时辅以 `annual.json`/`peers.json`/`earnings_call.json`），按 `template.md` 的 8 节骨架填充，遵循 `reasoning_protocol.md` 的推理协议与 `style_guide.md` 的语言规范。

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
2. **删除末尾"附：自动化流程缺失项"表格**（保留"报告口径声明"段）；
3. 把开头 4 行（公司名称/副标题/报告日期/分析师）提升为 pandoc YAML 元数据，渲染真·标题页；
4. 用 `tools/pdf_header.tex` 作为 LaTeX preamble（`ctexart` + 强制 SC 字形 + Noto CJK SC + DejaVu 西文 + 彩色章节标题 + booktabs 表格 + 引用块 tcolorbox + 页眉脚），通过 `pandoc --pdf-engine=xelatex` 生成 PDF；
5. 输出到 `reports/pdf/{SYMBOL}_{YYYYMMDD}.pdf`。

**注意**：原始 .md 保留完整附录（含"自动化流程缺失项"），便于追溯；只有 PDF 版剥离附录。脚本依赖 `pandoc + texlive-xetex + texlive-lang-chinese`，缺则脚本会用清晰错误信息退出；本地未装时执行 `sudo apt install -y pandoc texlive-xetex texlive-lang-chinese`。

## 强制约束（7 条，违反任何一条即失败）

1. **零编造**：所有数字必须来自 `data/{SYMBOL}/aggregate.json`；JSON 为 null 的字段必须明示"未取得"，不得编造、推算、或从训练数据中取。
2. **置信度强制标记**：所有判断性句子以 `[H/M/L]` 结尾。`H` = 数据直接支撑；`M` = 推理合理但需验证；`L` = 弱证据，需人工 review。
3. **时间戳**：每节首行可 trace 到"基于 YYYY-MM-DD 收盘数据"。报告日 = `data.report_date`。
4. **CY 口径**：A 股使用日历年（CY）口径，不混用 FY。季度营收用单季差分（已在数据层处理），不直接用累计数。
5. **复权口径**：股价历史一律前复权（qfq）。
6. **共识预期给区间**：研报 EPS 预测给区间（如 `0.71–0.86`）+ 中位（`0.77`），不给单点估计。
   **豁免**：看 `aggregate.json` 的 `research_coverage` —— 为 `"none"`（已核实无任何券商
   研报覆盖）时，"共识预期"一节写「无券商覆盖，无 EPS 预测 / 评级 / 目标价」，本条不适用；
   为 `"unknown"`（研报接口取数失败）时写「未取得，原因：研报接口取数失败」。
   两者措辞不可互换：前者是已核实的事实，后者是我们没拿到。
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
| `../../tools/md_to_pdf.py` | 步骤 5：剥附录 + 生成 PDF |
| `../../tools/pdf_header.tex` | LaTeX preamble：强制 SC 字形 + 排版美化 |

## 已知限制（必须在报告"附：缺失项"中明示）

- **北向个股持股**：2024-08 后监管层停止公开每日个股北向持股数据（akshare/东财/Wind 各源数据均停在该日期附近）。这是**结构性限制**，无法通过换源解决。报告中此项标"未取得，原因：监管口径调整 (2024-08 起)"。
- **无券商研报覆盖**：小盘股常见（如 300877 金春股份），东财 reportapi 返回 `hits=0`。
  `run_pipeline.py` 会把它记成 `research_coverage="none"` 并落空数组 —— **这是客观事实，
  不是取数故障**，照常出报告，"共识预期"节按约束 6 的豁免写。
- **CEO 公开访谈**：可用 WebSearch 但需人工挑选
- 其他缺失项见各 fetcher 的执行结果

## 免责声明

每份报告末尾必须包含：
> 本报告为"输入股票代码 → 自动生成研报"工程化流水线输出，数据均来自公开源（akshare、东方财富、上交所等）。判断性陈述末尾以 [H/M/L] 标记置信度。**不构成投资建议**。
