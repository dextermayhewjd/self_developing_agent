"""补充审计：把"真越权"从 audit_run.py 的 dig_after 里择出来。

audit_run.py 的 DIG 含 Read/Bash，而综合阶段读 findings、跑校验器都是设计要求的
（SKILL.md 步骤 4：只读 findings/ 和 aggregate.json）。所以 dig_after 系统性高估越权。

真越权 = 派活后触碰 annual_pdf / pdftotext，或**不带同业意图**的 WebSearch / WebFetch。
联网不再一律算越权：参照系 agent（板块基准 / 补参照系）是本项目唯一获准联网的
agent，它一旦自己 spawn，此前会把它全部合法联网记成告警——见 is_overreach。

用法：
    python tools/audit_overreach.py <TRANSCRIPT.jsonl> [标的代码] [标的公司全称]
后两个参数可选：给了就额外跑一遍「查自己」检查（见 detect_self_lookup）；
不给就明确打印跳过说明，不静默——静默会让人以为查过了。

退出码（与 check_thesis.py 的 0/1/2 同源）：
    0 = 完整分析（spawn 分段成功）且干净——无真越权、查自己检查也没命中
    1 = 发现越权——真越权非空，或查自己检查命中非空，两者任一即为 1
    2 = 部分分析——没有 spawn 事件，「真越权/合法联网/合法/其他」四项分段跳过；
        查自己检查不受影响、仍照常跑，跑完没命中才是 2（命中了仍是 1）
"""
import json, sys, re
from pathlib import Path

SPAWN = {"Task", "Agent"}
# 越权 = 碰年报正文。必须含绕路：先 pdftotext 把年报导到 /tmp/xxx.txt，
# 再对那个文件 grep/sed/awk——2026-08-19 实测这条绕路占越权近一半，
# 且不触发任何按原路径写的检测（skill 的禁令和本脚本此前都栽在这里）。
OVER_PAT = re.compile(
    r"annual_pdf|pdftotext|pdftoppm|年报"
    r"|/tmp/\S*annual\S*\.txt"      # /tmp/601678_annual.txt 这类导出文本
    r"|/tmp/p\d+-\d+\.png",          # pdftoppm 渲染出的页面图
    re.I,
)
OVER_TOOLS = {"WebSearch", "WebFetch"}
LEGIT_PAT = re.compile(r"findings/|疑惑\.md|report\.md|aggregate\.json|positions/|check_thesis", re.I)

# 参照系 agent 的界线：只查别人，不查自己。判据不看工具，看"查的是谁的什么"。
_FINANCIAL_FIELDS = (
    "净利润", "营收", "营业收入", "毛利率", "净利率", "市值", "PE", "PB", "PS",
    "现金流", "负债率", "股东", "业绩", "财报", "年报", "净资产",
)
_SEARCH_CALL_RE = re.compile(r'(?:WebSearch|WebFetch)\s*\(\s*(?:query|url)\s*=\s*["\']([^"\']+)["\']')

# 参照系 agent 的核心工作就是拿标的当锚点去查同业/行业数据——这种检索会让标的名和
# 财务字段同时出现在同一句里，但财务字段问的是别人，不是标的自己。含下列词时不判违规。
# 这是启发式：近义表达不在表里仍会被漏判成违规——词表不可能穷举所有"在查别人"的
# 说法。判据要找的是无意的越界，不是防故意绕过（真要故意绕过，绕过者只能是 agent
# 自己，它没有绕过的动机）。误报的代价（判据被忽略）远大于漏报（少一条提示）。
_PEER_INTENT_MARKERS = (
    "同业", "可比", "对标", "peer", "comparable", "中位数", "板块", "行业",
    "对比", "比较", "同行", "同类", "竞品", "竞争对手", "可比公司", "同板块",
    "benchmark", "分位", "均值", "平均",
)


def _has_peer_intent(q):
    ql = q.lower()
    return any(m.lower() in ql for m in _PEER_INTENT_MARKERS)


def is_overreach(name, blob):
    """这一次调用算不算真越权。

    年报正文一律算（含 pdftotext 导出到 /tmp 再 grep 的绕路）。**联网分两种**：

    - 带同业意图标记的 WebSearch/WebFetch → **不算**。参照系 agent 是本项目唯一
      获准联网的 agent（设计 D2），它的本职就是查外部同业/同板块口径。此前 OVER_TOOLS
      把联网一律记为真越权，于是这个 agent 只要自己 spawn 过一次，它全部的合法联网
      都会变成告警——一个老是误报的判据会被直接忽略，等于没有这道检查。
    - 不带同业意图的联网 → 仍算越权。综合成稿、核查、五个 lens 都明令禁网，
      它们的检索不会带「同业/可比/板块/中位数/分位」这类词。

    取舍与 detect_self_lookup 一致：**宁可漏报也不要误报**。代价是"用同业措辞包装的
    越权检索"会被放过——但这个判据要找的是无意的越界，不是防故意绕过（绕过者只能
    是 agent 自己，它没有绕过的动机）。「只查别人不查自己」那条线由 detect_self_lookup
    独立守，且它不依赖 spawn 分段，整份转录都扫，所以这里放宽不会让那条线一起松。
    """
    if name in OVER_TOOLS:
        return not _has_peer_intent(blob)
    return bool(OVER_PAT.search(blob))


def _contains_symbol(symbol, q):
    """标的代码在 q 里必须是独立的数字串（两侧不再挨着数字）。

    纯子串匹配会把"同业代码恰好包含标的代码"误判成命中——例如标的 03858、
    同业代码 038585，"03858" 是 "038585" 的子串。要求两侧非数字，排除这种碰撞。
    """
    if not symbol:
        return False
    return re.search(r"(?<!\d)" + re.escape(symbol) + r"(?!\d)", q) is not None


def detect_self_lookup(transcript, symbol, company):
    """找出「参照系 agent 去查标的公司自己的财务数」的调用。

    只在同一次检索里**既出现标的标识（代码或公司名）又出现财务字段**、且**不含同业
    意图标记**（完整词表见 _PEER_INTENT_MARKERS）时才判违规——单独提公司名不算
    （查行业格局时顺带提及是正常的），单独提财务字段更不算（查同业的财务数正是
    本职），含同业意图词（同业/可比/对标/对比/比较/同行/同类/竞品/竞争对手/可比
    公司/同板块/板块/行业/peer/comparable/benchmark/分位/均值/平均/中位数）也不算
    ——拿标的当锚点查同业正是这个 agent 的核心用法。宁可漏报也不要误报：误报会让
    这条判据被忽略。

    这是启发式：近义表达不在词表里仍会漏判成违规，词表不可能穷举所有"在查别人"
    的说法。判据要找的是无意的越界，不是防故意绕过——绕过者只能是 agent 自己，
    它没有绕过的动机。

    已知边界（有意不修，接受漏报，见 task-6-report.md）：只认标的**全称**与**完整
    代码**的精确匹配。公司简称/俗称（如"佳鑫国际"之于"佳鑫国际资源投资"）、代码去掉
    前导零（"3858"）、代码带交易所后缀/格式变体（"0385.HK"）都不会命中。
    """
    hits = []
    for q in _SEARCH_CALL_RE.findall(transcript):
        names_self = _contains_symbol(symbol, q) or (company and company in q)
        has_field = any(f in q for f in _FINANCIAL_FIELDS)
        if names_self and has_field and not _has_peer_intent(q):
            hits.append(f"参照系 agent 查了标的自己的财务数：{q}")
    return hits


def main():
    if len(sys.argv) < 2:
        print("用法: python tools/audit_overreach.py <TRANSCRIPT.jsonl> [标的代码] [标的公司全称]")
        return 1
    path = sys.argv[1]
    symbol = sys.argv[2] if len(sys.argv) > 2 else None
    company = sys.argv[3] if len(sys.argv) > 3 else None

    uses = []
    for line in Path(path).read_text(errors="replace").splitlines():
        try: ev = json.loads(line)
        except Exception: continue
        msg = ev.get("message") if isinstance(ev.get("message"), dict) else {}
        for b in (msg.get("content") or []):
            if isinstance(b, dict) and b.get("type") == "tool_use":
                uses.append((b.get("name","?"), b.get("input",{}) or {}))

    # 派活后越权分段：需要一次 spawn 来分「派活前/后」。没有 spawn 就这一段跳过
    # （退出码降级为 2：部分分析），但仍继续往下跑「查自己」检查——那条检查不
    # 依赖 spawn 分段，且它要覆盖的正是参照系 agent 自己的转录（往往没有它自己
    # 再往下 spawn 的事件）。
    first = next((i for i, (n, _) in enumerate(uses) if n in SPAWN), None)
    partial = first is None
    over = []
    if partial:
        print("没有 spawn，无法分段（真越权/合法联网/合法/其他 四项跳过）")
    else:
        after = uses[first:]
        blob = lambda i: " ".join(str(v) for v in i.values())
        over  = [(n,blob(i)) for n,i in after if n not in SPAWN and is_overreach(n, blob(i))]
        # 参照系 agent 的合法联网单列一档：不计入越权，但要**打印出来**——
        # 从告警里摘掉不等于让它消失，看的人有权知道这一轮联网查了什么。
        bench_net = [(n,blob(i)) for n,i in after
                     if n not in SPAWN and n in OVER_TOOLS and not is_overreach(n, blob(i))]
        legit = [(n,blob(i)) for n,i in after if n not in SPAWN and n not in OVER_TOOLS and not OVER_PAT.search(blob(i)) and LEGIT_PAT.search(blob(i))]
        spawn_n = sum(1 for n,_ in after if n in SPAWN)
        other = len(after) - len(over) - len(bench_net) - len(legit) - spawn_n
        print(f"派活后总调用: {len(after)}（含 {spawn_n} 次 spawn 本身）")
        print(f"  真越权（年报/无同业意图的联网）: {len(over)}")
        print(f"  参照系 agent 的合法联网（带同业意图）: {len(bench_net)}")
        print(f"  合法（findings/档案/校验器）: {len(legit)}")
        print(f"  其他: {other}")
        if bench_net:
            print("\n合法联网明细（前 10，仅供人工复核，不计入越权）:")
            for n,b in bench_net[:10]: print(f"    {n:10} {b[:95]}")
        if over:
            print("\n真越权明细（前 20）:")
            for n,b in over[:20]: print(f"    {n:10} {b[:95]}")

    print()
    self_hits = []
    if symbol or company:
        # 把已解析出的 WebSearch/WebFetch 调用还原成 detect_self_lookup 认得的
        # `Tool(query="...")` / `Tool(url="...")` 伪调用串（它按这个格式做正则匹配，
        # 见 _SEARCH_CALL_RE），再整体喂给它——不管这些调用出现在 spawn 前还是后。
        search_calls = "\n".join(
            f'{n}({"query" if "query" in i else "url"}="{i.get("query") or i.get("url") or ""}")'
            for n, i in uses
            if n in OVER_TOOLS and (i.get("query") or i.get("url"))
        )
        self_hits = detect_self_lookup(search_calls, symbol or "", company or "")
        print(f"查自己检查（标的 {symbol or '(未给代码)'} / {company or '(未给公司名)'}）: {len(self_hits)} 处")
        for h in self_hits[:20]:
            print(f"    {h}")
    else:
        print("未提供标的标识，跳过查自己检查")

    if over or self_hits:
        return 1
    if partial:
        return 2
    return 0

if __name__ == "__main__":
    sys.exit(main())
