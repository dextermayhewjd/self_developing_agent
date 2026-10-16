"""校验 data/{symbol}/aggregate.json 是否足够生成报告

退出码（SKILL.md 步骤 2 按此确定性分支，不得询问用户）：
  0 = 核心字段齐备，直接出报告
  1 = 核心字段缺失（约束 7 的四项）→ 不出报告
  2 = 非核心字段缺失或数据警告 → 照常出报告，但每条警告都要在报告里明示
"""
import json
import re
import sys
from pathlib import Path

DATA_ROOT = Path(__file__).resolve().parent.parent / "data"

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

RAW_FILES = ["basic", "governance", "news"]


def get_path(obj, path):
    cur = obj
    for k in path:
        if cur is None: return None
        if isinstance(cur, dict):
            cur = cur.get(k)
        else:
            return None
    return cur


def freshness_issues(obj, raw_period_columns):
    """数据"有"但"旧"——核心字段齐备照样会过关，必须单独查。

    301557（2026-09）的教训：原始层 financial_abstract 已有 20260630，汇总层季度序列
    却止于 20251231，十大股东也停在 20251231，校验照样 exit 0，报告整段用旧数据。
    raw_period_columns 为空（港股管线没有 financial_abstract）时跳过原始层比对。
    """
    issues = []
    rs = get_path(obj, ("financials_quarterly", "revenue_single")) or {}
    agg_latest = max((k for k, v in rs.items() if v is not None), default=None)
    raw_latest = max((c for c in raw_period_columns if re.fullmatch(r"\d{8}", str(c))), default=None)
    if agg_latest and raw_latest and raw_latest > agg_latest:
        issues.append(f"最新季报过期：aggregate.json 季度序列止于 {agg_latest}，"
                      f"原始层财务摘要已有 {raw_latest}（流水线汇总遗漏）")
    latest_q = max(filter(None, [agg_latest, raw_latest]), default=None)
    # 港股 CCASS 日期是 '2026/09/14'，只留数字再比，否则 '/' < '0' 会误判过期
    top_as_of = re.sub(r"\D", "", str(obj.get("top10_free_as_of") or ""))[:8]
    if top_as_of and latest_q and top_as_of < latest_q:
        issues.append(f"十大流通股东截至 {top_as_of}，早于最新财报期 {latest_q}（新一期名单未取得）")
    # 两个行情源更新节奏不同（新浪日线 vs 东财估值），盘后跑数时常差一天
    q_date = str(get_path(obj, ("quote_latest", "date_close")) or "")[:10]
    v_date = str(get_path(obj, ("valuation", "as_of")) or "")[:10]
    if q_date and v_date and q_date != v_date:
        issues.append(f"行情日期不一致：日线序列止于 {q_date}，估值数据截至 {v_date}（现价与估值倍数须取同一日）")
    return issues


def collector_error_issues(raw_by_name):
    """原始层 errors 里记下的取数失败，逐条回传给报告层——否则只表现为"某字段为空"。"""
    issues = []
    for name, raw in raw_by_name.items():
        for key, err in ((raw or {}).get("errors") or {}).items():
            issues.append(f"{name}.{key} 取数失败：{err}")
    return issues


def load_raw(sym_dir):
    out = {}
    for name in RAW_FILES:
        p = sym_dir / f"{name}.json"
        if p.exists():
            try:
                out[name] = json.load(open(p))
            except json.JSONDecodeError:
                out[name] = {"errors": {"_file": f"{p.name} 无法解析"}}
    return out


def raw_financial_columns(raw_by_name):
    rows = get_path(raw_by_name, ("basic", "data", "financial_abstract")) or []
    return list(rows[0].keys()) if rows else []


def main():
    if len(sys.argv) < 2:
        print("usage: validate.py <symbol>")
        sys.exit(2)
    symbol = sys.argv[1].strip().lstrip("sh").lstrip("sz")
    sym_dir = DATA_ROOT / symbol
    path = sym_dir / "aggregate.json"
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
    if obj.get("research_coverage") == "covered" and obj.get("consensus_eps_available") is False:
        issues.append("research_reports 有覆盖但无任何 EPS 预测：共识 EPS 区间不可计算")

    raw = load_raw(sym_dir)
    issues += freshness_issues(obj, raw_financial_columns(raw))
    issues += collector_error_issues(raw)

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
