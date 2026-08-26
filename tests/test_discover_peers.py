import json
import tempfile
import unittest
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "tools"))
import discover_peers


class TestExtractProductTerms(unittest.TestCase):
    def test_extracts_from_business_description(self):
        text = "本公司主要从事钨精矿的开采、加工及销售，产品为 65% WO3 白钨精矿。"
        terms = discover_peers.extract_product_terms(text)
        self.assertIn("钨精矿", terms)

    def test_drops_generic_words(self):
        """'销售''业务''公司'这类词不是品种，混进去会把检索面撑爆。"""
        text = "公司主要业务为销售。"
        self.assertEqual(discover_peers.extract_product_terms(text), [])

    def test_returns_at_most_five_terms(self):
        text = "钨精矿、仲钨酸铵、碳化钨粉、硬质合金、钨条、钨丝、钨粉、三氧化钨"
        self.assertLessEqual(len(discover_peers.extract_product_terms(text)), 5)


class TestMedianMultiples(unittest.TestCase):
    def test_median_of_four(self):
        rows = [
            {"PE_TTM": 23.49, "PB": 4.45, "PS": 1.34},
            {"PE_TTM": 51.72, "PB": 12.89, "PS": 5.56},
            {"PE_TTM": 34.74, "PB": 10.39, "PS": 3.47},
            {"PE_TTM": 31.72, "PB": 8.38, "PS": 3.98},
        ]
        m = discover_peers.median_multiples(rows)
        self.assertAlmostEqual(m["PE_TTM"], 33.23, places=2)
        self.assertAlmostEqual(m["PB"], 9.385, places=3)

    def test_skips_none_and_zero(self):
        rows = [{"PE_TTM": None, "PB": 0, "PS": 2.0}, {"PE_TTM": 10.0, "PB": 5.0, "PS": 4.0}]
        m = discover_peers.median_multiples(rows)
        self.assertEqual(m["PE_TTM"], 10.0)
        self.assertEqual(m["PB"], 5.0)

    def test_all_missing_gives_none(self):
        self.assertIsNone(discover_peers.median_multiples([{"PE_TTM": None, "PB": None, "PS": None}])["PE_TTM"])


class TestCacheBehaviour(unittest.TestCase):
    def test_manual_entries_survive_regeneration(self):
        """人工加的同业不许被重跑覆盖——这是方案里唯一保留的人工入口。"""
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp) / "peers_curated.json"
            p.write_text(json.dumps({
                "生成日期": "2026-08-01", "品种词": ["钨精矿"], "通道": "①",
                "peers": [{"code": "ALM", "market": "US", "name": "Almonty",
                           "keep": True, "reason": "人工补", "manual": True}],
                "中位数": {},
            }, ensure_ascii=False), encoding="utf-8")
            merged = discover_peers.merge_preserving_manual(
                p, [{"code": "600549", "market": "CN", "name": "厦门钨业",
                     "keep": True, "reason": "同品种", "manual": False}])
            codes = {r["code"] for r in merged}
            self.assertIn("ALM", codes, "人工条目被覆盖了")
            self.assertIn("600549", codes)


if __name__ == "__main__":
    unittest.main()
