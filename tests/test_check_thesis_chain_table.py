"""硬约束 8（外部环节表）的端到端退出码测试。

为什么必须端到端而不是单元测：这条门的第一版被对抗审查**实测**绕过了两次，
两条通道都不在 `check_chain_table` 的入参层面，而在它上面的编排里：

- **通道一（内容空转）**：六行零信息表 `| 上游 | 供应 | L0 | 无 |` ×2 加一句
  「定价锚在下游」完整过门，零硬错零软警。
- **通道二（釜底抽薪）**：`疑惑.md` 缺 `估值原型：` 行时第一版只给 soft，
  `main()` 走 `return 2` 打印「通过（含警告）」放行——**门的开关握在被检查者手里**。

所以本文件测的是退出码，且两条通道各有一个用例钉住，防止以后被改回去。

本文件复用 `test_check_thesis_gate_e2e` 的 run 构造与 run_check，
但覆盖它 fixture 里的 `疑惑.md` 与外部环节表——那份 fixture 的职责是
「过掉其余硬约束」，本文件要立的靶子恰好是它顺手过掉的那一条。
"""

import tempfile
import unittest
from pathlib import Path

from test_check_thesis_gate_e2e import DATE, SYMBOL, build_run, run_check

# 一张真的满足五项要求的表：≥2 行、依据非空占位、≥半数行有来路、定价锚命中第一列
GOOD_TABLE = (
    "### 外部环节表\n\n"
    "| 环节 | 在材料价值链上的位置 | 与本环的关系 | 深度档 | 依据 / 跳过理由 |\n"
    "|---|---|---|---|---|\n"
    "| 仲钨酸铵 | 招股章程 P.129 价值链图中游首环 | 本环售价是它的折扣价 | L2 | ITR 10.4 节 P.III-171 |\n"
    "| 钨铁 | P.129 图上白钨矿直接分出的支线 | 旁路，火法电炉还原 | L0 | ITR P.III-43，分流量该书未给 |\n\n"
    "**定价锚**在仲钨酸铵那一环。\n"
)

# 对抗审查实测能过第一版门的凑数表，一字不改地留作回归靶子
GAMING_TABLE = (
    "### 外部环节表\n\n"
    "| 环节 | 与本环的关系 | 深度档 | 依据 |\n"
    "|---|---|---|---|\n"
    "| 上游 | 供应 | L0 | 无 |\n"
    "| 下游 | 需求 | L0 | 无 |\n\n"
    "定价锚在下游。\n"
)

OPENING = "本票的核心矛盾是量能路径能否兑现，我判断兑现不了，理由在第五节。"


def build(root, archetype, table):
    """造 run，然后按需覆盖 疑惑.md 的原型行与报告尾部的外部环节表。"""
    report = build_run(root, OPENING)
    run = Path(root) / "reports" / f"{SYMBOL}_thesis_{DATE}"

    doubt = "疑惑一：量能够不够？\n"
    if archetype is not None:
        doubt = f"估值原型：{archetype}\n\n" + doubt
    (run / "疑惑.md").write_text(doubt, encoding="utf-8")

    text = (run / "report.md").read_text(encoding="utf-8")
    # fixture 自带一张占位表，先摘掉，再按用例贴回去
    text = text.split("### 外部环节表")[0]
    if table:
        text += table
    (run / "report.md").write_text(text, encoding="utf-8")
    return report


class TestChainTableGate(unittest.TestCase):
    def _run(self, archetype, table):
        with tempfile.TemporaryDirectory() as root:
            report = build(root, archetype, table)
            return run_check(root, report)

    # ── 通道二：门的开关不能握在被检查者手里 ──────────────────────────
    def test_missing_archetype_line_is_hard_not_soft(self):
        code, out = self._run(None, GOOD_TABLE)
        self.assertEqual(code, 1, f"缺 `估值原型：` 行必须 hard——否则删掉一行就能关掉整条门\n{out}")
        self.assertIn("估值原型", out)

    def test_unknown_archetype_value_does_not_silently_pass(self):
        """写一个不在 15 原型里的值（含错别字）不该连警告都没有。"""
        code, out = self._run("耗竭资源型X", None)
        self.assertNotEqual(
            code, 0, f"原型值不认识时不能静默通过——那是通道二的变体\n{out}"
        )

    # ── 通道一：凑数表不能过 ──────────────────────────────────────────
    def test_gaming_table_is_rejected(self):
        code, out = self._run("耗竭资源型", GAMING_TABLE)
        self.assertEqual(code, 1, f"对抗审查实测的凑数表必须被拦下\n{out}")
        self.assertIn("空占位", out)
        self.assertIn("来路", out)

    # ── 基本形态 ──────────────────────────────────────────────────────
    def test_commodity_archetype_without_table_fails(self):
        code, out = self._run("耗竭资源型", None)
        self.assertEqual(code, 1, out)
        self.assertIn("外部环节表", out)
        self.assertIn("定价锚", out)

    def test_anchor_must_name_a_row_in_the_table(self):
        table = GOOD_TABLE.replace("**定价锚**在仲钨酸铵那一环。", "定价锚在硬质合金那一环。")
        code, out = self._run("耗竭资源型", table)
        self.assertEqual(code, 1, f"定价锚指向表外环节应被拦——结论要和表连通\n{out}")
        self.assertIn("第一列", out)

    def test_valid_table_passes(self):
        code, out = self._run("耗竭资源型", GOOD_TABLE)
        self.assertEqual(code, 0, f"合规的表不得误拦\n{out}")

    def test_processing_archetype_also_triggers(self):
        code, _ = self._run("周期加工型", None)
        self.assertEqual(code, 1, "周期加工型同样是商品类，必须触发")

    def test_non_commodity_archetype_not_triggered(self):
        """银行、药企没有这条链，不该被要求画表——false-block 比 fail-open 更难发现。"""
        code, out = self._run("金融息差型", None)
        self.assertEqual(code, 0, f"非商品类原型不得被这条门拦住\n{out}")
        self.assertNotIn("外部环节表", out)

    # ── 取表逻辑的两个已知脆点 ────────────────────────────────────────
    def test_prose_mention_before_real_table_does_not_fool_extractor(self):
        """正文先随口提一句「外部环节表」，真表在后面——不能只取第一处。"""
        table = "本节先说明为什么需要外部环节表，再给表本身。\n\n" + GOOD_TABLE
        code, out = self._run("耗竭资源型", table)
        self.assertEqual(code, 0, f"anchor 首次出现在散文里时应继续往后找真表\n{out}")

    def test_single_hash_heading_does_not_swallow_later_tables(self):
        """截断用 #{1,6}：`#` 分节时不能把后文别的表一起数进来。"""
        table = GOOD_TABLE + "\n# 附录\n\n| 甲 | 乙 |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |\n"
        code, out = self._run("耗竭资源型", table)
        self.assertEqual(code, 0, f"后文无关表不该影响本条判定\n{out}")


class TestArchetypeListDoesNotDrift(unittest.TestCase):
    """check_thesis 里冗余的 15 原型白名单必须与 valuation_archetypes.md 一致。

    冗余是有意的（checker 可能在任意 cwd 下跑），但冗余就会漂移，所以钉一条。
    """

    def test_whitelist_matches_the_skill_file(self):
        import sys

        sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "tools"))
        import benchmark_lib
        import check_thesis

        path = (
            Path(__file__).resolve().parent.parent
            / ".claude/skills/equity-thesis-cn/valuation_archetypes.md"
        )
        parsed = benchmark_lib.parse_archetypes(path.read_text(encoding="utf-8"))
        self.assertEqual(
            list(check_thesis._ALL_ARCHETYPES),
            list(parsed.keys()),
            "check_thesis._ALL_ARCHETYPES 与 valuation_archetypes.md 的原型清单不一致",
        )

    def test_chain_archetypes_are_a_subset(self):
        import check_thesis

        for a in check_thesis._CHAIN_ARCHETYPES:
            self.assertIn(a, check_thesis._ALL_ARCHETYPES)


if __name__ == "__main__":
    unittest.main()
