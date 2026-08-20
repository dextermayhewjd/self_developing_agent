"""共享工具：市场识别、安全调用、字段提取"""
import json
import sys
from pathlib import Path

import akshare as ak  # noqa: F401  (re-exported)
import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
REPORTS_DIR = ROOT / "reports"


def symbol_dir(symbol: str) -> Path:
    """每只股票的数据目录：data/{symbol}/，自动创建。"""
    d = DATA_DIR / symbol
    d.mkdir(parents=True, exist_ok=True)
    return d


def normalize_symbol(symbol: str) -> str:
    """把用户各种写法归一成本仓内部代码。

    A 股 6 位原样返回；港股统一补齐到 5 位（"700"/"0700"/"03858.HK" → "00700"/"03858"）。
    港股与 A 股靠位数区分：A 股恒为 6 位，港股恒为 5 位，不冲突。
    """
    s = symbol.strip().upper()
    for suffix in (".HK", ".SS", ".SZ", ".SH"):
        if s.endswith(suffix):
            s = s[: -len(suffix)]
    s = s.lstrip("SH").lstrip("SZ").lstrip("BJ").lstrip("HK")
    if not s.isdigit():
        raise ValueError(f"Invalid symbol: {symbol}")
    if len(s) == 6:
        return s
    if len(s) <= 5:
        return s.zfill(5)
    raise ValueError(f"Invalid symbol: {symbol}")


def detect_market(symbol: str) -> str:
    """6 位数字 → sh/sz/bj；5 位数字 → hk"""
    s = normalize_symbol(symbol)
    if len(s) == 5:
        return "hk"
    if s.startswith(("60", "68", "90", "11")):
        return "sh"
    if s.startswith(("00", "30", "20")):
        return "sz"
    if s.startswith(("83", "87", "88", "43")):
        return "bj"
    return "sh"  # 默认


def board_name(symbol: str) -> str:
    if detect_market(symbol) == "hk":
        return "香港交易所主板"     # GEM 由 aggregate 用 security_profile 覆盖
    p = symbol[:2]
    return {
        "60": "上交所主板", "68": "上交所科创板",
        "00": "深交所主板", "30": "深交所创业板",
        "83": "北交所", "87": "北交所", "88": "北交所",
    }.get(p, "未知板块")


class Collector:
    """统一收集：成功写入 OUT、失败写入 ERR"""
    def __init__(self, name: str):
        self.name = name
        self.OUT = {}
        self.ERR = {}

    def safe(self, key, fn, retries=2):
        import time
        last_err = None
        for attempt in range(retries + 1):
            try:
                v = fn()
                if isinstance(v, pd.DataFrame):
                    self.OUT[key] = v.to_dict(orient="records")
                else:
                    self.OUT[key] = v
                n = len(self.OUT[key]) if hasattr(self.OUT[key], "__len__") else 1
                tag = "OK " if attempt == 0 else f"OK*{attempt}"
                print(f"  {tag} {key}: {n}", file=sys.stderr)
                return
            except Exception as e:
                last_err = f"{type(e).__name__}: {e}"
                if attempt < retries:
                    time.sleep(1.5 * (attempt + 1))
                    continue
        self.ERR[key] = last_err
        print(f"  ERR {key}: {last_err}", file=sys.stderr)

    def dump(self, symbol: str):
        from datetime import datetime
        path = symbol_dir(symbol) / f"{self.name}.json"
        path.write_text(json.dumps(
            {"data": self.OUT, "errors": self.ERR, "fetched_at": datetime.now().isoformat()},
            ensure_ascii=False, default=str, indent=2,
        ))
        return path
