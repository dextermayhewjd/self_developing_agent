import re
import unittest
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "tools"))
import benchmark_lib

ARCHETYPES = Path(__file__).resolve().parent.parent / ".claude/skills/equity-thesis-cn/valuation_archetypes.md"

FIELDS = ["归属判据", "主估值方法", "失效指标", "必比口径", "必做分析", "排雷阈值变体", "典型悬空点"]

# 下游 schema（equity-thesis.mjs 的 archetype enum）拿这份清单当枚举，改一个字就断，
# 所以名称与序号在这里逐字钉死，不是靠数量 15 来兜。
EXPECTED_ARCHETYPES = {
    "耗竭资源型": 1,
    "周期加工型": 2,
    "稳态现金流型": 3,
    "成长渗透型": 4,
    "研发管线型": 5,
    "平台网络型": 6,
    "项目制工程型": 7,
    "金融息差型": 8,
    "金融承保型": 9,
    "金融资本型": 10,
    "重资产公用型": 11,
    "地产存货型": 12,
    "持有型不动产": 13,
    "渠道分销型": 14,
    "亏损未验证型": 15,
}


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

    def test_no_extra_fields(self):
        """恰好七字段，多一个都不行——解析器有静默污染路径：列表项漏写 `-` 且形如
        `词：…` 时会被当成新字段（benchmark_lib.py 的 kv 分支），只断言「七字段非空」
        抓不到它，因为七个字段仍在，只是少了一个列表项、多了一个野键。"""
        allowed = {"index", *FIELDS}
        for name, body in self.parsed.items():
            extra = sorted(set(body) - allowed)
            self.assertEqual(
                extra, [], f"原型「{name}」多出字段 {extra}——多半是列表项漏写 `- ` 或续行以「词：」开头"
            )

    def test_names_and_indexes_are_exactly_the_canonical_list(self):
        """15 个原型名与序号必须与清单全等（顺序无关，映射必须一一对上）。"""
        self.assertEqual(
            {name: body["index"] for name, body in self.parsed.items()},
            EXPECTED_ARCHETYPES,
            "原型名或序号与清单不符：名称须逐字一致（含「型」字），序号须为 1–15 且一一对应",
        )

    def test_depleting_resource_archetype_content(self):
        """03858 归入的那一类，必比口径必须包含板块 P/NAV 中位数——这是本方案的起因。"""
        a = self.parsed["耗竭资源型"]
        self.assertEqual(a["index"], 1)
        joined = " ".join(a["必比口径"])
        self.assertIn("P/NAV", joined)
        self.assertIn("成本曲线", joined)

    def test_no_orphan_lines_in_archetype_bodies(self):
        """孤行（既不是「字段：值」、也不是「- 」列表项、也不是空行的散文续行）会被
        benchmark_lib.parse_archetypes 的续行分支静默并入上一个非列表字段的值——不产生
        新键，所以 test_no_extra_fields 抓不到。这里直接扫原始文本，逐行分类。"""
        text = ARCHETYPES.read_text(encoding="utf-8")
        marks = list(benchmark_lib._ARCHETYPE_RE.finditer(text))
        offset = 0
        for i, m in enumerate(marks):
            start = m.end()
            end = marks[i + 1].start() if i + 1 < len(marks) else len(text)
            body = text[start:end]
            offset = start
            for raw in body.splitlines(keepends=True):
                line = raw.rstrip("\n").rstrip()
                if line.strip():
                    s = line.lstrip()
                    if not s.startswith("-") and not re.match(r"^\S+?[：:]", s):
                        lineno = text.count("\n", 0, offset) + 1
                        self.fail(
                            f"原型「{m.group(2)}」第 {lineno} 行是孤行"
                            f"（既非「字段：值」也非「- 」列表项，会被静默并入上一字段）：{line!r}"
                        )
                offset += len(raw)


if __name__ == "__main__":
    unittest.main()
