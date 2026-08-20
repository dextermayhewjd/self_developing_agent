"""港股备案抓取：年报 + 招股章程 + 公告清单（对标 A 股 fetch_annual_pdf.py）

数据源：披露易 https://www1.hkexnews.hk/search/titleSearchServlet.do
（A 股走的东财 np-cnotice 接口只覆盖 A 股公告，港股必须走披露易。）

产出：
  data/{symbol}/annual_pdf/*.pdf     年报与招股章程原件
  data/{symbol}/annual.json          与 A 股同名同结构：annual_meta / annual_reports / sections
  data/{symbol}/filings.json         全部备案清单（供 announcements_recent 用）

两点港股特有的处理：
1. **年报是繁体**。A 股那套简体关键词（"主营业务分行业""前五名客户"）在繁体年报里
   一个都命中不了，所以这里另起一套港式词表，并加了港股独有的段落
   （主要股东权益 / 关连交易 / 公众持股量 / 核数师报告）。
2. **次新股用招股章程补历史**。港股上市未满 3 年的公司只有 1-2 份年报，
   而招股章程（「全球發售」）里的会计师报告覆盖上市前三年 track record——
   这是这类公司唯一的历史财务来源，所以一并抓下来当作一期"年报"。

用法：python fetch_hk_filings.py <5位港股代码> [--years N]
"""
import json
import re
import sys
from datetime import datetime
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools"))
from lib import symbol_dir, normalize_symbol  # noqa: E402

DEFAULT_YEARS = 3
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36"
HEADERS = {"User-Agent": UA, "Referer": "https://www1.hkexnews.hk/"}
BASE = "https://www1.hkexnews.hk"
SEARCH = f"{BASE}/search/titleSearchServlet.do"
PREFIX = f"{BASE}/search/prefix.do"

# 年报标题（繁体）：2025年度報告 / 年報 / Annual Report
RE_ANNUAL = re.compile(r"(年度報告|年報|Annual Report)", re.I)
# 招股章程：港股 IPO 文件叫「全球發售」，聆讯后资料集叫「聆訊後資料集」
RE_IPO = re.compile(r"(全球發售|招股章程|聆訊後資料集|Prospectus)", re.I)
RE_EXCLUDE = re.compile(r"(中期|季度|環境、社會|ESG|摘要|補充|更正|Interim|Quarterly)", re.I)
RE_YEAR = re.compile(r"(\d{4})\s*年?\s*(?:年度報告|年報|Annual Report)", re.I)


def lookup_stock_id(symbol: str) -> str:
    """代码 → 披露易内部 stockId"""
    r = requests.get(PREFIX, params={"callback": "c", "lang": "ZH", "type": "A", "name": symbol},
                     headers=HEADERS, timeout=40)
    m = re.search(r'\{.*\}', r.text, re.S)
    if not m:
        raise RuntimeError(f"prefix.do 无返回：{r.text[:200]}")
    data = json.loads(m.group(0))
    for info in data.get("stockInfo", []):
        if str(info.get("code", "")).zfill(5) == symbol:
            return str(info["stockId"])
    raise RuntimeError(f"披露易查不到代码 {symbol}")


def search_filings(stock_id: str, from_date: str, to_date: str, rows: int = 200) -> list:
    params = {
        "sortDir": "0", "sortByOptions": "DateTime", "category": "0", "market": "SEHK",
        "stockId": stock_id, "documentType": "-1", "fromDate": from_date, "toDate": to_date,
        "title": "", "searchType": "1", "t1code": "-1", "t2Gcode": "-2", "t2code": "-2",
        "rowRange": str(rows), "lang": "ZH",
    }
    r = requests.get(SEARCH, params=params, headers=HEADERS, timeout=60)
    payload = r.json()
    result = payload.get("result")
    return json.loads(result) if isinstance(result, str) else (result or [])


def filing_year(title: str, date_time: str) -> str:
    m = RE_YEAR.search(title or "")
    if m:
        return m.group(1)
    m = re.search(r"(\d{2})/(\d{2})/(\d{4})", date_time or "")
    return str(int(m.group(3)) - 1) if m else ""


def download(symbol: str, url_path: str, tag: str) -> Path | None:
    if not url_path or not url_path.lower().endswith(".pdf"):
        return None
    url = url_path if url_path.startswith("http") else BASE + url_path
    out_dir = symbol_dir(symbol) / "annual_pdf"
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / f"{symbol}_{tag}.pdf"
    if path.exists() and path.stat().st_size > 10000:
        print(f"  cached {path.name} ({path.stat().st_size/1e6:.1f}MB)", file=sys.stderr)
        return path
    try:
        r = requests.get(url, headers=HEADERS, timeout=300)
        r.raise_for_status()
        path.write_bytes(r.content)
        print(f"  saved {path.name} ({len(r.content)/1e6:.1f}MB)", file=sys.stderr)
        return path
    except Exception as e:
        print(f"  下载失败 {url}: {e}", file=sys.stderr)
        return None


def parse_pdf_text(pdf_path, max_pages: int = 1200) -> str:
    """优先 pdftotext（poppler），失败再退 pdfplumber。

    速度差距是数量级的：955 页 36MB 的招股章程 pdftotext 约 1 秒，
    pdfplumber 要几分钟。港股招股章程动辄近千页，这个差别决定了
    "顺手抽出来"和"抽不起"。
    """
    import shutil
    import subprocess
    if shutil.which("pdftotext"):
        try:
            r = subprocess.run(
                ["pdftotext", "-f", "1", "-l", str(max_pages), str(pdf_path), "-"],
                capture_output=True, timeout=300,
            )
            text = r.stdout.decode("utf-8", errors="ignore")
            if len(text) > 1000:
                print(f"  pdftotext: {len(text):,} 字", file=sys.stderr)
                return text
        except Exception as e:
            print(f"  pdftotext 失败（退回 pdfplumber）: {e}", file=sys.stderr)
    try:
        import pdfplumber
        with pdfplumber.open(pdf_path) as pdf:
            n = min(len(pdf.pages), max_pages)
            print(f"  pdfplumber 解析 {n} 页...", file=sys.stderr)
            chunks = []
            for i in range(n):
                try:
                    chunks.append(pdf.pages[i].extract_text() or "")
                except Exception:
                    continue
            return "\n".join(chunks)
    except Exception as e:
        print(f"  pdfplumber 失败: {e}", file=sys.stderr)
        return ""


# 港式繁体词表。前 10 项对齐 A 股 KEYWORDS 的键名，后 4 项是港股独有段落。
KEYWORDS = {
    "business_segments": ["分部資料", "分部業績", "經營分部", "收益分析", "業務回顧", "收益及其他收入"],
    "customer_concentration": ["五大客戶", "最大客戶", "主要客戶", "客戶集中"],
    "supplier_concentration": ["五大供應商", "最大供應商", "主要供應商"],
    "capex_long_term": ["購買物業、廠房及設備", "資本開支", "資本承擔", "資本性開支"],
    "rnd": ["研發開支", "研究及開發", "研發成本", "研發活動"],
    "moat": ["競爭優勢", "核心競爭力", "業務優勢"],
    "risk": ["主要風險", "風險因素", "風險管理", "面臨的風險"],
    "outlook": ["未來展望", "業務展望", "前景", "發展策略", "未來計劃"],
    "dividend": ["末期股息", "派息", "股息政策", "建議派發"],
    "segment_split": ["分部資料", "按分部", "經營分部"],
    # ↓ 港股独有：A 股无对应概念，但判断稿里是承重信息
    "substantial_shareholders": ["主要股東", "主要股東權益", "須予披露的權益", "董事及最高行政人員"],
    "connected_transactions": ["關連交易", "持續關連交易", "關連人士"],
    "public_float": ["公眾持股量", "足夠的公眾持股量", "公眾人士持有"],
    "auditor": ["核數師報告", "獨立核數師", "保留意見", "強調事項"],
}


# 招股章程独有的段落：这些在年报里没有，但对次新股的判断是承重的
PROSPECTUS_KEYWORDS = {
    "track_record": ["往績記錄期", "往績記錄"],
    "accountant_report": ["會計師報告", "財務資料", "經審核財務報表"],
    "use_of_proceeds": ["所得款項用途", "所得款項淨額"],
    "cornerstone": ["基石投資者", "基石投資"],
    "pre_ipo_investors": ["首次公開發售前投資", "上市前投資"],
    "industry_overview": ["行業概覽", "市場規模", "競爭格局"],
}


def locate_sections(text: str, context_chars: int = 1200, extra: dict | None = None) -> dict:
    table = {**KEYWORDS, **(extra or {})}
    out = {k: [] for k in table}
    for key, kws in table.items():
        seen = set()
        for kw in kws:
            for m in re.finditer(re.escape(kw), text):
                pos = m.start()
                if any(abs(pos - p) < 500 for p in seen):
                    continue
                seen.add(pos)
                excerpt = text[max(0, pos - 100): pos + context_chars].strip()
                excerpt = re.sub(r"[ \t]+", " ", excerpt)
                out[key].append({"char_pos": pos, "keyword": kw, "excerpt": excerpt})
    return out


def main():
    if len(sys.argv) < 2:
        print("usage: fetch_hk_filings.py <symbol> [--years N]", file=sys.stderr)
        sys.exit(2)
    symbol = normalize_symbol(sys.argv[1])
    years = DEFAULT_YEARS
    if "--years" in sys.argv:
        try:
            years = max(1, int(sys.argv[sys.argv.index("--years") + 1]))
        except (IndexError, ValueError):
            pass

    sym_dir = symbol_dir(symbol)
    stock_id = lookup_stock_id(symbol)
    print(f"  stockId={stock_id}", file=sys.stderr)

    today = datetime.now()
    # 多抓两年：年报滞后一年发布，招股章程可能更早
    from_date = f"{today.year - years - 2}0101"
    filings = search_filings(stock_id, from_date, today.strftime("%Y%m%d"))
    print(f"  披露易返回 {len(filings)} 条备案", file=sys.stderr)

    (sym_dir / "filings.json").write_text(json.dumps({
        "symbol": symbol, "stock_id": stock_id, "count": len(filings),
        "fetched_at": today.isoformat(), "filings": filings,
    }, ensure_ascii=False, indent=2))

    annuals, ipo_docs = [], []
    for f in filings:
        title = f.get("TITLE", "") or ""
        link = f.get("FILE_LINK", "") or ""
        if not link.lower().endswith(".pdf"):
            continue
        if RE_ANNUAL.search(title) and not RE_EXCLUDE.search(title):
            annuals.append(f)
        elif RE_IPO.search(title) and not RE_EXCLUDE.search(title):
            ipo_docs.append(f)

    # 同年度可能有多份（中英文/补充），按日期降序后按年度去重
    annuals.sort(key=lambda x: x.get("DATE_TIME", ""), reverse=True)
    picked, seen_years = [], set()
    for f in annuals:
        y = filing_year(f.get("TITLE", ""), f.get("DATE_TIME", ""))
        if y in seen_years:
            continue
        seen_years.add(y)
        picked.append((y, f))
        if len(picked) >= years:
            break

    # 年报不足 N 期 → 补招股章程（次新股的唯一历史财务来源），取体积最大的那份
    if len(picked) < years and ipo_docs:
        ipo_docs.sort(key=lambda x: x.get("DATE_TIME", ""), reverse=True)
        picked.append(("IPO招股章程", ipo_docs[0]))
        print(f"  年报仅 {len(picked)-1} 期 → 补招股章程（上市前 3 年 track record）",
              file=sys.stderr)

    if not picked:
        (sym_dir / "annual.json").write_text(json.dumps({
            "symbol": symbol, "status": "no_annual_in_filings",
        }, ensure_ascii=False, indent=2))
        print("NO ANNUAL REPORT", file=sys.stderr)
        sys.exit(0)

    reports, latest_text, prospectus_text = [], "", ""
    for idx, (year, f) in enumerate(picked):
        title = f.get("TITLE", "")
        print(f"  [{year}] {f.get('DATE_TIME')} | {title[:50]}", file=sys.stderr)
        pdf_path = download(symbol, f.get("FILE_LINK", ""), str(year))
        text = ""
        # 最新一期年报抽全文；招股章程也抽（次新股的上市前财务只在这里面）。
        # 其余往期年报只落 PDF，子 agent 按需自己读。
        if pdf_path and (idx == 0 or year == "IPO招股章程"):
            text = parse_pdf_text(pdf_path)
            if year == "IPO招股章程":
                prospectus_text = text
            if idx == 0:
                latest_text = text
        reports.append({
            "year": year,
            "date": f.get("DATE_TIME"),
            "title": title,
            "type": "招股章程" if year == "IPO招股章程" else "年度报告",
            "pdf_url": BASE + f.get("FILE_LINK", ""),
            "pdf_local": str(pdf_path.relative_to(ROOT)) if pdf_path else None,
            "text_length": len(text),
            "sections_extracted": idx == 0,
        })

    out = {
        "symbol": symbol,
        "market": "hk",
        "annual_meta": reports[0] if reports else {},
        "annual_reports": reports,
        "sections": locate_sections(latest_text),
        "sections_prospectus": (
            locate_sections(prospectus_text, extra=PROSPECTUS_KEYWORDS)
            if prospectus_text else {}
        ),
        "note": "港股年报为繁体；sections 用港式词表定位。"
                "substantial_shareholders / connected_transactions / public_float / auditor "
                "为港股独有段落，A 股无对应。",
    }
    path = sym_dir / "annual.json"
    path.write_text(json.dumps(out, ensure_ascii=False, default=str, indent=2))
    print(f"  wrote {path}（{len(reports)} 期）", file=sys.stderr)
    print("  年报 hits: " + ", ".join(f"{k}={len(v)}" for k, v in out["sections"].items() if v))
    if out["sections_prospectus"]:
        print("  招股章程 hits: " + ", ".join(
            f"{k}={len(v)}" for k, v in out["sections_prospectus"].items() if v))


if __name__ == "__main__":
    main()
