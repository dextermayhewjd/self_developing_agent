import contextlib
import io
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "tools"))
import validate


def _agg(latest_q="20260630", top10_as_of="20260630"):
    return {
        "valuation": {"close": 83.0, "pe_ttm": 66.4, "pb": 5.02, "total_mcap_yuan": 5.1e9},
        "quote_latest": {"close": 83.0},
        "financials_annual": {
            "revenue": {"20231231": 8.7e8, "20241231": 1.05e9, "20251231": 1.18e9},
            "net_profit_attributable": {"20251231": 8.9e7},
            "gross_margin_pct": {"20251231": 21.9},
        },
        "financials_quarterly": {"revenue_single": {"20251231": 3.56e8, latest_q: 3.5e8}},
        "top10_free": [{"名次": 1}],
        "top10_free_as_of": top10_as_of,
        "research_reports": [{"报告名称": "x"}],
        "announcements_recent": [{"公告标题": "x"}],
        "business": {"主营业务": "x"},
    }


class TestFreshness(unittest.TestCase):
    def test_flags_quarter_series_older_than_raw_financial_abstract(self):
        """301557：原始层已有 20260630，汇总层止于 20251231，校验却 exit 0。"""
        issues = validate.freshness_issues(_agg("20251231", "20251231"),
                                           ["选项", "指标", "20260630", "20251231"])
        self.assertTrue(any("20251231" in i and "20260630" in i and "季度" in i for i in issues))

    def test_flags_top10_holders_older_than_latest_quarter(self):
        issues = validate.freshness_issues(_agg("20260630", "20251231"), ["20260630"])
        self.assertTrue(any("十大流通股东" in i and "20251231" in i for i in issues))

    def test_hk_slash_date_holders_are_not_misread_as_stale(self):
        """港股 00700 的 top10_free_as_of 是 CCASS 的 '2026/09/14'，按字符串比 '/' < '0' 会误报过期。"""
        issues = validate.freshness_issues(_agg("20260630", "2026/09/14"), [])
        self.assertFalse(any("十大流通股东" in i for i in issues))

    def test_flags_quote_date_behind_valuation_date(self):
        """301557 当天 value_em 已有 09-15 收盘 ¥80.82，新浪日线仍停在 09-14 ¥83.00，现价与 PE 对不上。"""
        agg = _agg()
        agg["quote_latest"] = {"close": 83.0, "date_close": "2026-09-14"}
        agg["valuation"]["as_of"] = "2026-09-15"
        issues = validate.freshness_issues(agg, [])
        self.assertTrue(any("2026-09-14" in i and "2026-09-15" in i for i in issues))

    def test_aligned_data_has_no_freshness_issue(self):
        self.assertEqual(validate.freshness_issues(_agg(), ["选项", "20260630", "20260331"]), [])

    def test_no_raw_financial_abstract_skips_raw_comparison(self):
        """港股管线没有 financial_abstract，不能因此误报。"""
        self.assertEqual(validate.freshness_issues(_agg(), []), [])


class TestCollectorErrors(unittest.TestCase):
    def test_fetch_errors_in_raw_files_become_warnings(self):
        raw = {"basic": {"errors": {"margin_detail": "ConnectionError: reset"}},
               "news": {"errors": {}}}
        self.assertEqual(validate.collector_error_issues(raw),
                         ["basic.margin_detail 取数失败：ConnectionError: reset"])


class TestMainExitCode(unittest.TestCase):
    def test_stale_quarter_series_exits_2_instead_of_0(self):
        with tempfile.TemporaryDirectory() as tmp:
            d = Path(tmp) / "301557"
            d.mkdir()
            (d / "aggregate.json").write_text(json.dumps(_agg("20251231", "20251231")))
            (d / "basic.json").write_text(json.dumps({"data": {"financial_abstract": [
                {"选项": "常用指标", "指标": "营业总收入", "20260630": 1.0, "20251231": 1.0}]}, "errors": {}}))
            out = io.StringIO()
            with mock.patch.object(validate, "DATA_ROOT", Path(tmp)), \
                    mock.patch.object(sys, "argv", ["validate.py", "301557"]), \
                    contextlib.redirect_stdout(out):
                with self.assertRaises(SystemExit) as cm:
                    validate.main()
        self.assertEqual(cm.exception.code, 2)
        self.assertIn("20260630", out.getvalue())


if __name__ == "__main__":
    unittest.main()
