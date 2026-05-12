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
    out_pdf = PDF_OUT_DIR / (md_path.stem + ".pdf")

    text = md_path.read_text(encoding="utf-8")
    text = strip_appendix(text)
    text = promote_header_to_yaml(text)

    with tempfile.TemporaryDirectory() as td:
        tmp_md = pathlib.Path(td) / md_path.name
        tmp_md.write_text(text, encoding="utf-8")

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
            f"--include-in-header={HEADER_TEX}",
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
