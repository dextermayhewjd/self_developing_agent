"""补充审计：把"真越权"从 audit_run.py 的 dig_after 里择出来。

audit_run.py 的 DIG 含 Read/Bash，而综合阶段读 findings、跑校验器都是设计要求的
（SKILL.md 步骤 4：只读 findings/ 和 aggregate.json）。所以 dig_after 系统性高估越权。

真越权 = 派活后触碰 annual_pdf / pdftotext / WebSearch / WebFetch。
用法：python tools/audit_overreach.py <TRANSCRIPT.jsonl> [标的代码] [标的公司全称]
后两个参数可选：给了就额外跑一遍「查自己」检查（见 detect_self_lookup）；
不给就明确打印跳过说明，不静默——静默会让人以为查过了。
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
# 这是启发式，会带来漏报（少数不含这些词的锚点句式仍可能被判违规）：本工具是事后审计，
# 不是硬门，误报的代价（判据被忽略）远大于漏报（少一条提示）。
_PEER_INTENT_MARKERS = ("同业", "可比", "对标", "peer", "comparable", "中位数", "板块", "行业")


def _has_peer_intent(q):
    ql = q.lower()
    return any(m.lower() in ql for m in _PEER_INTENT_MARKERS)


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
    意图标记**（见 _PEER_INTENT_MARKERS）时才判违规——单独提公司名不算（查行业格局
    时顺带提及是正常的），单独提财务字段更不算（查同业的财务数正是本职），含"同业/
    可比/对标/peer/comparable/中位数/板块/行业"等词也不算（拿标的当锚点查同业正是
    这个 agent 的核心用法）。宁可漏报也不要误报：误报会让这条判据被忽略。

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

    # 派活后越权分段：需要一次 spawn 来分「派活前/后」。没有 spawn 就跳过这一段，
    # 但仍继续往下跑「查自己」检查——那条检查不依赖 spawn 分段，且它要覆盖的正是
    # 参照系 agent 自己的转录（往往没有它自己再往下 spawn 的事件）。
    first = next((i for i, (n, _) in enumerate(uses) if n in SPAWN), None)
    if first is None:
        print("没有 spawn，无法分段（真越权/合法/其他 三项跳过）")
    else:
        after = uses[first:]
        blob = lambda i: " ".join(str(v) for v in i.values())
        over  = [(n,blob(i)) for n,i in after if n not in SPAWN and (n in OVER_TOOLS or OVER_PAT.search(blob(i)))]
        legit = [(n,blob(i)) for n,i in after if n not in SPAWN and n not in OVER_TOOLS and not OVER_PAT.search(blob(i)) and LEGIT_PAT.search(blob(i))]
        spawn_n = sum(1 for n,_ in after if n in SPAWN)
        other = len(after) - len(over) - len(legit) - spawn_n
        print(f"派活后总调用: {len(after)}（含 {spawn_n} 次 spawn 本身）")
        print(f"  真越权（年报/联网）: {len(over)}")
        print(f"  合法（findings/档案/校验器）: {len(legit)}")
        print(f"  其他: {other}")
        if over:
            print("\n真越权明细（前 20）:")
            for n,b in over[:20]: print(f"    {n:10} {b[:95]}")

    print()
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

    return 0

if __name__ == "__main__":
    sys.exit(main())
