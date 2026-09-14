"""判定一个大宗品种的「分析形态」：单一标准品 还是 多形态产业链。

这个判定决定第五节要不要做「外部环节表」，以及做到什么深度：

  单一标准品   —— 定价锚是交易所或公认基准报价（铜铝锌铅锡镍金银）。
                  链上其余环节只需记账级：它分走多少原料 / 它吸收多少产出。
  多形态产业链 —— 同一品种按化合物或加工形态分别报价，各环节价格与利润独立
                  （钨钼钒钛锰锆）。本环售价往往是相邻环报价的折扣价，
                  那一环无条件必做。

**判定的依据是「这个品种有几个独立报价品」，不是行业名，也不是中金的分类。**
中金分类树只作交叉校验：一致提高信心，不一致是信号（说明我们或它有一方看错了），
两种情况都打印。它不参与判定本身——`docs/reference/` 那份快照的用法限制写明
「用作设计参照与校验，不得直接当配置用」。

用法：
    python3 tools/variety_shape.py 钨
    python3 tools/variety_shape.py 钨 --priced 钨精矿,仲钨酸铵,钨粉,碳化钨
    python3 tools/variety_shape.py 铜 --priced 电解铜

退出码：
    0 = 判定完成
    2 = 证据不足（没给 --priced，且快照里也没有该品种）——需要先去查报价品
    1 = 用法错误或快照文件损坏
"""

import argparse
import json
import sys
from pathlib import Path

SNAPSHOT = Path(__file__).resolve().parent.parent / "docs/reference/中金行业体系-分类树-20260827.json"

# 指标词：子节点名里出现这些，说明该层切的是「指标」而不是「形态」
INDICATOR_WORDS = [
    "价格", "产量", "产能", "库存", "进口", "出口", "进出口", "开工",
    "表观消费", "消费量", "成本", "利润", "需求", "供给", "销量", "产销",
    "运价", "价差", "加工费", "毛利", "储量", "持仓", "景气", "ETF",
]

SINGLE = "单一标准品"
MULTI = "多形态产业链"
UNKNOWN = "未确定"


def load_snapshot():
    """返回 nodes 列表；快照缺失或损坏时返回 None（不让交叉校验拖垮判定）。"""
    if not SNAPSHOT.exists():
        return None
    try:
        return json.loads(SNAPSHOT.read_text(encoding="utf-8"))["nodes"]
    except (json.JSONDecodeError, KeyError, UnicodeDecodeError) as e:
        print(f"[WARN] 快照损坏，跳过交叉校验：{e}", file=sys.stderr)
        return None


def cicc_axis(variety, nodes):
    """快照里该品种子节点的轴向。返回 (形态, 子节点名列表) 或 (None, [])。"""
    if not nodes:
        return None, []
    hits = [n for n in nodes if n.get("name") == variety]
    if not hits:
        return None, []
    # 同名多节点时取子节点最多的那个（避免撞上「个股数据」下面的同名分组）
    best, best_kids = None, []
    for h in hits:
        kids = [n.get("name", "") for n in nodes if n.get("parentId") == h.get("id")]
        if len(kids) > len(best_kids):
            best, best_kids = h, kids
    if not best_kids:
        return None, []
    ratio = sum(1 for k in best_kids if any(w in k for w in INDICATOR_WORDS)) / len(best_kids)
    # 阈值与全量扫描时一致：>=0.6 指标轴、<=0.2 形态轴、中间不表态
    if ratio >= 0.6:
        return SINGLE, best_kids
    if ratio <= 0.2:
        return MULTI, best_kids
    return UNKNOWN, best_kids


def judge(priced):
    """由「独立报价品个数」判形态。这是唯一的判定依据。"""
    n = len(priced)
    if n == 0:
        return UNKNOWN
    return MULTI if n >= 2 else SINGLE


def main():
    ap = argparse.ArgumentParser(description="判定大宗品种的分析形态")
    ap.add_argument("variety", help="品种名，如 钨 / 铜 / 碳酸锂")
    ap.add_argument(
        "--priced",
        default="",
        help="该品种下**分别独立报价**的产品名，逗号分隔。"
        "判据是「说『X 价』时要不要追问是哪种 X」——要追问就是多个。",
    )
    args = ap.parse_args()

    priced = [s.strip() for s in args.priced.split(",") if s.strip()]
    verdict = judge(priced)

    nodes = load_snapshot()
    cicc, kids = cicc_axis(args.variety, nodes)

    print(f"品种：{args.variety}")
    if priced:
        print(f"独立报价品（{len(priced)}）：{' · '.join(priced)}")
        print(f"判定：{verdict}")
    else:
        print("独立报价品：未提供")
        print(f"判定：{UNKNOWN}——先去查「说『{args.variety}价』时要不要追问是哪一种」")

    # ---- 交叉校验（不参与判定）----
    if cicc is None:
        print("交叉校验：中金快照里没有这个品种，无法校验")
    else:
        print(f"交叉校验：中金快照该品种为「{cicc}」，子节点 {len(kids)} 个：{' · '.join(kids[:10])}")
        if verdict == UNKNOWN:
            print("  → 判定未做，快照仅供参考，不要拿它当结论")
        elif verdict == cicc:
            print("  → 一致 ✓")
        else:
            print(
                f"  → **不一致**：我们判 {verdict}，快照是 {cicc}。"
                "两边都可能错——快照是 2026-08-27 的第三方分类且只爬到第 4 层；"
                "我们的判定依赖 --priced 是否列全。查清楚再往下走，不要默认哪一边对"
            )

    if verdict == UNKNOWN:
        return 2

    if verdict == MULTI:
        print()
        print("→ 第五节必须做「外部环节表」：先定定价锚在哪一环，再按吨位份额累计到 80% 指派深度档")
    else:
        print()
        print("→ 定价锚不在链上。外部环节表仍要写，但一行说明「锚在交易所/公认基准」+ 其余环节降为记账级即可")
    return 0


if __name__ == "__main__":
    sys.exit(main())
