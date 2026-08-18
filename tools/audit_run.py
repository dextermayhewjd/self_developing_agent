"""审计一次隔离运行的 stream-json 转录，把黑盒变成可读的行为报告。

用法：
    python tools/audit_run.py <TRANSCRIPT.jsonl> [SYMBOL] [REPORT_DIR]

回答的问题：
    1. 编排器自发 spawn 了几个子 agent？是哪几个 lens？
    2. 派活后编排器有没有"越权重做"——自己又刨年报（该轻量却在重挖）？
    3. 产物齐不齐（疑惑 / findings / report / 档案）？
    4. 过没过校验器？
    5. 整条工具时间线（中间过程，可读）。

这个脚本只读转录 + 文件系统，不改任何东西。
"""
import json
import subprocess
import sys
from pathlib import Path

DIG = {"Bash", "Read", "Grep", "Glob", "WebSearch", "WebFetch", "ToolSearch"}
SPAWN = {"Task", "Agent"}


def load_tool_uses(path):
    """从 stream-json 抽主 agent 的 tool_use 序列（子 agent 内部调用不在主流里）。"""
    uses = []
    for line in Path(path).read_text(errors="replace").splitlines():
        try:
            ev = json.loads(line)
        except Exception:
            continue
        msg = ev.get("message") if isinstance(ev.get("message"), dict) else {}
        for b in (msg.get("content") or []):
            if isinstance(b, dict) and b.get("type") == "tool_use":
                uses.append((b.get("name", "?"), b.get("input", {}) or {}))
    return uses


def hint(name, inp):
    if name in SPAWN:
        return "SPAWN → " + str(inp.get("description") or inp.get("subagent_type") or "")[:50]
    for k in ("file_path", "skill", "command", "query", "pattern", "url"):
        if k in inp:
            return f"{k}={str(inp[k])[:60]}"
    return ""


def main():
    if len(sys.argv) < 2:
        print("用法：python tools/audit_run.py <TRANSCRIPT.jsonl | --latest> [SYMBOL] [REPORT_DIR]", file=sys.stderr)
        print("  --latest：自动找本项目最新的交互会话转录（交互 auto mode 跑完后用这个）", file=sys.stderr)
        return 2
    tp = sys.argv[1]
    symbol = sys.argv[2] if len(sys.argv) > 2 else None
    report_dir = sys.argv[3] if len(sys.argv) > 3 else None

    if tp == "--latest":
        # 交互会话自动录在 ~/.claude/projects/<项目名>/<uuid>.jsonl，项目名=cwd 把 / 换成 -
        proj = "-" + str(Path.cwd())[1:].replace("/", "-")
        sdir = Path.home() / ".claude" / "projects" / proj
        js = sorted(sdir.glob("*.jsonl"), key=lambda p: p.stat().st_mtime, reverse=True)
        if not js:
            print(f"没找到会话转录：{sdir}", file=sys.stderr)
            return 2
        tp = str(js[0])
        print(f"审计最新会话转录：{tp}\n（注意：若这就是你正在用的会话，审到的是本对话；请在跑完 equity-thesis-cn 的那个会话里、或用它的 uuid 指定）\n")

    uses = load_tool_uses(tp)
    if not uses:
        print("转录里没抽到 tool_use——格式不对或文件为空。", file=sys.stderr)
        return 2

    # 时间线
    print("=" * 60)
    print("工具时间线（主编排器的动作，子 agent 内部调用不在此）")
    print("=" * 60)
    spawn_idx = []
    for i, (name, inp) in enumerate(uses, 1):
        mark = ""
        if name in SPAWN:
            spawn_idx.append(i)
            mark = "  <<<<"
        print(f"{i:3} {name:10} {hint(name, inp)}{mark}")

    # 指标
    spawns = [(i, hint(*uses[i - 1])) for i in spawn_idx]
    first_spawn = spawn_idx[0] if spawn_idx else None
    dig_before = sum(1 for n, _ in uses[: (first_spawn or 0)] if n in DIG)
    dig_after = sum(1 for n, _ in uses[(first_spawn or 0):] if n in DIG) if first_spawn else 0
    skill_reads = [h for n, i in uses if n == "Read" for h in [str(i.get("file_path", ""))] if "skills/" in h]

    print("\n" + "=" * 60)
    print("审计小结")
    print("=" * 60)
    print(f"总工具调用: {len(uses)}")
    print(f"自发 SPAWN 子 agent: {len(spawns)} 个")
    for i, h in spawns:
        print(f"    #{i} {h}")
    print(f"读过的 skill 文件: {len(set(skill_reads))} 个")

    # 越权重做信号
    print(f"\n派活前的数据挖掘调用: {dig_before}（立疑需要，正常）")
    print(f"派活后的数据挖掘调用: {dig_after}", end="")
    if first_spawn and dig_after > 15:
        print(f"  ⚠️ 偏高——编排器可能在越权重做子 agent 的活（该轻量却在重挖）")
    else:
        print("  ✓ 派活后保持轻量")

    # 产物核查
    if symbol and not report_dir:
        # 猜 run 目录
        cands = list(Path("reports").glob(f"{symbol}_thesis_*"))
        report_dir = str(cands[0]) if cands else None
    print("\n产物核查:")
    if report_dir and Path(report_dir).exists():
        rd = Path(report_dir)
        for art in ["疑惑.md", "report.md"]:
            print(f"    {'✓' if (rd / art).exists() else '✗'} {art}")
        fdir = rd / "findings"
        fcount = len(list(fdir.glob("*.md"))) if fdir.exists() else 0
        print(f"    {'✓' if fcount else '✗'} findings/ （{fcount} 份）")
        # 校验器
        rep = rd / "report.md"
        if symbol and rep.exists():
            r = subprocess.run(
                ["python3", "tools/check_thesis.py", symbol, str(rep)],
                capture_output=True, text=True,
            )
            print(f"\n校验器 check_thesis 退出码: {r.returncode}（0=过 1=硬伤 2=软警告）")
            for ln in (r.stdout + r.stderr).splitlines():
                if ln.strip():
                    print("    " + ln)
    else:
        print(f"    ✗ 未找到 run 目录（symbol={symbol} report_dir={report_dir}）——可能还没写成品")

    if symbol:
        pos = Path("positions") / f"{symbol}.md"
        print(f"\n档案 positions/{symbol}.md: {'✓ 存在' if pos.exists() else '✗ 不存在'}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
