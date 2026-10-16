"""通过东财 API 抓**近 N 年**年度报告全文 + PDF URL（默认 3 年）。

东财 announcement detail API:
  https://np-cnotice-stock.eastmoney.com/api/content/ann?art_code={code}
返回 {data: {attach_url, notice_content (full extracted text), ...}}

由于年报多达数百页，notice_content 可能很长（>50万字）。
策略：
1. 拉取近 N+1 个自然年的公告列表，挑出每一年的「年度报告全文」
2. 全部下载 PDF 到 data/{symbol}/annual_pdf/
3. 对**最新一期**抽全文并按关键词定位关键段落（业务分部/客户集中度/Capex 等）
4. 往期年报只落 PDF 与元数据，不抽全文（省时间），供子 agent 按需 Read

为什么要多年：判断稿反复需要跨期核对（商誉减值的性质、借款用途、
分部口径重分类、激励目标的历史达成情况）。只存最新一期时，这些问题
一律卡在「缺上一年年报无法核实」。

用法：
  fetch_annual_pdf.py <symbol> [--years N]
"""
import json
import re
import sys
from datetime import datetime
from pathlib import Path

import pdfplumber
import requests

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools"))
from lib import DATA_DIR, symbol_dir  # noqa: E402

DEFAULT_YEARS = 3

UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36"
HEADERS = {"User-Agent": UA, "Referer": "https://data.eastmoney.com/"}

API = "https://np-cnotice-stock.eastmoney.com/api/content/ann"


EXCLUDE = ["摘要", "英文版", "草案", "问询函", "回复", "修订稿", "港股",
           "翌日披露", "ESG", "网上说明会", "业绩说明会", "征集问题", "评估报告",
           "履职情况", "审计报告", "内部控制", "ESG报告"]


def report_year(title: str) -> str:
    """从标题里取报告年度：'开立医疗:2025年年度报告' -> '2025'。取不到返回 ''。"""
    m = re.search(r"(\d{4})\s*年[年度]*报告", title or "")
    return m.group(1) if m else ""


def fetch_announcements_wide(symbol: str, years: int):
    """独立拉取近 years+1 个自然年的公告列表。

    不能复用 aggregate.json 的 announcements_recent —— 那份是 run_pipeline 用
    「当年 1 月 1 日至今」抓的，只覆盖本年度，天然不含往期年报。
    akshare 不可用时返回 None，由调用方回退到 aggregate.json。
    """
    try:
        import akshare as ak
    except ImportError:
        print("  akshare 不可用，回退到 aggregate.json 的公告列表", file=sys.stderr)
        return None
    today = datetime.now()
    begin = f"{today.year - years}0101"
    end = today.strftime("%Y%m%d")
    try:
        df = ak.stock_individual_notice_report(
            security=symbol, symbol="全部", begin_date=begin, end_date=end)
    except Exception as e:
        print(f"  公告列表拉取失败({begin}~{end}): {e}", file=sys.stderr)
        return None
    if df is None or len(df) == 0:
        return None
    print(f"  公告列表 {begin}~{end}: {len(df)} 条", file=sys.stderr)
    return df.to_dict("records")


def pick_annual_reports(announcements, n: int = DEFAULT_YEARS):
    """挑出最近 n 个**不同报告年度**的年报全文，按年度倒序。

    优先公告类型 == '年度报告全文'；fallback 标题含 'XXXX年年度报告'。
    同一年度出现多条（如更正后重发）时保留公告日期最新的一条。
    返回 [(date, title, atype, url, year), ...]
    """
    if not announcements:
        return []
    strict, loose = [], []
    for a in announcements:
        title = (a.get("公告标题") or "")
        atype = (a.get("公告类型") or "")
        date = str(a.get("公告日期", ""))[:10]
        url = a.get("网址", "")
        if not url or any(x in title for x in EXCLUDE):
            continue
        year = report_year(title)
        if atype == "年度报告全文":
            strict.append((date, title, atype, url, year))
        elif re.search(r"\d{4}年[年度]+报告$", title.strip()):
            loose.append((date, title, atype, url, year))

    picked = {}   # year -> record
    for rec in sorted(strict, reverse=True) + sorted(loose, reverse=True):
        y = rec[4]
        if not y:
            continue
        if y not in picked:            # 先到先得 = 公告日期最新的那条
            picked[y] = rec
    out = [picked[y] for y in sorted(picked, reverse=True)][:n]

    # 极端情况：标题里取不到年度（picked 为空）时，退回旧行为取最新一条
    if not out:
        fallback = sorted(strict, reverse=True) or sorted(loose, reverse=True)
        out = fallback[:1]
    return out


def pick_latest_semiannual(announcements):
    """挑出最新一期半年度报告全文（排除摘要等），返回 (date, title, atype, url, year) 或 None。

    年报只在每年 4 月更新一次；到 9 月出报告时，分部收入等口径还停在上一年，
    而半年报已经给出了新的分产品表（301557：26H1 增长来自芯材而非罩体，与年报叙事相反）。
    """
    strict, loose = [], []
    for a in announcements or []:
        title = (a.get("公告标题") or "").strip()
        atype = (a.get("公告类型") or "")
        url = a.get("网址", "")
        if not url or any(x in title for x in EXCLUDE):
            continue
        m = re.search(r"(\d{4})\s*年半年度报告", title)
        rec = (str(a.get("公告日期", ""))[:10], title, atype, url, m.group(1) if m else "")
        if atype == "半年度报告全文":
            strict.append(rec)
        elif re.search(r"\d{4}年半年度报告$", title):
            loose.append(rec)
    ranked = sorted(strict, reverse=True) or sorted(loose, reverse=True)
    return ranked[0] if ranked else None


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


def fetch_report_text(symbol: str, art_code: str):
    """抓一期定期报告的全文：API 文本优先，太短则用缓存的 PDF 兜底解析。
    返回 (text, pdf_url, pdf_path)。半年报 PDF 也缓存在 annual_pdf/ 下，按 art_code 区分。"""
    data = fetch_announcement_content(art_code)
    text = data.get("notice_content", "") or ""
    pdf_url = data.get("attach_url", "")
    pdf_path = cache_pdf(symbol, art_code, pdf_url)
    # 当 API 没抽到文本（page_size=0），用磁盘 PDF 作兜底解析
    if len(text) < 5000 and pdf_path:
        text = parse_pdf_text(pdf_path)
        print(f"  pdfplumber text: {len(text)} chars", file=sys.stderr)
    if len(text) < 1000:
        print("  WARN: text too short", file=sys.stderr)
    return text, pdf_url, pdf_path


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
        "分产品或服务",   # 半年报的分产品表标题
        "按产品档次",     # 上交所酒类行业模板（600519 半年报）
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
    # 表头「从公司获得的税前报酬总额」常被 PDF 分页/页眉拆开，只剩表后说明文字能命中；
    # 同一张表的另一列「是否在公司关联方获取报酬」不跨行，沪深两所模板都有，作主锚点
    "management_pay": ["是否在公司关联方获取报酬", "从公司获得的税前报酬总额",
                       "董事、监事和高级管理人员报酬情况", "董事、高级管理人员报酬情况"],
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
        print("usage: fetch_annual_pdf.py <symbol> [--years N]", file=sys.stderr)
        sys.exit(2)
    symbol = sys.argv[1].strip().lstrip("sh").lstrip("sz").lstrip("bj")
    years = DEFAULT_YEARS
    if "--years" in sys.argv:
        try:
            years = max(1, int(sys.argv[sys.argv.index("--years") + 1]))
        except (IndexError, ValueError):
            print(f"  --years 取值无效，用默认 {DEFAULT_YEARS}", file=sys.stderr)

    sym_dir = symbol_dir(symbol)
    agg_path = sym_dir / "aggregate.json"
    if not agg_path.exists():
        print(f"FATAL: {agg_path} 不存在，请先跑 run_pipeline.py", file=sys.stderr)
        sys.exit(1)

    # 优先用宽窗口公告列表；拿不到再回退 aggregate.json（只覆盖本年度）
    announcements = fetch_announcements_wide(symbol, years)
    if not announcements:
        agg = json.load(open(agg_path))
        announcements = agg.get("announcements_recent") or []

    picked = pick_annual_reports(announcements, years)
    if not picked:
        print(f"NO ANNUAL REPORT in announcements for {symbol}", file=sys.stderr)
        (sym_dir / "annual.json").write_text(json.dumps({
            "symbol": symbol, "status": "no_annual_in_announcements",
        }, ensure_ascii=False, indent=2))
        sys.exit(0)

    print(f"  命中 {len(picked)} 期年报："
          + ", ".join(f"{r[4] or '?'}年" for r in picked), file=sys.stderr)

    reports = []
    latest_text = ""
    for idx, (date, title, atype, landing, year) in enumerate(picked):
        art_code = extract_art_code(landing)
        if not art_code:
            print(f"  [{year}] 无法解析 art_code: {landing}", file=sys.stderr)
            continue
        print(f"  [{year}] {date} | {title[:60]} | {art_code}", file=sys.stderr)

        is_latest = (idx == 0)
        if is_latest:
            text, pdf_url, pdf_path = fetch_report_text(symbol, art_code)
            latest_text = text
        else:
            # 往期年报只要 PDF，不抽全文：省掉每期数十万字的 API 分页
            data = fetch_announcement_content(art_code, max_pages=1)
            text = ""
            pdf_url = data.get("attach_url", "")
            pdf_path = cache_pdf(symbol, art_code, pdf_url)

        reports.append({
            "year": year, "date": date, "title": title, "type": atype,
            "art_code": art_code, "pdf_url": pdf_url,
            "pdf_local": str(pdf_path.relative_to(ROOT)) if pdf_path else None,
            "text_length": len(text),
            "sections_extracted": is_latest,
        })

    sections = locate_sections(latest_text)

    # 半年报：只在它比最新年报更新时抓，且只抽分产品表（年报之后的分部口径只有它有）
    semiannual = None
    semi = pick_latest_semiannual(announcements)
    if semi and reports and semi[0] > reports[0]["date"]:
        s_date, s_title, s_type, s_landing, s_year = semi
        s_art = extract_art_code(s_landing)
        if s_art:
            print(f"  [半年报 {s_year}] {s_date} | {s_title[:60]} | {s_art}", file=sys.stderr)
            s_text, s_url, s_pdf = fetch_report_text(symbol, s_art)
            semiannual = {
                "meta": {"year": s_year, "date": s_date, "title": s_title, "art_code": s_art,
                         "pdf_url": s_url,
                         "pdf_local": str(s_pdf.relative_to(ROOT)) if s_pdf else None,
                         "text_length": len(s_text)},
                "sections": {"business_segments": locate_sections(s_text)["business_segments"]},
            }

    out = {
        "symbol": symbol,
        # annual_meta = 最新一期，保留旧字段名以兼容既有 skill / lens 引用
        "annual_meta": reports[0] if reports else {},
        "annual_reports": reports,
        "sections": sections,
        "semiannual": semiannual,
    }
    out_path = sym_dir / "annual.json"
    out_path.write_text(json.dumps(out, ensure_ascii=False, default=str, indent=2))
    print(f"  wrote {out_path} （{len(reports)} 期年报）", file=sys.stderr)
    print("  hits: " + ", ".join(f"{k}={len(v)}" for k, v in sections.items()))


if __name__ == "__main__":
    main()
