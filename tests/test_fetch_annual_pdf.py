import unittest
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "tools"))
import fetch_annual_pdf as fap


def _ann(title, atype, date, art):
    return {"公告标题": title, "公告类型": atype, "公告日期": date,
            "网址": f"https://data.eastmoney.com/notices/detail/301557/{art}.html"}


class TestPickLatestSemiannual(unittest.TestCase):
    def test_picks_newest_full_semiannual_report_not_summary(self):
        anns = [
            _ann("常友科技:2026年半年度报告摘要", "半年度报告摘要", "2026-08-28", "AN1"),
            _ann("常友科技:2026年半年度报告", "半年度报告全文", "2026-08-28", "AN2"),
            _ann("常友科技:2025年半年度报告", "半年度报告全文", "2025-08-20", "AN3"),
            _ann("常友科技:2025年年度报告", "年度报告全文", "2026-04-28", "AN4"),
        ]
        rec = fap.pick_latest_semiannual(anns)
        self.assertEqual((rec[0], rec[4]), ("2026-08-28", "2026"))
        self.assertIn("AN2", rec[3])

    def test_title_fallback_when_type_missing(self):
        anns = [_ann("某公司:2026年半年度报告", "其他", "2026-08-20", "AN9")]
        self.assertIn("AN9", fap.pick_latest_semiannual(anns)[3])

    def test_none_when_absent(self):
        self.assertIsNone(fap.pick_latest_semiannual([_ann("某公司:2025年年度报告", "年度报告全文", "2026-04-01", "AN5")]))


class TestLocateSections(unittest.TestCase):
    def test_semiannual_product_table_is_found_as_business_segments(self):
        """半年报的分产品表标题是「分产品或服务」，原关键词表一个都命中不了。"""
        text = "前文" * 300 + "分产品或服务\n风电机组罩体 273,009,448.27 219,815,224.50 19.48% 0.55%"
        hits = fap.locate_sections(text)["business_segments"]
        self.assertTrue(any("风电机组罩体" in h["excerpt"] for h in hits))

    def test_pay_table_found_when_pdf_splits_header_across_page_break(self):
        """301557 年报 PDF：表头「从公司获得的税前」与「报酬总额」被页眉隔开，整词关键词只命中表后说明文字。"""
        text = ("前文" * 300 + "姓名 性别 年龄 职务 任职状态 从公司获得的税前 是否在公司关联方获取报酬\n39\n"
                "常友科技集团股份有限公司2025年年度报告全文\n报酬总额\n刘文叶 男 49 董事长、总经理 现任 154.45 否")
        hits = fap.locate_sections(text)["management_pay"]
        self.assertTrue(any("154.45" in h["excerpt"] for h in hits))

    def test_liquor_template_sales_table_is_found_as_business_segments(self):
        """600519 半年报用酒类行业模板，分产品表标题是「按产品档次」，没有「分产品」字样。"""
        text = ("前文" * 300 + "3、 销售情况\n单位：万元 币种：人民币\n按产品档次 按销售渠道 按地区\n项目\n"
                "茅台酒 系列酒 直销\n7,772,443.79 1,293,418.65")
        hits = fap.locate_sections(text)["business_segments"]
        self.assertTrue(any("7,772,443.79" in h["excerpt"] for h in hits))

    def test_management_pay_section_is_located(self):
        text = "前文" * 300 + "姓名 职务 从公司获得的税前报酬总额 是否在公司关联方获取报酬\n刘文叶 董事长 120.5"
        hits = fap.locate_sections(text)["management_pay"]
        self.assertTrue(any("刘文叶" in h["excerpt"] for h in hits))


if __name__ == "__main__":
    unittest.main()
