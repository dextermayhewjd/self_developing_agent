"""校验 data/{symbol}/aggregate.json 是否足够生成报告
退出码：0=通过，1=核心字段缺失，2=数据不合理
"""
import json
import sys
from pathlib import Path

REQUIRED_PATHS = [
    ("valuation",),
    ("valuation", "close"),
    ("valuation", "pe_ttm"),
    ("valuation", "pb"),
    ("quote_latest", "close"),
    ("financials_annual", "revenue"),
    ("financials_annual", "net_profit_attributable"),
    ("financials_annual", "gross_margin_pct"),
    ("financials_quarterly", "revenue_single"),
    ("top10_free",),
    ("research_reports",),
    ("announcements_recent",),
    ("business",),
]


def get_path(obj, path):
    cur = obj
    for k in path:
        if cur is None: return None
        if isinstance(cur, dict):
            cur = cur.get(k)
        else:
            return None
    return cur


def main():
    if len(sys.argv) < 2:
        print("usage: validate.py <symbol>")
        sys.exit(2)
    symbol = sys.argv[1].strip().lstrip("sh").lstrip("sz")
    path = Path(__file__).resolve().parent.parent / "data" / symbol / "aggregate.json"
    if not path.exists():
        print(f"FATAL: {path} 不存在")
        sys.exit(1)
    obj = json.load(open(path))
    missing = []
    for p in REQUIRED_PATHS:
        v = get_path(obj, p)
        if v is None or (isinstance(v, (list, dict)) and len(v) == 0):
            missing.append(".".join(p))
    if missing:
        print("CRITICAL fields missing:")
        for m in missing:
            print(f"  - {m}")
        sys.exit(1)
    # 数字合理性
    issues = []
    fa = obj["financials_annual"]
    rev = fa.get("revenue") or {}
    # 至少有 3 年营收数据
    # 注意用 `is not None` 而不是 `if v`：营收合法地等于 0 是存在的
    # （港股 03858 佳鑫国际，矿山 2025 年才投产，2021-2024 营收就是 0），
    # 用真值判断会把这些年错判成缺数据。
    non_null_years = sum(1 for v in rev.values() if v is not None)
    if non_null_years < 3:
        issues.append(f"年度营收 only {non_null_years} 个年份有数据（要 ≥3）")
    val = obj["valuation"]
    if not (0.01 < val["close"] < 10000):
        issues.append(f"close={val['close']} 不在合理区间")
    if val["pe_ttm"] and val["pe_ttm"] < 0:
        print(f"NOTE: PE(TTM) 为负 ({val['pe_ttm']}) — 公司亏损，需要用其他估值方法")
    if issues:
        print("DATA WARNINGS:")
        for i in issues:
            print(f"  - {i}")
        sys.exit(2)
    # 港股的行情与市值是港元，A 股是人民币；别用硬编码的 ¥ 糊弄过去
    cur = (obj.get("currency") or {}).get("quote_and_mcap")
    sym_cur = {"HKD": "HK$", "USD": "US$"}.get(cur, "¥")
    print(f"OK  {symbol}: all core fields present, {non_null_years} years of revenue data")
    print(f"     close={sym_cur}{val['close']} mcap={sym_cur}{val['total_mcap_yuan']/1e8:.1f}亿 "
          f"PE(TTM)={val['pe_ttm']:.1f}x")


if __name__ == "__main__":
    main()
