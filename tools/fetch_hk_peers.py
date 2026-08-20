"""港股同业对照（对标 A 股 fetch_peers.py，输出同结构 peers.json）

和 A 股的差别：A 股要靠手工维护的同业池（peers_pool.json）逐个抓；
港股这边东财 F10 的「行业对比」接口本身就带整条行业的成员表——
把 akshare 那层 `(CORRE_SECUCODE="X")` 过滤去掉，一次请求拿回全行业，
估值/规模/成长三张表按代码 join 即可。同业池不用手工维护。

**币种陷阱（已实测）**：同一行返回里币种是混的——
  OPERATE_INCOME  是财报本位币原值（佳鑫 = 港元 960,166,214）
  HKTOTAL_MARKET_CAP 是折算成**人民币**的市值（247.67 亿，比值 1.1560 = 中行中间价）
所以市值必须显式折回港元，否则和行情、和指标表的市值对不上，估值直接算错。

用法：python fetch_hk_peers.py <5位港股代码>
"""
import json
import sys
from datetime import datetime
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools"))
from lib import symbol_dir, normalize_symbol  # noqa: E402

API = "https://datacenter.eastmoney.com/securities/api/data/v1/get"
REPORTS = {
    "value": ("RPT_PCF10_INDUSTRY_HKCVALUE",
              "CORRE_SECURITY_CODE,CORRE_SECURITY_NAME,TYPE_NAME,PE_TTM,PB_MQR,PS_TTM,PCE_TTM"),
    "scale": ("RPT_PCF10_INDUSTRY_SCALE",
              "CORRE_SECURITY_CODE,CORRE_SECURITY_NAME,TYPE_NAME,"
              "HKTOTAL_MARKET_CAP,OPERATE_INCOME,GROSS_PROFIT"),
    "growth": ("RPT_PCF10_INDUSTRY_HKGROWTH",
               "CORRE_SECURITY_CODE,CORRE_SECURITY_NAME,TYPE_NAME,"
               "EPS_YOY,OPERATE_INCOME_YOY,OPERATE_PROFIT_YOY,TOTAL_ASSET_YOY"),
}


def hkd_per_cny() -> float:
    """中行「港币」中间价：100 港币兑 N 人民币 → 1 人民币 = 100/N 港币"""
    try:
        import akshare as ak
        end = datetime.now().strftime("%Y%m%d")
        start = (datetime.now().replace(day=1)).strftime("%Y%m%d")
        df = ak.currency_boc_sina(symbol="港币", start_date=start, end_date=end)
        mid = float(df.iloc[-1]["央行中间价"])
        return 100.0 / mid
    except Exception as e:
        print(f"  汇率获取失败（{e}），退回 1.156（近月中枢）", file=sys.stderr)
        return 1.156


def pull(report: str, columns: str, symbol: str) -> list:
    """只按 SECUCODE 过滤 → 返回整条行业；带 CORRE_ 前缀的是对照证券"""
    p = {"reportName": report, "columns": columns,
         "filter": f'(SECUCODE="{symbol}.HK")',
         "pageNumber": "1", "pageSize": "500", "source": "F10", "client": "PC"}
    r = requests.get(API, params=p, timeout=60).json()
    return ((r.get("result") or {}).get("data")) or []


def main():
    if len(sys.argv) < 2:
        print("usage: fetch_hk_peers.py <symbol>", file=sys.stderr)
        sys.exit(2)
    symbol = normalize_symbol(sys.argv[1])

    tables = {}
    for key, (report, cols) in REPORTS.items():
        try:
            tables[key] = pull(report, cols, symbol)
            print(f"  {key}: {len(tables[key])} 家", file=sys.stderr)
        except Exception as e:
            print(f"  {key} ERR: {e}", file=sys.stderr)
            tables[key] = []

    if not tables.get("value"):
        out = {"symbol": symbol, "status": "no_industry_data"}
        (symbol_dir(symbol) / "peers.json").write_text(json.dumps(out, ensure_ascii=False, indent=2))
        print("NO INDUSTRY DATA", file=sys.stderr)
        sys.exit(0)

    fx = hkd_per_cny()
    industry = tables["value"][0].get("TYPE_NAME", "")
    by_code = {}
    for row in tables["value"]:
        code = str(row.get("CORRE_SECURITY_CODE", "")).zfill(5)
        by_code[code] = {
            "symbol": code,
            "label": row.get("CORRE_SECURITY_NAME") + ("（本公司）" if code == symbol else ""),
            "pe_ttm": row.get("PE_TTM"),
            "pb": row.get("PB_MQR"),
            "ps": row.get("PS_TTM"),
            "pcf": row.get("PCE_TTM"),
        }
    for row in tables.get("scale", []):
        code = str(row.get("CORRE_SECURITY_CODE", "")).zfill(5)
        if code not in by_code:
            continue
        mcap_cny = row.get("HKTOTAL_MARKET_CAP")
        by_code[code].update({
            # 折回港元：源字段是人民币口径，见模块 docstring
            "mcap_yi": (mcap_cny * fx / 1e8) if mcap_cny else None,
            "mcap_yi_cny_raw": (mcap_cny / 1e8) if mcap_cny else None,
            "revenue_yi": (row["OPERATE_INCOME"] / 1e8) if row.get("OPERATE_INCOME") else None,
            "net_profit_yi": (row["GROSS_PROFIT"] / 1e8) if row.get("GROSS_PROFIT") else None,
        })
    for row in tables.get("growth", []):
        code = str(row.get("CORRE_SECURITY_CODE", "")).zfill(5)
        if code in by_code:
            by_code[code].update({
                "revenue_yoy_pct": row.get("OPERATE_INCOME_YOY"),
                "eps_yoy_pct": row.get("EPS_YOY"),
                "operate_profit_yoy_pct": row.get("OPERATE_PROFIT_YOY"),
            })

    peers = sorted(by_code.values(), key=lambda x: -(x.get("mcap_yi") or 0))

    def med(field):
        vals = sorted(v[field] for v in peers if v.get(field) not in (None, 0))
        if not vals:
            return None
        n = len(vals)
        return vals[n // 2] if n % 2 else (vals[n // 2 - 1] + vals[n // 2]) / 2

    def pct(field, q):
        vals = sorted(v[field] for v in peers if v.get(field) not in (None, 0))
        return vals[min(len(vals) - 1, int(len(vals) * q))] if vals else None

    out = {
        "symbol": symbol,
        "industry": industry,
        "peer_count": len(peers),
        "fx_hkd_per_cny": round(fx, 4),
        "currency": {"mcap_yi": "HKD", "revenue_yi": "报表本位币", "note":
                     "mcap_yi 已由源接口的人民币口径折算为港元；mcap_yi_cny_raw 保留原值备查"},
        "industry_stats": {
            "pe_ttm_median": med("pe_ttm"), "pe_ttm_p25": pct("pe_ttm", 0.25),
            "pe_ttm_p75": pct("pe_ttm", 0.75),
            "pb_median": med("pb"), "ps_median": med("ps"),
        },
        "peers": peers,
        "source": "东财港股 F10 行业对比（估值/规模/成长三表 join）",
    }
    path = symbol_dir(symbol) / "peers.json"
    path.write_text(json.dumps(out, ensure_ascii=False, default=str, indent=2))
    print(f"  wrote {path}", file=sys.stderr)
    print(f"\n行业：{industry}（{len(peers)} 家）  "
          f"PE中位数 {out['industry_stats']['pe_ttm_median']}  "
          f"PB中位数 {out['industry_stats']['pb_median']}")
    print("LABEL | MCAP亿HKD | PE | PB | PS | REV亿 | NP亿")
    for r in peers[:12]:
        f = lambda v, d=1: (f"{v:.{d}f}" if isinstance(v, (int, float)) else "-")
        print(f"{r['label'][:20]:22} | {f(r.get('mcap_yi'),0):>9} | {f(r.get('pe_ttm')):>6} | "
              f"{f(r.get('pb'),2):>5} | {f(r.get('ps'),2):>5} | {f(r.get('revenue_yi')):>7} | {f(r.get('net_profit_yi'),2):>6}")


if __name__ == "__main__":
    main()
