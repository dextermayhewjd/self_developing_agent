"""港股数据管道 —— 产出与 A 股**同 schema** 的 data/{symbol}/aggregate.json

设计目标：判断稿 skill（equity-thesis-cn）一个字都不用改。
所以这里的职责不是"抓港股数据"，而是"抓港股数据并塞进 A 股那张表的格子里"。
字段名、嵌套层级、键的写法（"20251231"）全部对齐 run_pipeline.py::aggregate()。

三条港股特有的处理，都写在了产出里而不是藏在代码里：
1. **币种**：agg["currency"] 显式标注每组数字的币种。
   东财行业对比接口的市值是**人民币**口径，而指标表/行情是**港元**——
   同一个"总市值"两个币种，实测比值 1.1560。折算在 fetch_hk_peers.py 里做。
2. **港股无季报**：只有中期(H1)与全年。financials_quarterly 里
   0630 放 H1、1231 放 H2（全年减 H1），0331/0930 恒为 null，并附 _note 说明。
   这不是抓取失败，是港股披露制度如此。
3. **港股无"扣非净利润"**：这是 A 股监管概念。non_gaap_net_profit 恒为 null。

用法：python run_pipeline_hk.py <5位港股代码> [--skip-extras]
（一般不直接调用——run_pipeline.py 认出 5 位代码后会转到这里。）
"""
import json
import sys
from datetime import datetime
from pathlib import Path

import akshare as ak
import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools"))
from lib import Collector, DATA_DIR, REPORTS_DIR, board_name, normalize_symbol, symbol_dir  # noqa: E402

# 港股报表科目不像 A 股那样标准化，各家用词有出入 → 每个指标给一串候选，取首个命中
ITEM_CANDIDATES = {
    "revenue": ["营业额", "营运收入", "营业收入", "收入", "总收入"],
    "cost": ["销售成本", "营业成本", "主营业务成本"],
    "gross_profit": ["毛利", "毛利润"],
    "net_profit_attributable": ["股东应占溢利", "本公司拥有人应占溢利",
                                "股东应占溢利(亏损)", "母公司拥有人应占溢利"],
    "net_profit_total": ["除税后溢利", "持续经营业务税后利润", "净利润", "年度溢利"],
    "operating_cashflow": ["经营业务现金净额", "经营活动现金流量净额", "经营业务所得现金净额"],
    "shareholders_equity": ["股东权益", "本公司拥有人应占权益", "净资产"],
    "total_assets": ["总资产"],
    "total_liabilities": ["总负债"],
    "capex": ["购建固定资产", "购买物业厂房及设备"],
    "eps_basic_stmt": ["每股基本盈利"],
    "selling_expense": ["销售及分销费用", "销售费用"],
    "admin_expense": ["行政开支", "管理费用"],
    "cash": ["现金及等价物", "现金及现金等价物"],
    "inventory": ["存货"],
    "receivables": ["应收帐款", "应收账款"],
    "payables": ["应付帐款", "应付账款"],
    "prepay_and_other_recv": ["预付款按金及其他应收款"],
    "goodwill": ["商誉"],
    "cip": ["在建工程"],
    "rnd_expense": ["研发费用", "研發開支"],
}


def _clean(obj):
    """递归把 NaN/inf 换成 None。

    上游各源经 pandas → json 落盘时 NaN 会写成裸 `NaN`（不是合法 JSON），
    读回来又是 truthy 的 float("nan")，会污染任何 `if v` 判断。
    统一在写 aggregate 之前清一遍，配合 allow_nan=False 兜底。
    """
    if isinstance(obj, dict):
        return {k: _clean(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_clean(v) for v in obj]
    if isinstance(obj, float):
        return None if (obj != obj or obj in (float("inf"), float("-inf"))) else obj
    return obj


def _pivot(df: pd.DataFrame) -> dict:
    """长表 → {报告期"YYYYMMDD": {科目名: 金额}}"""
    out = {}
    if df is None or len(df) == 0:
        return out
    for _, r in df.iterrows():
        key = str(r.get("REPORT_DATE", ""))[:10].replace("-", "")
        if not key:
            continue
        out.setdefault(key, {})[str(r.get("STD_ITEM_NAME", ""))] = r.get("AMOUNT")
    return out


def _num(v):
    """转 float；None / 非数 / NaN / inf 一律返回 None。

    这里必须显式拦 NaN：float("nan") 不抛异常，而 NaN 在 Python 里是 **truthy**，
    一旦漏进去，下游 `if v` 之类的判断会把它当成有效数据。
    """
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return None if (f != f or f in (float("inf"), float("-inf"))) else f


def _first(*vals):
    """取首个非 None —— 不能用 `a or b`：合法的 0.0 会被当假值丢掉。

    实测踩过：矿业公司投产前营收就是 0.0，用 `or` 会跳过这个真值去取回退源的 NaN。
    """
    for v in vals:
        if v is not None:
            return v
    return None


def _pick(period: dict, metric: str):
    for name in ITEM_CANDIDATES.get(metric, []):
        if name in period:
            v = _num(period[name])
            if v is not None:
                return v
    return None


def fetch_basic_hk(symbol: str) -> Collector:
    c = Collector("basic")
    print(f"\n[basic-hk] {symbol}", file=sys.stderr)
    # 行情走新浪（东财 push2his 在本环境不可达，且 A 股侧同样已改用新浪）
    c.safe("hist_qfq", lambda: ak.stock_hk_daily(symbol=symbol, adjust="qfq"))
    c.safe("company_profile", lambda: ak.stock_hk_company_profile_em(symbol=symbol))
    c.safe("security_profile", lambda: ak.stock_hk_security_profile_em(symbol=symbol))
    c.safe("financial_indicator", lambda: ak.stock_hk_financial_indicator_em(symbol=symbol))
    c.safe("analysis_indicator_annual",
           lambda: ak.stock_financial_hk_analysis_indicator_em(symbol=symbol, indicator="年度"))
    c.safe("analysis_indicator_period",
           lambda: ak.stock_financial_hk_analysis_indicator_em(symbol=symbol, indicator="报告期"))
    for tbl in ["资产负债表", "利润表", "现金流量表"]:
        c.safe(f"report_{tbl}_年度",
               lambda t=tbl: ak.stock_financial_hk_report_em(stock=symbol, symbol=t, indicator="年度"))
        c.safe(f"report_{tbl}_报告期",
               lambda t=tbl: ak.stock_financial_hk_report_em(stock=symbol, symbol=t, indicator="报告期"))
    c.safe("valuation_comparison", lambda: ak.stock_hk_valuation_comparison_em(symbol=symbol))
    c.safe("dividend", lambda: ak.stock_hk_dividend_payout_em(symbol=symbol))
    c.dump(symbol)
    return c


def fetch_governance_hk(symbol: str) -> Collector:
    """港股没有"十大流通股东"这一说：托管分布看 CCASS，实益持有看年报「主要股东权益」。"""
    c = Collector("governance")
    print(f"\n[governance-hk] {symbol}", file=sys.stderr)
    c.safe("profit_forecast",
           lambda: ak.stock_hk_profit_forecast_et(symbol=symbol, indicator="盈利预测概览"))
    # CCASS 由独立脚本抓（表单站点，逻辑较重），这里只读它的产物
    ccass_path = symbol_dir(symbol) / "ccass.json"
    if ccass_path.exists():
        c.OUT["ccass"] = json.load(open(ccass_path))
        print("  OK  ccass (从 ccass.json 读入)", file=sys.stderr)
    else:
        c.ERR["ccass"] = "ccass.json 不存在，请先跑 fetch_hk_ccass.py"
    c.dump(symbol)
    return c


def fetch_news_hk(symbol: str) -> Collector:
    c = Collector("news")
    print(f"\n[news-hk] {symbol}", file=sys.stderr)
    # 东财个股新闻接口直接吃港股代码，无需替代
    c.safe("news_em", lambda: ak.stock_news_em(symbol=symbol))
    # 公告来自披露易，由 fetch_hk_filings.py 落盘
    fp = symbol_dir(symbol) / "filings.json"
    if fp.exists():
        filings = json.load(open(fp)).get("filings", [])
        c.OUT["filings"] = filings
        print(f"  OK  filings (从 filings.json 读入): {len(filings)}", file=sys.stderr)
    else:
        c.ERR["filings"] = "filings.json 不存在，请先跑 fetch_hk_filings.py"
    c.dump(symbol)
    return c


def aggregate_hk(symbol: str) -> Path:
    print(f"\n[aggregate-hk] {symbol}", file=sys.stderr)
    sym_dir = symbol_dir(symbol)
    raw = {}
    for name in ["basic", "governance", "news"]:
        p = sym_dir / f"{name}.json"
        raw[name] = json.load(open(p))["data"] if p.exists() else {}

    b, g, n = raw["basic"], raw["governance"], raw["news"]
    agg = {
        "symbol": symbol,
        "board": board_name(symbol),
        "market": "hk",
        "report_date": datetime.now().strftime("%Y-%m-%d"),
        "fetched_at": datetime.now().isoformat(),
    }

    prof = (b.get("company_profile") or [{}])[0]
    sec = (b.get("security_profile") or [{}])[0]
    if sec.get("板块"):
        agg["board"] = f"香港交易所{sec['板块']}"

    # --- 主营业务：键名对齐 A 股 stock_zyjs_ths，附港股独有的治理字段 ---
    agg["business"] = {
        "股票代码": symbol,
        "主营业务": prof.get("公司介绍"),
        "产品类型": prof.get("所属行业"),
        "产品名称": prof.get("所属行业"),
        "经营范围": prof.get("公司介绍"),
        # ↓ 港股特有，A 股 aggregate 里没有
        "核数师": prof.get("核数师"),
        "年结日": prof.get("年结日"),
        "员工人数": prof.get("员工人数"),
        "注册地": prof.get("注册地"),
        "上市日期": sec.get("上市日期"),
        "证券类型": sec.get("证券类型"),
        "每手股数": sec.get("每手股数"),
        "是否沪港通标的": sec.get("是否沪港通标的"),
        "是否深港通标的": sec.get("是否深港通标的"),
    }
    agg["company_name"] = prof.get("公司名称")

    # --- 估值 ---
    fi = (b.get("financial_indicator") or [{}])[0]
    vc = (b.get("valuation_comparison") or [{}])[0]
    hist = pd.DataFrame(b.get("hist_qfq") or [])
    close = float(hist.iloc[-1]["close"]) if len(hist) else None
    as_of = str(hist.iloc[-1]["date"])[:10] if len(hist) else None

    _f = _num

    total_shares = _f(fi.get("已发行股本(股)"))
    agg["valuation"] = {
        "as_of": as_of,
        "close": close,
        "total_mcap_yuan": _f(fi.get("总市值(港元)")),
        "float_mcap_yuan": _f(fi.get("港股市值(港元)")),
        "total_shares": total_shares,
        "float_shares": _first(_f(fi.get("已发行股本-H股(股)")), total_shares),
        "pe_ttm": _first(_f(fi.get("市盈率")), _f(vc.get("市盈率-TTM"))),
        "pe_static": _f(vc.get("市盈率-LYR")),
        "pb": _first(_f(fi.get("市净率")), _f(vc.get("市净率-MRQ"))),
        "peg": None,          # 港股源无 PEG，按零编造原则留空而不是自算后冒充源数据
        "ps": _f(vc.get("市销率-TTM")),
        "pcf": _f(vc.get("市现率-TTM")),
        "dividend_yield_ttm_pct": _f(fi.get("股息率TTM(%)")),
    }

    # --- 行情 ---
    if len(hist):
        h = hist.copy()
        h["date"] = h["date"].astype(str).str[:10]
        last, prev = h.iloc[-1], (h.iloc[-2] if len(h) > 1 else h.iloc[-1])
        vol = _f(last.get("volume"))
        agg["quote_latest"] = {
            "date_close": str(last["date"]),
            "close": float(last["close"]),
            "change_pct": (float(last["close"]) / float(prev["close"]) - 1) * 100
                          if float(prev["close"]) else None,
            "amount_yuan": _f(last.get("amount")),
            # 港股行情源不提供换手率，用成交量/已发行股本自算
            "turnover_pct": (vol / total_shares * 100) if (vol and total_shares) else None,
        }
        today = datetime.now()

        def find_close(target):
            df = h[h["date"] <= target]
            return float(df.iloc[-1]["close"]) if len(df) else None

        agg["price_history_points"] = {
            f"{today.year-y}-{today.month:02d}-{today.day:02d}":
                find_close(f"{today.year-y}-{today.month:02d}-{today.day:02d}")
            for y in (3, 2, 1)
        }
        agg["price_history_points"][agg["quote_latest"]["date_close"]] = agg["quote_latest"]["close"]
    else:
        agg["quote_latest"] = None
        agg["price_history_points"] = None

    # --- 年度财务：三表 + 指标表 ---
    inc = _pivot(pd.DataFrame(b.get("report_利润表_年度") or []))
    bal = _pivot(pd.DataFrame(b.get("report_资产负债表_年度") or []))
    cfs = _pivot(pd.DataFrame(b.get("report_现金流量表_年度") or []))
    ind_rows = b.get("analysis_indicator_annual") or []
    ind = {str(r.get("REPORT_DATE", ""))[:10].replace("-", ""): r for r in ind_rows}

    cy = datetime.now().year
    year_cols = [f"{y}1231" for y in range(cy - 5, cy)]
    currency = next((r.get("CURRENCY") for r in ind_rows if r.get("CURRENCY")), None)

    def series(fn):
        return {col: fn(col) for col in year_cols}

    def stmt(col, table, metric):
        return _pick(table.get(col, {}), metric)

    def indv(col, field):
        return _num((ind.get(col) or {}).get(field))

    def opex_ratio(col):
        rev = stmt(col, inc, "revenue")
        sell = _pick(inc.get(col, {}), "selling_expense")
        adm = _pick(inc.get(col, {}), "admin_expense")
        if not rev or (sell is None and adm is None):
            return None
        return ((sell or 0) + (adm or 0)) / rev * 100

    agg["financials_annual"] = {
        "revenue": series(lambda c: _first(stmt(c, inc, "revenue"), indv(c, "OPERATE_INCOME"))),
        "cost": series(lambda c: stmt(c, inc, "cost")),
        "net_profit_attributable": series(
            lambda c: _first(stmt(c, inc, "net_profit_attributable"), indv(c, "HOLDER_PROFIT"))),
        "net_profit_total": series(lambda c: stmt(c, inc, "net_profit_total")),
        # 港股无"扣非"这一监管概念 —— 恒为 None，不是抓取失败
        "non_gaap_net_profit": series(lambda c: None),
        "operating_cashflow": series(lambda c: stmt(c, cfs, "operating_cashflow")),
        "shareholders_equity": series(lambda c: stmt(c, bal, "shareholders_equity")),
        "eps_basic": series(lambda c: _first(indv(c, "BASIC_EPS"), stmt(c, inc, "eps_basic_stmt"))),
        "bvps": series(lambda c: indv(c, "BPS")),
        "roe_pct": series(lambda c: indv(c, "ROE_AVG")),
        "roa_pct": series(lambda c: indv(c, "ROA")),
        "gross_margin_pct": series(lambda c: indv(c, "GROSS_PROFIT_RATIO")),
        "net_margin_pct": series(lambda c: indv(c, "NET_PROFIT_RATIO")),
        "opex_ratio_pct": series(opex_ratio),
        "debt_ratio_pct": series(lambda c: indv(c, "DEBT_ASSET_RATIO")),
        # 港股独有补充
        "total_assets": series(lambda c: stmt(c, bal, "total_assets")),
        "total_liabilities": series(lambda c: stmt(c, bal, "total_liabilities")),
        "capex": series(lambda c: stmt(c, cfs, "capex")),
        "cash": series(lambda c: stmt(c, bal, "cash")),
        # 排雷单要算应收/应付/存货周转天数与现金周期，直接给出来省得子 agent 回翻三表
        "receivables": series(lambda c: stmt(c, bal, "receivables")),
        "payables": series(lambda c: stmt(c, bal, "payables")),
        "inventory": series(lambda c: stmt(c, bal, "inventory")),
        "prepay_and_other_receivables": series(lambda c: stmt(c, bal, "prepay_and_other_recv")),
        "goodwill": series(lambda c: stmt(c, bal, "goodwill")),
        "construction_in_progress": series(lambda c: stmt(c, bal, "cip")),
        "rnd_expense": series(lambda c: stmt(c, inc, "rnd_expense")),
    }

    # --- 半年度（港股无季报）---
    inc_p = _pivot(pd.DataFrame(b.get("report_利润表_报告期") or []))
    q_cols = [f"{y}{m}" for y in (cy - 2, cy - 1, cy) for m in ("0331", "0630", "0930", "1231")]

    def half_single(metric):
        out = {}
        for col in q_cols:
            year, mmdd = col[:4], col[4:]
            if mmdd in ("0331", "0930"):
                out[col] = None                       # 港股不披露季度
            elif mmdd == "0630":
                out[col] = _pick(inc_p.get(col, {}), metric)
            else:                                     # 1231 = 全年 − 上半年
                full = _first(_pick(inc_p.get(col, {}), metric), _pick(inc.get(col, {}), metric))
                h1 = _pick(inc_p.get(f"{year}0630", {}), metric)
                out[col] = (full - h1) if (full is not None and h1 is not None) else full
        return out

    agg["financials_quarterly"] = {
        "_note": "港股只披露中期(H1)与全年，没有季报。0630=上半年单期，"
                 "1231=下半年单期(全年减上半年)，0331/0930 恒为 null——"
                 "这是披露制度差异，不是数据抓取失败。",
        "revenue_single": half_single("revenue"),
        "net_profit_single": half_single("net_profit_attributable"),
        "gross_margin_pct_cum": {
            col: (lambda gp, rev: (gp / rev * 100) if (gp is not None and rev) else None)(
                _pick(inc_p.get(col, {}), "gross_profit"),
                _pick(inc_p.get(col, {}), "revenue"))
            for col in q_cols
        },
    }

    # --- 治理：CCASS 顶替十大流通股东 ---
    ccass = g.get("ccass") or {}
    holders = []
    for i, r in enumerate(ccass.get("top10") or [], 1):
        holders.append({
            "名次": i,
            "股东名称": f"{r.get('name','')}（CCASS席位 {r.get('participant_id','')}）",
            "持股数": r.get("shares"),
            "占总流通股本持股比例": r.get("pct_of_issued"),
            "增减": None,
            "变动比率": None,
        })
    agg["top10_free"] = holders
    agg["top10_free_as_of"] = ccass.get("as_of")
    agg["top10_total"] = holders
    agg["top10_total_as_of"] = ccass.get("as_of")
    agg["ccass_caveat"] = ccass.get("caveat")
    agg["southbound_holding"] = ccass.get("southbound")
    agg["ownership_concentration"] = ccass.get("concentration")

    agg["research_reports"] = g.get("profit_forecast") or []

    # --- 公告 / 新闻 / 业绩 ---
    filings = n.get("filings") or []
    agg["announcements_recent"] = [
        {"公告标题": f.get("TITLE"), "公告日期": f.get("DATE_TIME"),
         "url": "https://www1.hkexnews.hk" + (f.get("FILE_LINK") or "")}
        for f in filings[:100]
    ]
    agg["news_recent"] = n.get("news_em")
    agg["earnings_flash"] = [
        a for a in agg["announcements_recent"]
        if any(k in (a["公告标题"] or "") for k in ("業績公告", "業績", "全年業績", "中期業績"))
    ]
    agg["earnings_preannouncement"] = [
        a for a in agg["announcements_recent"]
        if any(k in (a["公告标题"] or "") for k in ("盈利預告", "盈警", "盈喜", "正面盈利"))
    ]
    # 港股没有逐日个股资金流；南向持股是最接近的替代（快照，非流水）
    agg["fund_flow_recent"] = None
    agg["fund_flow_substitute"] = {
        "type": "southbound_ccass_snapshot",
        "data": ccass.get("southbound"),
        "note": "港股无逐日个股资金流数据。此为港股通南向持股快照"
                "（CCASS 席位 A00003 深港通 + A00004 沪港通），非资金流水。",
    }

    # --- 币种：这份文件里唯一必须先读的字段 ---
    agg["currency"] = {
        "financials": currency or "未知",
        "quote_and_mcap": "HKD",
        "peers_mcap": "HKD（fetch_hk_peers.py 已从源接口的人民币口径折算）",
        "warning": "港股财报本位币未必是港元（可能为 CNY/USD），行情与市值恒为 HKD。"
                   "跨口径比较前先看这里，不要默认同币种。",
    }

    # --- 历史估值带（港股无 stock_value_em 那样的现成序列，按月自算）---
    agg["valuation_history"] = _valuation_band(hist, agg["financials_annual"], total_shares)

    # 两类缺口分开写：A=港股制度/惯例上就不存在，换数据源也没有；
    #                B=本条数据存在于年报，只是东财港股模板不给，须去 PDF 读。
    agg["known_gaps"] = {
        "A_制度上不存在": {
            "non_gaap_net_profit":
                "「扣非净利润」是 A 股监管口径，港股无此概念。恒为 null，不必去年报找。",
            "quarterly":
                "港股只披露中期(H1)与全年，无季报。见 financials_quarterly._note。",
            "cash_received_from_sales":
                "港股现金流量表按惯例用**间接法**（除税前溢利→调整→营运资金变动），"
                "没有「销售商品提供劳务收到的现金」这一行，公司本身就没编，年报里也没有。"
                "因此「销售收现比」无法计算；判断利润含金量请改用净现比"
                "（operating_cashflow / net_profit_attributable，两项都齐）。",
            "fund_flow":
                "港股无逐日个股资金流。最接近的替代是南向持股快照，见 fund_flow_substitute。",
            "earnings_call":
                "港股业绩发布会/分析师会不属于强制披露，不上披露易；"
                "A 股的「投资者关系活动记录表」是交易所强制要求，港股无对应物。"
                "实测腾讯近 200 条备案里无任何投资者推介材料。"
                "替代：announcements_recent 里的「業績公告」与年报「管理層討論及分析」章节。",
        },
        "B_年报里有但本文件没有": {
            "goodwill":
                "东财港股资产负债表模板**不设「商誉」独立科目**（实测腾讯 55 个科目里也没有），"
                "商誉被并入无形资产/非流动资产其他项。财务排雷第 9 项「商誉占比」"
                "须读年报附注，不要因为这里是 null 就判定公司无商誉。",
            "other_receivables_split":
                "「其他应收款」与「预付款项」在港股模板里合并为"
                "`prepay_and_other_receivables`，无法拆分。"
                "排雷单第 2/4 项（藏关联方占款、异常预付）须读年报附注拆分表。",
            "segment_revenue":
                "分产品/分地区收入拆分不在三表里，须读年报"
                "「分部資料」（annual.json 的 sections.business_segments）。",
        },
        "top10_free":
            "港股无「十大流通股东」。这里给的是 CCASS 托管席位分布（券商/托管行席位，"
            "不等于实益股东），且只覆盖已入 CCASS 的股份——见 ccass_caveat。"
            "实益持有人须读年报「主要股东权益」（annual.json 的 "
            "sections.substantial_shareholders）。",
    }

    path = sym_dir / "aggregate.json"
    path.write_text(json.dumps(_clean(agg), ensure_ascii=False, default=str,
                               indent=2, allow_nan=False))
    print(f"  wrote {path}", file=sys.stderr)
    return path


def _valuation_band(hist: pd.DataFrame, fa: dict, total_shares) -> dict:
    """按月采样收盘价 × 当时可得的最近年度 EPS/BVPS → 历史 PE/PB 带。

    港股没有 A 股 stock_value_em 那样的现成估值序列，只能自算。
    口径写明：用的是**已披露**的最近年度静态 EPS（非 TTM），
    且年报披露有滞后，这里按"次年 4 月底起可用"处理。
    """
    if hist is None or len(hist) == 0:
        return {"status": "no_price_history"}
    eps, bvps = fa.get("eps_basic") or {}, fa.get("bvps") or {}
    avail = []
    for col, v in sorted(eps.items()):
        e = _num(v)
        if e is None:
            continue
        avail.append((f"{int(col[:4]) + 1}-04-30", e, _num(bvps.get(col))))
    if not avail:
        return {"status": "no_eps_history"}

    h = hist.copy()
    h["date"] = h["date"].astype(str).str[:10]
    h["ym"] = h["date"].str[:7]
    monthly = h.groupby("ym").last().reset_index()

    points = []
    for _, r in monthly.iterrows():
        d, c = str(r["date"]), float(r["close"])
        usable = [a for a in avail if a[0] <= d]
        if not usable:
            continue
        _, e, bv = usable[-1]
        points.append({
            "date": d, "close": c,
            "pe_static": round(c / e, 2) if e else None,
            "pb": round(c / bv, 2) if bv else None,
        })
    pes = sorted(p["pe_static"] for p in points if p["pe_static"] and p["pe_static"] > 0)
    return {
        "method": "月末收盘价 ÷ 当时已披露的最近年度基本EPS（静态，非TTM）；"
                  "年报按次年4月30日起可用。港股无现成估值序列，故自算。",
        "points": points,
        "pe_static_min": pes[0] if pes else None,
        "pe_static_max": pes[-1] if pes else None,
        "pe_static_median": pes[len(pes) // 2] if pes else None,
        "sample_months": len(points),
    }


def run_subprocess(script: str, symbol: str):
    import subprocess
    path = ROOT / "tools" / script
    if not path.exists():
        print(f"  skip {script}: not found", file=sys.stderr)
        return
    print(f"\n[{script}] {symbol}", file=sys.stderr)
    try:
        r = subprocess.run([sys.executable, str(path), symbol],
                           capture_output=True, text=True, timeout=900)
        for line in (r.stderr or "").splitlines()[-10:]:
            print(f"  {line}", file=sys.stderr)
        if r.returncode != 0:
            print(f"  {script} exit={r.returncode} (non-fatal)", file=sys.stderr)
    except subprocess.TimeoutExpired:
        print(f"  {script} TIMEOUT", file=sys.stderr)
    except Exception as e:
        print(f"  {script} ERR: {e}", file=sys.stderr)


def main():
    if len(sys.argv) < 2:
        print("usage: run_pipeline_hk.py <5位港股代码> [--skip-extras]", file=sys.stderr)
        sys.exit(2)
    symbol = normalize_symbol(sys.argv[1])
    skip_extras = "--skip-extras" in sys.argv

    DATA_DIR.mkdir(parents=True, exist_ok=True)
    REPORTS_DIR.mkdir(parents=True, exist_ok=True)

    # 先跑这两个：aggregate 要读它们的产物（CCASS → 股东，披露易 → 公告）
    run_subprocess("fetch_hk_ccass.py", symbol)
    if not skip_extras:
        run_subprocess("fetch_hk_filings.py", symbol)

    fetch_basic_hk(symbol)
    fetch_governance_hk(symbol)
    fetch_news_hk(symbol)
    out = aggregate_hk(symbol)

    if not skip_extras:
        run_subprocess("fetch_hk_peers.py", symbol)
        run_subprocess("fetch_hk_earnings_call.py", symbol)

    print("\n=== DONE (HK) ===")
    print(out)
    extras = [str(p) for name in ("annual", "peers", "ccass", "filings", "earnings_call")
              if (p := symbol_dir(symbol) / f"{name}.json").exists()]
    if extras:
        print("Extras:", *extras, sep="\n  ")


if __name__ == "__main__":
    main()
