#!/usr/bin/env python3
"""md_to_pdf.py — strip the 附:自动化流程缺失项 appendix and convert a report MD to PDF.

Usage:
    python tools/md_to_pdf.py <SYMBOL>          # uses today's report under reports/{SYMBOL}_{YYYYMMDD}.md
    python tools/md_to_pdf.py <SYMBOL> <DATE>   # explicit date, format YYYYMMDD
    python tools/md_to_pdf.py --md <path>       # arbitrary MD path

Output: reports/pdf/{basename}.pdf

Requires: pandoc, xelatex (texlive-xetex), texlive-lang-chinese, Noto CJK + DejaVu fonts.
"""

from __future__ import annotations

import argparse
import datetime as _dt
import pathlib
import re
import shutil
import subprocess
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[1]
HEADER_TEX = ROOT / "tools" / "pdf_header.tex"
PDF_OUT_DIR = ROOT / "reports" / "pdf"
# 单列参与宽度分配时的测量上限（显示宽度，东亚字符算 2）
WIDTH_CAP = 40
# 表头保底宽度的上限：长表头（"较现价隐含回报"）本来就该折行，不给保底
HEADER_FLOOR_CAP = 12



def _disp_width(text: str) -> int:
    """显示宽度：东亚宽字符算 2，其余算 1。"""
    import unicodedata
    w = 0
    for ch in text:
        w += 2 if unicodedata.east_asian_width(ch) in ("W", "F") else 1
    return w


def rebalance_table_widths(md_text: str) -> str:
    """按每列实际内容宽度重写 pipe table 的分隔行。

    pandoc 按分隔行里每列的字符数比例分配 LaTeX 列宽。模型写出来的表格
    分隔行一律是 `---`（等宽），于是 6 列表格每列各占 1/6——
    中文标签列（"经营活动现金流净额（OCF）"）被挤到折三行，
    而数字列（"23.29"）却大量留白。这里按内容重算比例，保留对齐标记。
    """
    lines = md_text.split("\n")
    out, i = [], 0
    sep_re = re.compile(r"^\s*\|(?:\s*:?-{2,}:?\s*\|)+\s*$")
    while i < len(lines):
        # 表头 + 分隔行 才算一个 pipe table
        if (i + 1 < len(lines) and lines[i].lstrip().startswith("|")
                and sep_re.match(lines[i + 1])):
            start = i
            body = i + 2
            while body < len(lines) and lines[body].lstrip().startswith("|"):
                body += 1
            rows = lines[start:body]
            cells = [[c.strip() for c in r.strip().strip("|").split("|")]
                     for k, r in enumerate(rows) if k != 1]
            ncol = len(rows[1].strip().strip("|").split("|"))
            # 两条约束，分别治两种折行：
            # （a）超长文本列（评分表的"说明"列有 200+ 字）按实际宽度参与比例
            #     分配时，会把旁边的短标签列压到 2 字宽——"商业模式"折成两行。
            #     长过一定程度的列无论给多宽都要折行，所以测量值封顶再分配。
            # （b）短表头列（"情景"、"维度"）分到的宽度恰好等于内容宽度，
            #     被 tabcolsep 一挤就折成"情/景"。给每列一个不低于表头的保底。
            header = cells[0] if cells else []
            widths = []
            for c in range(ncol):
                w = max((_disp_width(row[c]) for row in cells
                         if len(row) > c), default=3)
                w = min(max(w, 3), WIDTH_CAP)
                hw = _disp_width(header[c]) if c < len(header) else 0
                widths.append(max(w, min(hw + 3, HEADER_FLOOR_CAP)))
            total = sum(widths) or 1
            # 归一到 120 个破折号总量，单列至少 3、至多 60
            aligns = [c.strip() for c in rows[1].strip().strip("|").split("|")]
            new_cells = []
            for c in range(ncol):
                n = max(3, min(60, round(widths[c] / total * 120)))
                a = aligns[c] if c < len(aligns) else "---"
                left, right = a.startswith(":"), a.endswith(":")
                bar = "-" * n
                new_cells.append(f":{bar}:" if left and right
                                 else f"{bar}:" if right
                                 else f":{bar}" if left else bar)
            rows[1] = "|" + "|".join(new_cells) + "|"
            out.extend(rows)
            i = body
            continue
        out.append(lines[i])
        i += 1
    return "\n".join(out)


def output_stem(md_path: pathlib.Path) -> str:
    """判断稿一律是 reports/{代码}_thesis_{日期}/report.md，stem 全叫 report——
    两份判断稿会输出到同一个 report.pdf 互相覆盖。stem 认不出代码时改用目录名。"""
    stem = md_path.stem
    if re.match(r"^\d{6}[_-]", stem):
        return stem
    parent = md_path.parent.name
    if re.match(r"^\d{6}[_-]", parent):
        return parent
    return stem


def strip_appendix(md_text: str) -> str:
    """Drop the `## 附：自动化流程缺失项` block but keep the disclaimer paragraph."""
    # Excise from the appendix heading up to (not including) the disclaimer line.
    new = re.sub(
        r"## 附：自动化流程缺失项.*?(?=\*\*报告口径声明\*\*)",
        "",
        md_text,
        count=1,
        flags=re.DOTALL,
    )
    # Remove any stranded `---` separator that the cut left dangling.
    new = re.sub(r"---\s*\n+(?=\*\*报告口径声明\*\*)", "", new)
    # Re-insert one clean separator before the disclaimer for visual break.
    new = re.sub(r"(?=\*\*报告口径声明\*\*)", "---\n\n", new, count=1)
    return new


def promote_header_to_yaml(md_text: str) -> str:
    """Turn the leading 4 lines (公司名称/副标题/报告日期/分析师) into pandoc YAML frontmatter,
    so pandoc renders a real title block instead of a run-on paragraph."""
    lines = md_text.splitlines()
    meta: dict[str, str] = {}
    body_start = 0
    for i, ln in enumerate(lines):
        m = re.match(r"^(公司名称|副标题|报告日期|分析师)：(.+)$", ln.strip())
        if m:
            meta[m.group(1)] = m.group(2).strip()
        elif meta and ln.strip() == "":
            body_start = i + 1
            break
        elif not meta:
            continue
    if not meta:
        return md_text

    def esc(s: str) -> str:
        return s.replace('"', '\\"')

    parts = ["---"]
    if "公司名称" in meta:
        parts.append(f'title: "{esc(meta["公司名称"])}"')
    if "副标题" in meta:
        parts.append(f'subtitle: "{esc(meta["副标题"])}"')
    if "报告日期" in meta:
        parts.append(f'date: "{esc(meta["报告日期"])}"')
    if "分析师" in meta:
        parts.append(f'author: "{esc(meta["分析师"])}"')
    parts.append("---\n")
    body = "\n".join(lines[body_start:]).lstrip("\n")
    return "\n".join(parts) + "\n" + body



def latex_escape(t: str) -> str:
    for a, b in (("\\", r"\textbackslash{}"), ("&", r"\&"), ("%", r"\%"),
                 ("$", r"\$"), ("#", r"\#"), ("_", r"\_"),
                 ("{", r"\{"), ("}", r"\}"), ("~", r"\textasciitilde{}"),
                 ("^", r"\textasciicircum{}")):
        t = t.replace(a, b)
    return t


def demote_long_bold(md_text: str, limit: int = 40) -> str:
    """超长加粗降级为斜体载体（LaTeX 侧渲染成"蓝色不加粗"）。

    判断稿平均每段 5.4 处加粗，15% 的加粗超过 40 字、最长 100+ 字。
    加粗的语义是强调局部，整句加粗只剩视觉重量。这里把长的降一级：
    短加粗仍是「蓝+粗」，长加粗变「蓝不粗」，强调还在但不结块。
    md 原文不动，只影响 PDF。
    """
    def repl(m):
        inner = m.group(1)
        return f"*{inner}*" if len(inner) > limit else m.group(0)
    return re.sub(r"\*\*([^*]+)\*\*", repl, md_text)


def style_conclusion(md_text: str) -> str:
    """把「观点总结：」这一行提成 h4，交给 titlesec 加左色条。"""
    return re.sub(r"^\*\*(观点总结|细节补充)：?\*\*\s*$",
                  lambda m: f"#### {m.group(1)}", md_text, flags=re.M)


def add_table_captions(md_text: str) -> str:
    """给 pipe table 补 caption，让 LaTeX 侧自动编号成「表 N」。

    caption 取表格上方最近的一行引导语（≤30 字、以冒号结尾的那种）。
    引导语来自紧邻的小标题、或者压根取不到时，只编号不给标题。
    """
    lines = md_text.split("\n")
    sep_re = re.compile(r"^\s*\|(?:\s*:?-{2,}:?\s*\|)+\s*$")
    out, i = [], 0
    while i < len(lines):
        out.append(lines[i])
        if (i + 1 < len(lines) and lines[i].lstrip().startswith("|")
                and sep_re.match(lines[i + 1])):
            head = i
            j = i + 2
            while j < len(lines) and lines[j].lstrip().startswith("|"):
                j += 1
            out.extend(lines[i + 1:j])
            cap, from_heading = "", False
            for k in range(head - 1, max(head - 4, -1), -1):
                prev = lines[k].strip()
                if not prev:
                    continue
                if prev.startswith("#"):
                    cap, from_heading = prev.lstrip("# ").strip(), True
                elif prev.endswith(("：", ":")) and len(prev) <= 30:
                    cap = prev.rstrip("：:").strip()
                break
            cap = re.sub(r"\*\*|`", "", cap)
            # 引导语取自紧邻的小标题时，题注会把眼前的标题一字不差再念一遍
            # （"增长与费用" → "表 5 增长与费用"）；而取不到引导语时旧代码写空
            # 题注，pandoc 直接丢弃、表格连编号都没有。两种情况统一给 \mbox{}：
            # 只出「表 N」，不重复标题，也不漏号。
            out.append("")
            out.append(f"  : {cap}" if cap and not from_heading else r"  : \mbox{}")
            i = j
            continue
        i += 1
    return "\n".join(out)


def style_thesis_anchors(md_text: str) -> str:
    """给判断稿的两处「落点」加视觉锚，一个字都不改写。

    〇、开篇结论 整节套进浅底框，「五维均分 … → 字母评级 X」那行渲染成评级条。
    两处都靠十二节骨架里写死的固定字符串定位，包住的是原文本身——
    不新增、不删减、不改写任何文字，只是换了呈现。

    包裹用宏（\rptboxstart）而不是 \begin{tcolorbox}：pandoc 见到 \begin{env}
    会把整段吞成 raw LaTeX，里面的 **加粗** 就不再被解析了；见到未知宏则只把
    这一行当 raw block，后面的 markdown 照常处理。
    """
    def _rating(m):
        return (r"\rptratingbar{" + latex_escape(m.group(1).strip())
                + "}{" + latex_escape(m.group(2)) + "}")

    md_text = re.sub(
        r"^\*\*(五维均分.*?)\s*(?:→|->)\s*字母评级\s*([A-C][+\-]?)\*\*\s*$",
        _rating, md_text, count=1, flags=re.M)

    m = re.search(r"^##\s+〇、开篇结论\s*$", md_text, re.M)
    if m:
        start = m.end()
        rest = md_text[start:]
        e = re.search(r"^(?:---\s*$|##\s+)", rest, re.M)
        end = start + (e.start() if e else len(rest))
        body = md_text[start:end].strip("\n")
        if body:
            md_text = (md_text[:start] + "\n\n\\rptboxstart\n\n" + body
                       + "\n\n\\rptboxend\n\n" + md_text[end:])
    return md_text


def build_footer_tex(md_text: str) -> str:
    """页脚右下角常驻评级角标：35 页的稿子翻到哪一页都知道结论是什么。"""
    m = re.search(r"字母评级\s*([A-C][+\-]?)", md_text)
    if not m:
        return ""
    return (r"\fancyfoot[R]{\small\color{rptmuted}评级\hspace{0.35em}"
            r"{\sffamily\bfseries\color{rptaccent}" + latex_escape(m.group(1)) + "}}")


def build_cover_tex(md_text: str) -> str:
    """从 frontmatter + h1 + 评级行拼一页封面，重定义 \\maketitle。"""
    def field(name):
        m = re.search(rf"^{name}\s*[:：]\s*(.+)$", md_text, re.M)
        return m.group(1).strip() if m else ""
    title = ""
    m = re.search(r"^#\s+(.+)$", md_text, re.M)
    if m:
        title = m.group(1).strip()
    subtitle = field("标的")
    date = field("报告日期")
    t0 = field("T-0")
    rating = ""
    m = re.search(r"字母评级\s*([A-C][+\-]?)", md_text)
    if m:
        rating = m.group(1)
    if not title:
        return ""
    E = latex_escape
    rating_block = (
        rf"{{\fontsize{{56}}{{60}}\selectfont\sffamily\bfseries"
        rf"\color{{rptaccent}}{E(rating)}\par}}"
        rf"\vspace{{0.3em}}{{\small\color{{rptmuted}}字母评级\par}}"
    ) if rating else ""
    return "\n".join([
        r"\renewcommand{\maketitle}{%",
        r"\begin{titlepage}\centering",
        r"\vspace*{0.22\textheight}",
        rf"{{\sffamily\Huge\bfseries\color{{rpttitle}}{E(title)}\par}}",
        rf"\vspace{{1.1em}}{{\large\color{{rptmuted}}{E(subtitle)}\par}}" if subtitle else "",
        r"\vspace{2.2em}",
        r"\textcolor{rpttitle}{\rule{0.30\textwidth}{1.2pt}}\par",
        r"\vspace{2.2em}",
        rating_block,
        r"\vfill",
        rf"{{\large {E(date)}\par}}" if date else "",
        rf"\vspace{{0.8em}}{{\footnotesize\color{{rptmuted}}{E(t0)}\par}}" if t0 else "",
        r"\vspace{2.4em}",
        r"{\footnotesize\color{rptmuted}\parbox{0.72\textwidth}{\centering "
        r"本报告为判断型研究稿，含大量主观判断与自建假设，"
        r"数据来自公开源及人工注入的一手信息。\mbox{\textbf{不构成投资建议}。}}\par}",
        r"\vspace*{0.05\textheight}",
        r"\end{titlepage}}",
    ])

def require(cmd: str) -> None:
    if shutil.which(cmd) is None:
        sys.stderr.write(
            f"[md_to_pdf] ERROR: `{cmd}` not found in PATH.\n"
            f"  Install with: sudo apt install -y pandoc texlive-xetex texlive-lang-chinese\n"
        )
        sys.exit(2)


def resolve_md_path(args: argparse.Namespace) -> pathlib.Path:
    if args.md:
        p = pathlib.Path(args.md)
        if not p.is_absolute():
            p = ROOT / p
        return p
    date = args.date or _dt.date.today().strftime("%Y%m%d")
    p = ROOT / "reports" / f"{args.symbol}_{date}.md"
    return p


def build_pdf(md_path: pathlib.Path) -> pathlib.Path:
    require("pandoc")
    require("xelatex")
    if not HEADER_TEX.exists():
        sys.exit(f"[md_to_pdf] ERROR: header file missing: {HEADER_TEX}")
    if not md_path.exists():
        sys.exit(f"[md_to_pdf] ERROR: source MD not found: {md_path}")

    PDF_OUT_DIR.mkdir(parents=True, exist_ok=True)
    out_pdf = PDF_OUT_DIR / (output_stem(md_path) + ".pdf")

    text = md_path.read_text(encoding="utf-8")
    text = strip_appendix(text)
    cover_tex = build_cover_tex(text)
    footer_tex = build_footer_tex(text)
    cover_title = ""
    m = re.search(r"^#\s+(.+)$", text, re.M)
    if m and cover_tex:
        cover_title = m.group(1).strip()
        text = re.sub(r"^#\s+.+$", "", text, count=1, flags=re.M)
    text = demote_long_bold(text)
    text = style_conclusion(text)
    text = style_thesis_anchors(text)
    text = add_table_captions(text)
    text = rebalance_table_widths(text)
    text = promote_header_to_yaml(text)

    with tempfile.TemporaryDirectory() as td:
        tmp_md = pathlib.Path(td) / md_path.name
        tmp_md.write_text(text, encoding="utf-8")

        # 封面是动态内容（标题/评级/日期随报告变），所以把静态模板与
        # 生成的 \maketitle 定义合并到临时 header，pdf_header.tex 保持干净。
        hdr = pathlib.Path(td) / "header.tex"
        hdr.write_text(HEADER_TEX.read_text(encoding="utf-8")
                       + ("\n\n% ---- 本次生成的封面 ----\n" + cover_tex if cover_tex else "")
                       + ("\n\n% ---- 本次生成的页脚评级角标 ----\n" + footer_tex if footer_tex else ""),
                       encoding="utf-8")

        cmd = [
            "pandoc",
            str(tmp_md),
            "-o",
            str(out_pdf),
            "--pdf-engine=xelatex",
            "-V",
            "documentclass=ctexart",
            "-V",
            "classoption=fontset=none",
            "-V",
            "geometry:a4paper",
            "-V",
            "geometry:margin=2cm",
            "-V",
            "geometry:headheight=14pt",
            "-V",
            "fontsize=10pt",
            f"--include-in-header={hdr}",
            *(["-M", f"title={cover_title}"] if cover_title else []),
            "--toc",
            "--toc-depth=2",
        ]
        proc = subprocess.run(cmd, capture_output=True, text=True)
        if proc.returncode != 0:
            sys.stderr.write(proc.stdout)
            sys.stderr.write(proc.stderr)
            sys.exit(f"[md_to_pdf] pandoc failed for {md_path.name}")

    return out_pdf


def main() -> None:
    parser = argparse.ArgumentParser(description="Strip appendix and convert MD → PDF.")
    parser.add_argument("symbol", nargs="?", help="6-digit A-share code (e.g. 000333)")
    parser.add_argument("date", nargs="?", help="YYYYMMDD report date (default: today)")
    parser.add_argument("--md", help="explicit MD path (overrides symbol/date)")
    args = parser.parse_args()
    if not (args.md or args.symbol):
        parser.error("either SYMBOL or --md is required")

    md_path = resolve_md_path(args)
    out = build_pdf(md_path)
    print(f"[md_to_pdf] OK  {md_path.relative_to(ROOT)} → {out.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
