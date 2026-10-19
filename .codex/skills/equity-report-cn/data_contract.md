# 数据契约（占位符 → JSON 字段）

所有占位符必须能映射到 `data/{SYMBOL}/aggregate.json` 的某个字段，或由该字段计算得出。扩展数据另见 `data/{SYMBOL}/annual.json`、`peers.json`、`earnings_call.json`。

## Header 与现价

| 占位符 | JSON 路径 | 计算方式 |
|---|---|---|
| `{{SYMBOL}}` | `symbol` | 直接读 |
| `{{COMPANY_CN}}` | `business.股票代码` 关联 / `top10_total[*]` 反查 | 需补抓表（见 5.缺失） |
| `{{MARKET_UPPER}}` | `market` → `SH` / `SZ` / `BJ` | upper(market) |
| `{{REPORT_DATE}}` | `report_date` | 直接读 |
| `{{QUOTE_DATE}}` | `quote_latest.date_close` | 直接读 |
| `{{PRICE_LATEST}}` | `quote_latest.close` | 保留 2 位小数 |
| `{{PRICE_CHG_PCT}}` | `quote_latest.change_pct` | 1 位小数 + `%` |
| `{{MCAP_TOTAL_YI}}` | `valuation.total_mcap_yuan` | ÷ 1e8，保留 1 位 |
| `{{MCAP_FLOAT_YI}}` | `valuation.float_mcap_yuan` | ÷ 1e8，保留 1 位 |
| `{{PE_TTM}}` | `valuation.pe_ttm` | 1 位小数 |
| `{{PB}}` | `valuation.pb` | 2 位小数 |
| `{{PS}}` | `valuation.ps` | 2 位小数 |

`quote_latest.date_close` 早于 `valuation.as_of` 时（日线源还没更新到最新交易日，`validate.py` 报「行情日期不一致」），
现价、市值、估值倍数统一取 `valuation.close` / `valuation.as_of`，并注明日线序列止于哪天——否则现价与 PE 对不上。

## 历史价格

| 占位符 | JSON 路径 |
|---|---|
| `{{PRICE_3YR_AGO}}` / `{{P_3YR}}` | `price_history_points` 的第 1 个 key |
| `{{P_2YR}}` | 第 2 个 key |
| `{{P_1YR}}` | 第 3 个 key |
| `{{PRICE_3YR_CHG_PCT}}` | `(P_LATEST / P_3YR - 1) * 100` 取 1 位 |
| `{{PRICE_3YR_CAGR}}` | `(P_LATEST / P_3YR) ** (1/3) - 1` × 100，取 1 位 |

## 5 年财务（CY{{Y1}}–CY{{Y5}}）

JSON 路径 `financials_annual.<metric>` 是 `{"20211231": value, ...}` 的字典。
- 单位：原始为"元"，除以 1e8 转"亿元"
- `gross_margin_pct` / `roe_pct` 已是百分数，直接显示

| 占位符 | metric | 单位 |
|---|---|---|
| `{{REV_Y1..Y5}}` | revenue | 亿元 |
| `{{NP_Y1..Y5}}` | net_profit_attributable | 亿元 |
| `{{GM_Y1..Y5}}` | gross_margin_pct | % |
| `{{ROE_Y1..Y5}}` | roe_pct | % |
| `{{OCF_Y1..Y5}}` | operating_cashflow | 亿元 |
| `{{DR_Y1..Y5}}` | debt_ratio_pct | % |
| `{{NM_Y1..Y5}}` | net_margin_pct | % |
| `{{OPM_Y1..Y5}}` | gross_margin_pct − opex_ratio_pct | % （估算）|
| `{{EPS_Y1..Y5}}` | eps_basic | 元 |
| `{{REV_YOY_Yi}}` | (REV_Yi / REV_Y(i-1) - 1) × 100 | % |

## 季度数据（最近 8 季）

| 占位符 | JSON 路径 |
|---|---|
| `{{Q1_LABEL}}..{{Q8_LABEL}}` | `financials_quarterly.revenue_single` 的 key（YYYYMMDD 转 YYQn） |
| `{{Q1_REV}}..{{Q8_REV}}` | 同上 value ÷ 1e8 |
| `{{Q1_QOQ}}..{{Q8_QOQ}}` | 单季环比 |

key 是财务摘要里**实际最新**的 8 个季末（以最新报告期为终点，含当年）。`validate.py` 若报
「最新季报过期」，照常出报告，但 1.1 与 3.3 节首行写明季度数据止于哪一期，并进附表。

## 业绩快报（CY{{LAST_YEAR}}）

| 占位符 | JSON 路径 |
|---|---|
| `{{REV_LATEST_YI}}` | `earnings_flash[0].营业总收入-营业总收入` ÷ 1e8 |
| `{{REV_YOY}}` | `earnings_flash[0].营业总收入-同比增长` |
| `{{NP_LATEST_YI}}` | `earnings_flash[0].净利润-净利润` ÷ 1e8 |
| `{{NP_YOY}}` | `earnings_flash[0].净利润-同比增长` |
| `{{EPS_LATEST}}` | `earnings_flash[0].每股收益` |
| `{{BVPS_LATEST}}` | `earnings_flash[0].每股净资产` |
| `{{GM_LATEST}}` | `earnings_flash[0].销售毛利率` |
| `{{ROE_LATEST}}` | `earnings_flash[0].净资产收益率` |
| `{{EARNINGS_FLASH_DATE}}` | `earnings_flash[0].最新公告日期` |

若 `earnings_flash` 为空数组，所有上述字段标"未取得"。

## 研报共识 EPS

来源：`research_reports` 数组中：
- `2026-盈利预测-收益` → EPS 2026E
- `2027-盈利预测-收益` → EPS 2027E
- 取非空值的 min/median/max

| 占位符 | 计算 |
|---|---|
| `{{EPS_NEXT_LO}}` / `{{EPS_NEXT_HI}}` / `{{EPS_NEXT_MEDIAN}}` | 2026E EPS 区间与中位 |
| `{{EPS_NEXT2_LO}}` / `{{EPS_NEXT2_HI}}` / `{{EPS_NEXT2_MEDIAN}}` | 2027E EPS |
| `{{NEXT_YEAR}}` / `{{NEXT2_YEAR}}` | 当前年 / 当前年+1 |

**先看 `research_coverage`，再看数组** —— 它决定这一节怎么写：

| `research_coverage` | 含义 | 写法 |
|---|---|---|
| `"covered"` 且 `consensus_eps_available` 为 true | 有券商覆盖且有 EPS 预测 | 按上表填区间 + 中位 |
| `"covered"` 且 `consensus_eps_available` 为 false | 有研报，但一个 EPS 预测都没有（常见于新股覆盖研报） | 所有 EPS 占位符写「未取得，原因：覆盖研报未给出盈利预测」，并列出机构 / 标题 / 日期；不得写成"无券商覆盖" |
| `"none"` | 已核实无任何券商研报（东财 `hits=0`） | 所有 EPS 占位符写「无券商覆盖」，注明"无 EPS 预测 / 评级 / 目标价" |
| `"unknown"` | 研报接口取数失败 | 所有 EPS 占位符写「未取得，原因：研报接口取数失败」 |

三种措辞不可互换：`"none"` 是已核实无覆盖，`"unknown"` 是我们没拿到，`covered` + 无预测是
"有人覆盖但没给数"。

## 股东（截至 `top10_free_as_of`）

JSON 数组 `top10_free`，每项含 `名次 / 股东名称 / 股份类型 / 占总流通股本持股比例 / 变动比率`。

直接映射到 6.3 表格。`top10_free_as_of` 与季度数据最新期不一致时 `validate.py` 会报警告，表头如实写截至日。

`restricted_release`（限售解禁队列，含已解禁与未解禁批次）→ 1.4 催化剂与 6.4：写明未来最近一批的
解禁时间、数量（亿股）、占总股本比例、解禁股东数；空数组 = 无限售股。

## 公告 / 重组事件

JSON 数组 `announcements_recent`，每项含 `公告日期 / 公告标题 / 公告类型`。

- 过滤 `公告类型` 包含 "并购重组" / "回复问询函" / "重大事项" 的为"重大事件"
- 过滤 `公告标题` 含 "业绩说明会" / "投资者关系" 的进 3.4 节

## 资金流（最近 5 日）

JSON 数组 `fund_flow_recent`，含每日 `主力净流入-净额` 等。
- 取最后 5 日累计
- T-1 单日数据进 1.8 节

## 两融 / 龙虎榜 / 基准指数

| JSON 路径 | 用于 | 写法 |
|---|---|---|
| `margin_recent`（近 60 个交易日，升序） | 1.8 融资融券 | 最新融资余额（亿元）、融资余额占流通市值比、较 20 个交易日前变化；空数组 = 非两融标的，写"非融资融券标的" |
| `lhb_recent`（上一年 1 月 1 日至今，本股上榜记录） | 1.8 龙虎榜 | 列上榜日、上榜原因、龙虎榜净买额；空数组写"上一年 1 月 1 日至今未上榜" |
| `benchmark_index`（`code` / `name` / `closes` 近 500 个交易日） | 5.2 | 每个事件区间算同期指数涨跌，与个股涨跌对照拆 Alpha / Beta；只有宽基（创业板指 / 科创50 / 北证50 / 沪深300），行业指数未接 |

## 扩展数据（annual / peers / earnings_call）

| JSON 路径 | 用于 | 写法 |
|---|---|---|
| `annual.json` `sections.business_segments` | 2.2 | 最新年报分产品 / 分行业表 |
| `annual.json` `semiannual.sections.business_segments` | 2.2、1.1、1.7 | 仅当半年报比最新年报新时存在；补 H1 分产品收入、同比、毛利率。增长来源与年报叙事不一致时以半年报为准 |
| `annual.json` `sections.management_pay` → `{{MANAGEMENT_PAY_OR_GAP}}` | 6.1 | 主要董事、高管税前报酬；无命中写"未取得，原因：年报报酬表未抽取到" |
| `annual.json` `sections.customer_concentration` / `supplier_concentration` | 7.2 | 前五大客户 / 供应商占比；年报多不披露客户名称，写"年报未披露名称" |
| `peers.json` `peer_source` | 7.3、1.5 | `competitor_pool` = 手工同业池；`eastmoney_industry_neighbors` = 东财行业排名近邻，**不是同品种确认**，表头或脚注必须写明，据此得出的估值对比结论置信度最高 M；`none` = 只有本公司，写"未取得" |
| `earnings_call.json` `categories.material_contract` | 1.4、2.1、8.2 | 重大合同正文：合同对手、金额、期限，折算占上年营收比例 |
| `categories.accounting_change` | 4.3 | 会计政策变更的内容与对报表的影响 |
| `categories.investment` | 6.2 | 对外投资 / 产业基金的出资额、投向、进展 |
| `categories.lockup_release` | 1.4、6.4 | 与 `restricted_release` 交叉核对 |
| `categories.pledge` | 6.3、1.7 | 控股股东 / 一致行动人质押的股数、占其持股比例、质押用途 |
| `earnings_call.json` `irm_qa` | 3.4 | 互动易已回复问答；仅深市有，沪市 / 北交所为空时写"未取得，原因：上证e互动无可用接口" |

## 缺失字段（必须显式标"未取得"）

| 字段 | 影响占位符 | 性质 |
|---|---|---|
| 北向最新持股 | `{{HSGT_SUMMARY_OR_GAP_NOTICE}}` | 结构性：监管 2024-08 起停止公开 |
| 上市不足三年的价格点（`price_history_points` 为 null） | 1.1、5.1 | 结构性：以上市首日收盘替代，写明"上市不足三年" |
| 业绩说明会全文 / CEO 访谈 | `{{EARNINGS_CALL_STATUS_OR_GAP}}` / `{{CEO_INTERVIEW_STATUS_OR_GAP}}` | 无接口，只有投资者关系活动记录表 |
| 董监高逐笔增减持 | 6.4 | 未接入：以公告列表中有无增减持公告替代，写明口径 |
| 行业装机量 / 价格 / 市场份额 | 2.1、7.1 | 无可靠免费源 |

## 公司名兜底

公司名在 `data/{SYMBOL}/aggregate.json` 中可能为 null。Fallback 顺序：
1. `earnings_flash[0].股票简称`
2. `research_reports[0].股票简称`
3. `news_recent` 中标题里的简称
4. 都没有 → 输出"`{SYMBOL}`"代替
