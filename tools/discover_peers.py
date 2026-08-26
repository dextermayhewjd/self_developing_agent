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
再用 stock_zyjs_ths 逐个读主营描述确认「同品种」——粗筛+确认两步都在通道①内，
这是本文件里唯一没有在 brief 里给出完整算法、需要自己设计的部分。

没有 LLM 可用（本文件是纯 stdlib+akshare 脚本，不是 agent），L3「LLM 确认」在这里
退化成确定性的关键词命中检查（_confirm_peer）——命中就 keep=True，没命中就
keep=False 但仍然留在名单里如实写 reason，不静默丢弃，人工复核时看得见。

用法：python3 tools/discover_peers.py <SYMBOL> [--root DIR] [--force] [--terms 词1,词2]
退出码：0 产出成功 / 1 一个同业都没找到 / 2 找到了但估值口径缺失
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


def extract_product_terms(text):
    """从主营描述里提品种词。

    规则刻意保守：先按标点切段，再把段内的停用词（从事/主要/开采/销售……）当成
    额外分隔符切掉，剩下的碎片才当候选——这样「本公司主要从事钨精矿的开采」这类
    夹在动词短语中间的品种词也能被单独取出来，而不必要求整段恰好是品种词。
    候选还要满足 2–8 字、且含材料类提示字（矿/砂/粉/材料/芯/片/药/械/设备/酒/
    器/件/电池/组件）或形如「WO3」的字母数字代号，宁可少提也不要提出「销售」
    这种词——检索面一旦撑爆，确认阶段的成本会失控。
    """
    terms = []
    for chunk in re.split(r"[，。、；;,\s]+", text or ""):
        chunk = chunk.strip()
        if not chunk:
            continue
        for piece in _STOPWORD_PATTERN.split(chunk):
            piece = piece.strip()
            if not (2 <= len(piece) <= 8):
                continue
            if re.search(r"[矿砂粉材料芯片药械设备酒器件电池组件]", piece) or re.search(r"[A-Z0-9]{2,}", piece):
                terms.append(piece)
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
    Almonty），不做「维护一整张分类表」。
    """
    manual = []
    if Path(cache_path).exists():
        old = json.loads(Path(cache_path).read_text(encoding="utf-8"))
        manual = [r for r in old.get("peers", []) if r.get("manual")]
    manual_codes = {r["code"] for r in manual}
    return manual + [r for r in fresh_rows if r["code"] not in manual_codes]


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
    """现抓一个 A 股代码的主营描述文本（同花顺 stock_zyjs_ths，通道①的数据源）。

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


def _channel1_name_match(terms, exclude_symbol):
    """通道①：主营描述匹配。

    没有 push2、也没有"按品种词搜全市场主营描述"的现成接口，改成两步近似：
    1) 用交易所官方代码名录（stock_info_a_code_name，源头是 SSE/SZSE/BSE 官网，
       不经过 push2）按品种词的字符前缀做名称粗筛——品种词整词命中公司名的概率
       很低（"钨精矿"不会出现在股票简称里），所以从整词开始，命中为空就逐字缩短
       前缀，直到命中数落在 (0, 20] 的合理区间再停（区间上限是防止退化到单字后
       命中几百家，把检索面撑爆）。
    2) 对粗筛出的候选，实际调用 stock_zyjs_ths 读主营描述——这一步才是「主营描述
       匹配」字面意思，也顺带充当 L3 确认（没有 LLM，退化成关键词命中，见
       _confirm_peer）。

    只处理含中文字符的品种词（"WO3""65%"这类不含中文的提取物做名称匹配没有意义）。
    """
    import akshare as ak

    universe = ak.stock_info_a_code_name()
    seen_codes = {}
    for term in terms:
        if not re.search(r"[一-鿿]", term):
            continue
        for cut in range(len(term), 0, -1):
            prefix = term[:cut]
            matched = universe[universe["name"].str.contains(prefix, regex=False, na=False)]
            if 0 < len(matched) <= 20:
                for _, row in matched.iterrows():
                    code = str(row["code"]).strip()
                    if code == exclude_symbol or code in seen_codes:
                        continue
                    seen_codes[code] = {"code": code, "market": "CN", "name": str(row["name"]).strip()}
                break  # 这个词已经找到合适的前缀长度，不用再缩短
    return list(seen_codes.values())


def _channel2_industry_compare(symbol):
    """通道②：行业成员，datacenter.eastmoney.com「同行比较」（非 push2，已实测）。

    注意：这个接口返回的是「以该股票为锚的排名近邻窗口」（约 8 行：行业中值/
    行业平均 + 排名相邻的几家），不是完整行业名单——见模块 docstring 的实测记录。
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
    return out


def _channel3_board(terms, exclude_symbol):
    """通道③：概念/行业板块成员，stock_board_*_em——全走 push2。

    本环境已实测 push2 族连接被重置（见 tools/probe_endpoints.py），这里保留
    真实实现而非 stub：一旦 push2 恢复，这条通道不需要重写就能生效。
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
    return list(out.values())


def _confirm_peer(code, terms):
    """L3「LLM 确认」的确定性近似：没有 LLM 可用，退化成关键词命中检查。

    读候选自己的主营描述，看是否含品种词（或品种词的字符前缀，兜底"钨精矿"
    vs"钨钼、稀土……"这类不完全重合但确属同品种的表述）。没命中不静默丢弃，
    仍然写进名单但 keep=False，reason 如实说明——人工复核时看得见、也补得上。
    """
    try:
        text = fetch_zyjs_text(code) or ""
    except Exception as e:
        return False, f"主营描述获取失败：{e}"
    if not text:
        return False, "该代码取不到主营描述（非 A 股或 stock_zyjs_ths 无数据）"
    for term in terms:
        if term in text:
            return True, f"主营含「{term}」"
    for term in terms:
        for cut in range(min(len(term), 2), 0, -1):
            prefix = term[:cut]
            if re.search(r"[一-鿿]", prefix) and prefix in text:
                return True, f"主营含「{prefix}」（品种词「{term}」的前缀）"
    return False, "主营描述未命中任何品种词"


def _to_float(v):
    try:
        if v is None:
            return None
        f = float(v)
        return f if f == f else None  # 过滤 NaN
    except (TypeError, ValueError):
        return None


def _fill_valuation(row):
    """同业估值口径：stock_value_em 最新一行的 PE(TTM)/市净率/市销率。"""
    import akshare as ak

    if row.get("market") != "CN" or not _is_a_share(row["code"]):
        return
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
    """L1 品种提取：优先 --terms；否则读 aggregate.json 的 business；
    aggregate.json 缺失或无主营描述时降级为现抓 stock_zyjs_ths（仅 A 股）。"""
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


def main():
    parser = argparse.ArgumentParser(
        description="动态同业检索——从主营描述提品种词，多通道检索同业，算板块中位数")
    parser.add_argument("symbol", help="6 位 A 股代码（本文件的检索通道目前只覆盖 A 股）")
    parser.add_argument("--root", default=None, help="数据根目录，默认 <repo>/data")
    parser.add_argument("--force", action="store_true", help="忽略今日缓存，强制重跑")
    parser.add_argument("--terms", default=None,
                         help="直接指定品种词（逗号/顿号分隔），跳过 aggregate.json 提取——"
                              "用于本地没有 data/{symbol}/aggregate.json 时验证通道")
    args = parser.parse_args()

    symbol = args.symbol.strip()
    data_root = Path(args.root) if args.root else (ROOT / "data")
    out_dir = data_root / symbol
    out_dir.mkdir(parents=True, exist_ok=True)
    cache_path = out_dir / "peers_curated.json"

    today = date.today().isoformat()
    if not args.force and cache_path.exists():
        try:
            cached = json.loads(cache_path.read_text(encoding="utf-8"))
            if cached.get("生成日期") == today:
                print(f"  缓存已是今天（{today}）生成，跳过。用 --force 强制重跑。", file=sys.stderr)
                sys.exit(0)
        except Exception:
            pass  # 缓存损坏就当不存在，往下重新生成

    # L1：品种提取
    terms = _extract_terms_for_symbol(symbol, out_dir, args.terms)
    if not terms:
        print("FATAL: 一个品种词都没提取到，无法检索同业。", file=sys.stderr)
        sys.exit(1)

    # L2：多通道候选检索（依次尝试①②③，每个通道独立 try/except，
    # 失败或空结果就降级到下一个；③命中 push2，本环境预期会失败）。
    channel_errors = {}
    candidates = []
    channel_used = None
    for label, fn in (
        ("①", lambda: _channel1_name_match(terms, symbol)),
        ("②", lambda: _channel2_industry_compare(symbol)),
        ("③", lambda: _channel3_board(terms, symbol)),
    ):
        try:
            result = fn()
        except Exception as e:
            channel_errors[label] = str(e)
            print(f"  通道{label} ERR：{e}", file=sys.stderr)
            continue
        print(f"  通道{label}：{len(result)} 候选", file=sys.stderr)
        if result:
            candidates = result
            channel_used = label
            break

    if not candidates:
        print("  所有通道均未找到候选。", file=sys.stderr)

    # L3：确认（无 LLM，退化为关键词命中）+ 同业估值口径
    fresh_rows = []
    for c in candidates:
        keep, reason = _confirm_peer(c["code"], terms)
        row = {**c, "keep": keep, "reason": reason, "manual": False}
        if keep:
            _fill_valuation(row)
        fresh_rows.append(row)
        time.sleep(0.3)

    merged = merge_preserving_manual(cache_path, fresh_rows)

    if not merged:
        out = {
            "生成日期": today, "品种词": terms, "通道": channel_used or "无",
            "peers": [], "中位数": {"PE_TTM": None, "PB": None, "PS": None},
            "channel_errors": channel_errors,
        }
        cache_path.write_text(json.dumps(out, ensure_ascii=False, indent=2, default=str), encoding="utf-8")
        print("FATAL: 一个同业都没找到。", file=sys.stderr)
        sys.exit(1)

    keep_rows = [r for r in merged if r.get("keep")]
    medians = median_multiples(keep_rows)

    out = {
        "生成日期": today,
        "品种词": terms,
        "通道": channel_used or "无（仅人工条目）",
        "peers": merged,
        "中位数": medians,
        "channel_errors": channel_errors,
    }
    cache_path.write_text(json.dumps(out, ensure_ascii=False, indent=2, default=str), encoding="utf-8")
    print(f"  wrote {cache_path}", file=sys.stderr)
    print(f"品种词：{terms}")
    print(f"通道：{channel_used}  同业 {len(merged)} 家（keep={len(keep_rows)}）")
    print(f"中位数 PE_TTM={medians['PE_TTM']}  PB={medians['PB']}  PS={medians['PS']}")

    if all(v is None for v in medians.values()):
        sys.exit(2)
    sys.exit(0)


if __name__ == "__main__":
    main()
