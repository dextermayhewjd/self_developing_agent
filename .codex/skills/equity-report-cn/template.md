# 报告模板（8 节骨架）

> 占位符以 `{{KEY}}` 标识。生成时全部替换。

---

公司名称：{{COMPANY_CN}}（{{SYMBOL}}.{{MARKET_UPPER}}{{H_SHARE_TAG_IF_ANY}}）
副标题：{{SUBTITLE_ONE_LINE}}
报告日期：{{REPORT_DATE}}（Asia/Shanghai）
分析师：Self-Developing-Agent 自动稿（输入 → ticker；数据截至 T-0 收盘）

> 置信度说明：判断性陈述末尾以 `[H/M/L]` 标记。`H` = 数据直接支撑；`M` = 推理合理但需进一步验证；`L` = 弱证据/需人工 review。

---

## 一、核心摘要（Summary）

### 1.1 投资主张（Thesis）

过去三年 {{COMPANY_CN}} 的基本面与股价呈现"{{THESIS_FRAMING_ONE_LINE}}"的过程：

- **基本面位置**：{{FUNDAMENTALS_POSITION_PARAGRAPH}} [H/M/L]
- **市场情绪位置**：股价从 {{PRICE_3YR_AGO_DATE}} 收盘 ¥{{PRICE_3YR_AGO}} → {{REPORT_DATE}} 收盘 ¥{{PRICE_LATEST}}，三年涨跌 {{PRICE_3YR_CHG_PCT}}，三年 CAGR {{PRICE_3YR_CAGR}}。[H]
- **共识与分歧**：{{CONSENSUS_VS_DISAGREEMENT_PARAGRAPH}} [M]
- **核心驱动组合**：{{DRIVER_COMPOSITION_ONE_LINE}}。[M]

### 1.2 关键假设（Key Assumptions）

| # | 假设 | 观察指标 | 来源 | 频率 |
|---|---|---|---|---|
| 1 | {{ASSUMPTION_1}} | {{METRIC_1}} | {{SOURCE_1}} | {{FREQ_1}} |
| 2 | {{ASSUMPTION_2}} | {{METRIC_2}} | {{SOURCE_2}} | {{FREQ_2}} |
| 3 | {{ASSUMPTION_3}} | {{METRIC_3}} | {{SOURCE_3}} | {{FREQ_3}} |
| 4 | {{ASSUMPTION_4}} | {{METRIC_4}} | {{SOURCE_4}} | {{FREQ_4}} |
| 5 | {{ASSUMPTION_5}} | {{METRIC_5}} | {{SOURCE_5}} | {{FREQ_5}} |

### 1.3 可证伪点（Falsification）

未来 2 个季度若出现以下任一信号，主张需重审：

1. {{FALSIFICATION_1}}；
2. {{FALSIFICATION_2}}；
3. {{FALSIFICATION_3}}；
4. {{FALSIFICATION_4}}。 [置信度逐条标注]

### 1.4 催化剂时间轴（Catalysts）

**1–6 个月（事件驱动）**
- {{CATALYST_NEAR_1}}
- {{CATALYST_NEAR_2}}
- {{CATALYST_NEAR_3}}

**6–18 个月（基本面驱动）**
- {{CATALYST_MID_1}}
- {{CATALYST_MID_2}}
- {{CATALYST_MID_3}}

<!-- 催化剂必查：restricted_release 里未来 18 个月内的解禁批次；earnings_call.json 的 material_contract / investment 正文。 -->

### 1.5 估值（Valuation）

**现价与基础数据（截至 {{QUOTE_DATE}} 收盘）**

- 收盘价 ¥{{PRICE_LATEST}}（{{PRICE_CHG_PCT}}）
- 总市值 ¥{{MCAP_TOTAL_YI}} 亿
- 流通市值 ¥{{MCAP_FLOAT_YI}} 亿
- PE(TTM) {{PE_TTM}}x；P/B {{PB}}x；P/S {{PS}}x
- TTM 归母净利 ¥{{TTM_NET_PROFIT_YI}} 亿；TTM EPS ¥{{TTM_EPS}}

**方法选择**：{{VALUATION_METHOD_RATIONALE_PARAGRAPH}}

### 1.6 回报结构（Payoff）

> **共识 EPS（机构研报中位）**：{{NEXT_YEAR}}E ¥{{EPS_NEXT_MEDIAN}}（区间 ¥{{EPS_NEXT_LO}}–{{EPS_NEXT_HI}}），{{NEXT2_YEAR}}E ¥{{EPS_NEXT2_MEDIAN}}（区间 ¥{{EPS_NEXT2_LO}}–{{EPS_NEXT2_HI}}）。

<!-- 无覆盖时（aggregate.json 的 research_coverage == "none"）整行替换为下面这句，
     不要留空占位符、不要写 "¥–"：
> **共识 EPS**：该股无券商研报覆盖（东财 reportapi 返回 0 条），无 EPS 预测 / 评级 / 目标价。
> 下表情景 EPS 由本报告依据历史财务自行推演，缺少卖方共识作为交叉验证，置信度相应下调。
     research_coverage == "unknown" 时改写为「未取得，原因：研报接口取数失败」。
     research_coverage == "covered" 但 consensus_eps_available == false（有研报、无任何 EPS 预测）时改写为
     「未取得，原因：覆盖研报未给出盈利预测」并列出机构 / 标题 / 日期，不得写成"无券商覆盖"。 -->

| 情景 | 核心假设 | 估值方法 | 估值区间（前瞻 PE） | EPS（{{NEXT2_YEAR}}E） | 目标价区间 | 较现价隐含回报 |
|---|---|---|---|---|---|---|
| Bear | {{BEAR_ASSUMPTION}} | PE | {{BEAR_PE_LO}}–{{BEAR_PE_HI}}x | {{BEAR_EPS}} | ¥{{BEAR_PRICE_LO}}–{{BEAR_PRICE_HI}} | {{BEAR_RETURN}} |
| Base | {{BASE_ASSUMPTION}} | PE | {{BASE_PE_LO}}–{{BASE_PE_HI}}x | {{BASE_EPS}} | ¥{{BASE_PRICE_LO}}–{{BASE_PRICE_HI}} | {{BASE_RETURN}} |
| Bull | {{BULL_ASSUMPTION}} | PE | {{BULL_PE_LO}}–{{BULL_PE_HI}}x | {{BULL_EPS}} | ¥{{BULL_PRICE_LO}}–{{BULL_PRICE_HI}} | {{BULL_RETURN}} |

（以现价 ¥{{PRICE_LATEST}} 为锚。）

**P/B–ROE 交叉验证**：{{PB_ROE_VALIDATION_PARAGRAPH}} [M]

### 1.7 多空观点（Long vs Short）

**多头逻辑**
1. {{LONG_1}} [置信度]
2. {{LONG_2}} [置信度]
3. {{LONG_3}} [置信度]
4. {{LONG_4}} [置信度]

**上行催化剂**：{{UPSIDE_CATALYSTS_ONE_PARAGRAPH}}

**空头逻辑**
1. {{SHORT_1}} [置信度]
2. {{SHORT_2}} [置信度]
3. {{SHORT_3}} [置信度]
4. {{SHORT_4}} [置信度]

**下行催化剂**：{{DOWNSIDE_CATALYSTS_ONE_PARAGRAPH}}

### 1.8 交易流（Flow）

**T-1 资金流（{{T1_DATE}}）**：{{T1_FUND_FLOW_SUMMARY}} [H]
**前 5 日资金累计**：{{T5_FUND_FLOW_SUMMARY}} [H]

**北向持股**：{{HSGT_SUMMARY_OR_GAP_NOTICE}} [L if 数据陈旧]

**融资融券**：{{MARGIN_SUMMARY_OR_GAP}} [H]
<!-- 读 margin_recent：最新融资余额、融资余额占流通市值比、较 20 个交易日前变化；空数组写"非融资融券标的"。 -->

**龙虎榜**：{{LHB_SUMMARY_OR_NONE}} [H]
<!-- 读 lhb_recent：上榜日 / 上榜原因 / 净买额；空数组写"上一年 1 月 1 日至今未上榜"。 -->

### 1.9 结论（Conclusion）

决定性变量三项：
1. {{KEY_VAR_1}}；
2. {{KEY_VAR_2}}；
3. {{KEY_VAR_3}}。

一句话：**{{ONE_LINE_CONCLUSION}}** [置信度]

---

## 二、公司（Company）

### 2.1 定位 / 商业逻辑 / 行业地位

**定位**：{{POSITIONING_FROM_BUSINESS_FIELD}} [H]

**商业逻辑**：
- 上游：{{UPSTREAM}}；
- 中游（公司位置）：{{MIDSTREAM}}；
- 下游：{{DOWNSTREAM}}；
- 付费动因：{{WHY_CUSTOMERS_PAY}}。 [M]

**行业地位**：{{INDUSTRY_POSITION_PARAGRAPH}} [M/L]

### 2.2 业务组成（CY{{LAST_YEAR}}）

{{BUSINESS_SEGMENTS_PARAGRAPH_OR_GAP_NOTICE}} [L if 年报正文未抓]
<!-- 年报分产品表之外，annual.json 有 semiannual 时补一张最新半年报分产品表（收入 / 同比 / 毛利率）；
     半年报显示的增长来源与年报不同时以半年报为准，并回写 1.1 与 1.7。 -->

### 2.3 壁垒（Moat）

- {{MOAT_1}}；
- {{MOAT_2}}；
- {{MOAT_3}}。 [M]

### 2.4 发展历程（与当前投资相关节点）

- {{HISTORY_1}}；
- {{HISTORY_2}}；
- {{HISTORY_3}}；
- {{HISTORY_4}}。 [M]

### 2.5 运营分析（CY{{FIRST_YEAR}}–CY{{LAST_YEAR}}）

| 指标 | CY{{Y1}} | CY{{Y2}} | CY{{Y3}} | CY{{Y4}} | CY{{Y5}} | 变化解读 |
|---|---|---|---|---|---|---|
| Revenue（亿元） | {{REV_Y1}} | {{REV_Y2}} | {{REV_Y3}} | {{REV_Y4}} | {{REV_Y5}} | {{REV_COMMENTARY}} |
| Gross margin | {{GM_Y1}} | {{GM_Y2}} | {{GM_Y3}} | {{GM_Y4}} | {{GM_Y5}} | {{GM_COMMENTARY}} |
| ROE | {{ROE_Y1}} | {{ROE_Y2}} | {{ROE_Y3}} | {{ROE_Y4}} | {{ROE_Y5}} | {{ROE_COMMENTARY}} |
| 经营现金流（亿元） | {{OCF_Y1}} | {{OCF_Y2}} | {{OCF_Y3}} | {{OCF_Y4}} | {{OCF_Y5}} | {{OCF_COMMENTARY}} |
| 资产负债率 | {{DR_Y1}} | {{DR_Y2}} | {{DR_Y3}} | {{DR_Y4}} | {{DR_Y5}} | {{DR_COMMENTARY}} |

**关键观察**：{{OPERATING_KEY_OBSERVATION}} [H/M]

---

## 三、最新业绩要点（Latest Earning）

### 3.1 最近一期数据

- **业绩快报披露日**：{{EARNINGS_FLASH_DATE}}
- **正式年报**：{{ANNUAL_REPORT_STATUS}}

### 3.2 业绩快报核心数据（CY{{LAST_YEAR}}）

| 项目 | 数值 | YoY |
|---|---|---|
| 营业总收入 | ¥{{REV_LATEST_YI}} 亿 | {{REV_YOY}} |
| 归母净利润 | ¥{{NP_LATEST_YI}} 亿 | {{NP_YOY}} |
| EPS（基本） | ¥{{EPS_LATEST}} | {{EPS_YOY}} |
| 每股净资产 | ¥{{BVPS_LATEST}} | {{BVPS_YOY}} |
| 销售毛利率 | {{GM_LATEST}} | {{GM_YOY_DELTA}} |
| ROE（加权） | {{ROE_LATEST}} | {{ROE_YOY_DELTA}} |
| 经营现金流（亿元） | {{OCF_LATEST_YI}} | {{OCF_YOY}} |

### 3.3 季度营收节奏（单季，亿元）

| 季度 | 单季营收 | 环比 |
|---|---|---|
| {{Q1_LABEL}} | {{Q1_REV}} | {{Q1_QOQ}} |
| {{Q2_LABEL}} | {{Q2_REV}} | {{Q2_QOQ}} |
| {{Q3_LABEL}} | {{Q3_REV}} | {{Q3_QOQ}} |
| {{Q4_LABEL}} | {{Q4_REV}} | {{Q4_QOQ}} |
| {{Q5_LABEL}} | {{Q5_REV}} | {{Q5_QOQ}} |
| {{Q6_LABEL}} | {{Q6_REV}} | {{Q6_QOQ}} |
| {{Q7_LABEL}} | {{Q7_REV}} | {{Q7_QOQ}} |
| {{Q8_LABEL}} | {{Q8_REV}} | {{Q8_QOQ}} |

**结构性观察**：{{QUARTERLY_STRUCTURAL_OBSERVATION}} [H]

### 3.4 业绩说明会与公开访谈

- **最近业绩说明会**：{{EARNINGS_CALL_STATUS_OR_GAP}} [L if 未抓取]
- **CEO 公开访谈**：{{CEO_INTERVIEW_STATUS_OR_GAP}} [L]

---

## 四、财务表现（Financial Performance）

### 4.1 五年总览（GAAP，财年=日历年，单位：人民币亿元；EPS = 元）

| 年度 | 收入 | YoY | 毛利率 | 营业利润率* | 归母净利 | EPS（基本） | 净利率 | OCF | 资产负债率 |
|---|---|---|---|---|---|---|---|---|---|
| CY{{Y1}} | {{REV_Y1}} | {{REV_YOY_Y1}} | {{GM_Y1}} | {{OPM_Y1}} | {{NP_Y1}} | {{EPS_Y1}} | {{NM_Y1}} | {{OCF_Y1}} | {{DR_Y1}} |
| CY{{Y2}} | {{REV_Y2}} | {{REV_YOY_Y2}} | {{GM_Y2}} | {{OPM_Y2}} | {{NP_Y2}} | {{EPS_Y2}} | {{NM_Y2}} | {{OCF_Y2}} | {{DR_Y2}} |
| CY{{Y3}} | {{REV_Y3}} | {{REV_YOY_Y3}} | {{GM_Y3}} | {{OPM_Y3}} | {{NP_Y3}} | {{EPS_Y3}} | {{NM_Y3}} | {{OCF_Y3}} | {{DR_Y3}} |
| CY{{Y4}} | {{REV_Y4}} | {{REV_YOY_Y4}} | {{GM_Y4}} | {{OPM_Y4}} | {{NP_Y4}} | {{EPS_Y4}} | {{NM_Y4}} | {{OCF_Y4}} | {{DR_Y4}} |
| CY{{Y5}} | {{REV_Y5}} | {{REV_YOY_Y5}} | {{GM_Y5}} | {{OPM_Y5}} | {{NP_Y5}} | {{EPS_Y5}} | {{NM_Y5}} | {{OCF_Y5}} | {{DR_Y5}} |

*营业利润率为估算（毛利率 − 期间费用率），非完全口径。[M]

### 4.2 三张表的优势项 / 劣势项

**优势项**
- {{STRENGTH_1}} [置信度]
- {{STRENGTH_2}} [置信度]
- {{STRENGTH_3}} [置信度]

**劣势项 / 需跟踪项**
- {{WEAKNESS_1}} [置信度]
- {{WEAKNESS_2}} [置信度]
- {{WEAKNESS_3}} [置信度]

### 4.3 GAAP vs 非经常项目

{{NON_GAAP_PARAGRAPH}} [M]

---

## 五、资本市场表现（Market Performance & Sentiment）

### 5.1 最近三年股价（前复权口径）

| 日期 | 收盘价 | 同比 |
|---|---|---|
| {{P_3YR_DATE}} | ¥{{P_3YR}} | — |
| {{P_2YR_DATE}} | ¥{{P_2YR}} | {{P_2YR_YOY}} |
| {{P_1YR_DATE}} | ¥{{P_1YR}} | {{P_1YR_YOY}} |
| {{QUOTE_DATE}} | ¥{{PRICE_LATEST}} | {{P_LATEST_YOY}} |

**三年累计涨幅 {{PRICE_3YR_CHG_PCT}}，三年 CAGR {{PRICE_3YR_CAGR}}。**[H]
<!-- price_history_points 的 3 年 / 2 年前为 null（上市不足三年）时：该行写"未取得，原因：上市前"，
     另加一行上市首日收盘作起点，三年涨幅改为"上市以来涨幅 + 年化"。 -->

### 5.2 事件映射（Alpha vs Beta）

- {{EVENT_MAP_1}}
- {{EVENT_MAP_2}}
- {{EVENT_MAP_3}}
- {{EVENT_MAP_4}} [M]

<!-- 每个事件区间用 benchmark_index.closes 算同期指数涨跌，写成"个股 +x% / 创业板指 +y%"，差值即 Alpha 近似。 -->

---

## 六、管理层和股东回报（Management & Capital Allocation）

### 6.1 关键高管

- {{EXEC_1}}
- {{EXEC_2}}
- {{EXEC_3}}

- **薪酬**：{{MANAGEMENT_PAY_OR_GAP}} [H]
<!-- 读 annual.json sections.management_pay：主要董事、高管的税前报酬（保留年报原表单位万元并注明）；
     无命中时写"未取得，原因：年报报酬表未抽取到"，置信度改 L。 -->

### 6.2 股东回报

- **分红**：{{DIVIDEND_HISTORY_OR_NONE}}
- **回购**：{{BUYBACK_OR_NONE}}
- **其他资本运作**：{{OTHER_CAPITAL_EVENTS_OR_NONE}} [M]

### 6.3 十大流通股东（截至 {{TOP10_AS_OF}}）

| 排名 | 股东名称 | 股份类型 | 持股比例 | 变动 |
|---|---|---|---|---|
| 1 | {{H_1_NAME}} | {{H_1_TYPE}} | {{H_1_PCT}} | {{H_1_CHG}} |
| 2 | {{H_2_NAME}} | {{H_2_TYPE}} | {{H_2_PCT}} | {{H_2_CHG}} |
| 3 | {{H_3_NAME}} | {{H_3_TYPE}} | {{H_3_PCT}} | {{H_3_CHG}} |
| 4 | {{H_4_NAME}} | {{H_4_TYPE}} | {{H_4_PCT}} | {{H_4_CHG}} |
| 5 | {{H_5_NAME}} | {{H_5_TYPE}} | {{H_5_PCT}} | {{H_5_CHG}} |
| 6–10 | {{H_6_TO_10_SUMMARY}} | | | |

**结构观察**：{{HOLDERS_STRUCTURE_OBSERVATION}} [M]

### 6.4 内部人交易

{{INSIDER_TRANSACTIONS_OR_NONE_DETECTED}} [M]

---

## 七、环境、价值链与竞争分析

### 7.1 环境（宏观 / 监管 / 供需）

- **监管 / 地缘**：{{REGULATORY_PARAGRAPH}} [H/M]
- **行业供需**：{{INDUSTRY_SUPPLY_DEMAND}} [M]

### 7.2 上游 / 下游与成本传递

- **上游**：{{UPSTREAM_DETAIL}}
- **下游**：{{DOWNSTREAM_DETAIL}} [L if 客户集中度未抓]

### 7.3 竞争

- **全球同业**：{{GLOBAL_PEERS}}
- **A 股可比**：{{A_SHARE_PEERS}}
<!-- 先看 peers.json 的 peer_source：eastmoney_industry_neighbors 时必须写明"东财行业排名近邻，非同品种确认"，
     估值对比结论置信度最高 M；none 时写"未取得"。 -->
- **行业研究**：{{INDUSTRY_RESEARCH_OR_GAP}} [L]

---

## 八、问题与展望（Legacy Issues & Outlook）

### 8.1 展望

- **短期（1 年内）**：{{SHORT_TERM_OUTLOOK}} [H]
- **中期（1–3 年）**：{{MID_TERM_OUTLOOK}} [M]
- **长期（3 年以上）**：{{LONG_TERM_OUTLOOK}} [M]

### 8.2 待跟踪问题

1. {{TRACK_1}}；
2. {{TRACK_2}}；
3. {{TRACK_3}}；
4. {{TRACK_4}}。

---

## 附：自动化流程缺失项

<!-- 按本次实际缺口逐条列，不照抄固定清单：
     ① validate.py 输出的每一条 DATA WARNING；② 正文里每一处"未取得"；
     ③ 本次涉及的结构性限制（北向持股、上市不足三年的价格点、沪市互动问答、业绩说明会全文等），注明"结构性"。
     本次已取得的项不要列。 -->
| 缺失项 | 影响章节 | 建议来源 |
|---|---|---|
| {{GAP_ITEM}} | {{GAP_SECTIONS}} | {{GAP_SOURCE}} |

---

**报告口径声明**：本报告为"输入股票代码 → 自动生成研报"工程化流水线输出，数据均来自公开源（akshare、东方财富、上交所等），报告日 {{REPORT_DATE}}。判断性陈述末尾以 `[H/M/L]` 标记置信度。**不构成投资建议**。
