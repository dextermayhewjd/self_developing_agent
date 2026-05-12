"""同业对照：根据股票行业找到同业池 → 抓每个对手的核心指标 → 输出对比表。

输入：symbol
输出：data/{symbol}/peers.json

包含字段（每个对手）：
- 名称、当前价、总市值
- PE(TTM)、P/B、P/S
- 最新年度营收、归母净利、毛利率、ROE
- 最新年度营收 YoY
"""
import json
import sys
import time
from pathlib import Path

import akshare as ak
import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools"))
from lib import DATA_DIR, symbol_dir  # noqa: E402

POOL_PATH = ROOT / ".claude" / "skills" / "equity-report-cn" / "competitor_pool.json"


def get_industry(symbol: str) -> str:
    # 优先：stock_individual_info_em
    for attempt in range(3):
        try:
            df = ak.stock_individual_info_em(symbol=symbol)
            row = df[df["item"] == "行业"]
            if len(row):
                return str(row.iloc[0]["value"])
        except Exception:
            time.sleep(2)
    # fallback 1：从 earnings_flash 的"所处行业"取
    agg_path = symbol_dir(symbol) / "aggregate.json"
    if agg_path.exists():
        try:
            agg = json.load(open(agg_path))
            ef = (agg.get("earnings_flash") or [])
            if ef and ef[0].get("所处行业"):
                print(f"  industry from earnings_flash: {ef[0]['所处行业']}", file=sys.stderr)
                return str(ef[0]["所处行业"])
            # fallback 2：研报"行业"
            rr = agg.get("research_reports") or []
            if rr and rr[0].get("行业"):
                print(f"  industry from research_reports: {rr[0]['行业']}", file=sys.stderr)
                return str(rr[0]["行业"])
        except Exception:
            pass
    return ""


def lookup_pool(industry: str) -> dict:
    pool = json.load(open(POOL_PATH))
    if industry in pool:
        entry = pool[industry]
        if "alias" in entry:
            return pool[entry["alias"]]
        return entry
    # 模糊匹配
    for k, v in pool.items():
        if k.startswith("_"):
            continue
        if industry and (industry in k or k in industry):
            if "alias" in v:
                return pool[v["alias"]]
            return v
    return pool["_unknown_fallback"]


def fetch_peer_snapshot(symbol: str) -> dict:
    """简化版抓取：只拿对照所需字段（不跑完整 pipeline）"""
    out = {"symbol": symbol}
    # 估值与市值
    try:
        ve = ak.stock_value_em(symbol=symbol).tail(1)
        if len(ve):
            r = ve.iloc[0]
            out.update({
                "close": float(r["当日收盘价"]),
                "mcap_yi": float(r["总市值"]) / 1e8,
                "pe_ttm": float(r["PE(TTM)"]),
                "pb": float(r["市净率"]),
                "ps": float(r["市销率"]),
                "as_of": r["数据日期"],
            })
    except Exception as e:
        out["valuation_err"] = str(e)

    # 财务摘要：取最近年度（CY{Y-1}1231）
    try:
        fa = ak.stock_financial_abstract(symbol=symbol)
        from datetime import datetime
        target = f"{datetime.now().year - 1}1231"
        prev = f"{datetime.now().year - 2}1231"
        def get(label):
            sel = fa[fa["指标"] == label]
            if len(sel) == 0: return None
            row = sel.iloc[0]
            return (
                (float(row[target]) if target in row.index and pd.notna(row[target]) else None),
                (float(row[prev])   if prev   in row.index and pd.notna(row[prev])   else None),
            )
        rev_t, rev_p = get("营业总收入")
        np_t, _ = get("归母净利润")
        gm_t, _ = get("毛利率")
        roe_t, _ = get("净资产收益率(ROE)")
        out.update({
            "revenue_yi": rev_t / 1e8 if rev_t else None,
            "revenue_yoy_pct": ((rev_t / rev_p - 1) * 100) if (rev_t and rev_p) else None,
            "net_profit_yi": np_t / 1e8 if np_t else None,
            "gross_margin_pct": gm_t,
            "roe_pct": roe_t,
        })
    except Exception as e:
        out["financials_err"] = str(e)
    return out


def main():
    if len(sys.argv) < 2:
        print("usage: fetch_peers.py <symbol>", file=sys.stderr)
        sys.exit(2)
    symbol = sys.argv[1].strip().lstrip("sh").lstrip("sz").lstrip("bj")

    industry = get_industry(symbol)
    print(f"  industry: {industry}", file=sys.stderr)
    pool = lookup_pool(industry)
    peers = pool.get("stars", [])
    labels = pool.get("labels", {})
    if symbol not in peers:
        peers = [symbol] + peers
        labels = {symbol: f"{symbol}（本公司）", **labels}
    print(f"  peers ({len(peers)}): {peers}", file=sys.stderr)

    results = []
    for p in peers:
        print(f"  fetching {p}...", file=sys.stderr)
        try:
            snap = fetch_peer_snapshot(p)
            snap["label"] = labels.get(p, p)
            results.append(snap)
        except Exception as e:
            print(f"    err: {e}", file=sys.stderr)
            results.append({"symbol": p, "label": labels.get(p, p), "error": str(e)})
        time.sleep(0.5)

    out = {
        "symbol": symbol, "industry": industry,
        "peers": results,
    }
    out_path = symbol_dir(symbol) / "peers.json"
    out_path.write_text(json.dumps(out, ensure_ascii=False, default=str, indent=2))
    print(f"  wrote {out_path}", file=sys.stderr)
    # 打印对照表
    print("\nLABEL | MCAP亿 | PE | PB | PS | REV亿 | YoY% | NP亿 | GM% | ROE%")
    for r in results:
        print(f"{r.get('label','?'):28} | {r.get('mcap_yi',0):.0f} | "
              f"{r.get('pe_ttm',0):.1f} | {r.get('pb',0):.2f} | {r.get('ps',0):.2f} | "
              f"{r.get('revenue_yi',0):.0f} | {r.get('revenue_yoy_pct',0):.1f} | "
              f"{r.get('net_profit_yi',0):.1f} | {r.get('gross_margin_pct',0):.1f} | "
              f"{r.get('roe_pct',0):.1f}")


if __name__ == "__main__":
    main()
