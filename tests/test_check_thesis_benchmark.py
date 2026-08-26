import unittest
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "tools"))
import check_thesis


BENCH = {
    "市值 / ITR 税后 NPV": "私有基准",
    "钨业板块 PE(TTM) 中位数": "外部·可回溯",
}

OPENING_UNDECLARED = """## 〇、开篇结论

市值是 ITR 税后 NPV 的 2.31–3.25 倍，所以贵。

## 一、公司简介
"""

OPENING_DECLARED = """## 〇、开篇结论

市值是 ITR 税后 NPV 的 2.31–3.25 倍，所以贵。

> **参照系声明**
> 核心第一点压在「市值 / ITR 税后 NPV」——参照系类型 **私有基准**；板块 P/NAV
> 中位数**未取得**，故相对板块的贵贱本篇**无法回答**。

## 一、公司简介
"""

OPENING_TEMPLATE_DODGE = """## 〇、开篇结论

市值是 ITR 税后 NPV 的 2.31–3.25 倍，所以贵。

> **参照系声明**
> 本报告部分数据未经外部验证，相关结论**无法回答**其相对水平。

## 一、公司简介
"""

OPENING_SAFE_NUMBER = """## 〇、开篇结论

估值高于同业：见「钨业板块 PE(TTM) 中位数」。

> **参照系声明**
> 核心第一点压在「钨业板块 PE(TTM) 中位数」——参照系类型 **外部·可回溯**。

## 一、公司简介
"""


class TestOpeningBenchmark(unittest.TestCase):
    def test_missing_declaration_block_fails(self):
        errs = check_thesis.check_opening_benchmark(OPENING_UNDECLARED, BENCH)
        self.assertTrue(errs)
        self.assertIn("参照系声明", errs[0])

    def test_proper_declaration_passes(self):
        self.assertEqual(check_thesis.check_opening_benchmark(OPENING_DECLARED, BENCH), [])

    def test_template_dodge_fails(self):
        """泛泛声明匹配不上任何 what，必须照样拦——这是防绕过的关键。"""
        errs = check_thesis.check_opening_benchmark(OPENING_TEMPLATE_DODGE, BENCH)
        self.assertTrue(errs)

    def test_usable_strength_needs_no_downgrade_wording(self):
        self.assertEqual(check_thesis.check_opening_benchmark(OPENING_SAFE_NUMBER, BENCH), [])

    def test_none_bench_skips_check(self):
        """参照系/ 不存在（旧 run）时向后兼容，不拦。"""
        self.assertEqual(check_thesis.check_opening_benchmark(OPENING_UNDECLARED, None), [])


if __name__ == "__main__":
    unittest.main()
