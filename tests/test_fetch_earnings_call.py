import unittest
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "tools"))
import fetch_earnings_call as fec


class TestClassifyTitle(unittest.TestCase):
    def test_material_contract(self):
        """301557 的远景能源 9.49 亿元芯材协议只有标题进了报告，正文从未被抓取。"""
        self.assertEqual(fec.classify_title("常友科技:关于签署日常经营重大合同的公告"), "material_contract")

    def test_accounting_change(self):
        self.assertEqual(fec.classify_title("常友科技:关于会计政策变更的公告"), "accounting_change")

    def test_investment(self):
        self.assertEqual(fec.classify_title("常友科技:关于公司与专业投资机构共同投资的进展公告"), "investment")

    def test_lockup_release(self):
        self.assertEqual(fec.classify_title("常友科技:关于部分首次公开发行前已发行股份上市流通的提示性公告"),
                         "lockup_release")

    def test_pledge(self):
        """301557：2025-09-30、2025-12-30 两次控股股东方质押，此前只有标题进报告。"""
        self.assertEqual(fec.classify_title("常友科技:关于控股股东部分股份质押的公告"), "pledge")
        self.assertEqual(fec.classify_title("常友科技:关于控股股东一致行动人部分股份质押的公告"), "pledge")

    def test_existing_categories_still_match(self):
        self.assertEqual(fec.classify_title("常友科技:2026年5月14日投资者关系活动记录表"), "investor_relations")
        self.assertEqual(fec.classify_title("常友科技:关于举行2025年度业绩说明会的公告"), "earnings_call")

    def test_unrelated_and_excluded_titles(self):
        self.assertIsNone(fec.classify_title("常友科技:关于召开2026年第三次临时股东会的通知"))
        self.assertIsNone(fec.classify_title("某公司:关于签署重大合同的公告(英文版)"))


class TestIrmSupported(unittest.TestCase):
    def test_only_shenzhen_listed_stocks_have_cninfo_qa(self):
        """stock_irm_cninfo 只覆盖深交所互动易：000858 实测 390 条，沪市 600519 / 688981 实测 KeyError。"""
        self.assertTrue(fec.irm_supported("301557"))
        self.assertTrue(fec.irm_supported("000858"))
        self.assertFalse(fec.irm_supported("600519"))
        self.assertFalse(fec.irm_supported("688981"))


class TestIrmRecords(unittest.TestCase):
    def test_keeps_latest_answered_questions_with_core_fields(self):
        rows = [
            {"提问时间": "2026-06-16 14:53:13", "问题": "股东人数？", "回答内容": "定期报告披露", "提问者": "a"},
            {"提问时间": "2026-07-23 16:34:38", "问题": "基金进展？", "回答内容": "已实缴1502万元", "提问者": "b"},
            {"提问时间": "2026-08-01 09:00:00", "问题": "未回复的问题", "回答内容": None, "提问者": "c"},
        ]
        self.assertEqual(fec.irm_records(rows, limit=1), [
            {"提问时间": "2026-07-23 16:34:38", "问题": "基金进展？", "回答内容": "已实缴1502万元"},
        ])


if __name__ == "__main__":
    unittest.main()
