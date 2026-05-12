"""通过东财 API 直接抓最新年度报告全文 + PDF URL。

东财 announcement detail API:
  https://np-cnotice-stock.eastmoney.com/api/content/ann?art_code={code}
返回 {data: {attach_url, notice_content (full extracted text), ...}}

由于年报多达数百页，notice_content 可能很长（>50万字）。
策略：
1. 调 API 拿 notice_content
2. 按关键词定位关键段落（业务分部/客户集中度/Capex 等）
3. 每个段落保留 800-1500 字上下文
4. 不保存全文（太大），但保存 PDF URL 用于人工查阅
"""
import json
import re
import sys
from pathlib import Path

import pdfplumber
import requests

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools"))
from lib import DATA_DIR, symbol_dir  # noqa: E402

UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36"
HEADERS = {"User-Agent": UA, "Referer": "https://data.eastmoney.com/"}

API = "https://np-cnotice-stock.eastmoney.com/api/content/ann"


def pick_annual_report(announcements, prefer_year: str = None):
    """优先选公告类型 == '年度报告全文'；fallback 标题含'XXX年年度报告'但严格排除说明会/摘要等"""
    if not announcements:
        return None
    strict = []   # 类型 = 年度报告全文
    loose = []   # 标题含 XXXX年年度报告 不含说明会等
    EXCLUDE = ["摘要", "英文版", "草案", "问询函", "回复", "修订稿", "港股",
               "翌日披露", "ESG", "网上说明会", "业绩说明会", "征集问题", "评估报告",
               "履职情况", "审计报告", "内部控制", "ESG报告"]
    for a in announcements:
        title = (a.get("公告标题") or "")
        atype = (a.get("公告类型") or "")
        date = a.get("公告日期", "")
        url = a.get("网址", "")
        if not url:
            continue
        if any(x in title for x in EXCLUDE):
            continue
        if atype == "年度报告全文":
            strict.append((date, title, atype, url))
        elif re.search(r"\d{4}年[年度]+报告$", title.strip()) or re.search(r"\d{4}年年度报告$", title.strip()):
            loose.append((date, title, atype, url))
    strict.sort(reverse=True)
    loose.sort(reverse=True)
    return strict[0] if strict else (loose[0] if loose else None)


def extract_art_code(url: str) -> str:
    m = re.search(r"(AN\d+)", url)
    return m.group(1) if m else ""


def fetch_announcement_content(art_code: str, max_pages: int = 60) -> dict:
    """API 按 5000 字一页分页，逐页拼接 notice_content"""
    full_text = []
    attach_url = ""
    page_index = 1
    while page_index <= max_pages:
        params = {
            "cb": "jQuery_cb", "art_code": art_code,
            "client_source": "web_em", "page_index": page_index, "_": "1",
        }
        r = requests.get(API, params=params, headers=HEADERS, timeout=30)
        r.raise_for_status()
        body = r.text
        body = re.sub(r"^[^(]*\(", "", body, count=1)
        body = re.sub(r"\)\s*;?\s*$", "", body)
        try:
            data = json.loads(body).get("data", {})
        except json.JSONDecodeError:
            break
        if not attach_url:
            attach_url = data.get("attach_url", "") or data.get("attach_url_web", "")
        content = data.get("notice_content", "") or ""
        if not content:
            break
        full_text.append(content)
        # 如果本页 <5000 字则视为最后一页
        if len(content) < 4500:
            break
        page_index += 1
    return {"notice_content": "".join(full_text), "attach_url": attach_url,
            "pages_fetched": page_index}


def cache_pdf(symbol: str, art_code: str, url: str):
    """常态下载 PDF 到 data/{symbol}/annual_pdf/{art_code}.pdf，已缓存则跳过。"""
    if not url:
        return None
    annual_dir = symbol_dir(symbol) / "annual_pdf"
    annual_dir.mkdir(parents=True, exist_ok=True)
    pdf_path = annual_dir / f"{art_code}.pdf"
    if pdf_path.exists() and pdf_path.stat().st_size >= 10 * 1024:
        print(f"  pdf cached: {pdf_path.name} ({pdf_path.stat().st_size/1024/1024:.1f} MB)",
              file=sys.stderr)
        return pdf_path
    try:
        r = requests.get(url, headers=HEADERS, timeout=120, stream=True)
        r.raise_for_status()
        with pdf_path.open("wb") as f:
            for chunk in r.iter_content(chunk_size=128 * 1024):
                f.write(chunk)
        print(f"  downloaded {pdf_path.name} ({pdf_path.stat().st_size/1024/1024:.1f} MB)",
              file=sys.stderr)
        return pdf_path
    except Exception as e:
        print(f"  pdf download failed: {e}", file=sys.stderr)
        return None


def parse_pdf_text(pdf_path, max_pages: int = 500) -> str:
    """pdfplumber 抽全文：仅当 API 没抽到文本时调用作兜底。"""
    try:
        with pdfplumber.open(pdf_path) as pdf:
            n = min(len(pdf.pages), max_pages)
            print(f"  parsing {n} pages with pdfplumber...", file=sys.stderr)
            chunks = []
            for i in range(n):
                try:
                    t = pdf.pages[i].extract_text() or ""
                    chunks.append(t)
                except Exception:
                    continue
            return "\n".join(chunks)
    except Exception as e:
        print(f"  pdfplumber failed: {e}", file=sys.stderr)
        return ""


KEYWORDS = {
    "business_segments": [
        "主营业务分行业", "主营业务分产品", "营业收入构成",
        "分行业经营情况", "分产品经营情况", "分产品情况", "主要业务分行业",
    ],
    "customer_concentration": [
        "前五名客户", "前 5 名客户", "前五大客户", "客户集中度",
        "前五名客户合计", "前五大客户合计",
    ],
    "supplier_concentration": [
        "前五名供应商", "前五大供应商", "主要供应商合计", "前五名供应商合计",
    ],
    "capex_long_term": [
        "购建固定资产、无形资产和其他长期资产支付的现金",
        "购建固定资产", "资本性支出",
    ],
    "rnd": ["研发投入合计", "研发费用", "研发投入金额", "研发投入占营业收入比例"],
    "moat": ["核心竞争力分析", "公司核心竞争力", "竞争优势"],
    "risk": ["主要风险", "可能面对的风险", "公司面临的风险", "风险因素"],
    "outlook": ["发展战略", "经营计划", "经营目标", "下年度经营计划", "公司发展战略"],
    "dividend": ["利润分配预案", "现金分红", "现金股利", "每 10 股派"],
    "segment_split": ["按经营分部", "经营分部信息", "分部报告"],
}


def locate_sections(text: str, context_chars: int = 1200) -> dict:
    out = {k: [] for k in KEYWORDS}
    for key, kws in KEYWORDS.items():
        seen_pos = set()
        for kw in kws:
            for m in re.finditer(re.escape(kw), text):
                pos = m.start()
                # 同段落不重复
                if any(abs(pos - p) < 500 for p in seen_pos):
                    continue
                seen_pos.add(pos)
                start = max(0, pos - 100)
                end = min(len(text), pos + context_chars)
                excerpt = text[start:end].strip()
                # 清理多余空白
                excerpt = re.sub(r"[ \t]+", " ", excerpt)
                excerpt = re.sub(r"\n{3,}", "\n\n", excerpt)
                out[key].append({
                    "char_pos": pos,
                    "keyword": kw,
                    "excerpt": excerpt,
                })
    return out


def main():
    if len(sys.argv) < 2:
        print("usage: fetch_annual_pdf.py <symbol>", file=sys.stderr)
        sys.exit(2)
    symbol = sys.argv[1].strip().lstrip("sh").lstrip("sz").lstrip("bj")

    sym_dir = symbol_dir(symbol)
    agg_path = sym_dir / "aggregate.json"
    if not agg_path.exists():
        print(f"FATAL: {agg_path} 不存在，请先跑 run_pipeline.py", file=sys.stderr)
        sys.exit(1)
    agg = json.load(open(agg_path))
    announcements = agg.get("announcements_recent") or []

    picked = pick_annual_report(announcements)
    if not picked:
        print(f"NO ANNUAL REPORT in announcements for {symbol}", file=sys.stderr)
        (sym_dir / "annual.json").write_text(json.dumps({
            "symbol": symbol, "status": "no_annual_in_announcements",
        }, ensure_ascii=False, indent=2))
        sys.exit(0)

    date, title, atype, landing = picked
    art_code = extract_art_code(landing)
    if not art_code:
        print(f"  cannot extract art_code from {landing}", file=sys.stderr)
        sys.exit(1)

    print(f"  selected: {date} | {atype} | {title[:80]}", file=sys.stderr)
    print(f"  art_code: {art_code}", file=sys.stderr)

    data = fetch_announcement_content(art_code)
    text = data.get("notice_content", "") or ""
    pdf_url = data.get("attach_url", "")
    print(f"  api text: {len(text)} chars; pdf: {pdf_url[:80]}", file=sys.stderr)

    # 常态：只要拿到 pdf_url 就缓存到磁盘（不再仅作 fallback）
    pdf_path = cache_pdf(symbol, art_code, pdf_url)

    # 当 API 没抽到文本（page_size=0），用磁盘 PDF 作兜底解析
    if len(text) < 5000 and pdf_path:
        text = parse_pdf_text(pdf_path)
        print(f"  pdfplumber text: {len(text)} chars", file=sys.stderr)

    if len(text) < 1000:
        print(f"  WARN: text too short", file=sys.stderr)

    sections = locate_sections(text)

    out = {
        "symbol": symbol,
        "annual_meta": {
            "date": date, "title": title, "type": atype,
            "art_code": art_code,
            "pdf_url": pdf_url,
            "pdf_local": str(pdf_path.relative_to(ROOT)) if pdf_path else None,
            "text_length": len(text),
        },
        "sections": sections,
    }
    out_path = sym_dir / "annual.json"
    out_path.write_text(json.dumps(out, ensure_ascii=False, default=str, indent=2))
    print(f"  wrote {out_path}", file=sys.stderr)
    print(f"  hits: " + ", ".join(f"{k}={len(v)}" for k, v in sections.items()))


if __name__ == "__main__":
    main()
