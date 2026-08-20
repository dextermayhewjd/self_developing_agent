"""单一入口：python run_pipeline.py <symbol>

执行：
  1. 抓所有数据源（并行/串行 = 取舍：串行更稳）
  2. 汇总到 data/{symbol}.json
  3. 调 validate.py 校验
退出码：0=成功，1=fetch 失败，2=校验失败
"""
import json
import sys
from datetime import datetime
from pathlib import Path

import akshare as ak
import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools"))
from lib import Collector, DATA_DIR, REPORTS_DIR, detect_market, board_name, normalize_symbol, symbol_dir  # noqa: E402


def _fetch_hist_qfq_sina(symbol: str, market: str) -> pd.DataFrame:
    """Sina 前复权日线，归一化为 stock_zh_a_hist 的列名供下游聚合器使用。

    放弃 ak.stock_zh_a_hist (push2his.eastmoney.com) — 该接口长期 RemoteDisconnected。
    sina 'stock_zh_a_daily' 稳定且支持 qfq；返回列：date/open/high/low/close/volume/amount/outstanding_share/turnover。
    """
    end_date = datetime.now().strftime("%Y%m%d")
    df = ak.stock_zh_a_daily(
        symbol=f"{market}{symbol}", start_date="20210101",
        end_date=end_date, adjust="qfq",
    )
    if df is None or len(df) == 0:
        return pd.DataFrame()
    prev_close = df["close"].shift(1)
    return pd.DataFrame({
        "日期": df["date"].astype(str),
        "股票代码": symbol,
        "开盘": df["open"],
        "收盘": df["close"],
        "最高": df["high"],
        "最低": df["low"],
        "成交量": df["volume"],
        "成交额": df["amount"],
        "振幅": (df["high"] - df["low"]) / prev_close * 100,
        "涨跌幅": (df["close"] / prev_close - 1) * 100,
        "涨跌额": df["close"] - prev_close,
        "换手率": df["turnover"] * 100,
    }).dropna(subset=["收盘"])


def fetch_basic(symbol: str) -> Collector:
    c = Collector("basic")
    print(f"\n[basic] {symbol}", file=sys.stderr)
    market = detect_market(symbol)
    c.safe("main_business_ths", lambda: ak.stock_zyjs_ths(symbol=symbol))
    c.safe("hist_qfq", lambda: _fetch_hist_qfq_sina(symbol, market))
    c.safe("financial_abstract", lambda: ak.stock_financial_abstract(symbol=symbol))
    for kind in ["资产负债表", "利润表", "现金流量表"]:
        c.safe(f"report_{kind}",
               lambda k=kind: ak.stock_financial_report_sina(
                   stock=f"{market}{symbol}", symbol=k).head(20))
    c.safe("key_indicators",
           lambda: ak.stock_financial_analysis_indicator(symbol=symbol, start_year="2020").head(40))
    c.safe("value_em", lambda: ak.stock_value_em(symbol=symbol).tail(1500))
    c.safe("fund_flow",
           lambda: ak.stock_individual_fund_flow(stock=symbol, market=market).tail(20))
    c.dump(symbol)
    return c


def fetch_governance(symbol: str) -> Collector:
    c = Collector("governance")
    print(f"\n[governance] {symbol}", file=sys.stderr)
    market = detect_market(symbol)
    # 找最近一个季报披露日：直接用近 4 个季末
    quarter_ends = ["20251231", "20250930", "20250630", "20250331"]
    success = False
    for q in quarter_ends:
        try:
            df = ak.stock_gdfx_top_10_em(symbol=f"{market}{symbol}", date=q)
            if len(df):
                c.OUT["top10_em"] = df.to_dict(orient="records")
                c.OUT["top10_em_as_of"] = q
                print(f"  OK  top10_em (as of {q}): {len(df)}", file=sys.stderr)
                success = True
                break
        except Exception as e:
            print(f"  miss top10 @ {q}: {e}", file=sys.stderr)
    if not success:
        c.ERR["top10_em"] = "all 4 quarter-ends returned empty"

    for q in quarter_ends:
        try:
            df = ak.stock_gdfx_free_top_10_em(symbol=f"{market}{symbol}", date=q)
            if len(df):
                c.OUT["top10_free_em"] = df.to_dict(orient="records")
                c.OUT["top10_free_em_as_of"] = q
                print(f"  OK  top10_free_em (as of {q}): {len(df)}", file=sys.stderr)
                break
        except Exception:
            continue

    c.safe("research_report",
           lambda: ak.stock_research_report_em(symbol=symbol).head(30))
    c.dump(symbol)
    return c


def fetch_news(symbol: str) -> Collector:
    c = Collector("news")
    print(f"\n[news] {symbol}", file=sys.stderr)
    today = datetime.now().strftime("%Y%m%d")
    start = (datetime.now().replace(month=1, day=1)).strftime("%Y%m%d")
    c.safe("notice_individual",
           lambda: ak.stock_individual_notice_report(
               security=symbol, symbol="全部", begin_date=start, end_date=today))
    c.safe("news_em", lambda: ak.stock_news_em(symbol=symbol))
    # 业绩快报与预告：取上一年 12-31
    last_year_end = f"{datetime.now().year - 1}1231"
    c.safe("yjbb",
           lambda: ak.stock_yjbb_em(date=last_year_end).query(f'股票代码=="{symbol}"'))
    c.safe("yjyg",
           lambda: ak.stock_yjyg_em(date=last_year_end).query(f'股票代码=="{symbol}"'))
    c.dump(symbol)
    return c


def aggregate(symbol: str) -> Path:
    """汇总 basic + governance + news 到 data/{symbol}/aggregate.json"""
    print(f"\n[aggregate] {symbol}", file=sys.stderr)
    sym_dir = symbol_dir(symbol)
    raw = {}
    for name in ["basic", "governance", "news"]:
        path = sym_dir / f"{name}.json"
        if path.exists():
            raw[name] = json.load(open(path))["data"]
        else:
            raw[name] = {}

    agg = {
        "symbol": symbol,
        "board": board_name(symbol),
        "market": detect_market(symbol),
        "report_date": datetime.now().strftime("%Y-%m-%d"),
        "fetched_at": datetime.now().isoformat(),
    }

    # 主营业务
    mb = raw["basic"].get("main_business_ths") or []
    agg["business"] = mb[0] if mb else None
    if agg["business"]:
        agg["company_name"] = None  # 待从其他源补；可能要 hardcode 表

    # 估值
    ve = raw["basic"].get("value_em") or []
    if ve:
        latest = ve[-1]
        agg["valuation"] = {
            "as_of": latest.get("数据日期"),
            "close": float(latest.get("当日收盘价", 0) or 0),
            "total_mcap_yuan": float(latest.get("总市值", 0) or 0),
            "float_mcap_yuan": float(latest.get("流通市值", 0) or 0),
            "total_shares": float(latest.get("总股本", 0) or 0),
            "float_shares": float(latest.get("流通股本", 0) or 0),
            "pe_ttm": float(latest.get("PE(TTM)", 0) or 0),
            "pe_static": float(latest.get("PE(静)", 0) or 0),
            "pb": float(latest.get("市净率", 0) or 0),
            "peg": float(latest.get("PEG值", 0) or 0),
            "ps": float(latest.get("市销率", 0) or 0),
            "pcf": float(latest.get("市现率", 0) or 0),
        }
    else:
        agg["valuation"] = None

    # 行情：优先 hist_qfq，失败时用 value_em 兜底
    hist = pd.DataFrame(raw["basic"].get("hist_qfq", []))
    if len(hist):
        last = hist.iloc[-1]
        agg["quote_latest"] = {
            "date_close": str(last["日期"]),
            "close": float(last["收盘"]),
            "change_pct": float(last["涨跌幅"]),
            "amount_yuan": float(last["成交额"]),
            "turnover_pct": float(last["换手率"]),
        }
        today = datetime.now()
        def find_close(target_str):
            df = hist[hist["日期"] <= target_str]
            return float(df.iloc[-1]["收盘"]) if len(df) else None
        agg["price_history_points"] = {
            f"{today.year-3}-{today.month:02d}-{today.day:02d}":
                find_close(f"{today.year-3}-{today.month:02d}-{today.day:02d}"),
            f"{today.year-2}-{today.month:02d}-{today.day:02d}":
                find_close(f"{today.year-2}-{today.month:02d}-{today.day:02d}"),
            f"{today.year-1}-{today.month:02d}-{today.day:02d}":
                find_close(f"{today.year-1}-{today.month:02d}-{today.day:02d}"),
            agg["quote_latest"]["date_close"]: agg["quote_latest"]["close"],
        }
    elif ve:
        # fallback: 用 value_em 的最近一日；放弃 turnover_pct
        latest = ve[-1]
        agg["quote_latest"] = {
            "date_close": latest.get("数据日期"),
            "close": float(latest.get("当日收盘价", 0) or 0),
            "change_pct": float(latest.get("当日涨跌幅", 0) or 0),
            "amount_yuan": None,
            "turnover_pct": None,
            "source": "value_em_fallback",
        }
        # 历史关键点：从 value_em 取
        ve_df = pd.DataFrame(ve)
        def find_close_ve(target_str):
            df = ve_df[ve_df["数据日期"] <= target_str]
            return float(df.iloc[-1]["当日收盘价"]) if len(df) else None
        today = datetime.now()
        agg["price_history_points"] = {
            # value_em 只返回 120 日，找不到 3 年前的点 → 标 None
            f"{today.year-3}-{today.month:02d}-{today.day:02d}": find_close_ve(f"{today.year-3}-{today.month:02d}-{today.day:02d}"),
            f"{today.year-2}-{today.month:02d}-{today.day:02d}": find_close_ve(f"{today.year-2}-{today.month:02d}-{today.day:02d}"),
            f"{today.year-1}-{today.month:02d}-{today.day:02d}": find_close_ve(f"{today.year-1}-{today.month:02d}-{today.day:02d}"),
            agg["quote_latest"]["date_close"]: agg["quote_latest"]["close"],
        }
    else:
        agg["quote_latest"] = None
        agg["price_history_points"] = None

    # 财务摘要 → 5 年年度 + 8 季度
    fa_rows = raw["basic"].get("financial_abstract") or []
    if fa_rows:
        fa = pd.DataFrame(fa_rows)
        cy = datetime.now().year
        year_cols = [f"{y}1231" for y in range(cy - 5, cy)]
        q_cols = [f"{y}{m}" for y in [cy - 2, cy - 1] for m in ["0331","0630","0930","1231"]]
        def get_metric(label, cols):
            sel = fa[fa["指标"] == label]
            if len(sel) == 0: return None
            row = sel.iloc[0]
            out = {}
            for col in cols:
                if col in row.index:
                    try:
                        out[col] = float(row[col]) if pd.notna(row[col]) else None
                    except Exception:
                        out[col] = None
                else:
                    out[col] = None
            return out

        def single_quarter(cum):
            if not cum: return None
            out = {}
            for q in q_cols:
                v = cum.get(q)
                if v is None:
                    out[q] = None; continue
                year, mmdd = q[:4], q[4:]
                if mmdd == "0331":
                    out[q] = v
                else:
                    prev_mmdd = {"0630":"0331","0930":"0630","1231":"0930"}[mmdd]
                    prev_v = cum.get(f"{year}{prev_mmdd}")
                    out[q] = (v - prev_v) if (prev_v is not None) else None
            return out

        agg["financials_annual"] = {
            "revenue": get_metric("营业总收入", year_cols),
            "cost": get_metric("营业成本", year_cols),
            "net_profit_attributable": get_metric("归母净利润", year_cols),
            "net_profit_total": get_metric("净利润", year_cols),
            "non_gaap_net_profit": get_metric("扣非净利润", year_cols),
            "operating_cashflow": get_metric("经营现金流量净额", year_cols),
            "shareholders_equity": get_metric("股东权益合计(净资产)", year_cols),
            "eps_basic": get_metric("基本每股收益", year_cols),
            "bvps": get_metric("每股净资产", year_cols),
            "roe_pct": get_metric("净资产收益率(ROE)", year_cols),
            "roa_pct": get_metric("总资产报酬率(ROA)", year_cols),
            "gross_margin_pct": get_metric("毛利率", year_cols),
            "net_margin_pct": get_metric("销售净利率", year_cols),
            "opex_ratio_pct": get_metric("期间费用率", year_cols),
            "debt_ratio_pct": get_metric("资产负债率", year_cols),
        }
        cum_rev = get_metric("营业总收入", q_cols)
        cum_np = get_metric("归母净利润", q_cols)
        agg["financials_quarterly"] = {
            "revenue_single": single_quarter(cum_rev),
            "net_profit_single": single_quarter(cum_np),
            "gross_margin_pct_cum": get_metric("毛利率", q_cols),
        }
    else:
        agg["financials_annual"] = None
        agg["financials_quarterly"] = None

    # 治理
    agg["top10_total"] = raw["governance"].get("top10_em")
    agg["top10_total_as_of"] = raw["governance"].get("top10_em_as_of")
    agg["top10_free"] = raw["governance"].get("top10_free_em")
    agg["top10_free_as_of"] = raw["governance"].get("top10_free_em_as_of")
    agg["research_reports"] = raw["governance"].get("research_report")

    # 公告、新闻、业绩快报
    agg["announcements_recent"] = (raw["news"].get("notice_individual") or [])[:100]
    agg["news_recent"] = raw["news"].get("news_em")
    agg["earnings_flash"] = raw["news"].get("yjbb")
    agg["earnings_preannouncement"] = raw["news"].get("yjyg")
    agg["fund_flow_recent"] = raw["basic"].get("fund_flow")

    path = sym_dir / "aggregate.json"
    path.write_text(json.dumps(agg, ensure_ascii=False, default=str, indent=2))
    print(f"  wrote {path}", file=sys.stderr)
    return path


def run_subprocess(script: str, symbol: str):
    """跑扩展 fetcher（PDF/peers/earnings_call）—— 失败不影响主流程"""
    import subprocess
    path = ROOT / "tools" / script
    if not path.exists():
        print(f"  skip {script}: not found", file=sys.stderr)
        return
    print(f"\n[{script}] {symbol}", file=sys.stderr)
    try:
        r = subprocess.run(
            [sys.executable, str(path), symbol],
            capture_output=True, text=True, timeout=600,
        )
        # 打印 stderr 最后几行
        for line in (r.stderr or "").splitlines()[-10:]:
            print(f"  {line}", file=sys.stderr)
        if r.returncode != 0:
            print(f"  {script} exit={r.returncode} (non-fatal)", file=sys.stderr)
    except subprocess.TimeoutExpired:
        print(f"  {script} TIMEOUT (>600s)", file=sys.stderr)
    except Exception as e:
        print(f"  {script} ERR: {e}", file=sys.stderr)


def main():
    if len(sys.argv) < 2:
        print("usage: run_pipeline.py <symbol> [--skip-extras]   # A股6位 / 港股5位", file=sys.stderr)
        sys.exit(2)
    try:
        symbol = normalize_symbol(sys.argv[1])
        market = detect_market(symbol)
    except Exception as e:
        print(f"ERROR: {e}", file=sys.stderr)
        sys.exit(2)
    skip_extras = "--skip-extras" in sys.argv

    # 港股（5 位代码）走另一条管道：数据源完全不同，但产出的 aggregate.json 同 schema，
    # 所以下游的 validate.py / 判断稿 skill / check_thesis.py 都不用改。
    if market == "hk":
        import run_pipeline_hk
        sys.argv[1] = symbol
        return run_pipeline_hk.main()

    DATA_DIR.mkdir(parents=True, exist_ok=True)
    REPORTS_DIR.mkdir(parents=True, exist_ok=True)

    # 核心：行情 + 治理 + 新闻 → aggregate
    fetch_basic(symbol)
    fetch_governance(symbol)
    fetch_news(symbol)
    out = aggregate(symbol)

    # 扩展：PDF 年报 / 同业 / 业绩说明会（独立运行，失败不阻断）
    if not skip_extras:
        run_subprocess("fetch_annual_pdf.py", symbol)
        run_subprocess("fetch_peers.py", symbol)
        run_subprocess("fetch_earnings_call.py", symbol)

    print(f"\n=== DONE ===")
    print(out)
    extras = []
    sym_dir = symbol_dir(symbol)
    for name in ["annual", "peers", "earnings_call"]:
        p = sym_dir / f"{name}.json"
        if p.exists():
            extras.append(str(p))
    if extras:
        print("Extras:", *extras, sep="\n  ")


if __name__ == "__main__":
    main()
