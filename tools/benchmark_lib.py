"""参照系接地的共用解析器（纯 stdlib）。

被 check_thesis.py 与 discover_peers.py 共用。不引第三方依赖——
check_thesis.py 是交付前的硬门，必须在没有 .venv 的环境也能跑。
"""

import re

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

# 行格式：- [强度] what ｜ 值 ｜ 出处 ｜ 取数日
# 分隔符是全角竖线 ｜（U+FF5C），与 核查/*.md 现有约定一致。
_BENCH_LINE_RE = re.compile(r"^\s*-\s*\[([^\]]+)\]\s*(.+?)\s*｜", re.M)


def parse_benchmarks(run_dir):
    """扫 run_dir/参照系/*.md，返回 {what: 强度}。

    参照系/ 不存在时返回 None——调用方据此区分"这一版没有这道工序"（向后兼容，
    应跳过检查）与"工序跑了但一条都没产出"（是真问题，应报警）。
    未知档位的行直接跳过：宁可漏判也不要把打错的标签当成有效强度。
    """
    d = run_dir / "参照系"
    if not d.is_dir():
        return None
    out = {}
    for f in sorted(d.glob("*.md")):
        for strength, what in _BENCH_LINE_RE.findall(f.read_text(encoding="utf-8")):
            strength = strength.strip()
            if strength in STRENGTHS:
                out[what.strip()] = strength
    return out


# 与 _BENCH_LINE_RE 同源但多捕获"值"字段。Task 4 评审 Ruling T4-2 追加：
# check_thesis.py 的覆盖性检查要判断"开篇结论散文是否字面引用了某条参照系记录"，
# 光有 what 不够——很多时候开篇写的是数字本身，不是 what 的名字。
_BENCH_LINE_VALUE_RE = re.compile(r"^\s*-\s*\[([^\]]+)\]\s*(.+?)\s*｜\s*(.+?)\s*｜", re.M)


def parse_benchmark_values(run_dir):
    """扫 run_dir/参照系/*.md，返回 {what: 值字符串}（键与 parse_benchmarks 一致）。

    只服务于字面 `in` 判断，不做任何数值归一化（不转单位、不做四舍五入对齐）：
    漏判可接受（少触发一次覆盖性检查），误判才是问题。
    参照系/ 不存在时返回 None，语义与 parse_benchmarks 一致。
    """
    d = run_dir / "参照系"
    if not d.is_dir():
        return None
    out = {}
    for f in sorted(d.glob("*.md")):
        for strength, what, value in _BENCH_LINE_VALUE_RE.findall(f.read_text(encoding="utf-8")):
            strength = strength.strip()
            if strength in STRENGTHS:
                out[what.strip()] = value.strip()
    return out
