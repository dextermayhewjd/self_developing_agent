"""港股版 earnings_call.json（对标 A 股 fetch_earnings_call.py，同文件名同结构）

**为什么需要这个文件**：`lenses/战略驱动.md` 明确要子 agent 读
`data/{SYMBOL}/earnings_call.json`。港股这边如果这个文件干脆不存在，
子 agent 会读到一个 FileNotFound 然后自己瞎猜要不要继续。所以即便
某些类别在港股制度上没有对应物，也要生成文件并在里面写清楚"为什么是空的、
该改看哪里"——把制度差异写成数据，而不是留给子 agent 去发现。

**港股与 A 股的类别对应**：

| 类别 | A 股来源 | 港股 |
|---|---|---|
| earnings_call | 业绩说明会记录 | 无强制披露 → 用「業績公告」（含管理層討論及分析）替代 |
| investor_relations | 投资者关系活动记录表 | **无对应**：那是深/沪交易所强制要求，港股没有 |
| monthly_operating | 月度经营数据 | **无对应**：港股月报表只报股本变动，不报经营数据 |
| buyback_progress | 回购实施进展 | 「翌日披露報表」（回购次日披露）✓ |
| guidance_change | 业绩预告/快报 | 「盈利預告 / 正面盈利預告 / 盈警 / 盈喜」✓ |
| major_shareholder | 股东增减持 | 部分：「主要股東」变动公告；权益披露在 di.hkex.com.hk（未接） |

用法：python fetch_hk_earnings_call.py <5位港股代码>
"""
import json
import re
import shutil
import subprocess
import sys
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools"))
from lib import normalize_symbol, symbol_dir  # noqa: E402

BASE = "https://www1.hkexnews.hk"
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36"

KW_PATTERNS = [
    ("earnings_call", ["業績公告", "全年業績", "中期業績", "年度業績"]),
    ("buyback_progress", ["翌日披露報表", "股份回購", "購回股份"]),
    ("guidance_change", ["盈利預告", "正面盈利預告", "盈警", "盈喜", "盈利警告"]),
    ("major_shareholder", ["主要股東", "權益變動", "股份權益"]),
]

# 这两类在港股制度上没有对应物，显式写空 + 写明原因，别让子 agent 以为是抓取失败
NO_EQUIVALENT = {
    "investor_relations":
        "港股无对应物。「投资者关系活动记录表」是深交所/上交所的强制披露要求，"
        "香港联交所无此规定，披露易上不存在这类文件"
        "（实测腾讯近 200 条备案里无任何投资者推介材料）。"
        "最接近的一手素材是年报「管理層討論及分析」章节与业绩公告。",
    "monthly_operating":
        "港股无对应物。港股的「股份發行人的證券變動月報表」只披露股本变动"
        "（发行/回购/购股权行使），不含经营数据。"
        "A 股那种月度/季度主要经营数据披露在港股不是强制项。",
}


# 业绩公告的前几页恒是免责声明 + 财务报表，管理层的话在后半部分。
# 直接截前 N 字会全是表格，必须先定位到管理层讨论段落再截。
MD_A_ANCHORS = ["管理層討論及分析", "管理層討論", "業務回顧", "主席報告",
                "業務review", "管理層評論", "財務回顧"]


def pdf_text(url_path: str, max_chars: int = 8000) -> str:
    if not url_path.lower().endswith(".pdf"):
        return ""
    url = url_path if url_path.startswith("http") else BASE + url_path
    try:
        r = requests.get(url, headers={"User-Agent": UA, "Referer": BASE + "/"}, timeout=180)
        r.raise_for_status()
    except Exception as e:
        print(f"    下载失败: {e}", file=sys.stderr)
        return ""
    tmp = symbol_dir("_tmp") / "ann.pdf"
    tmp.write_bytes(r.content)
    if not shutil.which("pdftotext"):
        return ""
    try:
        out = subprocess.run(["pdftotext", str(tmp), "-"],
                             capture_output=True, timeout=120).stdout
        full = out.decode("utf-8", errors="ignore")
        for anchor in MD_A_ANCHORS:
            i = full.find(anchor)
            if i >= 0:
                return full[i: i + max_chars]
        return full[:max_chars]
    except Exception:
        return ""
    finally:
        tmp.unlink(missing_ok=True)


def main():
    if len(sys.argv) < 2:
        print("usage: fetch_hk_earnings_call.py <symbol>", file=sys.stderr)
        sys.exit(2)
    symbol = normalize_symbol(sys.argv[1])
    sym_dir = symbol_dir(symbol)

    fp = sym_dir / "filings.json"
    if not fp.exists():
        print(f"FATAL: {fp} 不存在，请先跑 fetch_hk_filings.py", file=sys.stderr)
        sys.exit(1)
    filings = json.load(open(fp)).get("filings", [])
    print(f"  scanning {len(filings)} filings", file=sys.stderr)

    buckets = {k: [] for k, _ in KW_PATTERNS}
    for f in filings:
        title = re.sub(r"\s+", " ", f.get("TITLE", "") or "")
        for cat, kws in KW_PATTERNS:
            if any(kw in title for kw in kws):
                buckets[cat].append(f)
                break

    out = {"symbol": symbol, "market": "hk", "categories": {}, "no_equivalent": NO_EQUIVALENT}
    for cat, items in buckets.items():
        items = sorted(items, key=lambda x: x.get("DATE_TIME", ""), reverse=True)[:3]
        cat_out = []
        for a in items:
            title = re.sub(r"\s+", " ", a.get("TITLE", ""))
            # 只对业绩公告抽正文（那里面才有管理层讨论）；回购/盈警标题即信息
            text = pdf_text(a.get("FILE_LINK", "")) if cat == "earnings_call" else ""
            print(f"  {cat} | {a.get('DATE_TIME')} | {title[:40]} | {len(text)} chars",
                  file=sys.stderr)
            cat_out.append({
                "date": a.get("DATE_TIME"), "title": title,
                "url": BASE + (a.get("FILE_LINK") or ""),
                "content_chars": len(text), "excerpt": text,
            })
        out["categories"][cat] = cat_out
    for cat in NO_EQUIVALENT:
        out["categories"][cat] = []

    out["note"] = ("港股无「业绩说明会记录」这一强制披露文件；earnings_text 取自"
                   "「業績公告」，其中的「管理層討論及分析」是最接近一手管理层表述的材料。"
                   "categories 里为空且列在 no_equivalent 的类别，是制度上不存在，"
                   "不是抓取失败——不要重试，改读年报对应章节。")

    path = sym_dir / "earnings_call.json"
    path.write_text(json.dumps(out, ensure_ascii=False, default=str, indent=2))
    print(f"  wrote {path}", file=sys.stderr)
    for cat, items in out["categories"].items():
        flag = "（港股无此类）" if cat in NO_EQUIVALENT else ""
        print(f"  {cat}: {len(items)} 条{flag}")


if __name__ == "__main__":
    main()
