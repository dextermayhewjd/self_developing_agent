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
