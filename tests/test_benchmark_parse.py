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
        d = self.run_dir / "参照系"
        (d / "补.md").write_text("- [瞎写的档] 某个数 ｜ 1 ｜ 出处 ｜ 2026-08-26\n", encoding="utf-8")
        m = benchmark_lib.parse_benchmarks(self.run_dir)
        self.assertNotIn("某个数", m)


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
        d = self.run_dir / "参照系"
        (d / "补.md").write_text("- [瞎写的档] 某个数 ｜ 1 ｜ 出处 ｜ 2026-08-26\n", encoding="utf-8")
        v = benchmark_lib.parse_benchmark_values(self.run_dir)
        self.assertNotIn("某个数", v)


if __name__ == "__main__":
    unittest.main()
