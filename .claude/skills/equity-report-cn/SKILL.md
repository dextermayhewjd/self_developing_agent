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

**核心阶段**（必须成功）
- 行情、估值、5 年三表、季度数据、十大股东、研报（含 EPS 共识）、公告、新闻、业绩快报、资金流
- 三个分类原始文件落到 `data/{SYMBOL}/{basic,governance,news}.json`，再汇总到 `data/{SYMBOL}/aggregate.json`

**扩展阶段**（独立运行，失败不阻断核心）
- `fetch_annual_pdf.py` → `data/{SYMBOL}/annual.json`：年报关键段落（业务分部 / 客户集中度 / Capex / 风险 / 战略）。**PDF 原文常态缓存**到 `data/{SYMBOL}/annual_pdf/{art_code}.pdf`，`annual.json` 不再保留全文，仅以 `annual_meta.pdf_local` 指向 PDF 路径，下游需全文请直接读 PDF。
- `fetch_peers.py` → `data/{SYMBOL}/peers.json`：同业对照（行业池 from `competitor_pool.json`）
- `fetch_earnings_call.py` → `data/{SYMBOL}/earnings_call.json`：业绩说明会 / 投资者关系活动 / 月度经营 / 回购进展 全文

### 步骤 2：数据校验

```bash
.venv/bin/python tools/validate.py <SYMBOL>
```

校验对象为 `data/{SYMBOL}/aggregate.json`。退出码：
- `0` = 通过，可继续生成报告
- `1` = 核心字段缺失 → **必须停止**，向用户报缺失清单，不得生成报告
- `2` = 数据警告 → 可继续，但报告中必须明示

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
7. **拒绝降级生成**：核心数据（最新季报 / 5 年财务 / 价格历史 / 十大股东）任一缺失，**不出报告**，返回缺失清单。

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
- **CEO 公开访谈**：可用 WebSearch 但需人工挑选
- 其他缺失项见各 fetcher 的执行结果

## 免责声明

每份报告末尾必须包含：
> 本报告为"输入股票代码 → 自动生成研报"工程化流水线输出，数据均来自公开源（akshare、东方财富、上交所等）。判断性陈述末尾以 [H/M/L] 标记置信度。**不构成投资建议**。
