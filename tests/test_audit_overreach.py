import unittest
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "tools"))
import audit_overreach


class TestDetectSelfLookup(unittest.TestCase):
    def test_flags_websearch_on_own_financials(self):
        t = 'WebSearch(query="佳鑫国际资源投资 2025 净利润")'
        hits = audit_overreach.detect_self_lookup(t, "03858", "佳鑫国际资源投资")
        self.assertTrue(hits)

    def test_flags_symbol_plus_financial_field(self):
        t = 'WebSearch(query="03858 毛利率")'
        self.assertTrue(audit_overreach.detect_self_lookup(t, "03858", "佳鑫国际资源投资"))

    def test_allows_peer_lookup(self):
        """查同业是这个 agent 的本职，不能误报。"""
        t = 'WebSearch(query="Almonty Industries P/NAV")'
        self.assertEqual(audit_overreach.detect_self_lookup(t, "03858", "佳鑫国际资源投资"), [])

    def test_allows_company_name_without_financial_field(self):
        """提到公司名但不是在查它的财务数——例如查行业格局时顺带提及。"""
        t = 'WebSearch(query="全球钨矿产能格局 佳鑫国际资源投资 巴库塔")'
        self.assertEqual(audit_overreach.detect_self_lookup(t, "03858", "佳鑫国际资源投资"), [])


if __name__ == "__main__":
    unittest.main()
