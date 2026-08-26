#!/usr/bin/env python3
"""数据层接口探针——查清哪些上游主机/接口当前可用。

为什么需要它：数据层散在 run_pipeline / fetch_* 十来个脚本里，上游横跨
eastmoney 的五族主机、sina、同花顺、港交所。任何一族挂掉，症状都是
"某个 fetch 失败"，看不出是网络、代理还是接口改版。这个脚本把上游按主机
分组探一遍，直接告诉你断在哪一层。

实测背景（2026-08-26，sda-dev）：`push2.eastmoney.com` 与 `push2his.eastmoney.com`
整族不通（连接被重置，走不走代理都一样），而同为 eastmoney 的 datacenter /
reportapi / data 全部正常。症状是 A 股行情与个股信息取不到，港股链路却完好——
因为港股走的是 datacenter，一个 push2 都不碰。

两层探测：
  第一层 HTTP：纯 stdlib，不需要 .venv，直接打各主机的真实 API 路径。
               注意必须打真实路径而不是根路径——实测 push2 根路径返回 404
               （说明连得上），真实 API 路径却连接重置，只探根路径会漏报。
  第二层 akshare：需要 .venv。逐个调管线真正在用的函数，确认端到端可用。
               装不上 akshare 就跳过，不影响第一层结论。

用法：
    python3 tools/probe_endpoints.py           # 两层都跑（有 .venv 时）
    python3 tools/probe_endpoints.py --http    # 只跑第一层，纯 stdlib
    python3 tools/probe_endpoints.py --json    # 机器可读

退出码：
    0 = 全通
    1 = 关键接口不可用（run_pipeline 无法产出完整数据）
    2 = 降级（关键接口可用，可选接口有缺失）
"""

import argparse
import contextlib
import json
import os
import socket
import ssl
import sys
import time
import urllib.error
import urllib.request

TIMEOUT = 15
UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120 Safari/537.36"

# 每条探真实 API 路径而非根路径——根路径可能 404 却依然算"连得上"，会漏报。
# critical=True 表示该主机不通就意味着管线产不出完整数据。
HTTP_TARGETS = [
    {
        "host": "push2.eastmoney.com",
        "url": "https://push2.eastmoney.com/api/qt/stock/get?secid=1.600519&fields=f57,f58",
        "used_by": "akshare 个股信息/板块/实时行情（stock_individual_info_em、stock_board_*_em）",
        "critical": True,
    },
    {
        "host": "push2his.eastmoney.com",
        "url": "https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=1.600519&klt=101&fqt=1&beg=20260801&end=20260820&fields1=f1&fields2=f51",
        "used_by": "akshare A 股历史行情（stock_zh_a_hist）",
        "critical": True,
    },
    {
        "host": "datacenter.eastmoney.com",
        "url": "https://datacenter.eastmoney.com/securities/api/data/v1/get?reportName=RPT_HK_F10_FINANCE_GINCOMESTA&pageSize=1",
        "used_by": "fetch_hk_peers.py 港股同业池、港股 F10",
        "critical": True,
    },
    {
        "host": "datacenter-web.eastmoney.com",
        "url": "https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPT_DMSK_TS_STOCK&pageSize=1&columns=ALL",
        "used_by": "akshare 估值/业绩/股东（stock_value_em、stock_yjbb_em、stock_gdfx_*）",
        "critical": True,
    },
    {
        "host": "reportapi.eastmoney.com",
        "url": "https://reportapi.eastmoney.com/report/list?pageSize=1&pageNo=1&beginTime=2026-01-01&endTime=2026-12-31",
        "used_by": "akshare 研报（stock_research_report_em）",
        "critical": False,
    },
    {
        "host": "np-cnotice-stock.eastmoney.com",
        "url": "https://np-cnotice-stock.eastmoney.com/api/content/ann?page_size=1&page_index=1",
        "used_by": "fetch_annual_pdf.py 年报公告",
        "critical": True,
    },
    {
        "host": "money.finance.sina.com.cn",
        "url": "https://money.finance.sina.com.cn/corp/go.php/vFD_FinanceSummary/stockid/600519.phtml",
        "used_by": "akshare 财务报表（stock_financial_report_sina、stock_financial_abstract）",
        "critical": True,
    },
    {
        "host": "basic.10jqka.com.cn",
        "url": "https://basic.10jqka.com.cn/600519/operate.html",
        "used_by": "akshare 主营介绍（stock_zyjs_ths）——discover_peers 的品种提取源",
        "critical": True,
    },
    {
        "host": "www1.hkexnews.hk",
        "url": "https://www1.hkexnews.hk/search/titlesearch.xhtml",
        "used_by": "fetch_hk_filings.py 港交所披露易",
        "critical": True,
    },
]

# 第二层：管线真正调用的 akshare 函数，每个能力挑一个代表。
AK_TARGETS = [
    ("A股 历史行情", "stock_zh_a_hist", lambda ak: ak.stock_zh_a_hist(
        symbol="600519", period="daily", start_date="20260801", end_date="20260820"), True),
    ("A股 个股信息", "stock_individual_info_em", lambda ak: ak.stock_individual_info_em(symbol="600519"), True),
    ("A股 财务摘要", "stock_financial_abstract", lambda ak: ak.stock_financial_abstract(symbol="600519"), True),
    ("A股 估值指标", "stock_value_em", lambda ak: ak.stock_value_em(symbol="600519"), True),
    ("A股 主营介绍", "stock_zyjs_ths", lambda ak: ak.stock_zyjs_ths(symbol="600519"), True),
    ("A股 研报", "stock_research_report_em", lambda ak: ak.stock_research_report_em(symbol="600519"), False),
    ("港股 证券概况", "stock_hk_security_profile_em", lambda ak: ak.stock_hk_security_profile_em(symbol="03858"), True),
    ("汇率 中行", "currency_boc_sina", lambda ak: ak.currency_boc_sina(symbol="美元", start_date="20260801", end_date="20260810"), False),
    # 下面两个只影响 discover_peers 的降级通道③，缺了不致命。
    ("板块 概念列表", "stock_board_concept_name_em", lambda ak: ak.stock_board_concept_name_em(), False),
    ("板块 行业列表", "stock_board_industry_name_em", lambda ak: ak.stock_board_industry_name_em(), False),
]


def probe_http(target):
    """打一次真实 API 路径。任何 2xx/3xx/4xx 都算连通——我们测的是可达性，
    不是业务参数对不对；只有连接层失败（重置/超时/代理拒绝）才算不通。"""
    req = urllib.request.Request(target["url"], headers={"User-Agent": UA})
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
            return True, f"HTTP {r.status}", time.time() - t0
    except urllib.error.HTTPError as e:
        # 4xx/5xx 说明连上了，只是参数不对——对可达性而言是 OK。
        return True, f"HTTP {e.code}", time.time() - t0
    except urllib.error.URLError as e:
        return False, f"{type(e.reason).__name__ if hasattr(e, 'reason') else 'URLError'}: {str(e.reason)[:60]}", time.time() - t0
    except (socket.timeout, ssl.SSLError, ConnectionError) as e:
        return False, f"{type(e).__name__}: {str(e)[:60]}", time.time() - t0
    except Exception as e:
        return False, f"{type(e).__name__}: {str(e)[:60]}", time.time() - t0


def probe_akshare():
    try:
        import warnings
        warnings.filterwarnings("ignore")
        import akshare as ak
    except Exception as e:
        return None, f"akshare 不可用（{type(e).__name__}），跳过第二层"

    rows = []
    for label, fn_name, call, critical in AK_TARGETS:
        t0 = time.time()
        try:
            # akshare 部分接口用 tqdm 往 stderr 打进度条，会把探针输出糊掉。
            # 异常信息来自 raise 而非 stderr，屏蔽它不会丢诊断信息。
            with open(os.devnull, "w") as devnull, contextlib.redirect_stderr(devnull):
                df = call(ak)
            n = len(df) if df is not None else 0
            rows.append({"label": label, "fn": fn_name, "ok": n > 0,
                         "detail": f"{n} 行" if n else "返回空",
                         "critical": critical, "secs": round(time.time() - t0, 1)})
        except Exception as e:
            msg = str(e)
            host = next((w for w in msg.replace("'", " ").split() if "." in w and (
                "eastmoney" in w or "sina" in w or "10jqka" in w or "hkex" in w)), "")
            rows.append({"label": label, "fn": fn_name, "ok": False,
                         "detail": f"{type(e).__name__} {host} {msg[:50]}".strip(),
                         "critical": critical, "secs": round(time.time() - t0, 1)})
    return rows, None


def main():
    p = argparse.ArgumentParser(description="数据层接口探针")
    p.add_argument("--http", action="store_true", help="只跑第一层 HTTP 探测（纯 stdlib）")
    p.add_argument("--json", action="store_true", help="输出 JSON")
    args = p.parse_args()

    result = {"http": [], "akshare": [], "akshare_skipped": None}

    if not args.json:
        print("=" * 78)
        print("第一层：主机可达性（打真实 API 路径）")
        print("=" * 78)

    for t in HTTP_TARGETS:
        ok, detail, secs = probe_http(t)
        result["http"].append({**{k: t[k] for k in ("host", "used_by", "critical")},
                               "ok": ok, "detail": detail, "secs": round(secs, 1)})
        if not args.json:
            mark = "✓" if ok else "✗"
            tag = "关键" if t["critical"] else "可选"
            print(f"  {mark} [{tag}] {t['host']:<34} {detail:<28} {secs:.1f}s")
            if not ok:
                print(f"        └ 影响：{t['used_by']}")

    if not args.http:
        if not args.json:
            print()
            print("=" * 78)
            print("第二层：akshare 端到端（管线真正调用的函数）")
            print("=" * 78)
        rows, skipped = probe_akshare()
        if skipped:
            result["akshare_skipped"] = skipped
            if not args.json:
                print(f"  ⚠ {skipped}")
        else:
            result["akshare"] = rows
            if not args.json:
                for r in rows:
                    mark = "✓" if r["ok"] else "✗"
                    tag = "关键" if r["critical"] else "可选"
                    print(f"  {mark} [{tag}] {r['label']:<16} {r['fn']:<34} {r['detail'][:40]:<40} {r['secs']}s")

    crit_fail = [r for r in result["http"] if r["critical"] and not r["ok"]] + \
                [r for r in result["akshare"] if r["critical"] and not r["ok"]]
    opt_fail = [r for r in result["http"] if not r["critical"] and not r["ok"]] + \
               [r for r in result["akshare"] if not r["critical"] and not r["ok"]]

    code = 1 if crit_fail else (2 if opt_fail else 0)
    result["exit_code"] = code

    if args.json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return code

    print()
    print("=" * 78)
    if code == 0:
        print("结论：全通。")
    elif code == 1:
        print(f"结论：关键接口不可用 {len(crit_fail)} 项 —— run_pipeline 无法产出完整数据。")
        for r in crit_fail:
            key = r.get("host") or f"{r['label']}／{r['fn']}"
            print(f"  ✗ {key}")
            if r.get("used_by"):
                print(f"      影响：{r['used_by']}")
        print()
        print("  排查顺序：")
        print("   1. 代理：env | grep -i proxy —— 本机代理挂了会表现为全族不通")
        print("   2. 分主机：某一族不通而其余 eastmoney 主机正常 = 上游/线路问题，不是代理")
        print("   3. 对照 curl：curl -s -o /dev/null -w '%{http_code}' '<该 API 真实路径>'")
        print("      curl 通而 python 不通才是客户端问题；两者都不通就是链路问题")
    else:
        print(f"结论：关键接口全通，可选接口缺 {len(opt_fail)} 项——降级可用。")
        for r in opt_fail:
            print(f"  ✗ {r.get('host') or r['fn']}")
    print("=" * 78)
    return code


if __name__ == "__main__":
    sys.exit(main())
