"""参照系接地的共用解析器（纯 stdlib）。

被 check_thesis.py 与 discover_peers.py 共用。不引第三方依赖——
check_thesis.py 是交付前的硬门，必须在没有 .venv 的环境也能跑。
"""

import re
from collections import namedtuple
from pathlib import Path

# 原型段落：`## N. 名称`
_ARCHETYPE_RE = re.compile(r"^##\s+(\d+)\.\s*(\S+)\s*$", re.M)
# 列表型字段：值写在下方缩进的 `- ` 行里
_LIST_FIELDS = {"失效指标", "必比口径"}


def parse_archetypes(text):
    """解析 valuation_archetypes.md，返回 {原型名: {字段: 值}}。

    段落格式：
        ## 1. 耗竭资源型

        归属判据：...
        主估值方法：...
        失效指标:
          - ...
        必比口径：
          - ...
    冒号全角半角都认——手写文档里两者会混用。
    """
    out = {}
    marks = list(_ARCHETYPE_RE.finditer(text))
    for i, m in enumerate(marks):
        start = m.end()
        end = marks[i + 1].start() if i + 1 < len(marks) else len(text)
        body = text[start:end]
        fields = {"index": int(m.group(1))}
        cur = None
        for raw in body.splitlines():
            line = raw.rstrip()
            if not line.strip():
                continue
            kv = re.match(r"^(\S+?)[：:]\s*(.*)$", line.strip())
            if kv and not line.lstrip().startswith("-"):
                cur = kv.group(1)
                val = kv.group(2).strip()
                fields[cur] = [] if cur in _LIST_FIELDS else val
                if cur in _LIST_FIELDS and val:
                    fields[cur].append(val)
            elif line.lstrip().startswith("-") and cur in _LIST_FIELDS:
                fields[cur].append(line.lstrip()[1:].strip())
            elif cur and cur not in _LIST_FIELDS and fields.get(cur) is not None:
                fields[cur] = (fields[cur] + " " + line.strip()).strip()
        out[m.group(2)] = fields
    return out


# 五档强度，强到弱有序。分隔符是 U+00B7 的「·」，不是 ASCII 句点。
STRENGTHS = (
    "外部·可回溯",        # 有 URL/接口 + 逐字原文 + 口径说明，且 >=2 源交叉，或来自本地数据层
    "外部·单源未交叉",    # 有出处但只有一个来源
    "外部但口径存疑",      # 有外部数但口径不一致（含"宽池子且池内无同品种"）
    "私有基准",           # 出自标的公司或其委托方
    "无参照系",           # 没有可比对象
)
USABLE_AS_HARD = frozenset({"外部·可回溯"})
MUST_DOWNGRADE = frozenset({"私有基准", "无参照系"})

# ── 参照系真值的两个来源 ────────────────────────────────────────────────
# 硬门要的是「每个承重数字的参照系强度」这张表。它有两个来源，格式不同：
#   核查/*.md    `- [判定][参照系类型] what ｜ 核实值 ｜ 出处`     ← 双方括号，取第二个
#   参照系/*.md  `- [强度] what ｜ 值 ｜ 出处 ｜ 取数日`            ← 单方括号
# 复审 C1：此前只读 参照系/，而 参照系/ 只装两样——板块口径名，加上补参照系 agent
# **选择写下**的悬空条目。于是两个方向同时错：补参照系漏写一条，那条私有基准就
# 从硬门的视野里整个消失（fail-open，正是 03858 那次的重演）；而被核查判为
# 「外部·可回溯」的核心数字永远不会进 参照系/，成稿老实点名它们反而匹配不上（false-block）。
# 修法是把 核查/ 并入真值来源，参照系/ 的条目优先——它是更新后的判定。
#
# 分隔符是全角竖线 ｜（U+FF5C），与 核查/*.md 现有约定一致；档位串见 STRENGTHS
# （中间是 U+00B7 的「·」）。两处都不要手打，从这里引用。
BENCH_DIRNAME = "参照系"
CHECK_DIRNAME = "核查"

# 参照系行：- [强度] what ｜ 值 ｜ 出处 ｜ 取数日
_BENCH_LINE_RE = re.compile(r"^\s*-\s*\[([^\]\n]+)\]\s*([^｜\n]+?)\s*｜\s*([^｜\n]*)", re.M)
# 核查行：- [判定][参照系类型] what ｜ 核实值 ｜ 出处。取第二个方括号里的参照系类型。
_CHECK_LINE_RE = re.compile(
    r"^\s*-\s*\[([^\]\n]*)\]\s*\[([^\]\n]*)\]\s*([^｜\n]+?)\s*｜\s*([^｜\n]*)", re.M
)
# 「疑似条目行」——用来区分"这份文件里压根没有条目"与"有条目但一条都没解析成功"。
# 参照系文件：任何 `- [` 开头的行都算；核查文件：只有双方括号的才算（旧 run 的
# 核查是单方括号，那是 03858 那一版的格式，不该被当成新格式的解析失败）。
_BENCH_CANDIDATE_RE = re.compile(r"^\s*-\s*\[", re.M)
_CHECK_CANDIDATE_RE = re.compile(r"^\s*-\s*\[[^\]\n]*\]\s*\[", re.M)


class BenchmarkParseError(RuntimeError):
    """一份参照系/核查文件里有条目行，却一条都没解析成功。

    复审 C2(a)：此前未知档位的行被静默跳过，没有任何地方报告"文件里有 `- [` 开头的
    行、但零条解析成功"。实测风险是补参照系 agent 照抄核查的双方括号格式（它刚读完
    一屋子那种行），于是整份 补.md 被丢光、硬门却毫无察觉——这正是"静默失败"。
    判定按**单份文件**做，不按整个目录汇总：真实的失败形态是 板块基准.md 正常而
    补.md 整份写错，汇总计数会因为前者有命中而看不见后者。
    """


def _scan(text, line_re, candidate_re, strength_group, what_group, value_group):
    """扫一份文件，返回 (entries, n_candidates)。entries 是 [(what, strength, value)]。

    未知档位的行不进 entries：宁可漏判也不要把打错的标签当成有效强度。但它们会
    留在 n_candidates 里，好让调用方看出"有行没接上"。
    """
    entries = []
    for m in line_re.finditer(text):
        strength = m.group(strength_group).strip()
        what = m.group(what_group).strip()
        value = (m.group(value_group) or "").strip()
        # what 以 `[` 开头 = 这行还有第三个方括号没被吃掉，格式判断本身就没对上，
        # 不要把 "[确认无误] 某个数" 这种串当成 what 键落进表里。
        if strength in STRENGTHS and not what.startswith("["):
            entries.append((what, strength, value))
    return entries, len(candidate_re.findall(text))


def _scan_dir(d, line_re, candidate_re, groups, what_kind, candidate_desc):
    """扫一个目录下的 *.md，返回 (bench, values)。目录不存在时返回 ({}, {})。

    单份文件"有条目行但零命中"→ 抛 BenchmarkParseError，不静默返回空。
    """
    bench, values = {}, {}
    if not d.is_dir():
        return bench, values
    for f in sorted(d.glob("*.md")):
        entries, n_cand = _scan(f.read_text(encoding="utf-8"), line_re, candidate_re, *groups)
        if n_cand and not entries:
            raise BenchmarkParseError(
                f"{what_kind}文件 {f.name} 里有 {n_cand} 行像条目（{candidate_desc}），"
                f"却一条都没解析成功——多半是档位串写错了一个码位，或者格式串了行"
                f"（参照系行是 `- [强度] what ｜ 值 ｜ 出处 ｜ 取数日` 单方括号，"
                f"核查行是 `- [判定][参照系类型] what ｜ 值 ｜ 出处` 双方括号）。"
                f"合法档位：{' / '.join(STRENGTHS)}。文件全路径 {f}"
            )
        for what, strength, value in entries:
            bench[what] = strength
            values[what] = value
    return bench, values


def parse_benchmarks(run_dir):
    """扫 run_dir/参照系/*.md，返回 {what: 强度}。

    参照系/ 不存在时返回 None——调用方据此区分"这一版没有这道工序"（向后兼容，
    应跳过检查）与"工序跑了但一条都没产出"（是真问题，应报警）。
    单份文件里有条目行却零条解析成功时抛 BenchmarkParseError（见该类的说明）。
    """
    d = Path(run_dir) / BENCH_DIRNAME
    if not d.is_dir():
        return None
    bench, _ = _scan_dir(d, _BENCH_LINE_RE, _BENCH_CANDIDATE_RE, (1, 2, 3), "参照系", "以 `- [` 开头")
    return bench


def parse_benchmark_values(run_dir):
    """扫 run_dir/参照系/*.md，返回 {what: 值字符串}（键与 parse_benchmarks 一致）。

    只服务于字面 `in` 判断，不做任何数值归一化（不转单位、不做四舍五入对齐）：
    漏判可接受（少触发一次覆盖性检查），误判才是问题。
    参照系/ 不存在时返回 None，语义与 parse_benchmarks 一致。
    """
    d = Path(run_dir) / BENCH_DIRNAME
    if not d.is_dir():
        return None
    _, values = _scan_dir(d, _BENCH_LINE_RE, _BENCH_CANDIDATE_RE, (1, 2, 3), "参照系", "以 `- [` 开头")
    return values


def parse_check_benchmarks(run_dir):
    """扫 run_dir/核查/*.md 的双方括号行，返回 ({what: 参照系类型}, {what: 核实值})。

    核查/ 不存在时返回 ({}, {})——它不是"这道工序在不在"的判据（那个判据在
    参照系/ 上），只是真值表的另一半来源。旧 run 的单方括号行不参与解析，也不
    计入"疑似条目行"：那是 03858 那一版的格式，把它当成解析失败会误伤向后兼容。
    """
    return _scan_dir(
        Path(run_dir) / CHECK_DIRNAME, _CHECK_LINE_RE, _CHECK_CANDIDATE_RE, (2, 3, 4), "核查",
        "以 `- [判定][` 这样的双方括号开头",
    )


class Collected(namedtuple("Collected", "bench values notes")):
    """collect_benchmarks 的产物。

    bench / values 为 None 表示"这一版没有参照系接地这道工序"，调用方应整体跳过
    硬约束 7（向后兼容）。notes 是 [(level, message)]，level ∈ {"hard", "warn"}——
    凡是"跳过"或"降级"，都要有一条 note 说明为什么，不许静默。
    """


def collect_benchmarks(run_dir):
    """汇总一次 run 的参照系真值：核查/ 打底，参照系/ 覆盖（后者是更新后的判定）。

    返回 Collected(bench, values, notes)。四种情形：
      1. 两个目录都给不出条目、且 参照系/ 不存在 → bench=None，无 note（旧 run，向后兼容）
      2. 参照系/ 不存在但 核查/ 有条目            → bench=核查的，warn（真值来源只剩一半）
      3. 参照系/ 存在但合并后一条都没有            → bench=None，hard（工序空跑或落盘失败）
      4. 参照系/ 存在但自己零条、核查/ 有条目      → bench=合并的，warn

    情形 3 是复审 C2(b) 的"空目录砖化"：目录存在而没有条目，此前会让硬门全开却
    无一条可匹配，稿子必被拦、报错还指向"声明写错了"。它和"目录不存在"必须分开
    对待——前者不是"工序跑过且干净"，是工序没落盘。
    """
    run_dir = Path(run_dir)
    b_dir = run_dir / BENCH_DIRNAME
    notes = []

    c_bench, c_values = parse_check_benchmarks(run_dir)
    has_b_dir = b_dir.is_dir()
    b_bench, b_values = ({}, {})
    if has_b_dir:
        b_bench, b_values = _scan_dir(
            b_dir, _BENCH_LINE_RE, _BENCH_CANDIDATE_RE, (1, 2, 3), "参照系", "以 `- [` 开头"
        )

    bench = dict(c_bench)
    bench.update(b_bench)
    values = dict(c_values)
    values.update(b_values)

    if not has_b_dir:
        if not bench:
            return Collected(None, None, notes)
        notes.append((
            "warn",
            f"{BENCH_DIRNAME}/ 不存在，参照系真值只来自 {CHECK_DIRNAME}/ 的 {len(bench)} 条"
            f"——板块基准与补参照系两道工序疑似都没落盘，开篇声明仍按核查的判定校验",
        ))
        return Collected(bench, values, notes)

    if not bench:
        notes.append((
            "hard",
            f"{BENCH_DIRNAME}/ 目录存在但一条参照系记录都没有（{CHECK_DIRNAME}/ 也没有）："
            f"这不是「工序跑过且干净」，是板块基准/补参照系空跑或落盘失败。"
            f"有内容才建目录并落盘——空目录会让硬约束 7 无从校验",
        ))
        return Collected(None, None, notes)

    if not b_bench:
        notes.append((
            "warn",
            f"{BENCH_DIRNAME}/ 目录存在但自己一条条目都没有，真值来源退化为 "
            f"{CHECK_DIRNAME}/ 的 {len(bench)} 条——板块基准/补参照系疑似空跑",
        ))
    return Collected(bench, values, notes)
