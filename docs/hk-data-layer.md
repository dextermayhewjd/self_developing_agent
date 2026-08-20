# 港股支持：只换数据层

判断稿 skill（`equity-thesis-cn`）**一个字都没改**。港股支持全部做在数据层：
`run_pipeline_hk.py` 产出与 A 股同 schema 的 `aggregate.json`，
下游的 `validate.py`、五个子 agent、`check_thesis.py` 原样跑通。

## 怎么用

和 A 股完全一样，代码位数决定走哪条管道（A 股 6 位，港股 5 位）：

```bash
python3 tools/validate.py 03858                    # 校验（纯 stdlib）
.venv/bin/python tools/run_pipeline.py 03858.HK    # 采集，自动分派到港股管道
```

`03858` / `03858.HK` / `3858` / `hk03858` 都认，内部统一归一成 5 位。

## 数据源（全部避开 push2his.eastmoney.com）

| 用途 | 接口 | 主机 |
|---|---|---|
| 前复权日线 | `stock_hk_daily` | 新浪 |
| 三表（年度 + 报告期） | `stock_financial_hk_report_em` | datacenter.em |
| 财务指标 5 年 | `stock_financial_hk_analysis_indicator_em` | datacenter.em |
| PE/PB/市值/股本 | `stock_hk_financial_indicator_em` | datacenter.em |
| 公司简介/核数师/年结日 | `stock_hk_company_profile_em` + `_security_profile_em` | datacenter.em |
| 同业池（全行业） | 东财 F10 行业对比三表，去掉 `CORRE_SECUCODE` 过滤 | datacenter.em |
| 券商评级/目标价 | `stock_hk_profit_forecast_et` | etnet.com.hk |
| 年报 + 招股章程 + 公告 | 披露易 `titleSearchServlet` | www1.hkexnews.hk |
| 股东（托管分布） | CCASS 持股查询（ASP.NET 表单） | www3.hkexnews.hk |
| 个股新闻 | `stock_news_em` | 东财（该接口直接吃港股代码） |

`push2*` 全线在本环境不可达，但没有一项非它不可。
`stock_hk_valuation_baidu` 与 `stock_hk_indicator_eniu` 实测均已失效（JSONDecodeError），
估值改由 `financial_indicator` + `valuation_comparison` 提供。

## 逐项对账：skill 要的东西齐不齐

按 `SKILL.md` / 五个 lens / `financial-redflags-cn` 里点名的每一项逐个验过（03858 实测）：

**文件级（8/8 齐）**：`aggregate.json`、`annual.json`、`basic.json`、`governance.json`、
`peers.json`、`earnings_call.json`、`news.json`、`annual_pdf/` 全部存在。

**字段级（9/9 齐）**：`business`、`research_reports`、`sections.business_segments`、
十大股东（CCASS 替代）、`financials_annual`、`financials_quarterly`、公告标题、
`earnings_call.categories`、同业池（72 家）。

**财务排雷的原料**：21 指标里除扣非外全部可算；九项排雷单里
商誉与「其他应收款/预付款拆分」须去年报附注（见下 B 类）。

## 缺口分两类，不要混为一谈

### A 类：港股制度/惯例上就不存在，换任何数据源都没有

| 项 | 说明 |
|---|---|
| 扣非净利润 | A 股监管口径，港股无此概念。恒为 null，**不必去年报找** |
| 季度数据 | 港股只披露中期(H1)与全年。`0630`=上半年，`1231`=下半年（全年减H1） |
| 销售收现比 | 港股现金流量表按惯例用**间接法**，没有「销售商品收到的现金」这一行，公司本身就没编。判断利润含金量改用净现比（两项都齐） |
| 逐日资金流 | 无。替代为南向持股快照（CCASS 席位 A00003+A00004） |
| 业绩说明会 / 投资者关系活动记录表 | 港股不强制披露，不上披露易（实测腾讯近 200 条备案里一条都没有）。替代为「業績公告」里的「管理層討論及分析」 |

### B 类：年报里有，只是东财港股模板不给 —— 必须去 PDF 读

| 项 | 说明 |
|---|---|
| 商誉 | 东财港股资产负债表**不设「商誉」独立科目**——实测腾讯 55 个科目里也没有，商誉被并进无形资产/其他项。**不要因为字段是 null 就判定公司无商誉** |
| 其他应收款 / 预付款项 | 合并为 `prepay_and_other_receivables`，无法拆分。排雷单第 2/4 项须读年报附注 |
| 分产品/分地区收入 | 不在三表里，读年报「分部資料」（`sections.business_segments`） |

两类都写进了 `aggregate.json` 的 `known_gaps`（按 `A_制度上不存在` / `B_年报里有但本文件没有`
分组），子 agent 读数据时就地看见——**把制度差异写成数据，而不是留给子 agent 去发现**。

科目数是随公司自适应的，不是固定薄模板：腾讯 55/27/52 项，佳鑫 34/24/28 项。
所以某个科目为 null，先分清是"这家公司真没有"（如佳鑫无在建工程/研发）
还是"模板不给"（商誉）。

## 三个已经踩过的坑（都在代码注释里留了痕）

### 1. 同一行 API 返回里币种是混的

东财行业对比接口，**同一行**：

- `OPERATE_INCOME` = 财报本位币原值（佳鑫 = 港元 960,166,214）
- `HKTOTAL_MARKET_CAP` = 折算成**人民币**的市值（247.67 亿）

比值 1.1560 正是中行港币中间价。市值不折回港元，就和行情、和指标表的
286.3 亿港元对不上，估值直接算错。折算在 `fetch_hk_peers.py` 里做，
并在 `aggregate.json` 的 `currency` 字段标明每组数字的币种。

港股财报本位币也未必是港元（可能 CNY/USD），`currency.financials`
取自接口的 `CURRENCY` 字段，不要默认。

### 2. `0.0` 是合法值，不能用 `or` 做回退

`stmt(...) or indv(...)` 这种写法会把真实的 `0.0` 当假值丢掉，
去取回退源的 `NaN`。佳鑫矿山 2025 年才投产，2022–2024 营收就是 `0.0`——
正好是这个 bug 的靶心，实测把 4 个真零替换成了 NaN。
统一改用 `_first(*vals)`（取首个 `is not None`）。

### 3. `NaN` 在 Python 里是 truthy

`float("nan")` 不抛异常，且 `bool(nan) == True`。它一旦漏进 JSON，
任何 `if v` 判断都会把它当有效数据。实测 `validate.py` 因此报过
"5 years of revenue data"，而真实只有 1 年——**假通过**。

三道防线：`_num()` 转换时拦截、`_clean()` 落盘前递归清洗、
`json.dumps(allow_nan=False)` 兜底（`NaN` 本来也不是合法 JSON）。

## 顺带修的两处共享代码

- `tools/lib.py`：`detect_market` 认 5 位码 → `hk`，新增 `normalize_symbol`；
  `board_name` 返回港交所板块。A 股路径逻辑未变。
- `tools/validate.py`：`non_null_years` 的真值判断改成 `is not None`
  （见坑 2，这个 bug 对 A 股同样存在，只是 A 股营收极少合法为 0 所以没暴露）；
  输出的货币符号改为按 `currency.quote_and_mcap` 取，不再硬编码 `¥`。

回归：4 只 A 股 `validate.py` 全部 exit 0；`300633` 跑完整 `run_pipeline.py`
（真实采集）exit 0，输出 `close=¥19.97`，符号回退正确。

## 没做的事

- **不从招股章程自动抽取数字填进结构化字段**。招股章程 PDF 已落盘并做了
  段落定位（`annual.json` 的 `sections_prospectus`，含 `track_record`、
  `accountant_report`、`use_of_proceeds`、`cornerstone` 等港股独有段落），
  由子 agent 自己读原文。自动抽 955 页 PDF 里的表格数字风险太高，
  与"零编造"冲突。
- **权益披露（di.hkex.com.hk）未接**。实益持有人目前靠年报
  「主要股東權益」章节（已在 `sections.substantial_shareholders` 里定位）。
  CCASS 只反映托管席位分布，佳鑫的 CCASS 合计仅约占已发行股本 33%，
  其余为直接登记的控股股东——这个 caveat 写在 `ccass.json` 与
  `aggregate.json.ccass_caveat` 里。
- **方法论层未动**。港股独有的分析维度（港股通资格、公众持股量、
  同股不同权、核数师是否四大、注册地税率）目前只是把**数据**放进了
  `aggregate.json`（`business` 里的核数师/年结日/是否港股通标的，
  `annual.json` 的 `public_float`/`auditor`/`connected_transactions` 段落），
  lenses 里没有对应的追问指引。要不要补是下一步的决定。
