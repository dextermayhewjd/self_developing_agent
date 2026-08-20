"""校验判断稿（equity-thesis-cn 产物）是否满足硬约束。

用法：
    python tools/check_thesis.py <SYMBOL> <REPORT_PATH>

退出码：
    0 = 通过
    1 = 硬约束违反（结构缺失 / 档案未更新 / 体裁错配）——不合格
    2 = 软警告（配比偏低等）——可继续但应提示

这个校验器把四类实际观测到的失败编码成硬门：
    - 跳过"写回档案"这一步（档案 最近更新 != 报告日）
    - 长度失控 / 数据盖过判断（观点段字数 < 数据段的 1/3）
    - 残留卖方体裁（目标价 / 买入卖出评级）
    - run 文件夹产物缺失（疑惑.md / findings 不在报告旁边）
代码只能查形式，查不了判断质量——那仍靠模型。
"""
import re
import sys
from pathlib import Path

# 三段式标记（与 framework.md 一致）
SEG_DATA = "**详细资料/数据：**"
SEG_NOTE = "**细节补充：**"
SEG_VIEW = "**观点总结：**"

# 十二节一级标题
SECTION_RE = re.compile(r"^##\s+[一二三四五六七八九十]+[、\.]", re.M)


def read(path):
    return Path(path).read_text(encoding="utf-8")


def frontmatter_field(text, field):
    """从 YAML frontmatter 抓一个字段值。"""
    m = re.search(rf"^{re.escape(field)}\s*[:：]\s*(.+?)\s*$", text, re.M)
    return m.group(1).strip() if m else None


def blocks_after(text, marker):
    """返回每个 marker 之后、到下一个三段标记或一级标题之前的正文块。"""
    out = []
    idx = 0
    stops = [SEG_DATA, SEG_NOTE, SEG_VIEW]
    while True:
        i = text.find(marker, idx)
        if i < 0:
            break
        start = i + len(marker)
        # 找下一个边界
        ends = [text.find(s, start) for s in stops]
        ends = [e for e in ends if e >= 0]
        h = re.search(r"^##\s", text[start:], re.M)
        if h:
            ends.append(start + h.start())
        end = min(ends) if ends else len(text)
        out.append(text[start:end].strip())
        idx = end
    return out


def char_count(blocks):
    """统计中文可见字符数（去空白与标点噪声）。"""
    return sum(len(re.sub(r"\s", "", b)) for b in blocks)


def main():
    if len(sys.argv) != 3:
        print("用法：python tools/check_thesis.py <SYMBOL> <REPORT_PATH>", file=sys.stderr)
        return 1

    symbol, report_path = sys.argv[1], sys.argv[2]
    if not Path(report_path).exists():
        print(f"[FAIL] 报告不存在：{report_path}", file=sys.stderr)
        return 1

    report = read(report_path)
    hard, soft = [], []

    # 报告日期（用于和档案 最近更新 对比）
    report_date = frontmatter_field(report, "报告日期")
    if report_date:
        report_date = re.match(r"(\d{4}-\d{2}-\d{2})", report_date)
        report_date = report_date.group(1) if report_date else None
    if not report_date:
        m = re.search(r"_(\d{4})(\d{2})(\d{2})\.md$", report_path)
        report_date = f"{m.group(1)}-{m.group(2)}-{m.group(3)}" if m else None

    # ---- 硬约束 1：每节都有非空观点总结 ----
    sections = SECTION_RE.findall(report)
    view_blocks = blocks_after(report, SEG_VIEW)
    nonempty_views = [b for b in view_blocks if len(re.sub(r"\s", "", b)) >= 30]
    if len(sections) >= 8 and len(nonempty_views) < len(sections):
        hard.append(
            f"观点总结缺失或过短：{len(sections)} 节，仅 {len(nonempty_views)} 段有效观点总结（每节都必须有，>=30字）"
        )

    # ---- 硬约束 2：档案已更新到报告日 ----
    pos_path = Path("positions") / f"{symbol}.md"
    if not pos_path.exists():
        hard.append(f"档案不存在：{pos_path}（步骤 6 未执行）")
    elif report_date:
        updated = frontmatter_field(read(pos_path), "最近更新")
        if updated != report_date:
            hard.append(
                f"档案未更新到报告日：positions/{symbol}.md 最近更新={updated}，报告日={report_date}（步骤 6 疑似跳过）"
            )

    # ---- 硬约束 3：无残留卖方体裁 ----
    # "目标价"只在非否定语境才算违规（判断稿会正当地声明"不给目标价"）
    for m in re.finditer("目标价", report):
        pre = report[max(0, m.start() - 5): m.start()]
        if not re.search(r"[不无非]", pre):
            hard.append("残留'目标价'——判断稿给市值区间，不给股价目标位")
            break
    if re.search(r"评级[:：]?\s*(买入|增持|卖出|减持|中性)", report):
        hard.append("残留买入/卖出类评级——判断稿用 A/B/C 字母评级")

    # ---- 硬约束 4：立疑→销账机制存在 ----
    if "疑惑" not in report:
        hard.append("缺'开篇立疑'——第一节末尾应列 3–6 条疑惑")
    settle = len(re.findall(r"现在回答开篇", report))
    if "疑惑" in report and settle == 0:
        hard.append("有立疑但无销账——正文应有'现在回答开篇的问题…'逐条回收")

    # ---- 硬约束 5：无未替换占位符 ----
    if "{{" in report:
        hard.append("残留未替换占位符 {{...}}")

    # ---- 硬约束 6：run 文件夹产物齐备 ----
    # 2026-08-18 实测：立疑文件被写到了 .claude/skills/.../lenses/reports/ 下面——
    # 当时 cwd 停在 lenses/（上一条命令 cd 进去读 lens），写入用了相对路径，
    # 而同一条命令里的 wc -c 校验解析的是同一个坏相对路径，所以"写入成功"的自检也是假的。
    # 报告内容本身完全正常，五份 findings 因为是子 agent 写的也都在——
    # 缺失一路漏到交付前才被人工清点发现。这一条就是那个漏掉的门。
    run_dir = Path(report_path).resolve().parent
    if re.fullmatch(rf"{re.escape(symbol)}_thesis_\d{{8}}", run_dir.name):
        if not (run_dir / "疑惑.md").exists():
            hard.append(
                f"run 文件夹缺 疑惑.md：{run_dir}/疑惑.md 不存在（步骤 2 的立疑清单没落到报告旁边）。"
                "常见原因是写入用了相对路径而 cwd 不在仓库根——写产物一律用绝对路径"
            )
        findings_dir = run_dir / "findings"
        n_findings = len(list(findings_dir.glob("*.md"))) if findings_dir.is_dir() else 0
        if n_findings < 5:
            hard.append(
                f"findings 不足：{findings_dir} 下有 {n_findings} 个 .md，应为 5 份"
                "（财务排雷/竞争/尽调/产业/战略驱动）"
            )
    else:
        soft.append(
            f"报告不在 run 文件夹里：{run_dir.name} 不匹配 {symbol}_thesis_YYYYMMDD，"
            "无法校验 疑惑.md 与 findings/ 是否齐备（旧版扁平布局？）"
        )

    # ---- 软约束：观点段 / 数据段 配比 >= 1/3 ----
    data_chars = char_count(blocks_after(report, SEG_DATA))
    view_chars = char_count(view_blocks)
    if data_chars > 0:
        ratio = view_chars / data_chars
        if ratio < 0.33:
            soft.append(
                f"观点段偏薄：观点 {view_chars} 字 / 数据 {data_chars} 字 = {ratio:.2f}（应 >=0.33，数据盖过了判断）"
            )

    # ---- 输出 ----
    for h in hard:
        print(f"[FAIL] {h}")
    for s in soft:
        print(f"[WARN] {s}")

    if hard:
        print(f"\n不合格：{len(hard)} 项硬约束违反。", file=sys.stderr)
        return 1
    if soft:
        print(f"\n通过（含 {len(soft)} 项警告）。")
        return 2
    print("通过：全部硬约束满足。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
