import tempfile
import unittest
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "tools"))
import benchmark_lib


SAMPLE = """# 板块基准

- [外部·可回溯] 钨业板块 PE(TTM) 中位数 ｜ 33.23 ｜ stock_value_em 四家 2026-08-25 ｜ 2026-08-26
- [外部·单源未交叉] Almonty P/NAV ｜ 0.19x ｜ https://seekingalpha.com/article/4937692 ｜ 2026-08-26
    > 原文：ALM trades at a P/NAV of 0.19x
- [外部但口径存疑] 港股一般金属及矿石 PE 中值 ｜ 5.69 ｜ peers.json（池内无同品种） ｜ 2026-08-26
- [私有基准] 市值 / ITR 税后 NPV ｜ 2.31–3.25 倍 ｜ 招股章程附录三 ITR（公司委托 SRK） ｜ 2026-08-26
- [无参照系] 2029 年给矿品位 ｜ 0.140% ｜ 无外部可比 ｜ 2026-08-26
"""


class TestStrengthConstants(unittest.TestCase):
    def test_five_strengths_ordered_strong_to_weak(self):
        self.assertEqual(benchmark_lib.STRENGTHS, (
            "外部·可回溯", "外部·单源未交叉", "外部但口径存疑", "私有基准", "无参照系"))

    def test_usable_and_downgrade_partition(self):
        self.assertEqual(benchmark_lib.USABLE_AS_HARD, frozenset({"外部·可回溯"}))
        self.assertEqual(benchmark_lib.MUST_DOWNGRADE, frozenset({"私有基准", "无参照系"}))


class TestParseBenchmarks(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        d = Path(self.tmp.name) / "参照系"
        d.mkdir()
        (d / "板块基准.md").write_text(SAMPLE, encoding="utf-8")
        self.run_dir = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def test_parses_all_five_lines(self):
        m = benchmark_lib.parse_benchmarks(self.run_dir)
        self.assertEqual(len(m), 5)

    def test_maps_what_to_strength(self):
        m = benchmark_lib.parse_benchmarks(self.run_dir)
        self.assertEqual(m["市值 / ITR 税后 NPV"], "私有基准")
        self.assertEqual(m["钨业板块 PE(TTM) 中位数"], "外部·可回溯")
        self.assertEqual(m["2029 年给矿品位"], "无参照系")

    def test_ignores_verbatim_continuation_lines(self):
        m = benchmark_lib.parse_benchmarks(self.run_dir)
        self.assertNotIn("原文：ALM trades at a P/NAV of 0.19x", m)

    def test_missing_dir_returns_none(self):
        """参照系/ 不存在时返回 None，让调用方能区分'没这道工序'与'工序跑了但空'。"""
        with tempfile.TemporaryDirectory() as empty:
            self.assertIsNone(benchmark_lib.parse_benchmarks(Path(empty)))

    def test_unknown_strength_is_skipped(self):
        """打错档位的行不进表——宁可漏判也不要把打错的标签当成有效强度。

        坏行放在有正常行的同一份文件里：单独成文件时它已经是 C2(a) 的"整份零命中"，
        按设计要大声失败（见 TestZeroHitIsLoud），不再是"静默跳过"。
        """
        d = self.run_dir / "参照系"
        (d / "板块基准.md").write_text(
            SAMPLE + "- [瞎写的档] 某个数 ｜ 1 ｜ 出处 ｜ 2026-08-26\n", encoding="utf-8")
        m = benchmark_lib.parse_benchmarks(self.run_dir)
        self.assertNotIn("某个数", m)
        self.assertEqual(len(m), 5, "正常的五条不能被那一行坏行连累")


class TestParseBenchmarkValues(unittest.TestCase):
    """Task 4 评审 Ruling T4-2 追加：check_thesis 的覆盖性检查需要拿到"值"字段
    （不只是强度），用于判断开篇散文是否字面引用了某条参照系记录。"""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        d = Path(self.tmp.name) / "参照系"
        d.mkdir()
        (d / "板块基准.md").write_text(SAMPLE, encoding="utf-8")
        self.run_dir = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def test_maps_what_to_value(self):
        v = benchmark_lib.parse_benchmark_values(self.run_dir)
        self.assertEqual(v["市值 / ITR 税后 NPV"], "2.31–3.25 倍")
        self.assertEqual(v["钨业板块 PE(TTM) 中位数"], "33.23")

    def test_missing_dir_returns_none(self):
        with tempfile.TemporaryDirectory() as empty:
            self.assertIsNone(benchmark_lib.parse_benchmark_values(Path(empty)))

    def test_unknown_strength_is_skipped(self):
        """同 TestParseBenchmarks：坏行与正常行同处一份文件，才是"跳过"语义。"""
        d = self.run_dir / "参照系"
        (d / "板块基准.md").write_text(
            SAMPLE + "- [瞎写的档] 某个数 ｜ 1 ｜ 出处 ｜ 2026-08-26\n", encoding="utf-8")
        v = benchmark_lib.parse_benchmark_values(self.run_dir)
        self.assertNotIn("某个数", v)


# ── 复审 C1/C2(a) 追加 ────────────────────────────────────────────────
# 核查行是双方括号：`- [判定][参照系类型] what ｜ 核实值 ｜ 出处`，参照系类型在**第二个**
# 方括号里。旧 run（03858 那一版）的核查是单方括号，不参与解析也不算解析失败。
CHECK_NEW = """# 尽调 —— 承重数字核查结论

- [确认无误][私有基准] 市值 / ITR 税后 NPV ｜ 2.31–3.25 倍 ｜ 招股章程附录三 ITR
- [修正][外部·可回溯] 钨业板块 PE(TTM) 中位数 ｜ 33.23 ｜ peers_curated.json
- [未查到][无参照系] 2026H1 现货均价 ｜ 未取得 ｜ 本地无
"""

CHECK_LEGACY = """# 产业 —— 承重数字核查结论

- [确认无误] 承重数字1a｜钨精矿均价序列 ｜ 14.12 万元/吨 ｜ 招股章程 P.137
- [修正] 承重数字1d｜2025 年均价 ｜ 21.74 万元/吨 ｜ 安泰科
"""


def _mkrun(root, bench=None, check=None, bench_dir=False):
    root = Path(root)
    if bench or bench_dir:
        (root / "参照系").mkdir(exist_ok=True)
    for name, text in (bench or {}).items():
        (root / "参照系" / name).write_text(text, encoding="utf-8")
    if check:
        (root / "核查").mkdir(exist_ok=True)
    for name, text in (check or {}).items():
        (root / "核查" / name).write_text(text, encoding="utf-8")
    return root


class TestParseCheckBenchmarks(unittest.TestCase):
    """核查/*.md 是 bench 的另一半真值来源（复审 C1）。"""

    def test_takes_strength_from_second_bracket(self):
        with tempfile.TemporaryDirectory() as tmp:
            run = _mkrun(tmp, check={"尽调.md": CHECK_NEW})
            bench, values = benchmark_lib.parse_check_benchmarks(run)
        self.assertEqual(bench["市值 / ITR 税后 NPV"], "私有基准")
        self.assertEqual(bench["钨业板块 PE(TTM) 中位数"], "外部·可回溯")
        self.assertEqual(bench["2026H1 现货均价"], "无参照系")
        self.assertEqual(values["市值 / ITR 税后 NPV"], "2.31–3.25 倍")

    def test_legacy_single_bracket_yields_nothing_and_does_not_raise(self):
        """旧 run 的单方括号核查既不解析、也不算"有行零命中"——向后兼容不能破。"""
        with tempfile.TemporaryDirectory() as tmp:
            run = _mkrun(tmp, check={"产业.md": CHECK_LEGACY})
            bench, values = benchmark_lib.parse_check_benchmarks(run)
        self.assertEqual(bench, {})
        self.assertEqual(values, {})

    def test_missing_check_dir_is_empty_not_none(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.assertEqual(benchmark_lib.parse_check_benchmarks(Path(tmp)), ({}, {}))

    def test_bogus_strength_in_second_bracket_raises(self):
        """格式对了但档位串写错：整份零命中 → 大声失败，不静默丢。"""
        with tempfile.TemporaryDirectory() as tmp:
            run = _mkrun(tmp, check={"尽调.md": "- [确认无误][外部-可回溯] 某数 ｜ 1 ｜ 出处\n"})
            with self.assertRaises(benchmark_lib.BenchmarkParseError):
                benchmark_lib.parse_check_benchmarks(run)


class TestZeroHitIsLoud(unittest.TestCase):
    """复审 C2(a)：一份文件里有 `- [` 开头的行、却零条解析成功 → 抛异常。"""

    def test_bench_file_copied_from_check_format_raises(self):
        """补参照系 agent 照抄核查的双方括号格式——这正是实测风险本身。"""
        with tempfile.TemporaryDirectory() as tmp:
            run = _mkrun(tmp, bench={
                "板块基准.md": SAMPLE,
                "补.md": "- [确认无误][私有基准] 市值 / ITR 税后 NPV ｜ 2.31–3.25 倍 ｜ ITR ｜ 2026-08-26\n",
            })
            with self.assertRaises(benchmark_lib.BenchmarkParseError) as ctx:
                benchmark_lib.parse_benchmarks(run)
        self.assertIn("补.md", str(ctx.exception), "报错要指名是哪份文件")

    def test_detection_is_per_file_not_aggregated(self):
        """板块基准.md 正常时不能因为"整体还有命中"就放过整份写坏的 补.md——
        真实的失败形态正是这一种。"""
        with tempfile.TemporaryDirectory() as tmp:
            run = _mkrun(tmp, bench={
                "板块基准.md": SAMPLE,
                "补.md": "- [瞎写的档] 某个数 ｜ 1 ｜ 出处 ｜ 2026-08-26\n",
            })
            with self.assertRaises(benchmark_lib.BenchmarkParseError):
                benchmark_lib.parse_benchmarks(run)

    def test_file_with_no_entry_lines_at_all_is_fine(self):
        """纯散文的参照系文件不算失败——零候选行就是零候选行。"""
        with tempfile.TemporaryDirectory() as tmp:
            run = _mkrun(tmp, bench={"板块基准.md": SAMPLE, "说明.md": "本轮没有联网。\n"})
            self.assertEqual(len(benchmark_lib.parse_benchmarks(run)), 5)

    def test_second_bracket_leftover_is_not_taken_as_what(self):
        """`- [强度][判定] what` 这种反着写的，what 不能变成 "[判定] what"。"""
        with tempfile.TemporaryDirectory() as tmp:
            run = _mkrun(tmp, bench={
                "补.md": "- [私有基准][确认无误] 市值 / ITR 税后 NPV ｜ 2.31 倍 ｜ ITR ｜ 2026-08-26\n"})
            with self.assertRaises(benchmark_lib.BenchmarkParseError):
                benchmark_lib.parse_benchmarks(run)


class TestCollectBenchmarks(unittest.TestCase):
    """两个来源怎么合：核查/ 打底、参照系/ 覆盖；目录缺失/空目录各有各的信号。"""

    def test_bench_overrides_check_for_same_what(self):
        with tempfile.TemporaryDirectory() as tmp:
            run = _mkrun(
                tmp,
                bench={"补.md": "- [外部·单源未交叉] 市值 / ITR 税后 NPV ｜ 0.8x ｜ http://a ｜ 2026-08-26\n"},
                check={"尽调.md": CHECK_NEW},
            )
            got = benchmark_lib.collect_benchmarks(run)
        self.assertEqual(got.bench["市值 / ITR 税后 NPV"], "外部·单源未交叉",
                          "参照系/ 是更新后的判定，必须盖过核查/")
        self.assertEqual(got.bench["2026H1 现货均价"], "无参照系",
                          "参照系/ 没写的条目仍要从核查/ 兜住——C1 的 fail-open 就堵在这")

    def test_neither_dir_returns_none_without_notes(self):
        with tempfile.TemporaryDirectory() as tmp:
            got = benchmark_lib.collect_benchmarks(Path(tmp))
        self.assertIsNone(got.bench)
        self.assertEqual(got.notes, [], "旧 run 向后兼容：跳过就是跳过，不该报警")

    def test_legacy_check_only_returns_none(self):
        with tempfile.TemporaryDirectory() as tmp:
            run = _mkrun(tmp, check={"产业.md": CHECK_LEGACY})
            got = benchmark_lib.collect_benchmarks(run)
        self.assertIsNone(got.bench, "03858 那一版必须仍然整体跳过")

    def test_empty_bench_dir_with_nothing_else_is_hard(self):
        """空目录砖化（C2(b)）：目录存在但零条目 ≠ 工序跑过且干净。"""
        with tempfile.TemporaryDirectory() as tmp:
            run = _mkrun(tmp, bench_dir=True)
            got = benchmark_lib.collect_benchmarks(run)
        self.assertIsNone(got.bench)
        self.assertEqual([lv for lv, _ in got.notes], ["hard"])

    def test_empty_bench_dir_with_check_entries_warns_but_keeps_gate(self):
        with tempfile.TemporaryDirectory() as tmp:
            run = _mkrun(tmp, check={"尽调.md": CHECK_NEW}, bench_dir=True)
            got = benchmark_lib.collect_benchmarks(run)
        self.assertEqual(len(got.bench), 3)
        self.assertEqual([lv for lv, _ in got.notes], ["warn"])

    def test_missing_bench_dir_with_check_entries_warns(self):
        with tempfile.TemporaryDirectory() as tmp:
            run = _mkrun(tmp, check={"尽调.md": CHECK_NEW})
            got = benchmark_lib.collect_benchmarks(run)
        self.assertEqual(len(got.bench), 3, "参照系/ 没落盘也不能让硬门失效")
        self.assertEqual([lv for lv, _ in got.notes], ["warn"])


if __name__ == "__main__":
    unittest.main()
