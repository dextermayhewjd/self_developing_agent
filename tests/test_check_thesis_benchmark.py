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

# ---- 复审 Important（Ruling T4-4）：短 value 字面匹配对无关同串的误报 ----
# "20%"/"3.1 年" 这类短 value 很容易因完全无关的原因在开篇散文里重复出现
# （所得税率 20%、上市 3.1 年）——覆盖性检查若对短串也做 value 匹配，会逼作者
# 声明一个开篇根本没引用的私有基准条目。value 匹配只是附加触发器（主键仍是
# what 串），短 value 应退化为只靠 what 串匹配。

BENCH_SHORT_VALUE_PCT = {
    "某私有基准短值条目": "私有基准",
    "钨业板块 PE(TTM) 中位数": "外部·可回溯",
}
VALUES_SHORT_VALUE_PCT = {
    "某私有基准短值条目": "20%",
    "钨业板块 PE(TTM) 中位数": "33.23",
}
# 开篇散文因无关原因（所得税率）出现字面 "20%"，与「某私有基准短值条目」毫无关系，
# 声明块也没点名它——只点名了不相干的安全 what。
OPENING_UNRELATED_20PCT = """## 〇、开篇结论

所得税实际税率约 20%，对净利润影响有限；估值对照见下方声明。

> **参照系声明**
> 核心结论对照「钨业板块 PE(TTM) 中位数」——参照系类型 **外部·可回溯**。

## 一、公司简介
"""

BENCH_SHORT_VALUE_YEARS = {
    "某私有基准短值条目二": "无参照系",
    "钨业板块 PE(TTM) 中位数": "外部·可回溯",
}
VALUES_SHORT_VALUE_YEARS = {
    "某私有基准短值条目二": "3.1 年",
    "钨业板块 PE(TTM) 中位数": "33.23",
}
# 开篇散文因无关原因（上市年限）出现字面 "3.1 年"，与「某私有基准短值条目二」
# 毫无关系。
OPENING_UNRELATED_3_1_YEARS = """## 〇、开篇结论

公司上市 3.1 年，尚在业绩兑现窗口期；估值对照见下方声明。

> **参照系声明**
> 核心结论对照「钨业板块 PE(TTM) 中位数」——参照系类型 **外部·可回溯**。

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

    def test_short_value_percent_does_not_false_positive(self):
        """复审 Important（Ruling T4-4）：value="20%" 因无关原因（所得税率）
        字面出现在开篇散文里，不得被误判成"引用了该私有基准条目却未点名"。"""
        self.assertEqual(
            check_thesis.check_opening_benchmark(
                OPENING_UNRELATED_20PCT, BENCH_SHORT_VALUE_PCT, VALUES_SHORT_VALUE_PCT
            ),
            [],
        )

    def test_short_value_years_does_not_false_positive(self):
        """复审 Important（Ruling T4-4）：value="3.1 年" 因无关原因（上市年限）
        字面出现在开篇散文里，同样不得误判。"""
        self.assertEqual(
            check_thesis.check_opening_benchmark(
                OPENING_UNRELATED_3_1_YEARS, BENCH_SHORT_VALUE_YEARS, VALUES_SHORT_VALUE_YEARS
            ),
            [],
        )

    def test_long_value_coverage_still_triggers(self):
        """确认长 value（"2.31–3.25 倍"，长度 >= 6）的覆盖性检查未被 T4-4 的
        长度下限连带削弱——这就是评审攻击一的原始场景，此处再显式断言一次。"""
        errs = check_thesis.check_opening_benchmark(
            OPENING_POINTS_AT_SAFE_NUMBER, BENCH_TWO, VALUES_TWO
        )
        self.assertTrue(errs)
        self.assertTrue(any("市值 / ITR 税后 NPV" in e for e in errs))


if __name__ == "__main__":
    unittest.main()
