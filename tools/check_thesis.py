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

sys.path.insert(0, str(Path(__file__).resolve().parent))
import benchmark_lib

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


# 开篇结论：从 `## 〇、开篇结论` 到下一个一级节标题
_OPENING_RE = re.compile(r"##\s*〇、开篇结论(.*?)(?=\n##\s|\Z)", re.S)
# 声明块：以 `> **参照系声明**` 起头的连续引用行
_DECL_RE = re.compile(r">\s*\*\*参照系声明\*\*(.*?)(?=\n(?!\s*>)|\Z)", re.S)
# 声明块里点名的 what，写在「」中
_NAMED_RE = re.compile(r"「([^」]+)」")
# 降级措辞关键词——命中任意一个即认为已声明限制
_DOWNGRADE_WORDS = ("无法回答", "未取得", "绝对口径", "不可得", "悬空", "无法判断")
# T4-3：判定"降级措辞是否与某个 what 就近关联"的句子切分。按中文句末标点
# （。！？）切，不按「；」——手写声明常见"先摆 what/强度，用；接一句降级措辞"
# 的写法，这种情况下 what 与降级词属于同一句。
_SENTENCE_SPLIT_RE = re.compile(r"[。！？]")


def _joined_decl_prose(decl_text):
    """去掉声明块每行开头的 `>` 续行标记，拼回连续散文。

    Markdown 引用块换行是排版折行，不是句子边界——同一句降级措辞常因为折行
    被切到下一个 `>` 行，逐行找会把它和它要修饰的 what 错误拆开。
    """
    return "".join(line.strip().lstrip(">").strip() + " " for line in decl_text.splitlines())


def _has_nearby_downgrade_wording(decl_text, what):
    """降级措辞必须与被点名的 what 同句，不能整块搜。

    整块搜会被"块里随便哪句有降级词"捎带放行——声明两个 MUST_DOWNGRADE 的
    what、只给一个配了降级措辞，另一个不该被这样蒙混过关（评审攻击二）。
    """
    marker = f"「{what}」"
    joined = _joined_decl_prose(decl_text)
    for sentence in _SENTENCE_SPLIT_RE.split(joined):
        if marker in sentence and any(w in sentence for w in _DOWNGRADE_WORDS):
            return True
    return False


def check_opening_benchmark(report, bench, values=None):
    """硬约束 7：开篇结论的承重数字若压在私有基准/无参照系上，必须声明限制。

    只拦开篇，不拦正文。理由：悬空写在正文里是诚实，悬空写在开篇第一句而不声明
    才是误导——而读报告的人只读开篇。全面拦会让资源股/次新股每篇都被拦，写稿的
    人学会批量粘声明句，硬门反而失效。

    bench 为 None（参照系/ 不存在）时跳过，向后兼容旧 run。

    values 是 {what: 值字符串}（benchmark_lib.parse_benchmark_values 的产出），
    供下面的覆盖性检查（T4-2）判断开篇散文是否字面引用了某条 MUST_DOWNGRADE
    记录。省略或传 None 时该项检查退化为只用 what 串匹配，不影响 bench 为 None
    时的整体跳过。
    """
    if bench is None:
        return []
    values = values or {}
    m = _OPENING_RE.search(report)
    if not m:
        return ["缺〈〇、开篇结论〉一节，无法校验参照系声明"]
    opening = m.group(1)

    decl = _DECL_RE.search(opening)
    if not decl:
        return ["开篇结论缺「> **参照系声明**」块——核心两点各压在哪个数上必须写明"]

    decl_text = decl.group(1)
    named = [w.strip() for w in _NAMED_RE.findall(decl_text)]
    matched = [w for w in named if w in bench]
    if not matched:
        return [
            "参照系声明未点名任何可匹配的承重数字："
            f"声明里提到 {named or '（无）'}，都不在 参照系/*.md 的清单里。"
            "声明必须原样引用清单里的 what 串，泛泛一句不算"
        ]

    errs = []

    # ---- T4-2：覆盖性检查（防"点名一个无关安全数字掩护"绕过）----
    # 校验器读不懂散文，判不了"开篇到底压在哪个数上"，改用字面覆盖：凡参照系
    # 清单里强度属 MUST_DOWNGRADE、且其 what 或 value 字面出现在声明块之前的
    # 开篇散文里的条目，必须被声明块点名——点名别的安全数字不能替代对它的声明。
    # 只做字面 in 判断，不做归一化：漏判可接受，误判才是问题（评审 Ruling T4-2）。
    #
    # value 匹配只是这条的附加触发器（主键仍是 what），而短 value（"20%"
    # "3.1 年"这类）在开篇散文里因完全无关的原因重复出现的概率不小——所得税率
    # 20%、上市 3.1 年——都会被逐字命中，逼作者去声明一个根本没引用的东西。
    # 误判比漏判更糟（Ruling T4-2 自己定的原则），所以短 value 不参与 value 匹配，
    # 退化为只靠 what 串（Ruling T4-4）。原始案例"2.31–3.25 倍"长 10，仍在覆盖内。
    _MIN_VALUE_MATCH_LEN = 6
    prose = opening[:decl.start()]
    for what, strength in bench.items():
        if strength not in benchmark_lib.MUST_DOWNGRADE or what in named:
            continue
        value = values.get(what)
        value_hit = value and len(value) >= _MIN_VALUE_MATCH_LEN and value in prose
        if (what in prose) or value_hit:
            errs.append(
                f"开篇散文字面引用了「{what}」（参照系类型「{strength}」），"
                "但声明块未点名它——点名别的安全数字不能替代对它的声明"
            )

    # ---- T4-3：降级措辞必须与被点名的 what 就近关联（同句），逐个判定 ----
    for what in matched:
        if bench[what] not in benchmark_lib.MUST_DOWNGRADE:
            continue
        if not _has_nearby_downgrade_wording(decl_text, what):
            errs.append(
                f"「{what}」参照系类型为「{bench[what]}」，但声明块里紧邻它的那句没有降级措辞"
                f"（需与「{what}」同句、含 {'/'.join(_DOWNGRADE_WORDS[:3])} 之一）——"
                "压在私有基准上的判断不得当作已证实的事实写"
            )
    return errs


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

    # ---- 硬约束 7：开篇结论的参照系声明 ----
    # 03858 实测：五条承重数字全部回原文核实通过，但按参照系归类没有一条是外部
    # 同口径——核查全过，判断照样悬空。而全篇空头结论正压在其中一条私有基准上。
    # 核查只管"抄对没有"，管不了"这个数在外面算什么水平"，这一条补的就是后者。
    _bench = benchmark_lib.parse_benchmarks(run_dir)
    # bench 为 None（参照系/ 不存在）时不必再扫一遍 value——两者的"目录缺失"
    # 语义一致，check_opening_benchmark 会在 bench is None 时整体跳过。
    _bench_values = benchmark_lib.parse_benchmark_values(run_dir) if _bench is not None else None
    hard.extend(check_opening_benchmark(report, _bench, _bench_values))

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
