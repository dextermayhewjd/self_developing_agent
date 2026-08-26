#!/usr/bin/env python3
"""动态同业检索——按品种找同业，不维护手工分类表。

为什么不用手工池：competitor_pool.json 只有 10 个行业、A 股专用，而细分品种的
分类方式无法人工穷尽（「钨精矿」在申万里只到「小金属」，在东财概念里未必有）。
改为从标的自己的主营描述里提品种词，再拿品种词去检索——分类从标的自己长出来。

通道优先级（本地优先是硬规矩，不是偏好）：
    ① 主营描述匹配   stock_zyjs_ths（同花顺）        ✓ 已实测
    ② 行业成员       datacenter.eastmoney.com       ✓ 已实测
    ③ 概念/行业板块   stock_board_*_em（push2）      ✗ push2 族当前不通，降为备选
    同业估值口径      stock_value_em                 ✓ 已实测
凡本地通道取得到的数，一律不许走联网——本地数可复现、带交易日，可信度天然高一档。

实测发现（2026-08-26）：② datacenter 的「同行比较」接口（RPT_PCF10_INDUSTRY_CVALUE）
返回的不是完整行业名单，是「以该股票为锚的排名近邻窗口」（约 8 行：行业中值/平均 +
排名相邻几家）——钨业实测里，以 600549 为锚拿不到 002842（翔鹭钨业），换其他钨业
公司做锚也拿不到，是断开的窗口，多跳也连不上。所以①（主营描述匹配）不能只是对②
的候选做二次确认，必须自己能独立发现候选：做法是用交易所官方代码名录
（stock_info_a_code_name，SSE/SZSE/BSE 官方源，不经过 push2）按品种词做名称粗筛，
再用 stock_zyjs_ths 逐个读主营描述——粗筛+读文本两步都在通道①内。

**评审 fail-closed 裁决（2026-08-26 review round 1）**：本组件存在的全部理由是给
「结论强度锁死于参照系强度」这条骨架喂对的输入——零同业时下游正确判「无参照系」、
结论按设计降级；而**噪声同业**（名字沾边但根本不是同品种）会算出一个看起来合理、
实则无意义的板块中位数，且不触发任何警报，是比 03858 那次「港股 72 家宽池」更隐蔽
的同一种失败。round 1 的应对是把字符串判据调紧（前缀≥2 字 + 材料尾字同现），
round 2 又为 2 字品种词开了个"下限放宽到 1 字"的口子——**round 3 的复审证明这个
口子本身就是同一类失败**：品种词「钨矿」用这套加宽后的规则命中了一家灯具企业
（主营含「钨丝灯泡」+ 经营范围里的「矿产资源勘查」）和一家地产公司（「矿泉水」+
「钨金」仿真首饰），两者的字符串判据都能通过，却根本不是钨矿同业。

**Ruling T3-8（2026-08-26 review round 3）：L3 同业确认移交调用方（Task 5 的 LLM
agent），本文件退为确定性的候选发现 + 估值 + 中位数，不再自己判断"是不是同品种"。**
对称于 Ruling T3-6（L1 品种词提取移交 agent，理由是"品种词提取是语言任务"）——
**L3 的"这家公司是不是同品种"同样是语义任务，不是任何字符规则能回答的问题**。
调紧阈值换来 round 1 的零召回，调松阈值换来 round 2 的灯具厂/地产公司误判，连续
两轮 Critical 说明的是同一件事：字符串匹配在"噪声"和"零召回"之间来回移动，
从未真正解决过"语义判断"这个问题。

落地方式：
- 曾经叫 `_confirm_peer` 的函数改名 `_hint_for_peer`，返回值从"决定 keep"降级为
  "仅供参考的 hint 提示串"——**这个返回值从此不再单独驱动任何 keep 赋值**，
  它命中不命中，候选阶段的 keep 一律是 `None`。
- 候选发现阶段（不带 `--confirm` 调用）产出的每条候选带：代码/名称/市场、
  一段「主营节选」（截断过的主营描述，够 agent 判断即可，不塞几千字整段）、
  一个仅供排序参考的 `hint`，以及恒为 `null` 的 `keep`。
- 新增 `--confirm CODE1,CODE2,...` 确认入口：只对这份清单里的代码取估值、
  算中位数、写最终产物——**keep=True 只可能来自这里，或者 `manual: true`**。
  候选清单里没被选中的代码依然留在产物里，但标 `keep=False`，reason 写"候选
  存在但未在确认清单里"——不静默丢弃，复核时看得见。

调用方（Task 5 的板块基准 agent）变成两步：先跑一次拿候选（自己读「主营节选」
判断是不是同品种），再用 `--confirm` 把判断结果传回来算估值和中位数。多一次
往返，换来这一类 bug 从根上消失——不再有任何字符串阈值可调。

用法：
    候选阶段：python3 tools/discover_peers.py <SYMBOL> --terms 品种词1,品种词2 [--root DIR] [--force]
    确认阶段：python3 tools/discover_peers.py <SYMBOL> --confirm 代码1,代码2,... [--root DIR]
退出码：
    候选阶段：0 产出了候选（或已有 manual 条目）/ 1 一个候选都没有（也没有 manual 条目）
    确认阶段：0 产出成功 / 1 确认清单为空（或清单里没有一条真正生效）且无 manual 条目
             / 2 有确认同业但估值口径缺失
"""

import argparse
import json
import re
import statistics
import sys
import time
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# 主营描述里的通用词，不是品种。混进去会把检索面撑爆。
_STOPWORDS = {
    "公司", "本公司", "主要", "从事", "业务", "销售", "生产", "经营", "产品",
    "研发", "服务", "及", "与", "和", "的", "开采", "加工", "制造", "有限公司",
}
_MAX_TERMS = 5

# 按长度降序排列，保证 re.split 在同一起点优先吃掉更长的停用词
# （例如「有限公司」优先于「公司」），避免长词被拆成两截各自判断。
_STOPWORD_PATTERN = re.compile(
    "|".join(re.escape(w) for w in sorted(_STOPWORDS, key=len, reverse=True))
)

# 材料类提示字：这几个单字本身就是相对具体的信号（矿/粉/材/料/芯/片/药/械/酒），
# 命中即可当作"像品种词"的证据。
_HINT_CHARS = "矿砂粉材料芯片药械酒"
# 「设备/电池/组件/器件」是词，不是单字信号——拆成字符类会让「高端装备」因含
# 「备」被误判成品种词（Minor 8 的真实反例），必须整词命中才算数。
_HINT_WORDS = ("设备", "电池", "组件", "器件")


def _is_candidate_term(piece):
    """判断一个候选碎片是否"像品种词"：2–8 字，且含材料提示字/词或字母数字代号。"""
    if not (2 <= len(piece) <= 8):
        return False
    if any(c in piece for c in _HINT_CHARS):
        return True
    if any(w in piece for w in _HINT_WORDS):
        return True
    return bool(re.search(r"[A-Z0-9]{2,}", piece))


def extract_product_terms(text):
    """从主营描述里提品种词——**只是没有 --terms 时的兜底，不是生产路径**（见
    Ruling T3-6）。品种词提取本质是语言任务，这里用的是纯正则规则，**已用真实
    数据证明会产出噪声词**：拿 main 工作区 `data/03858/aggregate.json` 的真实
    主营描述跑这个函数，实测输出是
        ['钨矿', '资料', '地下钨矿)', '设计钨矿产能', '2025年']
    ——"资料""2025年"是正则从"根据弗若斯特沙利文的资料……"这类模板化措辞里
    误提的噪声，占掉了 _MAX_TERMS=5 的词槽；而 A 股钨业四家的股票简称（中钨高新/
    章源钨业/翔鹭钨业/厦门钨业）没有一个含"钨矿"，通道①的确定性名称匹配对
    "钨矿"必然 0 命中。生产路径请用 `--terms` 由调用方（LLM agent）显式指定
    品种词；这个函数只用于本地无 LLM 时的探测/调试。

    规则刻意保守：先按标点切段，再把段内的停用词（从事/主要/开采/销售……）当成
    额外分隔符切掉，切出的碎片里凡通过 _is_candidate_term 的才当候选——这样
    「本公司主要从事钨精矿的开采」这类夹在动词短语中间的品种词也能被单独取出来，
    而不必要求整段恰好是品种词。**但切分只在真的切出了合格碎片时才生效**：如果
    切完一个碎片都不合格（例如「铜加工材」被停用词「加工」切成「铜」「材」，各自
    太短），就退回判断切分前的整段——不能无条件用碎片替换整段，否则会把本来完整
    的品种词切碎丢掉（Important 4 的真实反例）。宁可少提也不要提出「销售」这种词
    ——检索面一旦撑爆，候选清单的可读性会失控。
    """
    terms = []
    for chunk in re.split(r"[，。、；;,\s]+", text or ""):
        chunk = chunk.strip()
        if not chunk:
            continue
        pieces = [p.strip() for p in _STOPWORD_PATTERN.split(chunk) if p.strip()]
        survivors = [p for p in pieces if _is_candidate_term(p)]
        if survivors:
            terms.extend(survivors)
        elif _is_candidate_term(chunk):
            terms.append(chunk)
    seen, out = set(), []
    for t in terms:
        if t not in seen:
            seen.add(t)
            out.append(t)
    return out[:_MAX_TERMS]


def median_multiples(rows):
    """对同业行算三个倍数的中位数。None 与 0 一律剔除——0 是缺失值的常见伪装。"""
    out = {}
    for field in ("PE_TTM", "PB", "PS"):
        vals = [r[field] for r in rows if r.get(field) not in (None, 0)]
        out[field] = statistics.median(vals) if vals else None
    return out


def merge_preserving_manual(cache_path, fresh_rows):
    """把新检索结果并进缓存，人工条目（manual=True）一律保留不覆盖。

    这是本方案唯一保留的人工入口：人只做「加一家机器没找到的」（例如境外的
    Almonty），不做「维护一整张分类表」。Ruling T3-8 之后依然不变——manual 行
    不受候选/确认两阶段流程影响。
    """
    manual = []
    if Path(cache_path).exists():
        old = json.loads(Path(cache_path).read_text(encoding="utf-8"))
        manual = [r for r in old.get("peers", []) if r.get("manual")]
    manual_codes = {r["code"] for r in manual}
    return manual + [r for r in fresh_rows if r["code"] not in manual_codes]


def _hint_for_peer(text, terms):
    """字符串启发式，**仅供参考排序，从不单独驱动 keep**（Ruling T3-8）。

    历史上（round 1-2）这个函数叫 `_confirm_peer`，返回值真的会决定
    keep=True/False。复审用两个反例证明字符串匹配判断不了"是不是同品种"这种
    语义问题：品种词「钨矿」命中了一家灯具企业（主营含「钨丝灯泡」+ 经营范围
    里的「矿产资源勘查」）和一家地产公司（「矿泉水」+「钨金」仿真首饰）——
    两者的"商品字+材料尾字"都能在文本里凑齐，却根本不是钨矿同业。调紧阈值换
    round 1 的零召回，调松阈值换 round 2 这个口子，无论怎么调都只是在两种
    失败之间挪位置。降级为 hint 之后，这两个反例不再是 bug：它们的 hint 可以
    命中，但 keep 恒为 None，"是不是同品种"交给读了「主营节选」的 agent 判断。

    读一段主营描述文本，返回 (matched, hint)：matched 只用于候选清单里的排序
    展示，不影响 keep；hint 是给 agent 参考的一句话理由。
    """
    text = text or ""
    if not text:
        return False, "该代码取不到主营描述（非 A 股或 stock_zyjs_ths 无数据）"
    for term in terms:
        if term in text:
            return True, f"主营含「{term}」"
    for term in terms:
        tail_chars = set(re.findall(f"[{_HINT_CHARS}]", term))
        tail_words = [w for w in _HINT_WORDS if w in term]
        if not tail_chars and not tail_words:
            continue  # 品种词本身没有材料提示字/词（如"WO3"），前缀提示没有意义
        has_tail_evidence = bool(tail_chars & set(text)) or any(w in text for w in tail_words)
        if not has_tail_evidence:
            continue
        floor = 2 if len(term) > 2 else 1  # 2 字品种词例外：下限放宽到 1 字
        for cut in range(len(term) - 1, floor - 1, -1):
            prefix = term[:cut]
            if re.search(r"[一-鿿]", prefix) and prefix in text:
                return True, f"主营含前缀「{prefix}」且含品种尾字/词（品种词「{term}」）"
    return False, "主营描述未命中任何品种词（含前缀+尾字校验）"


def _excerpt(text, limit=240):
    """把主营描述截成一段够 agent 判断、但不至于把几千字整段塞进候选清单的节选。"""
    text = (text or "").strip()
    if len(text) <= limit:
        return text
    return text[:limit] + "…"


def _build_candidate_row(base, text, terms):
    """把一个候选（至少含 code/market/name）+ 它的主营描述文本，组装成候选
    清单里的一行。**Ruling T3-8：keep 恒为 None**——hint 只供参考，从不驱动
    keep。这是一个纯函数，方便离线测试"候选阶段绝不会自己下判断"这件事本身，
    不需要真的跑一遍网络/CLI。
    """
    matched, hint = _hint_for_peer(text, terms)
    return {
        **base,
        "主营节选": _excerpt(text),
        "hint": hint,
        "keep": None,
        "reason": "候选，待 agent 用 --confirm 确认",
        "manual": False,
    }


# ----------------------------------------------------------------------------
# 下面是 CLI 与检索通道，需要 akshare/pandas ——全部延迟到函数体内 import，
# 保证 `import discover_peers` 在纯 stdlib（无 .venv）下也能成功，
# 这样测试才能用系统 python3 跑（约束：测试不得联网，也不需要 akshare）。
# ----------------------------------------------------------------------------

def _exchange_prefix(symbol):
    """6 位 A 股代码 → 交易所前缀，供 datacenter「同行比较」接口用（如 SH600549）。"""
    if symbol.startswith(("60", "68", "90", "11")):
        return "SH"
    if symbol.startswith(("00", "30", "20")):
        return "SZ"
    if symbol.startswith(("83", "87", "88", "43")):
        return "BJ"
    return "SH"


def _is_a_share(symbol):
    return len(symbol) == 6 and symbol.isdigit()


def _business_text_from_row(row_like):
    """把 stock_zyjs_ths / aggregate.json 的 business 字段拼成一段可提取的文本。"""
    parts = [str((row_like.get(k) or "")) for k in ("主营业务", "产品类型", "产品名称", "经营范围")]
    return "。".join(p for p in parts if p)


def fetch_zyjs_text(symbol):
    """现抓一个 A 股代码的主营描述文本（同花顺 stock_zyjs_ths，通道①的数据源，
    也是候选阶段"主营节选"/hint 的数据源）。

    非 6 位数字的 A 股代码（如港股 5 位代码）直接返回 None——这条通道本就只覆盖 A 股，
    港股的主营描述走的是另一套 aggregate.json 字段（见 lib.py 里港股 pipeline 的写法）。
    """
    if not _is_a_share(symbol):
        return None
    import akshare as ak

    df = ak.stock_zyjs_ths(symbol=symbol)
    if df is None or len(df) == 0:
        return None
    return _business_text_from_row(df.iloc[0].to_dict())


def _name_match_keywords(term):
    """从一个品种词生成一组**确定性**的候选匹配串：只依赖 term 自身的字符，
    不依赖"当日名录里这个串命中了多少家"——后者是评审 Important 3 指出的真实问题：
    按命中数自适应收缩前缀，命中数落在 (0,20] 就停，这个区间边界会因为名录当天
    多一家/少一家（比如一次 IPO）而把前缀再缩一位，候选集整体换掉，同一个品种词
    今天和明天可能查出完全不同的公司——这与"本地数据层结果可复现，天然进最高档"
    这条五档体系的前提直接冲突。

    改用固定规则：完整品种词本身，加上它固定的 2 字后缀（品种词的材料提示尾字
    通常就在最后 2 个字里，如"钨精矿"→"精矿"、"碳化钨粉"→"钨粉"）。不再有任何
    "按命中数决定用哪一级"的分支，同一个 term 无论哪天跑、名录内容如何变化，
    生成的候选串永远相同。代价是短词/前缀式品种词（如单字"钨"）如果本身没有
    在这两个候选串里，就不会被这条通道命中——宁可少召回，也不做不可复现的自适应。
    """
    keywords = [term]
    if len(term) > 2:
        keywords.append(term[-2:])
    seen, out = set(), []
    for k in keywords:
        if k and k not in seen:
            seen.add(k)
            out.append(k)
    return out


def _channel1_name_match(terms, exclude_symbol):
    """通道①：主营描述匹配。

    没有 push2、也没有"按品种词搜全市场主营描述"的现成接口，改成两步近似：
    1) 用交易所官方代码名录（stock_info_a_code_name，源头是 SSE/SZSE/BSE 官网，
       不经过 push2）按 _name_match_keywords 生成的确定性候选串做名称粗筛。
    2) 这一步只找候选，不做判断——判断"是不是同品种"移交调用方 agent（Ruling
       T3-8）。候选的主营描述文本由 main() 另外抓来算 hint、截成"主营节选"。

    只处理含中文字符的品种词（"WO3""65%"这类不含中文的提取物做名称匹配没有意义）。

    返回 (candidates, matched_keywords)：matched_keywords 记录本次实际命中、
    用来找到候选的匹配词，写进产物里供追溯（评审 Important 3 要求"结果可追溯"）。
    """
    import akshare as ak

    universe = ak.stock_info_a_code_name()
    seen_codes = {}
    matched_keywords = []
    for term in terms:
        if not re.search(r"[一-鿿]", term):
            continue
        for kw in _name_match_keywords(term):
            matched = universe[universe["name"].str.contains(kw, regex=False, na=False)]
            if len(matched) == 0:
                continue
            matched_keywords.append(kw)
            for _, row in matched.iterrows():
                code = str(row["code"]).strip()
                if code == exclude_symbol or code in seen_codes:
                    continue
                seen_codes[code] = {"code": code, "market": "CN", "name": str(row["name"]).strip()}
            break  # 这个词已经用固定优先级（整词优先于 2 字后缀）找到匹配，换下一个品种词
    return list(seen_codes.values()), matched_keywords


def _channel2_industry_compare(symbol):
    """通道②：行业成员，datacenter.eastmoney.com「同行比较」（非 push2，已实测）。

    注意：这个接口返回的是「以该股票为锚的排名近邻窗口」（约 8 行：行业中值/
    行业平均 + 排名相邻的几家），不是完整行业名单——见模块 docstring 的实测记录。

    返回 (candidates, meta)：meta 恒为 {}，与通道①③保持统一形状，方便 main() 里
    用同一套循环处理三个通道。
    """
    import akshare as ak

    prefix = _exchange_prefix(symbol)
    df = ak.stock_zh_valuation_comparison_em(symbol=f"{prefix}{symbol}")
    out = []
    for _, row in df.iterrows():
        code = str(row.get("代码", "")).strip()
        name = str(row.get("简称", "")).strip()
        if not code.isdigit() or len(code) != 6 or code == symbol:
            continue  # 跳过"行业中值"/"行业平均"这两行伪代码行，以及自身
        out.append({"code": code, "market": "CN", "name": name})
    return out, {}


def _channel3_board(terms, exclude_symbol):
    """通道③：概念/行业板块成员，stock_board_*_em——全走 push2。

    本环境已实测 push2 族连接被重置（见 tools/probe_endpoints.py），这里保留
    真实实现而非 stub：一旦 push2 恢复，这条通道不需要重写就能生效。

    Ruling T3-4：按板块名匹配品种词，语义上才是最直接的发现通道（比通道①的
    "拿品种词去猜公司名"更贴近"这个品种归属哪个板块"这个问题本身）——现在只是
    因为压在 push2 上暂时不可用才被排到最后。push2 恢复后，这条通道应该升级为
    主通道，通道①的名称匹配退回兜底角色。

    返回 (candidates, meta)：meta 恒为 {}，与通道①②保持统一形状。
    """
    import akshare as ak

    boards = []
    for kind, name_fn in (("concept", ak.stock_board_concept_name_em),
                           ("industry", ak.stock_board_industry_name_em)):
        try:
            boards.append((kind, name_fn()))
        except Exception:
            continue
    if not boards:
        raise RuntimeError("push2 板块列表（概念+行业）均不可用")

    out = {}
    for kind, df in boards:
        name_col = next((c for c in ("板块名称", "名称") if c in df.columns), None)
        if not name_col:
            continue
        cons_fn = ak.stock_board_concept_cons_em if kind == "concept" else ak.stock_board_industry_cons_em
        for term in terms:
            if not re.search(r"[一-鿿]", term):
                continue
            matched_boards = df[df[name_col].str.contains(term, regex=False, na=False)]
            for board_name in matched_boards[name_col]:
                try:
                    cons = cons_fn(symbol=board_name)
                except Exception:
                    continue
                code_col = next((c for c in ("代码", "股票代码") if c in cons.columns), None)
                name_col2 = next((c for c in ("名称", "股票简称") if c in cons.columns), None)
                if not code_col:
                    continue
                for _, row in cons.iterrows():
                    code = str(row[code_col]).strip()
                    if code == exclude_symbol or code in out:
                        continue
                    out[code] = {"code": code, "market": "CN", "name": str(row.get(name_col2, "")).strip()}
    return list(out.values()), {}


def _to_float(v):
    try:
        if v is None:
            return None
        f = float(v)
        return f if f == f else None  # 过滤 NaN
    except (TypeError, ValueError):
        return None


def _fill_valuation(row):
    """同业估值口径：stock_value_em 最新一行的 PE(TTM)/市净率/市销率。

    只在确认阶段（--confirm）对 keep=True 的行调用——候选阶段不取估值，
    避免为还没被确认的候选浪费网络调用（Ruling T3-8）。

    评审 round 2 Minor 4 的残留：非 A 股行（brief 举的例子是 Almonty，NASDAQ:
    ALM，人工入口 manual=True 补进来的境外同业）原来靠 market != "CN" 直接
    return，PE_TTM/PB/PS 三个键都不写，行为对下游"静默"——从产物里看不出这行
    是"估值缺失"还是"压根没试过"。改为显式标注：写 valuation_err 说明原因，
    PE_TTM/PB/PS 仍然不写（median_multiples 靠 dict.get 缺键即视为 None，
    天然排除出中位数），但原因不再是沉默的。

    非 A 股行走这条早退路径时**不需要 akshare**——import 挪到这条检查之后，
    是因为它曾经在检查之前，导致 manual=True 的非 A 股行（比如 Almonty）单独
    测试时也会因为 `import akshare` 而失败，即使实际用不到它。
    """
    if row.get("market") != "CN" or not _is_a_share(row["code"]):
        row["valuation_err"] = (
            "估值需人工提供：非 A 股（market="
            f"{row.get('market')}），stock_value_em 覆盖不到，本文件不联网找境外估值"
        )
        return
    import akshare as ak

    try:
        ve = ak.stock_value_em(symbol=row["code"])
        if ve is None or len(ve) == 0:
            row["valuation_err"] = "stock_value_em 返回空"
            return
        last = ve.iloc[-1]
        row["PE_TTM"] = _to_float(last.get("PE(TTM)"))
        row["PB"] = _to_float(last.get("市净率"))
        row["PS"] = _to_float(last.get("市销率"))
        row["估值日期"] = str(last.get("数据日期"))
    except Exception as e:
        row["valuation_err"] = str(e)


def _extract_terms_for_symbol(symbol, out_dir, explicit_terms):
    """L1 品种提取：**--terms 是主路径**（Ruling T3-6，调用方/LLM agent 显式指定
    品种词）；没给 --terms 才退回正则兜底——读 aggregate.json 的 business，缺失就
    现抓 stock_zyjs_ths（仅 A 股）。正则兜底已用真实数据证明会产出噪声词（见
    extract_product_terms 的 docstring），生产路径应该总是传 --terms。"""
    if explicit_terms:
        terms = [t.strip() for t in re.split(r"[,，、]", explicit_terms) if t.strip()]
        print(f"  品种词（--terms 直接指定）：{terms}", file=sys.stderr)
        return terms

    text = ""
    agg_path = out_dir / "aggregate.json"
    if agg_path.exists():
        try:
            agg = json.loads(agg_path.read_text(encoding="utf-8"))
            biz = agg.get("business") or {}
            if biz:
                text = _business_text_from_row(biz)
        except Exception as e:
            print(f"  {agg_path} 解析失败（{e}），降级为现抓", file=sys.stderr)

    if not text:
        reason = "aggregate.json 不存在" if not agg_path.exists() else "aggregate.json 无主营描述"
        print(f"  {reason}，降级为现抓 stock_zyjs_ths（{symbol}）", file=sys.stderr)
        try:
            text = fetch_zyjs_text(symbol) or ""
        except Exception as e:
            print(f"  现抓主营描述失败：{e}", file=sys.stderr)

    terms = extract_product_terms(text)
    print(f"  品种词（从主营描述提取）：{terms}", file=sys.stderr)
    return terms


def _is_self_code(code, symbol):
    """确认清单里的某个代码是不是标的自己。

    只做去空白 + 大小写归一的精确比较：本文件的检索通道只覆盖 A 股，代码恒为 6 位
    数字，不需要处理前导零/交易所后缀那些变体。宽松匹配（例如去前导零）反而会把
    000657 与 657 这类不同标的判成同一个——误排除一家真同业，比漏排除标的自己更糟。
    """
    return bool(symbol) and code.strip().upper() == symbol.strip().upper()


def _run_confirm_phase(cache_path, confirm_arg, today, symbol):
    """确认阶段（Ruling T3-8）：给定一份 agent 已经判断过"同品种"的代码清单，
    只对这些代码取估值、算中位数、写最终产物。keep=True 只可能来自这里
    （或 manual=True）——候选阶段算出的 hint 从不单独驱动 keep。

    候选清单里没被选中的代码保留在产物里但标 keep=False——不静默丢弃，
    人工/agent 复核时看得见"曾经是候选、但没被确认"这件事。

    退出码按"确认后 keep=True 的条数"判，不按候选/合并后的列表是否非空判
    （round 2 Important 3 定的规矩，这里延续）：零条 → exit 1。

    标的自身若出现在确认清单里（或以 manual 条目的形式混进来），一律排除出中位数：
    一家公司不是自己的同业，把自己算进中位数会把中位数往自己身上拉，偏离度当场失真
    （Task 8 验收 Step 3 就把 600549 算进了它自己的中位数）。排除动作是**大声**的：
    产物里那一行留着但 keep=False、reason 写明原因，stderr 打警告说明排除了谁、
    中位数基于几家——静默剔除会让人以为样本数本来就那么多。
    """
    confirmed_codes = [c.strip() for c in re.split(r"[,，、]", confirm_arg or "") if c.strip()]
    print(f"  确认清单：{confirmed_codes}", file=sys.stderr)

    existing = {}
    if Path(cache_path).exists():
        try:
            existing = json.loads(Path(cache_path).read_text(encoding="utf-8"))
        except Exception as e:
            print(f"  读取候选缓存失败（{e}），当作没有候选历史", file=sys.stderr)
    existing_peers = existing.get("peers", [])
    terms = existing.get("品种词")
    candidate_by_code = {r["code"]: r for r in existing_peers if not r.get("manual")}

    result_rows = []
    seen = set()
    for code in confirmed_codes:
        if code in seen:
            continue
        seen.add(code)
        base = candidate_by_code.get(code) or {
            "code": code, "market": "CN" if _is_a_share(code) else "UNKNOWN", "name": "",
        }
        row = {**base, "keep": True, "reason": "agent 确认为同品种", "manual": False}
        _fill_valuation(row)
        result_rows.append(row)

    for code, base in candidate_by_code.items():
        if code in seen:
            continue
        result_rows.append({**base, "keep": False, "reason": "候选存在但未在确认清单里", "manual": False})

    merged = merge_preserving_manual(cache_path, result_rows)

    # round 2 Minor 6 遗留：manual 行（比如非 A 股的 Almonty）可能从没被填过
    # 估值，这里统一补一次——幂等，已有 PE_TTM/valuation_err 的行不会被重复抓取。
    for row in merged:
        if row.get("keep") and "PE_TTM" not in row and "valuation_err" not in row:
            _fill_valuation(row)

    keep_rows = [r for r in merged if r.get("keep")]

    # 标的自身不进中位数。判据放在 keep_rows 上而不是只筛 confirmed_codes：
    # 人工 manual 条目同样可能把标的自己塞进来，两条路都要堵。
    self_rows = [r for r in keep_rows if _is_self_code(r.get("code", ""), symbol)]
    if self_rows:
        for r in self_rows:
            r["keep"] = False
            r["reason"] = f"标的自身（{symbol}），不计入同业中位数"
            r["is_self"] = True
        keep_rows = [r for r in keep_rows if not _is_self_code(r.get("code", ""), symbol)]
        print(
            f"WARN: 确认清单里含标的自身 {symbol}，已从中位数计算中排除"
            f"（一家公司不是自己的同业）。中位数将基于其余 {len(keep_rows)} 家。",
            file=sys.stderr,
        )

    if not keep_rows:
        label = "确认清单为空" if not confirmed_codes else "确认清单里没有一条留在 keep=True"
        out = {
            "状态": "已确认", "生成日期": today, "品种词": terms, "通道": label,
            "peers": merged, "中位数": {"PE_TTM": None, "PB": None, "PS": None},
        }
        cache_path.write_text(json.dumps(out, ensure_ascii=False, indent=2, default=str), encoding="utf-8")
        print("FATAL: 零条确认同业。", file=sys.stderr)
        sys.exit(1)

    medians = median_multiples(keep_rows)
    median_sample_counts = {
        field: sum(1 for r in keep_rows if r.get(field) not in (None, 0))
        for field in ("PE_TTM", "PB", "PS")
    }
    out = {
        "状态": "已确认", "生成日期": today, "品种词": terms,
        "通道": "agent 确认（--confirm）",
        "peers": merged, "中位数": medians, "中位数_样本数": median_sample_counts,
        "中位数_家数": len(keep_rows),
        "已排除标的自身": [r["code"] for r in self_rows],
    }
    cache_path.write_text(json.dumps(out, ensure_ascii=False, indent=2, default=str), encoding="utf-8")
    print(f"  wrote {cache_path}", file=sys.stderr)
    print(f"确认同业 {len(keep_rows)} 家（另有 {len(merged) - len(keep_rows)} 条留在产物里 keep=False"
          + (f"，其中标的自身 {len(self_rows)} 条" if self_rows else "") + "）")
    print(f"中位数 PE_TTM={medians['PE_TTM']}  PB={medians['PB']}  PS={medians['PS']}  "
          f"样本数 PE={median_sample_counts['PE_TTM']}/PB={median_sample_counts['PB']}/"
          f"PS={median_sample_counts['PS']}")

    if all(v is None for v in medians.values()):
        sys.exit(2)
    sys.exit(0)


def main():
    parser = argparse.ArgumentParser(
        description="动态同业检索——两阶段（Ruling T3-8）：先产出候选供 agent 判断"
                     "是不是同品种，再用 --confirm 回填确认结果算中位数")
    parser.add_argument("symbol", help="6 位 A 股代码（本文件的检索通道目前只覆盖 A 股）")
    parser.add_argument("--root", default=None, help="数据根目录，默认 <repo>/data")
    parser.add_argument("--force", action="store_true", help="候选阶段：忽略今日缓存，强制重跑")
    parser.add_argument("--terms", default=None,
                         help="候选阶段用：品种词（逗号/顿号分隔）——调用方（Task 5 的板块基准"
                              "LLM agent）的主路径，见 Ruling T3-6。不传时退回本文件自带的正则"
                              "兜底（extract_product_terms），已用真实数据证明会产出噪声词，"
                              "只适合本地无 LLM 时探测/调试")
    parser.add_argument("--confirm", default=None,
                         help="确认阶段（Ruling T3-8）：给定一份已经由 agent 判断过'同品种'的"
                              "代码清单（逗号/顿号分隔），只对这些代码取估值、算中位数、写最终"
                              "产物。传了这个参数就跳过候选发现，直接进确认阶段——候选阶段的"
                              "hint/主营节选 仅供参考，从不单独驱动 keep=True。"
                              "标的自身写进清单也没用：它会被排除出中位数并打警告——"
                              "一家公司不是自己的同业")
    args = parser.parse_args()

    symbol = args.symbol.strip()
    data_root = Path(args.root) if args.root else (ROOT / "data")
    out_dir = data_root / symbol
    out_dir.mkdir(parents=True, exist_ok=True)
    cache_path = out_dir / "peers_curated.json"
    today = date.today().isoformat()

    if args.confirm is not None:
        # 确认阶段永远执行，不受候选阶段的"今日缓存"判断影响——这是一次显式的
        # 确认动作，跟 --force 一样是调用方主动要求的事，不该被幂等跳过。
        _run_confirm_phase(cache_path, args.confirm, today, symbol)
        return

    if not args.force and cache_path.exists():
        try:
            cached = json.loads(cache_path.read_text(encoding="utf-8"))
            if cached.get("生成日期") == today:
                print(f"  候选缓存已是今天（{today}）生成，跳过。用 --force 强制重跑。",
                      file=sys.stderr)
                sys.exit(0)
        except Exception:
            pass  # 缓存损坏就当不存在，往下重新生成

    # L1：品种提取
    terms = _extract_terms_for_symbol(symbol, out_dir, args.terms)
    if not terms:
        print("FATAL: 一个品种词都没提取到，无法检索同业。", file=sys.stderr)
        sys.exit(1)

    # L2：多通道候选检索（依次尝试①②③，每个通道独立 try/except，失败或空结果
    # 就降级到下一个；③命中 push2，本环境预期会失败）。
    #
    # Ruling T3-8 之后，这里不再做"确认"——候选是不是真同品种交给 agent 判断，
    # 所以停在第一个非空通道就够了（round 2 Important 2 那套"用确认通过数决定
    # 要不要继续试下一个通道"的逻辑，连同 _confirm_peer 一起被 Ruling T3-8
    # 取消了：既然这一层不判断"是不是真同业"，也就没有"这个通道全是噪声"这个
    # 概念可用来触发降级）。
    channel_errors = {}
    channel_meta = {}
    candidates = []
    channel_used = None
    for label, fn in (
        ("①", lambda: _channel1_name_match(terms, symbol)),
        ("②", lambda: _channel2_industry_compare(symbol)),
        ("③", lambda: _channel3_board(terms, symbol)),
    ):
        try:
            result, meta = fn()
        except Exception as e:
            channel_errors[label] = str(e)
            print(f"  通道{label} ERR：{e}", file=sys.stderr)
            continue
        if meta:
            channel_meta[label] = meta
        print(f"  通道{label}：{len(result)} 候选", file=sys.stderr)
        if result:
            candidates = result
            channel_used = label
            break

    if not candidates:
        print("  所有通道均未找到候选。", file=sys.stderr)

    # L3 曾经在这里做"确认"（_confirm_peer 判 keep=True/False）。Ruling T3-8：
    # 移交调用方 agent。这里只算一个 hint（仅供参考排序）+ 截一段主营节选，
    # keep 恒为 None（未决），估值也不在这一步取——等 --confirm 回填。
    fresh_rows = []
    for c in candidates:
        try:
            text = fetch_zyjs_text(c["code"]) or ""
        except Exception as e:
            text = ""
            print(f"    {c['code']} 主营描述获取失败：{e}", file=sys.stderr)
        fresh_rows.append(_build_candidate_row(c, text, terms))
        time.sleep(0.3)

    merged = merge_preserving_manual(cache_path, fresh_rows)

    if not merged:
        out = {
            "状态": "候选待确认", "生成日期": today, "品种词": terms,
            "通道": "无候选（所有通道均为空或失败）",
            "peers": [], "中位数": {"PE_TTM": None, "PB": None, "PS": None},
            "channel_errors": channel_errors, "channel_meta": channel_meta,
        }
        cache_path.write_text(json.dumps(out, ensure_ascii=False, indent=2, default=str), encoding="utf-8")
        print("FATAL: 一个候选都没找到（也没有 manual 条目）。", file=sys.stderr)
        sys.exit(1)

    out = {
        "状态": "候选待确认",
        "生成日期": today,
        "品种词": terms,
        "通道": channel_used or "无（仅 manual 条目）",
        "peers": merged,
        "中位数": {"PE_TTM": None, "PB": None, "PS": None},
        "channel_errors": channel_errors,
        "channel_meta": channel_meta,
    }
    cache_path.write_text(json.dumps(out, ensure_ascii=False, indent=2, default=str), encoding="utf-8")
    print(f"  wrote {cache_path}", file=sys.stderr)
    print(f"品种词：{terms}")
    print(f"通道：{channel_used}  候选 {len(merged)} 条，keep 全部为 null，等待 --confirm 回填。")
    for r in merged:
        if not r.get("manual"):
            print(f"  {r['code']} {r.get('name', '')}  hint={r.get('hint', '')}")
    sys.exit(0)


if __name__ == "__main__":
    main()
