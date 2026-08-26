import unittest
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "tools"))
import benchmark_lib

ARCHETYPES = Path(__file__).resolve().parent.parent / ".claude/skills/equity-thesis-cn/valuation_archetypes.md"

FIELDS = ["归属判据", "主估值方法", "失效指标", "必比口径", "必做分析", "排雷阈值变体", "典型悬空点"]


class TestParseArchetypes(unittest.TestCase):
    def setUp(self):
        self.parsed = benchmark_lib.parse_archetypes(ARCHETYPES.read_text(encoding="utf-8"))

    def test_has_fifteen_archetypes(self):
        self.assertEqual(len(self.parsed), 15, f"应为 15 个原型，实得 {len(self.parsed)}")

    def test_every_archetype_has_all_seven_fields(self):
        for name, body in self.parsed.items():
            for field in FIELDS:
                self.assertIn(field, body, f"原型「{name}」缺字段：{field}")
                self.assertTrue(body[field], f"原型「{name}」的「{field}」为空")

    def test_list_fields_are_lists(self):
        for name, body in self.parsed.items():
            self.assertIsInstance(body["必比口径"], list, f"原型「{name}」的必比口径应为列表")
            self.assertGreaterEqual(len(body["必比口径"]), 1, f"原型「{name}」必比口径至少一条")

    def test_depleting_resource_archetype_content(self):
        """03858 归入的那一类，必比口径必须包含板块 P/NAV 中位数——这是本方案的起因。"""
        a = self.parsed["耗竭资源型"]
        self.assertEqual(a["index"], 1)
        joined = " ".join(a["必比口径"])
        self.assertIn("P/NAV", joined)
        self.assertIn("成本曲线", joined)


if __name__ == "__main__":
    unittest.main()
