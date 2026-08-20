"""港股 CCASS 持股分布（替代 A 股的十大流通股东）

数据源：https://www3.hkexnews.hk/sdw/search/searchsdw.aspx （ASP.NET 表单，POST）
只保留近 12 个月，指定日为周日/公众假期时站方自动回退到前一交易日。

产出 data/{symbol}/ccass.json：
  - participants:  全部参与者持股（按持股量降序）
  - top10:         前 10 名，字段名对齐 A 股 top10_free 的用法
  - southbound:    港股通南向持股（A00003 深港通 + A00004 沪港通 合计）
  - concentration: 前 5 / 前 10 / 前 20 集中度

用法：python fetch_hk_ccass.py <5位港股代码> [--date YYYY/MM/DD]
"""
import json
import re
import sys
from datetime import datetime, timedelta
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools"))
from lib import normalize_symbol, symbol_dir  # noqa: E402

URL = "https://www3.hkexnews.hk/sdw/search/searchsdw.aspx"
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36"

# 港股通席位：这两个participant就是南向资金，等价于 A 股口径里的"北向持股"镜像
SOUTHBOUND_IDS = {"A00003": "港股通（深）", "A00004": "港股通（沪）"}


def _hidden(html: str, name: str) -> str:
    m = re.search(rf'name="{name}"[^>]*value="([^"]*)"', html)
    return m.group(1) if m else ""


def _cells(row_html: str) -> dict:
    """从一个 <tr> 里按 col-* 类名取 mobile-list-body 的值"""
    out = {}
    for m in re.finditer(
        r'<td class="(col-[a-z\-]+)[^"]*">.*?<div class="mobile-list-body">(.*?)</div>',
        row_html, re.S,
    ):
        out[m.group(1)] = re.sub(r"<[^>]+>|\s+", " ", m.group(2)).strip()
    return out


def fetch_ccass(symbol: str, date_str: str) -> list:
    s = requests.Session()
    s.headers.update({"User-Agent": UA, "Referer": URL})
    html = s.get(URL, timeout=40).text
    payload = {
        "__EVENTTARGET": "btnSearch",
        "__EVENTARGUMENT": "",
        "__VIEWSTATE": _hidden(html, "__VIEWSTATE"),
        "__VIEWSTATEGENERATOR": _hidden(html, "__VIEWSTATEGENERATOR"),
        "today": _hidden(html, "today"),
        "sortBy": "shareholding",
        "sortDirection": "desc",
        "originalShareholdingDate": "",
        "alertMsg": "",
        "txtShareholdingDate": date_str,
        "txtStockCode": symbol,
        "txtStockName": "",
        "txtParticipantID": "",
        "txtParticipantName": "",
        "txtSelPartID": "",
    }
    t = s.post(URL, data=payload, timeout=60).text

    rows = []
    for m in re.finditer(r"<tr>(.*?)</tr>", t, re.S):
        c = _cells(m.group(1))
        pid = c.get("col-participant-id", "")
        if not pid or pid.lower().startswith("participant"):
            continue
        try:
            shares = int(c.get("col-shareholding", "0").replace(",", ""))
        except ValueError:
            continue
        pct_raw = c.get("col-shareholding-percent", "").replace("%", "").strip()
        try:
            pct = float(pct_raw)
        except ValueError:
            pct = None
        rows.append({
            "participant_id": pid,
            "name": c.get("col-participant-name", ""),
            "address": c.get("col-address", ""),
            "shares": shares,
            "pct_of_issued": pct,
        })
    # 站方页面的实际持股日（可能因假期回退）
    m = re.search(r'id="txtShareholdingDate"[^>]*value="([^"]*)"', t)
    actual = m.group(1) if m else date_str
    return rows, actual


def main():
    if len(sys.argv) < 2:
        print("usage: fetch_hk_ccass.py <symbol> [--date YYYY/MM/DD]", file=sys.stderr)
        sys.exit(2)
    symbol = normalize_symbol(sys.argv[1])

    if "--date" in sys.argv:
        candidates = [sys.argv[sys.argv.index("--date") + 1]]
    else:
        # 往前找最多 7 天：站方对未来日期/无数据日返回空
        base = datetime.now()
        candidates = [(base - timedelta(days=i)).strftime("%Y/%m/%d") for i in range(1, 8)]

    rows, actual = [], ""
    for d in candidates:
        try:
            rows, actual = fetch_ccass(symbol, d)
        except Exception as e:
            print(f"  {d} ERR {type(e).__name__}: {e}", file=sys.stderr)
            continue
        if rows:
            print(f"  CCASS {actual}: {len(rows)} 个参与者", file=sys.stderr)
            break
        print(f"  {d} 无数据，往前一天", file=sys.stderr)

    sym_dir = symbol_dir(symbol)
    if not rows:
        out = {"symbol": symbol, "status": "no_ccass_data", "tried": candidates}
        (sym_dir / "ccass.json").write_text(json.dumps(out, ensure_ascii=False, indent=2))
        print("NO CCASS DATA", file=sys.stderr)
        sys.exit(0)

    total = sum(r["shares"] for r in rows)
    sb = [r for r in rows if r["participant_id"] in SOUTHBOUND_IDS]
    for r in sb:
        r["southbound_channel"] = SOUTHBOUND_IDS[r["participant_id"]]

    def head_pct(n):
        return round(sum(r["pct_of_issued"] or 0 for r in rows[:n]), 2)

    out = {
        "symbol": symbol,
        "as_of": actual,
        "source": "HKEX CCASS Shareholding Search",
        "participant_count": len(rows),
        "ccass_total_shares": total,
        "participants": rows,
        "top10": rows[:10],
        "southbound": {
            "shares": sum(r["shares"] for r in sb),
            "pct_of_issued": round(sum(r["pct_of_issued"] or 0 for r in sb), 2),
            "detail": sb,
        },
        "concentration": {
            "top5_pct": head_pct(5),
            "top10_pct": head_pct(10),
            "top20_pct": head_pct(20),
        },
        "caveat": "CCASS 只反映在中央结算系统内的托管分布，"
                  "登记在册但未入 CCASS 的股份（多为控股股东）不在此列；"
                  "参与者是券商/托管行席位，不等于实益股东。实益持有人见年报「主要股东权益」与权益披露。",
    }
    path = sym_dir / "ccass.json"
    path.write_text(json.dumps(out, ensure_ascii=False, indent=2))
    print(f"  wrote {path}", file=sys.stderr)
    print(f"  top5={out['concentration']['top5_pct']}% "
          f"南向={out['southbound']['pct_of_issued']}%")


if __name__ == "__main__":
    main()
