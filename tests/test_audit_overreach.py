import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "tools"))
import audit_overreach

TOOLS_DIR = Path(__file__).resolve().parent.parent / "tools"


def run_audit(transcript_lines, *extra_args):
    """把几行转录写成临时 jsonl，跑一次 audit_overreach.py，返回 CompletedProcess。"""
    with tempfile.NamedTemporaryFile(
        "w", suffix=".jsonl", delete=False, encoding="utf-8"
    ) as f:
        f.write("\n".join(transcript_lines))
        path = f.name
    try:
        return subprocess.run(
            [sys.executable, str(TOOLS_DIR / "audit_overreach.py"), path, *extra_args],
            capture_output=True,
            text=True,
        )
    finally:
        Path(path).unlink(missing_ok=True)


def tool_use_line(name, input_):
    return json.dumps(
        {"message": {"content": [{"type": "tool_use", "name": name, "input": input_}]}},
        ensure_ascii=False,
    )


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

    def test_allows_peer_code_substring_collision(self):
        """同业代码 038585 恰好把标的代码 03858 当子串包含，不能因此误判成查自己。"""
        t = 'WebSearch(query="038585 净利润 对比")'
        self.assertEqual(audit_overreach.detect_self_lookup(t, "03858", "佳鑫国际资源投资"), [])

    def test_allows_peer_anchored_on_self_name(self):
        """拿标的当锚点查同业/行业数据是本职——含同业意图标记时不判违规。"""
        t = 'WebSearch(query="佳鑫国际资源投资 可比公司 市值中位数")'
        self.assertEqual(audit_overreach.detect_self_lookup(t, "03858", "佳鑫国际资源投资"), [])

    def test_allows_peer_anchored_with_duibi_marker(self):
        """「对比」是最初自测出的原始反例用词（不在旧词表里），扩表后必须也能压下去。"""
        t = 'WebSearch(query="对比佳鑫国际资源投资，Almonty Industries PE PB")'
        self.assertEqual(audit_overreach.detect_self_lookup(t, "03858", "佳鑫国际资源投资"), [])

    def test_still_flags_without_peer_marker(self):
        """同样是标的全称+财务字段同现，但没有同业意图标记，仍应判违规。"""
        t = 'WebSearch(query="佳鑫国际资源投资 现金流 情况")'
        self.assertTrue(audit_overreach.detect_self_lookup(t, "03858", "佳鑫国际资源投资"))


class TestMainWiring(unittest.TestCase):
    """detect_self_lookup 接进 main() 的输出流程：给了标的标识才查，没给要明确说跳过（不得静默）。
    退出码是三态（与 check_thesis.py 的 0/1/2 同源）：0 完整且干净 / 1 发现越权 / 2 部分分析。
    """

    _run = staticmethod(run_audit)
    _tool_use_line = staticmethod(tool_use_line)

    def _search_line(self, query):
        return self._tool_use_line("WebSearch", {"query": query})

    def _task_line(self):
        return self._tool_use_line("Task", {"prompt": "go"})

    def _read_line(self, file_path):
        return self._tool_use_line("Read", {"file_path": file_path})

    def test_reports_self_lookup_when_target_given(self):
        line = self._search_line("佳鑫国际资源投资 2025 净利润")
        proc = self._run([line], "03858", "佳鑫国际资源投资")
        self.assertIn("查自己检查", proc.stdout)
        self.assertIn("1 处", proc.stdout)

    def test_skips_with_explicit_message_when_no_target_given(self):
        line = self._search_line("佳鑫国际资源投资 2025 净利润")
        proc = self._run([line])
        self.assertIn("未提供标的标识，跳过查自己检查", proc.stdout)

    def test_exit_code_0_when_complete_and_clean(self):
        """有 spawn（能分段）、派活后调用干净、查自己检查也没命中——0。"""
        lines = [self._task_line(), self._read_line("findings/x.md")]
        proc = self._run(lines, "03858", "佳鑫国际资源投资")
        self.assertEqual(proc.returncode, 0)

    def test_exit_code_1_when_violation_found(self):
        """派活后直接 WebSearch 标的自己的财务数——真越权与查自己命中都非空，判 1。"""
        lines = [self._task_line(), self._search_line("佳鑫国际资源投资 2025 净利润")]
        proc = self._run(lines, "03858", "佳鑫国际资源投资")
        self.assertEqual(proc.returncode, 1)

    def test_exit_code_2_when_no_spawn_but_self_check_ran(self):
        """没有 spawn 事件（真越权/合法/其他 跳过），但查自己检查仍要跑且结果要出现在输出里；
        跑完没命中，判 2 而不是被「部分分析」悄悄吞掉。"""
        lines = [self._search_line("Almonty Industries P/NAV")]
        proc = self._run(lines, "03858", "佳鑫国际资源投资")
        self.assertEqual(proc.returncode, 2)
        self.assertIn("查自己检查", proc.stdout)
        self.assertIn("0 处", proc.stdout)


class TestIsOverreach(unittest.TestCase):
    """复审 I4：WebSearch/WebFetch 不再一律记为真越权。

    参照系 agent 是本项目唯一获准联网的 agent，它一旦自己 spawn，旧判据会把它
    全部合法联网变成告警——老误报的判据会被直接忽略，等于没有这道检查。
    """

    def test_peer_intent_search_is_not_overreach(self):
        self.assertFalse(audit_overreach.is_overreach(
            "WebSearch", "钨矿 同业 P/NAV 中位数"))

    def test_peer_intent_fetch_is_not_overreach(self):
        self.assertFalse(audit_overreach.is_overreach(
            "WebFetch", "https://example.com/mining 可比公司 估值"))

    def test_search_without_peer_intent_is_still_overreach(self):
        """成稿/核查/五个 lens 都禁网，它们的检索不会带同业措辞——仍要拦。"""
        self.assertTrue(audit_overreach.is_overreach(
            "WebSearch", "佳鑫国际资源投资 巴库塔 投产时间"))

    def test_annual_report_access_is_still_overreach(self):
        self.assertTrue(audit_overreach.is_overreach(
            "Bash", "pdftotext data/03858/annual_pdf/2025.pdf /tmp/a.txt"))

    def test_pdftotext_detour_is_still_overreach(self):
        self.assertTrue(audit_overreach.is_overreach("Bash", "grep 营业收入 /tmp/601678_annual.txt"))

    def test_ordinary_read_is_not_overreach(self):
        self.assertFalse(audit_overreach.is_overreach("Read", "findings/产业.md"))

    def test_carve_out_is_consistent_with_self_lookup_orientation(self):
        """两条判据取向一致：拿标的当锚点查同业，既不算越权、也不算查自己。"""
        q = "佳鑫国际资源投资 可比公司 市值中位数"
        self.assertFalse(audit_overreach.is_overreach("WebSearch", q))
        self.assertEqual(
            audit_overreach.detect_self_lookup(f'WebSearch(query="{q}")', "03858", "佳鑫国际资源投资"),
            [])


class TestBenchmarkNetworkNotFlagged(unittest.TestCase):
    """端到端：参照系 agent 自己 spawn 之后的合法联网不得让退出码变成 1。"""

    _run = staticmethod(run_audit)
    _line = staticmethod(tool_use_line)

    def test_peer_searches_after_spawn_exit_0(self):
        lines = [
            self._line("Task", {"prompt": "go"}),
            self._line("WebSearch", {"query": "钨精矿 同业 P/NAV 中位数"}),
            self._line("WebSearch", {"query": "Almonty Industries 可比公司 EV/NAV"}),
        ]
        proc = self._run(lines, "03858", "佳鑫国际资源投资")
        self.assertEqual(proc.returncode, 0, proc.stdout)
        self.assertIn("真越权（年报/无同业意图的联网）: 0", proc.stdout)

    def test_legit_network_is_printed_not_swallowed(self):
        """从告警里摘掉不等于让它消失——必须仍然打印出来供人工复核。"""
        lines = [
            self._line("Task", {"prompt": "go"}),
            self._line("WebSearch", {"query": "钨精矿 同业 P/NAV 中位数"}),
        ]
        proc = self._run(lines, "03858", "佳鑫国际资源投资")
        self.assertIn("合法联网（带同业意图）: 1", proc.stdout)
        self.assertIn("钨精矿 同业 P/NAV 中位数", proc.stdout)

    def test_non_peer_search_after_spawn_still_exit_1(self):
        lines = [
            self._line("Task", {"prompt": "go"}),
            self._line("WebSearch", {"query": "巴库塔钨矿 投产 最新进展"}),
        ]
        proc = self._run(lines, "03858", "佳鑫国际资源投资")
        self.assertEqual(proc.returncode, 1, proc.stdout)


if __name__ == "__main__":
    unittest.main()
