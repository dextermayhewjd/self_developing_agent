import json
import tempfile
import types
import unittest
from pathlib import Path
from unittest import mock
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


class TestExtractProductTermsFallbackToWholeChunk(unittest.TestCase):
    def test_keeps_whole_chunk_when_split_yields_nothing_usable(self):
        """Important 4 真实反例：品种词"铜加工材"被停用词"加工"切成"铜"/"材"，
        两个碎片都太短被过滤——但整段"铜加工材"本身就是合法品种词，不该被切丢。
        brief 原版（未加停用词二次切分之前）对这个输入给的就是 ['铜加工材']。"""
        text = "铜加工材、铝板带箔"
        self.assertEqual(discover_peers.extract_product_terms(text), ["铜加工材"])


class TestExtractProductTermsHintWords(unittest.TestCase):
    def test_high_end_equipment_is_not_a_product_term(self):
        """Minor 8 真实反例：提示字符类把"设备"拆成单字"备"，导致"高端装备"
        因为含"备"字被误判成品种词。"设备/电池/组件/器件"必须整词命中才算数。"""
        text = "公司主要从事高端装备的研发与销售。"
        self.assertEqual(discover_peers.extract_product_terms(text), [])


class TestNameMatchKeywordsDeterministic(unittest.TestCase):
    def test_same_term_yields_same_keywords_every_call(self):
        """Important 3：匹配词生成只依赖品种词自身字符，不依赖任何运行时状态
        （如当日名录命中数），同一个输入无论调用多少次都必须给出相同结果。"""
        first = discover_peers._name_match_keywords("碳化钨粉")
        second = discover_peers._name_match_keywords("碳化钨粉")
        self.assertEqual(first, second)
        self.assertEqual(first, ["碳化钨粉", "钨粉"])

    def test_short_term_has_no_separate_suffix(self):
        self.assertEqual(discover_peers._name_match_keywords("钨"), ["钨"])


# ----------------------------------------------------------------------------
# 下面几个测试要跑到 _channel1_name_match / _confirm_peer 里实际调用 akshare 的
# 代码路径，但测试本身不许联网。做法：往 sys.modules 注入一个假的 "akshare"
# 模块，只实现 discover_peers 用到的那一小撮 pandas/akshare API（纯 stdlib，
# 不需要真 pandas）。discover_peers 内部都是函数体内 `import akshare as ak`，
# 会直接拿到 sys.modules 里已经存在的这个假模块，不会碰真实网络。
# ----------------------------------------------------------------------------

class _FakeSeries:
    def __init__(self, values):
        self.values = list(values)

    class _StrAccessor:
        def __init__(self, values):
            self._values = values

        def contains(self, needle, regex=False, na=False):
            return _FakeSeries([(needle in v) if v is not None else na for v in self._values])

    @property
    def str(self):
        return _FakeSeries._StrAccessor(self.values)


class _FakeDataFrame:
    """极简 pandas.DataFrame 替身，只实现 discover_peers 用到的那部分 API：
    df["列名"]、df[布尔 mask]、len(df)、df.iterrows()。纯 stdlib。"""

    def __init__(self, rows):
        self.rows = list(rows)

    def __getitem__(self, key):
        if isinstance(key, str):
            return _FakeSeries([r.get(key) for r in self.rows])
        if isinstance(key, _FakeSeries):
            return _FakeDataFrame([r for r, m in zip(self.rows, key.values) if m])
        raise TypeError(f"unsupported key: {key!r}")

    def __len__(self):
        return len(self.rows)

    def iterrows(self):
        return iter(enumerate(self.rows))


class _FakeIloc:
    def __init__(self, rows):
        self._rows = rows

    def __getitem__(self, i):
        return self._rows[i]


class _FakeRow(dict):
    """行为像一行 pandas 数据：既能 .get()，也能 .to_dict()。"""
    def to_dict(self):
        return dict(self)


class _FakeZyjsFrame:
    def __init__(self, row_dict):
        self._rows = [_FakeRow(row_dict)]

    def __len__(self):
        return len(self._rows)

    @property
    def iloc(self):
        return _FakeIloc(self._rows)


def _fake_akshare(universe_rows=None, zyjs_texts=None):
    """构造一个假 akshare 模块：stock_info_a_code_name 返回 universe_rows，
    stock_zyjs_ths(symbol) 按 zyjs_texts（{code: 主营业务文本}）查表返回。"""
    fake = types.ModuleType("akshare")

    def stock_info_a_code_name():
        return _FakeDataFrame(universe_rows or [])

    def stock_zyjs_ths(symbol):
        text = (zyjs_texts or {}).get(symbol, "")
        return _FakeZyjsFrame({"主营业务": text, "产品类型": "", "产品名称": "", "经营范围": ""})

    fake.stock_info_a_code_name = stock_info_a_code_name
    fake.stock_zyjs_ths = stock_zyjs_ths
    return fake


class TestConfirmPeerRejectsNoise(unittest.TestCase):
    """Critical 1 的两个真实反例：评审实测品种词"碳化钨粉"曾靠单字前缀"碳"
    错误命中这两家跟钨完全无关的公司，被判 keep=True 并填了估值、进了中位数。"""

    def test_rejects_jilin_carbon_valley(self):
        fake_ak = _fake_akshare(zyjs_texts={
            "836077": "从事碳纤维原丝、碳纤维的研发、生产与销售，"
                      "主要产品为聚丙烯腈基碳纤维原丝。",
        })
        with mock.patch.dict(sys.modules, {"akshare": fake_ak}):
            keep, reason = discover_peers._confirm_peer("836077", ["碳化钨粉"])
        self.assertFalse(keep, f"836077 吉林碳谷不该被判 keep=True，reason={reason}")

    def test_rejects_fangda_carbon(self):
        fake_ak = _fake_akshare(zyjs_texts={
            "600516": "主要从事炭素制品的生产与销售，产品包括石墨电极、炭砖等。",
        })
        with mock.patch.dict(sys.modules, {"akshare": fake_ak}):
            keep, reason = discover_peers._confirm_peer("600516", ["碳化钨粉"])
        self.assertFalse(keep, f"600516 方大炭素不该被判 keep=True，reason={reason}")

    def test_still_confirms_real_match_via_prefix_and_tail_char(self):
        """收紧确认标准不等于把召回率清零：前缀（>=2 字）与品种词的材料提示
        尾字（这里是"粉"）同时命中真实钨制品公司的主营描述时，仍然确认通过——
        即使主营描述里没有逐字出现"碳化钨粉"这个完整品种词。"""
        fake_ak = _fake_akshare(zyjs_texts={
            "600549": "主要产品为碳化钨基硬质合金及钨粉、钼粉等硬质合金材料。",
        })
        with mock.patch.dict(sys.modules, {"akshare": fake_ak}):
            keep, reason = discover_peers._confirm_peer("600549", ["碳化钨粉"])
        self.assertTrue(keep, f"600549 应该通过前缀+尾字确认，reason={reason}")


class TestChannel1Deterministic(unittest.TestCase):
    def test_same_input_yields_same_candidates_every_call(self):
        """Important 3：同一个品种词、同一份名录，调用两次必须给出完全相同的
        候选集合——不能因为"当日命中数"落在某个区间就换一批候选。"""
        universe_rows = [
            {"code": "000657", "name": "中钨高新"},
            {"code": "002378", "name": "章源钨业"},
            {"code": "002842", "name": "翔鹭钨业"},
            {"code": "600397", "name": "江钨装备"},
            {"code": "600549", "name": "厦门钨业"},
            {"code": "688778", "name": "厦钨新能"},
            {"code": "000001", "name": "平安银行"},
        ]
        fake_ak = _fake_akshare(universe_rows=universe_rows)
        with mock.patch.dict(sys.modules, {"akshare": fake_ak}):
            first = discover_peers._channel1_name_match(["钨"], "600549")
            second = discover_peers._channel1_name_match(["钨"], "600549")
        self.assertEqual(first, second)
        candidates, matched_keywords = first
        codes = {c["code"] for c in candidates}
        self.assertEqual(codes, {"000657", "002378", "002842", "600397", "688778"})
        self.assertEqual(matched_keywords, ["钨"])


if __name__ == "__main__":
    unittest.main()
