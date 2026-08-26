"""硬约束 7 的端到端退出码测试：合成一整个 run 目录，跑 check_thesis.main()。

为什么不满足于 check_opening_benchmark 的单元测试：复审的两条 Critical 都不在那个
函数里，而在**「bench 这张表从哪来」**。C1 的 fail-open 是"表里少了一条"、false-block
是"表里本来就不会有那条"——两者在函数入参层面都表现为"传进来的 bench 就是这样"，
只有从 run 目录真实解析一遍才复现得出来。所以这里测的是退出码，不是返回值。

合成 run 的骨架只求过其余六条硬约束（档案、节数、销账、产物齐备……），刻意不铺满
十二节的真实文风——本文件唯一要立的靶子是参照系那道门。
"""
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "tools"))
import check_thesis

SYMBOL = "TEST8888"
DATE = "20260826"

_SECTIONS = ["一", "二", "三", "四", "五", "六", "七", "八", "九", "十", "十一", "十二"]

# 五档强度串一律从 benchmark_lib 取，不在测试里手打——手打一个码位就静默失配，
# 而这正是被测代码要防的失败模式本身。
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "tools"))
import benchmark_lib

TRACEABLE, SINGLE_SOURCE, DUBIOUS, PRIVATE, NONE_BENCH = benchmark_lib.STRENGTHS
BAR = "｜"  # U+FF5C，与 benchmark_lib._BENCH_LINE_RE 认的分隔符一致


def _body():
    """十二节骨架：每节一段够长的观点总结，含立疑与销账关键词。"""
    out = []
    for i, s in enumerate(_SECTIONS, 1):
        out.append(f"## {s}、第{s}节\n")
        out.append(
            f"**观点总结：** 现在回答开篇的问题{i}：这一节的疑惑本轮有答案，"
            f"证据链完整、方向明确，够撑住本节的判断，不需要再补一轮核查。\n"
        )
    return "\n".join(out)


def build_run(root, opening, bench_files=None, check_files=None, bench_dir_empty=False):
    """在 root 下造一个能过其余硬约束的 run，返回 report 路径（相对 root）。"""
    root = Path(root)
    run = root / "reports" / f"{SYMBOL}_thesis_{DATE}"
    (run / "findings").mkdir(parents=True, exist_ok=True)
    (run / "疑惑.md").write_text("估值原型：耗竭资源型\n\n疑惑一：够不够贵？\n", encoding="utf-8")
    for name in ("财务排雷", "尽调", "产业", "竞争", "战略驱动"):
        (run / "findings" / f"{name}.md").write_text(f"# {name}\n\n占位。\n", encoding="utf-8")

    (root / "positions").mkdir(exist_ok=True)
    (root / "positions" / f"{SYMBOL}.md").write_text(
        f"---\n最近更新：2026-08-26\n---\n\n占位档案。\n", encoding="utf-8"
    )

    if bench_dir_empty:
        (run / "参照系").mkdir(exist_ok=True)
    for name, text in (bench_files or {}).items():
        (run / "参照系").mkdir(exist_ok=True)
        (run / "参照系" / name).write_text(text, encoding="utf-8")
    for name, text in (check_files or {}).items():
        (run / "核查").mkdir(exist_ok=True)
        (run / "核查" / name).write_text(text, encoding="utf-8")

    report = f"---\n报告日期：2026-08-26\n---\n\n## 〇、开篇结论\n\n{opening}\n\n{_body()}"
    (run / "report.md").write_text(report, encoding="utf-8")
    return run / "report.md"


def run_check(root, report_path):
    """在 root 下跑一次 check_thesis.main()，返回 (退出码, 打印出来的全文)。"""
    import io
    import contextlib

    cwd = os.getcwd()
    buf = io.StringIO()
    try:
        os.chdir(root)
        argv = ["check_thesis.py", SYMBOL, str(report_path)]
        with mock.patch.object(sys, "argv", argv), contextlib.redirect_stdout(buf), \
                contextlib.redirect_stderr(buf):
            code = check_thesis.main()
    finally:
        os.chdir(cwd)
    return code, buf.getvalue()


# ── C1 的两个方向 ──────────────────────────────────────────────────────
# 复审实测的 fail-open：核查把「市值 / ITR 税后 NPV」判为私有基准，补参照系漏写这条，
# 于是它压根不在 参照系/ 里；开篇原样压在它上面、声明块只点了板块中位数 → 修复前 exit 0。
CHECK_PRIVATE = (
    f"# 尽调 —— 承重数字核查结论\n\n"
    f"- [确认无误][{PRIVATE}] 市值 / ITR 税后 NPV {BAR} 2.31–3.25 倍 {BAR} 招股章程附录三 ITR\n"
)
BENCH_ONLY_SECTOR = (
    f"# 板块基准\n\n"
    f"- [{TRACEABLE}] 钨业板块 PE(TTM) 中位数 {BAR} 33.23 {BAR} stock_value_em {BAR} 2026-08-26\n"
)
OPENING_FAIL_OPEN = """市值是 ITR 税后 NPV 的 2.31–3.25 倍，所以贵。

> **参照系声明**
> 核心结论对照「钨业板块 PE(TTM) 中位数」——参照系类型 **外部·可回溯**。"""

# false-block：核心两点都被核查判为「外部·可回溯」，它们永远不进 参照系/；
# 成稿老老实实点名它们 → 修复前 matched 为空 → exit 1，且报错指向"声明写错了"。
CHECK_TRACEABLE_TWO = (
    f"# 尽调 —— 承重数字核查结论\n\n"
    f"- [确认无误][{TRACEABLE}] 钨业板块 PE(TTM) 中位数 {BAR} 33.23 {BAR} peers_curated.json\n"
    f"- [确认无误][{TRACEABLE}] C1 现金成本全球分位 {BAR} 第 28 分位 {BAR} peers_curated.json\n"
)
BENCH_UNRELATED = (
    f"# 板块基准\n\n"
    f"- [{SINGLE_SOURCE}] 板块 P/NAV 中位数 {BAR} 0.8x {BAR} https://example.com/a {BAR} 2026-08-26\n"
)
OPENING_HONEST = """本篇的贵贱判断压在两条外部可回溯的数上。

> **参照系声明**
> 核心第一点压在「钨业板块 PE(TTM) 中位数」——参照系类型 **外部·可回溯**。
> 核心第二点压在「C1 现金成本全球分位」——参照系类型 **外部·可回溯**。"""

# 向后兼容：旧 run 的 核查/ 是单方括号格式（03858 那一版），参照系/ 不存在，
# report 里根本没有声明块——必须仍然 exit 0。
LEGACY_CHECK = (
    f"# 产业 —— 承重数字核查结论\n\n"
    f"- [确认无误] 承重数字1a{BAR}钨精矿均价序列 {BAR} 14.12 万元/吨 {BAR} 招股章程 P.137\n"
    f"- [修正] 承重数字1d{BAR}2025 年均价 {BAR} 21.74 万元/吨 {BAR} 安泰科\n"
)
OPENING_NO_DECL = "市值是 ITR 税后 NPV 的 2.31–3.25 倍，所以贵。"

# C2(a)：补.md 照抄了核查的双方括号格式——修复前整份文件被静默丢光。
BENCH_DOUBLE_BRACKET = (
    f"# 补参照系\n\n"
    f"- [确认无误][{PRIVATE}] 市值 / ITR 税后 NPV {BAR} 2.31–3.25 倍 {BAR} ITR {BAR} 2026-08-26\n"
)


class TestC1FailOpen(unittest.TestCase):
    """C1 方向一：核查判了私有基准、补参照系漏写 → 硬门必须拦住。"""

    def test_dangling_private_baseline_from_check_dir_blocks(self):
        with tempfile.TemporaryDirectory() as tmp:
            rp = build_run(
                tmp, OPENING_FAIL_OPEN,
                bench_files={"板块基准.md": BENCH_ONLY_SECTOR},
                check_files={"尽调.md": CHECK_PRIVATE},
            )
            code, out = run_check(tmp, rp)
        self.assertEqual(code, 1, f"补参照系漏写时必须拦住，实际 exit {code}\n{out}")
        self.assertIn("市值 / ITR 税后 NPV", out)


class TestC1FalseBlock(unittest.TestCase):
    """C1 方向二：核心两点都是外部·可比溯 → 硬门不得误拦最健康的稿子。"""

    def test_traceable_whats_named_from_check_dir_pass(self):
        with tempfile.TemporaryDirectory() as tmp:
            rp = build_run(
                tmp, OPENING_HONEST,
                bench_files={"板块基准.md": BENCH_UNRELATED},
                check_files={"尽调.md": CHECK_TRACEABLE_TWO},
            )
            code, out = run_check(tmp, rp)
        self.assertEqual(code, 0, f"核查判为外部·可回溯的 what 被点名，不该拦，实际 exit {code}\n{out}")


class TestBackwardCompat(unittest.TestCase):
    """旧 run（单方括号核查 + 无 参照系/）必须仍然放行。"""

    def test_legacy_single_bracket_check_dir_is_not_a_benchmark_source(self):
        with tempfile.TemporaryDirectory() as tmp:
            rp = build_run(tmp, OPENING_NO_DECL, check_files={"产业.md": LEGACY_CHECK})
            code, out = run_check(tmp, rp)
        self.assertEqual(code, 0, f"旧格式 run 必须向后兼容放行，实际 exit {code}\n{out}")

    def test_no_bench_and_no_check_dir_passes(self):
        with tempfile.TemporaryDirectory() as tmp:
            rp = build_run(tmp, OPENING_NO_DECL)
            code, out = run_check(tmp, rp)
        self.assertEqual(code, 0, f"两个目录都不存在时必须跳过本项，实际 exit {code}\n{out}")


class TestC2LoudFailures(unittest.TestCase):
    """C2：静默丢行与空目录砖化，两者都必须"要么拦住、要么大声记录"。"""

    def test_double_bracket_bench_file_fails_loudly(self):
        with tempfile.TemporaryDirectory() as tmp:
            rp = build_run(
                tmp, OPENING_FAIL_OPEN,
                bench_files={"板块基准.md": BENCH_ONLY_SECTOR, "补.md": BENCH_DOUBLE_BRACKET},
            )
            code, out = run_check(tmp, rp)
        self.assertEqual(code, 1, f"整份文件解析不出一条时必须大声失败，实际 exit {code}\n{out}")
        self.assertIn("补.md", out, "报错必须指名是哪个文件的格式不对")

    def test_empty_bench_dir_reports_the_real_reason(self):
        """空目录砖化：修复前报"声明未点名任何可匹配的承重数字"，把作者指向错的地方。"""
        with tempfile.TemporaryDirectory() as tmp:
            rp = build_run(tmp, OPENING_NO_DECL, bench_dir_empty=True)
            code, out = run_check(tmp, rp)
        self.assertEqual(code, 1)
        self.assertNotIn("未点名任何可匹配的承重数字", out,
                          "空目录的报错不能伪装成'声明写错了'——那会让作者去改声明块")
        self.assertNotIn("开篇结论缺", out,
                          "同上：空目录不该被报成'开篇少写了个声明块'")
        self.assertIn("目录存在但一条参照系记录都没有", out,
                      "必须指名真正的原因：工序空跑或落盘失败")

    def test_empty_bench_dir_with_check_entries_still_uses_check(self):
        """参照系/ 空但核查/ 有条目：真值来源退化为核查，声明写对了就该放行（带警告）。"""
        with tempfile.TemporaryDirectory() as tmp:
            rp = build_run(
                tmp, OPENING_HONEST,
                check_files={"尽调.md": CHECK_TRACEABLE_TWO},
                bench_dir_empty=True,
            )
            code, out = run_check(tmp, rp)
        self.assertEqual(code, 2, f"应通过但带软警告，实际 exit {code}\n{out}")
        self.assertIn("[WARN]", out)


# ── 最终修复波复审（Important）：短 what 的误拦 ────────────────────────
# C1 把 what 的来源扩到"核查文件的每一行"，而真实核查里 what 短到 5–6 字很常见。
# 这里走的是完整链路：核查/ 落盘 → 合并 → 覆盖性检查，用 03858 的真实开篇措辞。
CHECK_SHORT_WHAT = (
    f"# 财务排雷 —— 承重数字核查结论\n\n"
    f"- [确认无误][{PRIVATE}] 现金 {BAR} 12.4 亿港元 {BAR} 2025 年报 资产负债表\n"
    f"- [确认无误][{PRIVATE}] 产量 {BAR} 5,008 吨 {BAR} 2025 年报 P.7\n"
    f"- [确认无误][{TRACEABLE}] 钨业板块 PE(TTM) 中位数 {BAR} 33.23 {BAR} peers_curated.json\n"
)
OPENING_REAL_PROSE = """手上的现金既不对冲价格下行，也买不来第二座矿；产量峰值出现在 2027 年之后就一路下台阶。

> **参照系声明**
> 核心结论对照「钨业板块 PE(TTM) 中位数」——参照系类型 **外部·可回溯**。"""


class TestShortWhatNotFalseBlocked(unittest.TestCase):
    def test_short_whats_in_real_prose_do_not_block(self):
        with tempfile.TemporaryDirectory() as tmp:
            rp = build_run(tmp, OPENING_REAL_PROSE,
                            bench_files={"板块基准.md": BENCH_ONLY_SECTOR},
                            check_files={"财务排雷.md": CHECK_SHORT_WHAT})
            code, out = run_check(tmp, rp)
        self.assertEqual(code, 0, f"「现金」「产量」这类短 what 不得误拦，实际 exit {code}\n{out}")

    def test_long_what_still_blocks_through_the_full_chain(self):
        """同一条链路上，长 what 的覆盖必须仍然生效——别把这条一起关掉。"""
        with tempfile.TemporaryDirectory() as tmp:
            rp = build_run(
                tmp, OPENING_FAIL_OPEN,
                bench_files={"板块基准.md": BENCH_ONLY_SECTOR},
                check_files={"尽调.md": CHECK_PRIVATE},
            )
            code, out = run_check(tmp, rp)
        self.assertEqual(code, 1)
        self.assertIn("市值 / ITR 税后 NPV", out)


if __name__ == "__main__":
    unittest.main()
