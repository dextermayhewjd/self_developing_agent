"""补充审计：把"真越权"从 audit_run.py 的 dig_after 里择出来。

audit_run.py 的 DIG 含 Read/Bash，而综合阶段读 findings、跑校验器都是设计要求的
（SKILL.md 步骤 4：只读 findings/ 和 aggregate.json）。所以 dig_after 系统性高估越权。

真越权 = 派活后触碰 annual_pdf / pdftotext / WebSearch / WebFetch。
用法：python tools/audit_overreach.py <TRANSCRIPT.jsonl>
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


def detect_self_lookup(transcript, symbol, company):
    """找出「参照系 agent 去查标的公司自己的财务数」的调用。

    只在同一次检索里**既出现标的标识（代码或公司名）又出现财务字段**时才判违规——
    单独提公司名不算（查行业格局时顺带提及是正常的），单独提财务字段更不算
    （查同业的财务数正是本职）。宁可漏报也不要误报：误报会让这条判据被忽略。
    """
    hits = []
    for q in _SEARCH_CALL_RE.findall(transcript):
        names_self = symbol in q or (company and company in q)
        has_field = any(f in q for f in _FINANCIAL_FIELDS)
        if names_self and has_field:
            hits.append(f"参照系 agent 查了标的自己的财务数：{q}")
    return hits


def main():
    uses = []
    for line in Path(sys.argv[1]).read_text(errors="replace").splitlines():
        try: ev = json.loads(line)
        except Exception: continue
        msg = ev.get("message") if isinstance(ev.get("message"), dict) else {}
        for b in (msg.get("content") or []):
            if isinstance(b, dict) and b.get("type") == "tool_use":
                uses.append((b.get("name","?"), b.get("input",{}) or {}))
    first = next((i for i,(n,_) in enumerate(uses) if n in SPAWN), None)
    if first is None:
        print("没有 spawn，无法分段"); return 1
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
    return 0

if __name__ == "__main__":
    sys.exit(main())
