import json
import math
import tempfile
import unittest
from datetime import date
from pathlib import Path
from unittest import mock
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "tools"))
import lib
import run_pipeline


# 301557 实跑时 stock_financial_abstract 的真实列形状：两列非日期 + 报告期倒序，季度不连续
FA_COLUMNS = ["选项", "指标", "20260630", "20260331", "20251231", "20250930", "20250630",
              "20250331", "20241231", "20240930", "20240630", "20240331", "20231231",
              "20230331", "20221231", "20220630", "20211231", "20201231", "20191231"]


class TestPeriodColumns(unittest.TestCase):
    def test_quarter_columns_end_at_latest_reported_period(self):
        """2026-09 跑数时季度窗口曾硬编码为 [当年-2, 当年-1]，26Q1/26Q2 被整段丢弃。"""
        cols = run_pipeline.pick_quarter_columns(FA_COLUMNS, n=8)
        self.assertEqual(cols, ["20240930", "20241231", "20250331", "20250630",
                                "20250930", "20251231", "20260331", "20260630"])

    def test_year_end_columns_are_latest_five_reported_years(self):
        cols = run_pipeline.pick_year_end_columns(FA_COLUMNS, n=5)
        self.assertEqual(cols, ["20211231", "20221231", "20231231", "20241231", "20251231"])

    def test_single_quarter_uses_prior_cumulative_outside_window(self):
        """窗口第一季是 Q3 时，需要窗口外的 Q2 累计值做差分，不能记成 None。"""
        cum = {"20240630": 446.0, "20240930": 712.0, "20241231": 1050.0}
        out = run_pipeline.single_quarter(cum, ["20240930", "20241231"])
        self.assertEqual(out, {"20240930": 266.0, "20241231": 338.0})

    def test_single_quarter_keeps_q1_as_is_and_none_when_prior_missing(self):
        cum = {"20250331": 200.0, "20250930": 822.0}
        out = run_pipeline.single_quarter(cum, ["20250331", "20250930"])
        self.assertEqual(out, {"20250331": 200.0, "20250930": None})


class TestDateWindows(unittest.TestCase):
    def test_recent_quarter_ends_are_derived_from_today(self):
        """十大股东季末曾硬编码为 20251231…20250331，2026-06-30 名单永远取不到。"""
        self.assertEqual(run_pipeline.recent_quarter_ends(date(2026, 9, 15), n=6),
                         ["20260630", "20260331", "20251231", "20250930", "20250630", "20250331"])

    def test_recent_quarter_ends_include_today_when_today_is_quarter_end(self):
        self.assertEqual(run_pipeline.recent_quarter_ends(date(2026, 6, 30), n=2),
                         ["20260630", "20260331"])

    def test_announcement_window_starts_january_first_of_previous_year(self):
        """公告曾只抓当年 1 月 1 日起，上一年下半年的事件（含股价大幅波动期）全部缺失。"""
        self.assertEqual(run_pipeline.announcement_window_start(date(2026, 9, 15)), "20250101")


class TestBenchmarkIndex(unittest.TestCase):
    def test_chinext_stock_benchmarks_against_chinext_index(self):
        self.assertEqual(run_pipeline.benchmark_index_for("301557"), ("sz399006", "创业板指"))

    def test_star_market_stock_benchmarks_against_star50(self):
        self.assertEqual(run_pipeline.benchmark_index_for("688981"), ("sh000688", "科创50"))

    def test_main_board_stocks_benchmark_against_csi300(self):
        self.assertEqual(run_pipeline.benchmark_index_for("600519"), ("sh000300", "沪深300"))
        self.assertEqual(run_pipeline.benchmark_index_for("000001"), ("sh000300", "沪深300"))

    def test_bse_stock_benchmarks_against_bse50(self):
        self.assertEqual(run_pipeline.benchmark_index_for("830799"), ("bj899050", "北证50"))

    def test_benchmark_closes_keeps_last_n_days_as_date_to_close(self):
        """sina 返回的 date 是 datetime.date，落 JSON 前要转成字符串。"""
        rows = [{"date": date(2026, 9, d), "close": 3000.0 + d} for d in (10, 11, 14)]
        self.assertEqual(run_pipeline.benchmark_closes(rows, n=2),
                         {"2026-09-11": 3011.0, "2026-09-14": 3014.0})


class TestMarginAndLhb(unittest.TestCase):
    def test_margin_records_map_datacenter_fields(self):
        payload = {"result": {"data": [{
            "DATE": "2026-09-14 00:00:00", "RZYE": 173243061, "RZMRE": 11710979,
            "RZCHE": 4386279, "RQYL": 2940, "RZRQYE": 173487081, "RZYEZB": 8.39237556,
        }]}}
        self.assertEqual(run_pipeline.margin_records(payload), [{
            "日期": "2026-09-14", "融资余额": 173243061, "融资买入额": 11710979,
            "融资偿还额": 4386279, "融券余量": 2940, "融资融券余额": 173487081,
            "融资余额占流通市值比": 8.39237556,
        }])

    def test_margin_records_empty_when_stock_not_margin_eligible(self):
        """非两融标的：接口正常返回但 result 为 null，是事实不是故障。"""
        self.assertEqual(run_pipeline.margin_records({"result": None, "message": "ok"}), [])

    def test_rows_for_symbol_filters_market_wide_table(self):
        rows = [{"代码": "301557", "上榜日": "2025-03-04"}, {"代码": "600519", "上榜日": "2025-03-04"}]
        self.assertEqual(run_pipeline.rows_for_symbol(rows, "301557"),
                         [{"代码": "301557", "上榜日": "2025-03-04"}])


class TestConsensusEps(unittest.TestCase):
    def test_covered_report_without_any_forecast_has_no_eps(self):
        """301557：唯一研报是新股覆盖，EPS 全是 NaN——有覆盖但算不出共识区间。"""
        rows = [{"报告名称": "新股覆盖研究", "2026-盈利预测-收益": math.nan,
                 "2027-盈利预测-收益": math.nan, "2026-盈利预测-市盈率": math.nan}]
        self.assertFalse(run_pipeline.has_eps_forecast(rows))

    def test_any_numeric_forecast_counts(self):
        rows = [{"2026-盈利预测-收益": math.nan}, {"2026-盈利预测-收益": 1.23}]
        self.assertTrue(run_pipeline.has_eps_forecast(rows))


class TestAggregate(unittest.TestCase):
    def _write(self, d, name, data):
        (d / f"{name}.json").write_text(json.dumps({"data": data, "errors": {}}, ensure_ascii=False))

    def test_aggregate_carries_current_year_quarters_and_new_fields(self):
        with tempfile.TemporaryDirectory() as tmp:
            with mock.patch.object(lib, "DATA_DIR", Path(tmp)):
                d = lib.symbol_dir("301557")
                rev = {"20260630": 553.0, "20260331": 203.0, "20251231": 1178.0, "20250930": 822.0,
                       "20250630": 496.0, "20250331": 200.0, "20241231": 1050.0, "20240930": 712.0,
                       "20240630": 446.0, "20240331": 166.0, "20231231": 871.0, "20221231": 739.0,
                       "20211231": 619.0, "20201231": 857.0}
                self._write(d, "basic", {
                    "financial_abstract": [{"选项": "常用指标", "指标": "营业总收入", **rev}],
                    "margin_detail": [{"日期": "2026-09-14", "融资余额": 173243061}],
                    "lhb_detail": [{"代码": "301557", "上榜日": "2025-03-04"}],
                    "benchmark_index": {"code": "sz399006", "name": "创业板指", "closes": {"2026-09-14": 3285.6}},
                })
                self._write(d, "governance", {
                    "restricted_release": [{"解禁时间": "2028-03-06", "解禁数量": 37160042.0}],
                    "consensus_eps_available": False,
                })
                self._write(d, "news", {})
                path = run_pipeline.aggregate("301557")
                agg = json.loads(path.read_text())

        rs = agg["financials_quarterly"]["revenue_single"]
        self.assertEqual(max(rs), "20260630")
        self.assertEqual(rs["20260630"], 350.0)
        self.assertEqual(list(agg["financials_annual"]["revenue"]),
                         ["20211231", "20221231", "20231231", "20241231", "20251231"])
        self.assertEqual(agg["margin_recent"][0]["融资余额"], 173243061)
        self.assertEqual(agg["lhb_recent"][0]["上榜日"], "2025-03-04")
        self.assertEqual(agg["restricted_release"][0]["解禁时间"], "2028-03-06")
        self.assertEqual(agg["benchmark_index"]["code"], "sz399006")
        self.assertIs(agg["consensus_eps_available"], False)


if __name__ == "__main__":
    unittest.main()
