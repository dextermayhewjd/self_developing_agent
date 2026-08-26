import contextlib
import io
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
# Ruling T3-8：_hint_for_peer 现在是纯函数（text, terms） -> (matched, hint)，
# 不再自己调用 akshare 抓主营文本（那一步挪到了 main() 里，由调用方传文本进来）。
# 所以这里不需要任何 akshare mock，直接传字符串测试就够了。
# ----------------------------------------------------------------------------

class TestHintForPeer(unittest.TestCase):
    """Ruling T3-8：_hint_for_peer 只产出"仅供参考"的 hint，这里测的是 hint 本身
    的字符串行为——这个行为不再等价于"是否同品种"的最终判断（那是 agent 的事）。"""

    def test_rejects_jilin_carbon_valley_hint(self):
        """Critical 1 的历史反例：品种词"碳化钨粉"曾靠单字前缀"碳"错误命中这家
        碳纤维公司。现在即使 hint 命中了也不代表 keep=True（见
        TestBuildCandidateRowKeepIsAlwaysNone），但这里先确认 hint 本身依然
        正确判断"不像"——两个证据（前缀+材料尾字）缺一都不该命中。"""
        text = "从事碳纤维原丝、碳纤维的研发、生产与销售，主要产品为聚丙烯腈基碳纤维原丝。"
        matched, hint = discover_peers._hint_for_peer(text, ["碳化钨粉"])
        self.assertFalse(matched, f"吉林碳谷的 hint 不该命中，hint={hint}")

    def test_rejects_fangda_carbon_hint(self):
        text = "主要从事炭素制品的生产与销售，产品包括石墨电极、炭砖等。"
        matched, hint = discover_peers._hint_for_peer(text, ["碳化钨粉"])
        self.assertFalse(matched, f"方大炭素的 hint 不该命中，hint={hint}")

    def test_still_matches_real_tungsten_text_via_prefix_and_tail_char(self):
        """hint 逻辑本身没有被削弱到失去信号价值：前缀+材料尾字同现时依然命中，
        只是命中结果现在只是 hint，不再是 keep 的决定。"""
        text = "主要产品为碳化钨基硬质合金及钨粉、钼粉等硬质合金材料。"
        matched, hint = discover_peers._hint_for_peer(text, ["碳化钨粉"])
        self.assertTrue(matched, f"600549 类文本应该命中 hint，hint={hint}")

    def test_two_char_term_can_match_via_split_chars(self):
        """round 2 Important 2 修的 2 字词空区间问题：hint 逻辑本身依然保留，
        只是不再直接等于 keep。"""
        text = ("钨钼、稀土和能源新材料三大核心业务，产品包括硬质合金棒材等，"
                "许可项目含非煤矿山矿产资源开采。")
        matched, hint = discover_peers._hint_for_peer(text, ["钨矿"])
        self.assertTrue(matched, f"应该通过 2 字品种词「钨矿」的 hint 匹配，hint={hint}")

    def test_lamp_company_hint_can_match_but_is_not_the_final_word(self):
        """round 3 复审的真实反例之一：灯具企业主营含"钨丝灯泡"，经营范围罗列
        里含"矿产资源勘查"这类通用许可条目——"钨"和"矿"两个字都在，hint 会命中，
        但这正是 Ruling T3-8 要处理的问题：hint 命中不代表这家公司真的产钨矿。
        这条测试只确认 hint 行为本身（会命中）；"keep 绝不因此变 True"由
        TestBuildCandidateRowKeepIsAlwaysNone 断言。"""
        text = ("主要从事照明灯具的研发、生产和销售，产品包括钨丝灯泡、LED 灯具等。"
                "经营范围含矿产资源勘查、矿业信息咨询等。")
        matched, hint = discover_peers._hint_for_peer(text, ["钨矿"])
        self.assertTrue(matched, f"灯具厂的 hint 预期会命中（这正是问题所在），hint={hint}")

    def test_real_estate_company_hint_can_match_but_is_not_the_final_word(self):
        """round 3 复审的真实反例之二：地产公司有"矿泉水"业务 + "钨金"仿真首饰，
        同样会让 hint 命中，同样不该被当作确认。"""
        text = "主要从事房地产开发与销售，兼营矿泉水生产及仿真首饰（含钨金材质）。"
        matched, hint = discover_peers._hint_for_peer(text, ["钨矿"])
        self.assertTrue(matched, f"地产公司的 hint 预期会命中（这正是问题所在），hint={hint}")

    def test_rejects_unrelated_restaurant_company(self):
        text = "从事餐饮服务与连锁经营，主要产品为快餐及饮品。"
        matched, hint = discover_peers._hint_for_peer(text, ["钨矿"])
        self.assertFalse(matched, f"不相关的餐饮公司不该命中 hint，hint={hint}")


class TestBuildCandidateRowKeepIsAlwaysNone(unittest.TestCase):
    """Ruling T3-8 的核心断言：候选阶段产出的每一行，keep 恒为 None——**哪怕
    hint 命中**。这是复审要求"固化成测试"的两个真实反例（灯具厂、地产公司）
    真正被钉住的地方：字符串 hint 可以命中，但绝不能单独把 keep 置 True。"""

    def test_lamp_company_keep_stays_none_despite_matching_hint(self):
        base = {"code": "111111", "market": "CN", "name": "某灯具股份"}
        text = ("主要从事照明灯具的研发、生产和销售，产品包括钨丝灯泡、LED 灯具等。"
                "经营范围含矿产资源勘查、矿业信息咨询等。")
        row = discover_peers._build_candidate_row(base, text, ["钨矿"])
        self.assertTrue(row["hint"].startswith("主营含"), f"hint 应该命中，实际：{row['hint']}")
        self.assertIsNone(row["keep"], "灯具厂的 keep 必须是 None，即使 hint 命中")

    def test_real_estate_company_keep_stays_none_despite_matching_hint(self):
        base = {"code": "222222", "market": "CN", "name": "某地产股份"}
        text = "主要从事房地产开发与销售，兼营矿泉水生产及仿真首饰（含钨金材质）。"
        row = discover_peers._build_candidate_row(base, text, ["钨矿"])
        self.assertTrue(row["hint"].startswith("主营含"), f"hint 应该命中，实际：{row['hint']}")
        self.assertIsNone(row["keep"], "地产公司的 keep 必须是 None，即使 hint 命中")

    def test_real_tungsten_company_keep_also_stays_none(self):
        """就算是真正的钨业公司，候选阶段也一样是 None——决定权完全不在这一层。"""
        base = {"code": "000657", "market": "CN", "name": "中钨高新"}
        text = "钨钼、稀土和能源新材料三大核心业务。"
        row = discover_peers._build_candidate_row(base, text, ["钨"])
        self.assertIsNone(row["keep"])

    def test_non_matching_candidate_keep_also_stays_none(self):
        """hint 不命中的候选，keep 同样是 None，不是 False——候选阶段不下判断，
        False 只在确认阶段"存在但未被选中"时才出现。"""
        base = {"code": "999999", "market": "CN", "name": "某餐饮股份"}
        text = "从事餐饮服务与连锁经营，主要产品为快餐及饮品。"
        row = discover_peers._build_candidate_row(base, text, ["钨矿"])
        self.assertFalse(row["hint"].startswith("主营含"))
        self.assertIsNone(row["keep"])


# ----------------------------------------------------------------------------
# 下面几个测试要跑到 _channel1_name_match / main() 里实际调用 akshare 的
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


class TestCandidatePhaseNeverSetsKeepTrue(unittest.TestCase):
    """Ruling T3-8 端到端版本：跑完整的 main() 候选阶段（通道①0 命中降级到
    通道②，通道②返回灯具厂/地产公司作为"行业近邻"候选），确认写进产物的每一行
    keep 都是 null——即使其中两条的 hint 明显命中。"""

    def test_full_candidate_flow_keeps_null_even_for_high_hint_matches(self):
        empty_universe = _FakeDataFrame([])  # 通道①：官方名录里搜不到"钨矿"这种整词
        compare_rows = _FakeDataFrame([
            {"代码": "111111", "简称": "某灯具股份"},
            {"代码": "222222", "简称": "某地产股份"},
        ])
        zyjs_texts = {
            "111111": "主要从事照明灯具的研发、生产和销售，产品包括钨丝灯泡、LED 灯具等。"
                      "经营范围含矿产资源勘查、矿业信息咨询等。",
            "222222": "主要从事房地产开发与销售，兼营矿泉水生产及仿真首饰（含钨金材质）。",
        }
        fake_ak = types.ModuleType("akshare")
        fake_ak.stock_info_a_code_name = lambda: empty_universe
        fake_ak.stock_zh_valuation_comparison_em = lambda symbol: compare_rows
        fake_ak.stock_zyjs_ths = lambda symbol: _FakeZyjsFrame({
            "主营业务": zyjs_texts.get(symbol, ""), "产品类型": "", "产品名称": "", "经营范围": "",
        })

        with tempfile.TemporaryDirectory() as tmp:
            argv = ["discover_peers.py", "600549", "--root", tmp, "--force", "--terms", "钨矿"]
            with mock.patch.dict(sys.modules, {"akshare": fake_ak}), \
                 mock.patch.object(sys, "argv", argv):
                with self.assertRaises(SystemExit) as ctx:
                    discover_peers.main()
            self.assertEqual(ctx.exception.code, 0)
            out = json.loads((Path(tmp) / "600549" / "peers_curated.json").read_text(encoding="utf-8"))

        self.assertEqual(out.get("状态"), "候选待确认")
        by_code = {r["code"]: r for r in out["peers"]}
        self.assertIn("111111", by_code, "灯具厂应该作为候选出现——候选阶段不过滤，只展示")
        self.assertIn("222222", by_code, "地产公司应该作为候选出现")
        self.assertTrue(by_code["111111"]["hint"].startswith("主营含"),
                         "灯具厂的 hint 应该命中（这正是复审反例的关键）")
        for row in out["peers"]:
            self.assertIsNone(row["keep"], f"{row['code']} 的候选阶段 keep 必须是 null，实际是 {row['keep']!r}")


class TestConfirmPhase(unittest.TestCase):
    """Ruling T3-8 的确认阶段：--confirm 是 keep=True 的唯一来源（manual 除外）。"""

    def test_empty_confirm_list_exits_1(self):
        with tempfile.TemporaryDirectory() as tmp:
            argv = ["discover_peers.py", "600549", "--root", tmp, "--confirm", ""]
            with mock.patch.object(sys, "argv", argv):
                with self.assertRaises(SystemExit) as ctx:
                    discover_peers.main()
        self.assertEqual(ctx.exception.code, 1, "确认清单为空且无 manual 条目时必须 exit(1)")

    def test_confirmed_codes_get_keep_true_others_get_keep_false(self):
        with tempfile.TemporaryDirectory() as tmp:
            symbol_dir = Path(tmp) / "600549"
            symbol_dir.mkdir(parents=True)
            cache_path = symbol_dir / "peers_curated.json"
            cache_path.write_text(json.dumps({
                "状态": "候选待确认", "生成日期": "2026-08-01", "品种词": ["钨"], "通道": "①",
                "peers": [
                    {"code": "000657", "market": "CN", "name": "中钨高新",
                     "主营节选": "钨钼、稀土……", "hint": "主营含「钨」", "keep": None,
                     "reason": "候选，待 agent 用 --confirm 确认", "manual": False},
                    {"code": "600397", "market": "CN", "name": "江钨装备",
                     "主营节选": "钨矿装备……", "hint": "", "keep": None,
                     "reason": "候选，待 agent 用 --confirm 确认", "manual": False},
                ],
                "中位数": {"PE_TTM": None, "PB": None, "PS": None},
            }, ensure_ascii=False), encoding="utf-8")

            fake_ak = types.ModuleType("akshare")
            fake_ak.stock_value_em = lambda symbol: _FakeZyjsFrame({
                "PE(TTM)": 51.72, "市净率": 12.89, "市销率": 5.56, "数据日期": "2026-08-26",
            })

            argv = ["discover_peers.py", "600549", "--root", tmp, "--confirm", "000657"]
            with mock.patch.dict(sys.modules, {"akshare": fake_ak}), \
                 mock.patch.object(sys, "argv", argv):
                with self.assertRaises(SystemExit) as ctx:
                    discover_peers.main()
            self.assertEqual(ctx.exception.code, 0)

            out = json.loads(cache_path.read_text(encoding="utf-8"))
            by_code = {r["code"]: r for r in out["peers"]}
            self.assertTrue(by_code["000657"]["keep"], "确认清单里的代码必须 keep=True")
            self.assertFalse(by_code["600397"]["keep"], "没被确认的候选必须 keep=False，不能凭空消失")
            self.assertEqual(by_code["600397"]["reason"], "候选存在但未在确认清单里")
            self.assertEqual(out["中位数"]["PE_TTM"], 51.72)
            self.assertEqual(out.get("状态"), "已确认")

    def test_manual_entry_keep_unaffected_by_confirm_flow(self):
        """manual: true 的行不受确认流程影响——即使 --confirm 清单为空，
        manual 条目本身若 keep=True 依然应该让整体产出成功（不是 exit 1）。"""
        with tempfile.TemporaryDirectory() as tmp:
            symbol_dir = Path(tmp) / "600549"
            symbol_dir.mkdir(parents=True)
            cache_path = symbol_dir / "peers_curated.json"
            cache_path.write_text(json.dumps({
                "生成日期": "2026-08-01", "品种词": ["钨"], "通道": "①",
                "peers": [{"code": "ALM", "market": "US", "name": "Almonty",
                           "keep": True, "reason": "人工补", "manual": True}],
                "中位数": {},
            }, ensure_ascii=False), encoding="utf-8")

            argv = ["discover_peers.py", "600549", "--root", tmp, "--confirm", ""]
            with mock.patch.object(sys, "argv", argv):
                with self.assertRaises(SystemExit) as ctx:
                    discover_peers.main()
            # Almonty 是非 A 股，_fill_valuation 不会被调用（manual 行本来就该
            # 已有估值或明确标注缺失），中位数三项皆空，属于"有确认同业但估值缺失"
            self.assertEqual(ctx.exception.code, 2,
                              "manual 条目单独存在时，keep_rows 非空但可能无估值，应为 exit(2)")

            out = json.loads(cache_path.read_text(encoding="utf-8"))
            by_code = {r["code"]: r for r in out["peers"]}
            self.assertIn("ALM", by_code, "manual 条目必须保留")
            self.assertIn("valuation_err", by_code["ALM"],
                          "非 A 股的 manual 条目应该被显式标注估值缺失（Minor 4），不是静默")


class TestSelfExclusion(unittest.TestCase):
    """复审 I3：--confirm 清单含标的自身时，必须排除出中位数并打警告。

    Task 8 验收 Step 3 把 600549 算进了它自己的中位数——一家公司不是自己的同业，
    这样算出的偏离度当场失真。
    """

    def _run(self, tmp, confirm, peers):
        symbol_dir = Path(tmp) / "600549"
        symbol_dir.mkdir(parents=True, exist_ok=True)
        cache_path = symbol_dir / "peers_curated.json"
        cache_path.write_text(json.dumps({
            "状态": "候选待确认", "生成日期": "2026-08-01", "品种词": ["钨"], "通道": "①",
            "peers": peers, "中位数": {"PE_TTM": None, "PB": None, "PS": None},
        }, ensure_ascii=False), encoding="utf-8")

        # 每家给不同的 PE，好让"有没有把标的自己算进去"在中位数上看得出来
        pe_by_code = {"600549": 999.0, "000657": 51.72, "002378": 34.74, "002842": 31.72}
        fake_ak = types.ModuleType("akshare")
        fake_ak.stock_value_em = lambda symbol: _FakeZyjsFrame({
            "PE(TTM)": pe_by_code.get(symbol, 10.0), "市净率": 9.39,
            "市销率": 5.56, "数据日期": "2026-08-26",
        })
        argv = ["discover_peers.py", "600549", "--root", tmp, "--confirm", confirm]
        err = io.StringIO()
        with mock.patch.dict(sys.modules, {"akshare": fake_ak}), \
                mock.patch.object(sys, "argv", argv), \
                contextlib.redirect_stderr(err), contextlib.redirect_stdout(io.StringIO()):
            with self.assertRaises(SystemExit) as ctx:
                discover_peers.main()
        return ctx.exception.code, json.loads(cache_path.read_text(encoding="utf-8")), err.getvalue()

    def _candidates(self, codes):
        return [{"code": c, "market": "CN", "name": c, "主营节选": "钨……", "hint": "",
                 "keep": None, "reason": "候选，待 agent 用 --confirm 确认", "manual": False}
                for c in codes]

    def test_self_is_excluded_from_median(self):
        with tempfile.TemporaryDirectory() as tmp:
            code, out, err = self._run(
                tmp, "600549,000657,002378,002842",
                self._candidates(["600549", "000657", "002378", "002842"]))
        self.assertEqual(code, 0)
        # 三家（51.72 / 34.74 / 31.72）的中位数是 34.74；把 600549 的 999 算进去
        # 会变成四家的中位数 43.23——差得出来，断言才立得住。
        self.assertEqual(out["中位数"]["PE_TTM"], 34.74,
                          "中位数必须只由其余三家算出，标的自身不得参与")
        self.assertEqual(out["中位数_家数"], 3)
        self.assertEqual(out["已排除标的自身"], ["600549"])

    def test_self_row_is_kept_in_product_but_marked(self):
        """不静默丢弃：那一行留在产物里，keep=False 且写明原因。"""
        with tempfile.TemporaryDirectory() as tmp:
            _, out, _ = self._run(
                tmp, "600549,000657", self._candidates(["600549", "000657"]))
        by_code = {r["code"]: r for r in out["peers"]}
        self.assertFalse(by_code["600549"]["keep"])
        self.assertIn("标的自身", by_code["600549"]["reason"])
        self.assertTrue(by_code["600549"].get("is_self"))

    def test_warning_names_who_and_how_many(self):
        with tempfile.TemporaryDirectory() as tmp:
            _, _, err = self._run(
                tmp, "600549,000657", self._candidates(["600549", "000657"]))
        self.assertIn("600549", err)
        self.assertIn("排除", err)
        self.assertIn("其余 1 家", err, "警告要说明中位数基于几家")

    def test_only_self_confirmed_exits_1(self):
        """清单里只有标的自己 = 一条同业都没确认到，必须 exit 1，不能算"确认了一家"。"""
        with tempfile.TemporaryDirectory() as tmp:
            code, out, _ = self._run(tmp, "600549", self._candidates(["600549"]))
        self.assertEqual(code, 1)
        self.assertIsNone(out["中位数"]["PE_TTM"])

    def test_no_self_in_list_leaves_everything_untouched(self):
        """反向：清单里没有标的自己时，不得凭空排除任何人、也不该打警告。"""
        with tempfile.TemporaryDirectory() as tmp:
            code, out, err = self._run(
                tmp, "000657,002378,002842",
                self._candidates(["000657", "002378", "002842"]))
        self.assertEqual(code, 0)
        self.assertEqual(out["中位数_家数"], 3)
        self.assertEqual(out["已排除标的自身"], [])
        self.assertNotIn("标的自身", err)


if __name__ == "__main__":
    unittest.main()
