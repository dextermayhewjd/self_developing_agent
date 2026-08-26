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

# ---- 评审复现的两个绕过路径（T4-2 / T4-3），及其反向合法用例 ----

BENCH_TWO = {
    "市值 / ITR 税后 NPV": "私有基准",
    "2029 年给矿品位": "无参照系",
    "钨业板块 PE(TTM) 中位数": "外部·可回溯",
}
VALUES_TWO = {
    "市值 / ITR 税后 NPV": "2.31–3.25 倍",
    "2029 年给矿品位": "0.140%",
    "钨业板块 PE(TTM) 中位数": "33.23",
}

# 攻击一：声明块只点名一个无关的安全（外部·可回溯）what，只字不提私有基准的
# 「市值 / ITR 税后 NPV」——但开篇散文字面写出了它的 value「2.31–3.25 倍」。
OPENING_POINTS_AT_SAFE_NUMBER = """## 〇、开篇结论

市值是 ITR 税后 NPV 的 2.31–3.25 倍，所以贵。

> **参照系声明**
> 核心结论对照「钨业板块 PE(TTM) 中位数」——参照系类型 **外部·可回溯**。

## 一、公司简介
"""

# 攻击二：两个 MUST_DOWNGRADE 的 what 都点名了，但降级措辞只跟第一个同句，
# 第二句单独收尾、没有任何降级词。
OPENING_PARTIAL_DOWNGRADE = """## 〇、开篇结论

市值是 ITR 税后 NPV 的 2.31–3.25 倍，2029 年给矿品位会塌陷，所以贵。

> **参照系声明**
> 核心第一点压在「市值 / ITR 税后 NPV」——参照系类型 **私有基准**，板块口径
> 本篇**无法回答**。核心第二点压在「2029 年给矿品位」——参照系类型 **无参照系**。

## 一、公司简介
"""

# 反向合法用例：两个 MUST_DOWNGRADE 的 what 都点名，也都各自在同句配了降级
# 措辞——门不能因为收紧就把这种正当声明也拦下来。
OPENING_BOTH_DOWNGRADED = """## 〇、开篇结论

市值是 ITR 税后 NPV 的 2.31–3.25 倍，2029 年给矿品位会塌陷，所以贵。

> **参照系声明**
> 核心第一点压在「市值 / ITR 税后 NPV」——参照系类型 **私有基准**，板块口径
> 本篇**无法回答**。核心第二点压在「2029 年给矿品位」——参照系类型 **无参照系**，
> 该数本身**无法判断**其相对水平。

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
        self.assertIn("未点名任何可匹配的承重数字", errs[0])

    def test_usable_strength_needs_no_downgrade_wording(self):
        self.assertEqual(check_thesis.check_opening_benchmark(OPENING_SAFE_NUMBER, BENCH), [])

    def test_none_bench_skips_check(self):
        """参照系/ 不存在（旧 run）时向后兼容，不拦。"""
        self.assertEqual(check_thesis.check_opening_benchmark(OPENING_UNDECLARED, None), [])

    def test_none_bench_skips_check_even_with_values(self):
        """bench 为 None 时无论 values 传不传都跳过——向后兼容优先级最高。"""
        self.assertEqual(
            check_thesis.check_opening_benchmark(OPENING_UNDECLARED, None, VALUES_TWO), []
        )

    def test_pointing_at_safe_number_still_flags_unnamed_private_baseline(self):
        """评审攻击一：声明块只点名一个安全（外部·可回溯）的无关 what，但开篇
        散文字面引用了某条私有基准的 value——不能因为点了别的数字就放行。"""
        errs = check_thesis.check_opening_benchmark(
            OPENING_POINTS_AT_SAFE_NUMBER, BENCH_TWO, VALUES_TWO
        )
        self.assertTrue(errs)
        self.assertTrue(any("市值 / ITR 税后 NPV" in e for e in errs))

    def test_partial_downgrade_wording_flags_only_the_unlabeled_one(self):
        """评审攻击二：两个 MUST_DOWNGRADE 的 what 都点名了，只有第一个配了
        降级措辞——必须单独报出第二个缺措辞，不能被同块里第一个的措辞词捎带
        放行。"""
        errs = check_thesis.check_opening_benchmark(
            OPENING_PARTIAL_DOWNGRADE, BENCH_TWO, VALUES_TWO
        )
        self.assertTrue(errs)
        self.assertTrue(any("2029 年给矿品位" in e for e in errs))
        self.assertFalse(any("市值 / ITR 税后 NPV" in e for e in errs))

    def test_both_named_and_downgraded_still_passes(self):
        """反向：两个 MUST_DOWNGRADE 都点名、都各自同句配了降级措辞——门不能修死。"""
        self.assertEqual(
            check_thesis.check_opening_benchmark(OPENING_BOTH_DOWNGRADED, BENCH_TWO, VALUES_TWO),
            [],
        )


if __name__ == "__main__":
    unittest.main()
