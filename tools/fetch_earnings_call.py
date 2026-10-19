"""从公告里提取业绩说明会相关 + 月度经营数据 + 关键事项公告正文 + 互动易问答。

策略：
- 在 announcements_recent 里按标题关键词分桶（见 KW_PATTERNS）
  - 业绩说明会 / 投资者关系 / 调研 / 经营数据 / 回购 / 增减持 / 业绩预告
  - 关键事项：重大合同 / 会计政策变更 / 对外投资 / 限售股上市流通
    （只有标题时报告写不出合同对手、金额、影响，301557 的远景能源 9.49 亿元
    芯材协议就因此整条漏掉）
- 通过东财公告 API 抓内容文本（典型 ≤ 5000 字一页）
- 另抓深交所互动易 / 上证 e 互动问答（stock_irm_cninfo），补业绩说明会之外的一手问答
"""
import json
import re
import sys
import time
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools"))
from lib import DATA_DIR, detect_market, symbol_dir  # noqa: E402

UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36"
HEADERS = {"User-Agent": UA, "Referer": "https://data.eastmoney.com/"}
API = "https://np-cnotice-stock.eastmoney.com/api/content/ann"

# 顺序即优先级：一个标题只进第一个命中的桶
KW_PATTERNS = [
    ("earnings_call", ["业绩说明会"]),
    ("investor_relations", ["投资者关系活动", "调研活动"]),
    ("material_contract", ["重大合同", "中标"]),
    ("accounting_change", ["会计政策变更", "会计估计变更"]),
    ("investment", ["共同投资", "对外投资", "产业基金", "收购"]),
    ("lockup_release", ["上市流通"]),
    ("pledge", ["股份质押", "解除质押"]),
    ("monthly_operating", ["主要经营数据", "月度经营数据", "经营情况", "季度主要经营"]),
    ("buyback_progress", ["回购股份实施进展", "回购股份进展"]),
    ("major_shareholder", ["股东减持", "股东增持", "持股变动"]),
    ("guidance_change", ["业绩预告", "业绩快报", "盈利预测调整"]),
]
EXCLUDE_TITLE = ["港股", "英文版", "翌日披露"]
IRM_LIMIT = 20
IRM_ANSWER_CHARS = 1000


def classify_title(title: str):
    """公告标题 → 分桶名；不属于任何桶返回 None。"""
    title = title or ""
    if any(x in title for x in EXCLUDE_TITLE):
        return None
    for cat, kws in KW_PATTERNS:
        if any(kw in title for kw in kws):
            return cat
    return None


def irm_records(rows, limit: int = IRM_LIMIT):
    """互动易问答：只留已回复的，按提问时间倒序取前 limit 条，字段收窄到问与答。"""
    answered = [r for r in rows
                if isinstance(r.get("回答内容"), str) and r["回答内容"].strip()]
    answered.sort(key=lambda r: str(r.get("提问时间") or ""), reverse=True)
    return [{"提问时间": str(r.get("提问时间") or ""),
             "问题": r.get("问题"),
             "回答内容": r["回答内容"][:IRM_ANSWER_CHARS]} for r in answered[:limit]]


def irm_supported(symbol: str) -> bool:
    """stock_irm_cninfo 只覆盖深交所互动易；沪市实测 KeyError，上证e互动接口实测返回空。"""
    return detect_market(symbol) == "sz"


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
        cat = classify_title(a.get("公告标题"))
        if cat:
            buckets[cat].append(a)

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

    out["irm_qa"] = []
    if not irm_supported(symbol):
        out["irm_qa_error"] = "结构性限制：stock_irm_cninfo 只覆盖深交所互动易，上证e互动 / 北交所无可用接口"
    else:
        try:
            import akshare as ak
            df = ak.stock_irm_cninfo(symbol=symbol)
            out["irm_qa"] = irm_records(df.to_dict(orient="records"))
        except Exception as e:
            out["irm_qa_error"] = f"{type(e).__name__}: {e}"
    print(f"  irm_qa: {len(out['irm_qa'])} 条已回复问答 {out.get('irm_qa_error', '')}", file=sys.stderr)

    path = sym_dir / "earnings_call.json"
    path.write_text(json.dumps(out, ensure_ascii=False, default=str, indent=2))
    print(f"  wrote {path}", file=sys.stderr)
    # summary
    for cat, items in out["categories"].items():
        print(f"  {cat}: {len(items)} 条")


if __name__ == "__main__":
    main()
