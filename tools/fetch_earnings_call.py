"""从公告里提取业绩说明会相关 + 月度经营数据。

策略：
- 在 announcements_recent 找最近 12 个月含关键词的公告
  - "业绩说明会" / "投资者关系" / "调研" / "经营数据" / "月度经营"
- 通过东财公告 API 抓内容文本（典型 ≤ 5000 字一页）
- 输出 sections + 关键问答摘录
"""
import json
import re
import sys
import time
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools"))
from lib import DATA_DIR, symbol_dir  # noqa: E402

UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36"
HEADERS = {"User-Agent": UA, "Referer": "https://data.eastmoney.com/"}
API = "https://np-cnotice-stock.eastmoney.com/api/content/ann"

KW_PATTERNS = [
    ("earnings_call", ["业绩说明会"]),
    ("investor_relations", ["投资者关系活动", "调研活动"]),
    ("monthly_operating", ["主要经营数据", "月度经营数据", "经营情况", "季度主要经营"]),
    ("buyback_progress", ["回购股份实施进展", "回购股份进展"]),
    ("major_shareholder", ["股东减持", "股东增持", "持股变动"]),
    ("guidance_change", ["业绩预告", "业绩快报", "盈利预测调整"]),
]


def extract_art_code(url: str) -> str:
    m = re.search(r"(AN\d+)", url)
    return m.group(1) if m else ""


def fetch_content(art_code: str) -> str:
    full = []
    for page in range(1, 6):
        try:
            r = requests.get(API, params={
                "cb": "j", "art_code": art_code, "client_source": "web_em",
                "page_index": page, "_": "1"
            }, headers=HEADERS, timeout=20)
            body = re.sub(r"^[^(]*\(", "", r.text, count=1)
            body = re.sub(r"\)\s*;?\s*$", "", body)
            data = json.loads(body).get("data", {})
            content = data.get("notice_content", "") or ""
            if not content:
                break
            full.append(content)
            if len(content) < 4500:
                break
        except Exception:
            break
    return "".join(full)


def main():
    if len(sys.argv) < 2:
        print("usage: fetch_earnings_call.py <symbol>", file=sys.stderr); sys.exit(2)
    symbol = sys.argv[1].strip().lstrip("sh").lstrip("sz").lstrip("bj")

    sym_dir = symbol_dir(symbol)
    agg_path = sym_dir / "aggregate.json"
    if not agg_path.exists():
        print(f"FATAL: {agg_path} 不存在", file=sys.stderr); sys.exit(1)
    agg = json.load(open(agg_path))
    announcements = agg.get("announcements_recent") or []
    print(f"  scanning {len(announcements)} announcements", file=sys.stderr)

    # 按类别分桶
    buckets = {k: [] for k, _ in KW_PATTERNS}
    for a in announcements:
        title = a.get("公告标题") or ""
        # 排除港股、英文
        if any(x in title for x in ["港股", "英文版", "翌日披露"]):
            continue
        for cat, kws in KW_PATTERNS:
            if any(kw in title for kw in kws):
                buckets[cat].append(a)
                break

    out = {"symbol": symbol, "categories": {}}
    for cat, items in buckets.items():
        items = sorted(items, key=lambda x: x.get("公告日期", ""), reverse=True)[:3]
        cat_out = []
        for a in items:
            art = extract_art_code(a.get("网址", ""))
            if not art:
                continue
            text = fetch_content(art)
            print(f"  {cat} | {a.get('公告日期')} | art={art} | {len(text)} chars",
                  file=sys.stderr)
            cat_out.append({
                "date": a.get("公告日期"), "title": a.get("公告标题"),
                "art_code": art, "content_chars": len(text),
                "excerpt": text[:8000],  # 前 8k 字
            })
            time.sleep(0.3)
        out["categories"][cat] = cat_out

    path = sym_dir / "earnings_call.json"
    path.write_text(json.dumps(out, ensure_ascii=False, default=str, indent=2))
    print(f"  wrote {path}", file=sys.stderr)
    # summary
    for cat, items in out["categories"].items():
        print(f"  {cat}: {len(items)} 条")


if __name__ == "__main__":
    main()
