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

## 股东（截至 `top10_free_as_of`）

JSON 数组 `top10_free`，每项含 `名次 / 股东名称 / 股份类型 / 占总流通股本持股比例 / 变动比率`。

直接映射到 6.3 表格。

## 公告 / 重组事件

JSON 数组 `announcements_recent`，每项含 `公告日期 / 公告标题 / 公告类型`。

- 过滤 `公告类型` 包含 "并购重组" / "回复问询函" / "重大事项" 的为"重大事件"
- 过滤 `公告标题` 含 "业绩说明会" / "投资者关系" 的进 3.4 节

## 资金流（最近 5 日）

JSON 数组 `fund_flow_recent`，含每日 `主力净流入-净额` 等。
- 取最后 5 日累计
- T-1 单日数据进 1.8 节

## 缺失字段（必须显式标"未取得"）

| 字段 | 影响占位符 |
|---|---|
| 公司中文名 | `{{COMPANY_CN}}` —— 暂时从 top10_free / 业绩快报中反查"股票简称" |
| 业务分部明细 | `{{BUSINESS_SEGMENTS_PARAGRAPH_OR_GAP_NOTICE}}` |
| 客户集中度 | `{{DOWNSTREAM_DETAIL}}` |
| 业绩说明会纪要 | `{{EARNINGS_CALL_STATUS_OR_GAP}}` |
| 同业对照 | `{{A_SHARE_PEERS}}` / `{{INDUSTRY_RESEARCH_OR_GAP}}` |
| 北向最新持股 | `{{HSGT_SUMMARY_OR_GAP_NOTICE}}` |

## 公司名兜底

公司名在 `data/{SYMBOL}/aggregate.json` 中可能为 null。Fallback 顺序：
1. `earnings_flash[0].股票简称`
2. `research_reports[0].股票简称`
3. `news_recent` 中标题里的简称
4. 都没有 → 输出"`{SYMBOL}`"代替
