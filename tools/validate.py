"""校验 data/{symbol}/aggregate.json 是否足够生成报告

退出码（SKILL.md 步骤 2 按此确定性分支，不得询问用户）：
  0 = 核心字段齐备，直接出报告
  1 = 核心字段缺失（约束 7 的四项）→ 不出报告
  2 = 非核心字段缺失或数据警告 → 照常出报告，但每条警告都要在报告里明示
"""
import json
import sys
from pathlib import Path

# 与 SKILL.md「强制约束 7」一一对应，这是核心字段的唯一口径：
#   最新季报 / 5 年财务 / 价格历史 / 十大股东
# 动这个列表就必须同步动 SKILL.md 约束 7，反之亦然。
REQUIRED_PATHS = [
    ("valuation",),                                  # 价格历史 / 估值
    ("valuation", "close"),
    ("valuation", "pe_ttm"),
    ("valuation", "pb"),
    ("quote_latest", "close"),
    ("financials_annual", "revenue"),                # 5 年财务
    ("financials_annual", "net_profit_attributable"),
    ("financials_annual", "gross_margin_pct"),
    ("financials_quarterly", "revenue_single"),      # 最新季报
    ("top10_free",),                                 # 十大股东
]

# 缺失要在报告里明示、但不阻断出报告（exit 2）。
# 这三项原本都在 REQUIRED 里，与约束 7 口径冲突：300877（金春股份）仅因
# 无券商研报覆盖就被判 CRITICAL，数据其余部分全齐却出不了报告。
# 无券商覆盖 / 当年无公告 / 拿不到主营描述，都是"如实标注"的事，不是致命错误。
WARN_PATHS = [
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
    # 非阻断项：缺了继续走，但必须回传给报告层明示
    issues = []
    for p in WARN_PATHS:
        v = get_path(obj, p)
        if v is None or (isinstance(v, (list, dict)) and len(v) == 0):
            name = ".".join(p)
            if name == "research_reports" and obj.get("research_coverage") == "none":
                issues.append("research_reports 为空：该股无券商研报覆盖"
                              "（东财 reportapi 返回 0 条），无 EPS 预测/评级/目标价")
            else:
                issues.append(f"{name} 未取得")

    # 数字合理性
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
