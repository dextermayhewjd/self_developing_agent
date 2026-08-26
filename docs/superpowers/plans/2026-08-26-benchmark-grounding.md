# 参照系接地 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让判断稿的每个承重数字都带一个分了档的参照系，并让结论的措辞强度被这个档位机械地锁死——拿不到外部同口径就必须降级，且开篇结论过不了硬门。

**Architecture:** 四层。①`valuation_archetypes.md` 用 15 个「估值原型」定义每类公司「必须跟什么比」，是机器可消费的配置而非散文。②`discover_peers.py` 从标的主营描述提品种词、动态检索同业，不维护手工分类表。③workflow 新增两个 agent：板块基准（与五 lens 并行）与补参照系（核查后收口，唯一放行联网），产出 `参照系/*.md`。④`check_thesis.py` 新增硬约束 7，只拦开篇结论——压在「私有基准/无参照系」上而未声明即 exit 1。

**Tech Stack:** Python 3（纯 stdlib，与 `validate.py`/`check_thesis.py` 一致）、`unittest`（stdlib，本仓首次引入测试）、akshare 1.18.60（仅 `discover_peers.py` 用）、Claude Code Workflow（`.mjs`）。

**Spec:** `docs/superpowers/specs/2026-08-26-benchmark-grounding-design.md`

## Global Constraints

- **纯 stdlib 优先**：`benchmark_lib.py`、`check_thesis.py` 不得引入第三方依赖（`validate.py` 已确立此惯例：「纯 stdlib，不需要 .venv」）。仅 `discover_peers.py` 可用 akshare。
- **产物一律绝对路径**：workflow 与 skill 中所有写文件动作用绝对路径。原委见 `check_thesis.py` 硬约束 6 的注释（cwd 漂移不报错，产物静静落在别处）。
- **五档强度枚举，字符串精确匹配**：`外部·可回溯` / `外部·单源未交叉` / `外部但口径存疑` / `私有基准` / `无参照系`。中间的分隔符是 `·`（U+00B7），不是 `.` 也不是 `・`。
- **本地优先是硬规矩**：凡本地通道（`stock_zyjs_ths`、`datacenter.eastmoney.com`、`stock_value_em`）能取到的数，一律不许走联网通道。
- **push2 主机族不可用**：`push2.eastmoney.com` / `push2his.eastmoney.com` / `NN.push2.*` 当前不通（生产与 dev 均已实测，6/6 失败）。任何依赖它们的代码路径必须可降级，不得作为唯一通道。
- **schema property key 必须匹配 `^[a-zA-Z0-9_.-]{1,64}$`**：workflow schema 的键名走 ASCII，中文说明放 `description`。中文键名会让 agent 直接 400。
- **测试命令**：`python3 -m unittest discover -s tests -v`（仓库根执行，纯 stdlib，无需 .venv）。

---

## File Structure

| 文件 | 职责 | 动作 |
|---|---|---|
| `.claude/skills/equity-thesis-cn/valuation_archetypes.md` | 15 个估值原型的方法论标注；`必比口径` 是给 workflow 消费的配置 | 新建 |
| `tools/benchmark_lib.py` | 两个解析器：原型表、参照系文件。被 `check_thesis.py` 与 `discover_peers.py` 共用 | 新建 |
| `tools/discover_peers.py` | 品种提取 → 多通道候选检索 → 产出 `peers_curated.json` | 新建 |
| `tools/check_thesis.py` | 新增硬约束 7（开篇参照系声明） | 改 `main()` |
| `tools/audit_overreach.py` | 新增「参照系 agent 查了自己」判据 | 扩展 |
| `.claude/workflows/equity-thesis.mjs` | +2 agent、立疑改 `archetype`、核查改五档、成稿加输入、盘点加 `参照系/` | 改 |
| `.claude/skills/equity-thesis-cn/lenses/核查.md` | 四档 → 五档 | 改 |
| `.claude/skills/equity-thesis-cn/framework.md` | 原则三指向原型表 | 改 |
| `.claude/skills/equity-thesis-cn/SKILL.md` | 插入新步骤、数字纪律改五档 | 改 |
| `tests/` | 本仓首个测试目录，stdlib unittest | 新建 |

**任务顺序的依据**：契约先行。Task 1、2 定义两个文件格式与其解析器，Task 4（消费方）与 Task 5（生产方）才能各自独立测试而不必互相等待。

---

### Task 1: 估值原型表与解析器

**Files:**
- Create: `.claude/skills/equity-thesis-cn/valuation_archetypes.md`
- Create: `tools/benchmark_lib.py`
- Create: `tests/__init__.py`（空文件）
- Test: `tests/test_archetypes.py`

**Interfaces:**
- Consumes: 无
- Produces: `benchmark_lib.parse_archetypes(text: str) -> dict[str, dict]`
  返回 `{原型名: {"index": int, "归属判据": str, "主估值方法": str, "失效指标": list[str], "必比口径": list[str], "必做分析": str, "排雷阈值变体": str, "典型悬空点": str}}`。
  Task 5 用 `必比口径` 派活；Task 7 的文档同步引用原型名。

- [ ] **Step 1: 建测试目录并写失败的测试**

```bash
mkdir -p tests && touch tests/__init__.py
```

`tests/test_archetypes.py`：

```python
import unittest
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "tools"))
import benchmark_lib

ARCHETYPES = Path(__file__).resolve().parent.parent / ".claude/skills/equity-thesis-cn/valuation_archetypes.md"

FIELDS = ["归属判据", "主估值方法", "失效指标", "必比口径", "必做分析", "排雷阈值变体", "典型悬空点"]


class TestParseArchetypes(unittest.TestCase):
    def setUp(self):
        self.parsed = benchmark_lib.parse_archetypes(ARCHETYPES.read_text(encoding="utf-8"))

    def test_has_fifteen_archetypes(self):
        self.assertEqual(len(self.parsed), 15, f"应为 15 个原型，实得 {len(self.parsed)}")

    def test_every_archetype_has_all_seven_fields(self):
        for name, body in self.parsed.items():
            for field in FIELDS:
                self.assertIn(field, body, f"原型「{name}」缺字段：{field}")
                self.assertTrue(body[field], f"原型「{name}」的「{field}」为空")

    def test_list_fields_are_lists(self):
        for name, body in self.parsed.items():
            self.assertIsInstance(body["必比口径"], list, f"原型「{name}」的必比口径应为列表")
            self.assertGreaterEqual(len(body["必比口径"]), 1, f"原型「{name}」必比口径至少一条")

    def test_depleting_resource_archetype_content(self):
        """03858 归入的那一类，必比口径必须包含板块 P/NAV 中位数——这是本方案的起因。"""
        a = self.parsed["耗竭资源型"]
        self.assertEqual(a["index"], 1)
        joined = " ".join(a["必比口径"])
        self.assertIn("P/NAV", joined)
        self.assertIn("成本曲线", joined)


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: 运行测试确认失败**

Run: `python3 -m unittest tests.test_archetypes -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'benchmark_lib'`

- [ ] **Step 3: 写解析器**

`tools/benchmark_lib.py`：

```python
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
```

- [ ] **Step 4: 写原型表，先只写第 1 段验证解析器**

`.claude/skills/equity-thesis-cn/valuation_archetypes.md` 开头：

```markdown
# 估值原型标注表

> 按「现金流形态」切分，不按行业名切。判据：两家公司如果**估值方法、失效指标、
> 必比口径**三样都一样，就是同一个原型。钨矿/铜矿/油气共用一段；同属「有色金属」
> 的黄金（看储量重估）与铜（看冶炼加工费）必须分开。
>
> `必比口径` 是本表存在的理由——它被 `equity-thesis.mjs` 的板块基准 agent 直接读取
> 并据以派活，把「这一节该跟什么比」从模型的自由发挥变成配置。改这一行等于改行为。

## 1. 耗竭资源型

归属判据：主要资产有可枯竭的储量，产出为同质大宗商品，售价外生
主估值方法：P/NAV（以储量/资源 NPV 为基座）
失效指标：
  - 当期 PE——分母全看商品价假设，同一天可差 10 倍（03858 实测：93.8 / 46.0 / 8.2 三个值同日成立）
  - PB——矿按历史成本入账，分母基本是 IPO 募来的钱，不是矿的价值
必比口径：
  - 板块 P/NAV 中位数（在产 / 开发中分开取）
  - EV / 资源吨（含金属量口径）
  - EV / 单位年产能
  - C1 或 AISC 在全球成本曲线的分位
必做分析：供需平衡表、政策配额、再生供给响应曲线、储量寿命 vs 采矿权期限
排雷阈值变体：折耗政策、剥采比资本化、复垦拨备、投产爬坡期净现比可为负
典型悬空点：成本曲线位置与储量 NPV 往往只有公司委托的技术报告一个来源，属私有基准
```

- [ ] **Step 5: 运行测试，确认解析器过、数量断言仍失败**

Run: `python3 -m unittest tests.test_archetypes -v`
Expected: `test_depleting_resource_archetype_content` PASS，`test_has_fifteen_archetypes` FAIL（1 != 15）

- [ ] **Step 6: 补齐其余 14 段**

按同一格式续写，原型名与序号必须严格如下（Task 5 的立疑 schema 用它做枚举）：

```
2. 周期加工型      钢铁、电解铝、化工、水泥、造纸
3. 稳态现金流型    白酒、调味品、家电、必需消费
4. 成长渗透型      半导体设计、新能源车、光伏、创新硬件
5. 研发管线型      创新药、生物科技、疫苗
6. 平台网络型      互联网、SaaS、交易平台
7. 项目制工程型    建筑、工程设备、系统集成、军工总装
8. 金融息差型      银行
9. 金融承保型      保险
10. 金融资本型     券商、多元金融
11. 重资产公用型   电力、水务、燃气、高速、机场、铁路
12. 地产存货型     房地产开发
13. 持有型不动产   REITs、商业地产、物流仓储
14. 渠道分销型     医药商业、汽车经销、3C 分销、大宗贸易
15. 亏损未验证型   次新未盈利、pre-revenue 生物科技、早期科技
```

每段七个字段都要填实，禁止写「同上」或留空。写作时对照 `framework.md:317-330` 的
估值分叉表与 `financial-redflags-cn/SKILL.md:66-72` 的行业变体表，把已有结论搬进来，
不要另起炉灶。

- [ ] **Step 7: 运行测试确认全绿**

Run: `python3 -m unittest tests.test_archetypes -v`
Expected: 4 tests PASS

- [ ] **Step 8: 提交**

```bash
git add tests/ tools/benchmark_lib.py .claude/skills/equity-thesis-cn/valuation_archetypes.md
git commit -m "估值原型标注表：15 类按现金流形态切，必比口径作为机器可消费配置

框架原有的行业适配只有 8 行表格，周期股/有色总共 4 行着墨，而成长股有 493 行
framework 加 5 个 lens 文件——03858 那篇因此没有任何板块坐标系。改为按估值原型
切分：两家公司若估值方法、失效指标、必比口径三样都一样即同一原型，15 类可穷尽
全市场，且 A/港/美通用。

必比口径字段是本表的目的所在——板块基准 agent 直接读它派活。

本仓首次引入测试目录，用 stdlib unittest，不引 pytest 依赖。"
```

---

### Task 2: 参照系文件格式与解析器

**Files:**
- Modify: `tools/benchmark_lib.py`
- Test: `tests/test_benchmark_parse.py`

**Interfaces:**
- Consumes: `tools/benchmark_lib.py`（Task 1 创建）
- Produces:
  - `benchmark_lib.STRENGTHS: tuple[str, ...]` —— 五档枚举，强到弱有序
  - `benchmark_lib.USABLE_AS_HARD: frozenset[str]` —— 可当硬数字的档位
  - `benchmark_lib.MUST_DOWNGRADE: frozenset[str]` —— 必须降级的档位
  - `benchmark_lib.parse_benchmarks(run_dir: Path) -> dict[str, str]` —— `{what: 强度}`
  Task 4 用它建映射；Task 5 的 agent prompt 按此格式落盘。

- [ ] **Step 1: 写失败的测试**

`tests/test_benchmark_parse.py`：

```python
import tempfile
import unittest
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "tools"))
import benchmark_lib


SAMPLE = """# 板块基准

- [外部·可回溯] 钨业板块 PE(TTM) 中位数 ｜ 33.23 ｜ stock_value_em 四家 2026-08-25 ｜ 2026-08-26
- [外部·单源未交叉] Almonty P/NAV ｜ 0.19x ｜ https://seekingalpha.com/article/4937692 ｜ 2026-08-26
    > 原文：ALM trades at a P/NAV of 0.19x
- [外部但口径存疑] 港股一般金属及矿石 PE 中值 ｜ 5.69 ｜ peers.json（池内无同品种） ｜ 2026-08-26
- [私有基准] 市值 / ITR 税后 NPV ｜ 2.31–3.25 倍 ｜ 招股章程附录三 ITR（公司委托 SRK） ｜ 2026-08-26
- [无参照系] 2029 年给矿品位 ｜ 0.140% ｜ 无外部可比 ｜ 2026-08-26
"""


class TestStrengthConstants(unittest.TestCase):
    def test_five_strengths_ordered_strong_to_weak(self):
        self.assertEqual(benchmark_lib.STRENGTHS, (
            "外部·可回溯", "外部·单源未交叉", "外部但口径存疑", "私有基准", "无参照系"))

    def test_usable_and_downgrade_partition(self):
        self.assertEqual(benchmark_lib.USABLE_AS_HARD, frozenset({"外部·可回溯"}))
        self.assertEqual(benchmark_lib.MUST_DOWNGRADE, frozenset({"私有基准", "无参照系"}))


class TestParseBenchmarks(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        d = Path(self.tmp.name) / "参照系"
        d.mkdir()
        (d / "板块基准.md").write_text(SAMPLE, encoding="utf-8")
        self.run_dir = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def test_parses_all_five_lines(self):
        m = benchmark_lib.parse_benchmarks(self.run_dir)
        self.assertEqual(len(m), 5)

    def test_maps_what_to_strength(self):
        m = benchmark_lib.parse_benchmarks(self.run_dir)
        self.assertEqual(m["市值 / ITR 税后 NPV"], "私有基准")
        self.assertEqual(m["钨业板块 PE(TTM) 中位数"], "外部·可回溯")
        self.assertEqual(m["2029 年给矿品位"], "无参照系")

    def test_ignores_verbatim_continuation_lines(self):
        m = benchmark_lib.parse_benchmarks(self.run_dir)
        self.assertNotIn("原文：ALM trades at a P/NAV of 0.19x", m)

    def test_missing_dir_returns_none(self):
        """参照系/ 不存在时返回 None，让调用方能区分'没这道工序'与'工序跑了但空'。"""
        with tempfile.TemporaryDirectory() as empty:
            self.assertIsNone(benchmark_lib.parse_benchmarks(Path(empty)))

    def test_unknown_strength_is_skipped(self):
        d = self.run_dir / "参照系"
        (d / "补.md").write_text("- [瞎写的档] 某个数 ｜ 1 ｜ 出处 ｜ 2026-08-26\n", encoding="utf-8")
        m = benchmark_lib.parse_benchmarks(self.run_dir)
        self.assertNotIn("某个数", m)


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: 运行测试确认失败**

Run: `python3 -m unittest tests.test_benchmark_parse -v`
Expected: FAIL — `AttributeError: module 'benchmark_lib' has no attribute 'STRENGTHS'`

- [ ] **Step 3: 实现**

追加到 `tools/benchmark_lib.py`：

```python
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
```

- [ ] **Step 4: 运行测试确认通过**

Run: `python3 -m unittest tests.test_benchmark_parse -v`
Expected: 7 tests PASS

- [ ] **Step 5: 提交**

```bash
git add tools/benchmark_lib.py tests/test_benchmark_parse.py
git commit -m "参照系文件格式与解析器：五档强度，what 作为匹配键

四档改五档：联网放行后「外部同口径」会从'本地算出来的'变成'搜来的'，两者可核
实性差一个量级。实测依据——Almonty P/NAV 0.19x 一搜即得，但第二个来源核不上、
且给出方向相反的说法，只能进'外部·单源未交叉'。

匹配以 what 为键而非数值：数值会被改写、四舍五入、换单位，what 不会。

参照系/ 不存在返回 None 而非空 dict，让调用方能区分'旧版没这道工序'与'工序跑了
但空'——前者应跳过检查，后者是真问题。"
```

---

### Task 3: 动态同业检索

**Files:**
- Create: `tools/discover_peers.py`
- Test: `tests/test_discover_peers.py`

**Interfaces:**
- Consumes: 无（独立脚本）
- Produces:
  - CLI：`python3 tools/discover_peers.py <SYMBOL> [--root DIR] [--force]`
  - `discover_peers.extract_product_terms(text: str) -> list[str]`
  - `discover_peers.median_multiples(rows: list[dict]) -> dict[str, float]`
  - 产物 `data/{SYMBOL}/peers_curated.json`：
    `{"生成日期": str, "品种词": list[str], "通道": str, "peers": [{"code","market","name","keep","reason","manual"}], "中位数": {"PE_TTM","PB","PS"}}`
  Task 5 的板块基准 agent 调用此 CLI。

- [ ] **Step 1: 写失败的测试**

`tests/test_discover_peers.py`：

```python
import json
import tempfile
import unittest
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "tools"))
import discover_peers


class TestExtractProductTerms(unittest.TestCase):
    def test_extracts_from_business_description(self):
        text = "本公司主要从事钨精矿的开采、加工及销售，产品为 65% WO3 白钨精矿。"
        terms = discover_peers.extract_product_terms(text)
        self.assertIn("钨精矿", terms)

    def test_drops_generic_words(self):
        """'销售''业务''公司'这类词不是品种，混进去会把检索面撑爆。"""
        text = "公司主要业务为销售。"
        self.assertEqual(discover_peers.extract_product_terms(text), [])

    def test_returns_at_most_five_terms(self):
        text = "钨精矿、仲钨酸铵、碳化钨粉、硬质合金、钨条、钨丝、钨粉、三氧化钨"
        self.assertLessEqual(len(discover_peers.extract_product_terms(text)), 5)


class TestMedianMultiples(unittest.TestCase):
    def test_median_of_four(self):
        rows = [
            {"PE_TTM": 23.49, "PB": 4.45, "PS": 1.34},
            {"PE_TTM": 51.72, "PB": 12.89, "PS": 5.56},
            {"PE_TTM": 34.74, "PB": 10.39, "PS": 3.47},
            {"PE_TTM": 31.72, "PB": 8.38, "PS": 3.98},
        ]
        m = discover_peers.median_multiples(rows)
        self.assertAlmostEqual(m["PE_TTM"], 33.23, places=2)
        self.assertAlmostEqual(m["PB"], 9.385, places=3)

    def test_skips_none_and_zero(self):
        rows = [{"PE_TTM": None, "PB": 0, "PS": 2.0}, {"PE_TTM": 10.0, "PB": 5.0, "PS": 4.0}]
        m = discover_peers.median_multiples(rows)
        self.assertEqual(m["PE_TTM"], 10.0)
        self.assertEqual(m["PB"], 5.0)

    def test_all_missing_gives_none(self):
        self.assertIsNone(discover_peers.median_multiples([{"PE_TTM": None, "PB": None, "PS": None}])["PE_TTM"])


class TestCacheBehaviour(unittest.TestCase):
    def test_manual_entries_survive_regeneration(self):
        """人工加的同业不许被重跑覆盖——这是方案里唯一保留的人工入口。"""
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp) / "peers_curated.json"
            p.write_text(json.dumps({
                "生成日期": "2026-08-01", "品种词": ["钨精矿"], "通道": "①",
                "peers": [{"code": "ALM", "market": "US", "name": "Almonty",
                           "keep": True, "reason": "人工补", "manual": True}],
                "中位数": {},
            }, ensure_ascii=False), encoding="utf-8")
            merged = discover_peers.merge_preserving_manual(
                p, [{"code": "600549", "market": "CN", "name": "厦门钨业",
                     "keep": True, "reason": "同品种", "manual": False}])
            codes = {r["code"] for r in merged}
            self.assertIn("ALM", codes, "人工条目被覆盖了")
            self.assertIn("600549", codes)


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: 运行测试确认失败**

Run: `python3 -m unittest tests.test_discover_peers -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'discover_peers'`

- [ ] **Step 3: 实现纯函数部分（不碰网络，先让测试过）**

`tools/discover_peers.py`：

```python
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

用法：python3 tools/discover_peers.py <SYMBOL> [--root DIR] [--force]
退出码：0 产出成功 / 1 一个同业都没找到 / 2 找到了但估值口径缺失
"""

import argparse
import json
import statistics
import sys
from datetime import date
from pathlib import Path

# 主营描述里的通用词，不是品种。混进去会把检索面撑爆。
_STOPWORDS = {
    "公司", "本公司", "主要", "从事", "业务", "销售", "生产", "经营", "产品",
    "研发", "服务", "及", "与", "和", "的", "开采", "加工", "制造", "有限公司",
}
_MAX_TERMS = 5


def extract_product_terms(text):
    """从主营描述里提品种词。

    规则刻意保守：只取 2–8 字、不含停用词、且出现在「从事/生产/销售/产品为」
    之后的名词串。宁可少提也不要提出「销售」这种词——检索面一旦撑爆，
    LLM 确认阶段的成本会失控。
    """
    import re

    terms = []
    for chunk in re.split(r"[，。、；;,\s]+", text or ""):
        chunk = chunk.strip()
        if not (2 <= len(chunk) <= 8):
            continue
        if chunk in _STOPWORDS:
            continue
        if any(w in chunk and len(chunk) - len(w) < 2 for w in _STOPWORDS):
            continue
        if re.search(r"[矿砂粉材料芯片药械设备酒器件电池组件]", chunk) or re.search(r"[A-Z0-9]{2,}", chunk):
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
    Almonty），不做「维护一整张分类表」。
    """
    manual = []
    if Path(cache_path).exists():
        old = json.loads(Path(cache_path).read_text(encoding="utf-8"))
        manual = [r for r in old.get("peers", []) if r.get("manual")]
    manual_codes = {r["code"] for r in manual}
    return manual + [r for r in fresh_rows if r["code"] not in manual_codes]
```

- [ ] **Step 4: 运行测试确认通过**

Run: `python3 -m unittest tests.test_discover_peers -v`
Expected: 7 tests PASS

- [ ] **Step 5: 补 CLI 与检索通道**

在同文件追加。`main()` 需要：读 `data/{SYMBOL}/aggregate.json` 的主营描述 → `extract_product_terms`
→ 依次尝试通道①②③（每个通道包在 `try/except` 里，失败就记 `channel_errors` 并降级到下一个，
**不得因为 push2 不通而整体失败**）→ 对候选逐个取 `stock_value_em` 最新一行的
`PE(TTM)`/`市净率`/`市销率` → `merge_preserving_manual` → 写 `peers_curated.json`。

`--force` 之外，已有缓存且 `生成日期` 为今天则直接跳过（幂等，与 `validate.py` 风格一致）。

- [ ] **Step 6: 端到端验证（需网络与 .venv）**

Run: `.venv/bin/python tools/discover_peers.py 03858 --force`
Expected: `data/03858/peers_curated.json` 生成，`peers` 含 600549 / 000657 / 002378 / 002842，
`中位数.PE_TTM` 在 33 附近、`中位数.PB` 在 9.4 附近（Spec 第九节实测基线）。
若 03858 的 `data/` 不在本机，改用 `600549` 自检通道是否打通。

- [ ] **Step 7: 提交**

```bash
git add tools/discover_peers.py tests/test_discover_peers.py
git commit -m "动态同业检索：从主营描述提品种词，不再维护手工分类表

competitor_pool.json 只有 10 个行业且 A 股专用，而细分品种的分类方式无法人工
穷尽。改为分类从标的自己的披露里长出来：提品种词 → 多通道检索 → LLM 确认。

通道顺序按实测排：主营描述(同花顺)与行业成员(datacenter)可用，板块 API 走
push2 当前不通，降为备选。每个通道独立 try/except，push2 挂掉不致整体失败。

人工条目 manual=True 重跑不覆盖——这是方案里唯一保留的人工入口，用于补机器
找不到的境外同业（如 Almonty）。

实测基线：钨业四家 PE(TTM) 中位 33.23、PB 中位 9.39。据此 03858 是 PE 中位的
2.82 倍；而报告第七节用港股 72 家宽池算出的是 16.49 倍——错了一个数量级。"
```

---

### Task 4: check_thesis 硬约束 7

**Files:**
- Modify: `tools/check_thesis.py`（`main()` 内，硬约束 6 之后、软约束之前）
- Test: `tests/test_check_thesis_benchmark.py`

**Interfaces:**
- Consumes: `benchmark_lib.parse_benchmarks`、`benchmark_lib.MUST_DOWNGRADE`（Task 2）
- Produces: `check_thesis.check_opening_benchmark(report: str, bench: dict|None) -> list[str]`
  返回硬约束违规描述列表（空列表 = 通过）。

- [ ] **Step 1: 写失败的测试**

`tests/test_check_thesis_benchmark.py`：

```python
import unittest
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "tools"))
import check_thesis


BENCH = {
    "市值 / ITR 税后 NPV": "私有基准",
    "钨业板块 PE(TTM) 中位数": "外部·可回溯",
}

OPENING_UNDECLARED = """## 〇、开篇结论

市值是 ITR 税后 NPV 的 2.31–3.25 倍，所以贵。

## 一、公司简介
"""

OPENING_DECLARED = """## 〇、开篇结论

市值是 ITR 税后 NPV 的 2.31–3.25 倍，所以贵。

> **参照系声明**
> 核心第一点压在「市值 / ITR 税后 NPV」——参照系类型 **私有基准**；板块 P/NAV
> 中位数**未取得**，故相对板块的贵贱本篇**无法回答**。

## 一、公司简介
"""

OPENING_TEMPLATE_DODGE = """## 〇、开篇结论

市值是 ITR 税后 NPV 的 2.31–3.25 倍，所以贵。

> **参照系声明**
> 本报告部分数据未经外部验证，相关结论**无法回答**其相对水平。

## 一、公司简介
"""

OPENING_SAFE_NUMBER = """## 〇、开篇结论

估值高于同业：见「钨业板块 PE(TTM) 中位数」。

> **参照系声明**
> 核心第一点压在「钨业板块 PE(TTM) 中位数」——参照系类型 **外部·可回溯**。

## 一、公司简介
"""


class TestOpeningBenchmark(unittest.TestCase):
    def test_missing_declaration_block_fails(self):
        errs = check_thesis.check_opening_benchmark(OPENING_UNDECLARED, BENCH)
        self.assertTrue(errs)
        self.assertIn("参照系声明", errs[0])

    def test_proper_declaration_passes(self):
        self.assertEqual(check_thesis.check_opening_benchmark(OPENING_DECLARED, BENCH), [])

    def test_template_dodge_fails(self):
        """泛泛声明匹配不上任何 what，必须照样拦——这是防绕过的关键。"""
        errs = check_thesis.check_opening_benchmark(OPENING_TEMPLATE_DODGE, BENCH)
        self.assertTrue(errs)

    def test_usable_strength_needs_no_downgrade_wording(self):
        self.assertEqual(check_thesis.check_opening_benchmark(OPENING_SAFE_NUMBER, BENCH), [])

    def test_none_bench_skips_check(self):
        """参照系/ 不存在（旧 run）时向后兼容，不拦。"""
        self.assertEqual(check_thesis.check_opening_benchmark(OPENING_UNDECLARED, None), [])


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: 运行测试确认失败**

Run: `python3 -m unittest tests.test_check_thesis_benchmark -v`
Expected: FAIL — `AttributeError: module 'check_thesis' has no attribute 'check_opening_benchmark'`

- [ ] **Step 3: 实现**

在 `tools/check_thesis.py` 顶部 import 区加：

```python
sys.path.insert(0, str(Path(__file__).resolve().parent))
import benchmark_lib
```

在 `def main()` 之前加：

```python
# 开篇结论：从 `## 〇、开篇结论` 到下一个一级节标题
_OPENING_RE = re.compile(r"##\s*〇、开篇结论(.*?)(?=\n##\s|\Z)", re.S)
# 声明块：以 `> **参照系声明**` 起头的连续引用行
_DECL_RE = re.compile(r">\s*\*\*参照系声明\*\*(.*?)(?=\n(?!\s*>)|\Z)", re.S)
# 声明块里点名的 what，写在「」中
_NAMED_RE = re.compile(r"「([^」]+)」")
# 降级措辞关键词——命中任意一个即认为已声明限制
_DOWNGRADE_WORDS = ("无法回答", "未取得", "绝对口径", "不可得", "悬空", "无法判断")


def check_opening_benchmark(report, bench):
    """硬约束 7：开篇结论的承重数字若压在私有基准/无参照系上，必须声明限制。

    只拦开篇，不拦正文。理由：悬空写在正文里是诚实，悬空写在开篇第一句而不声明
    才是误导——而读报告的人只读开篇。全面拦会让资源股/次新股每篇都被拦，写稿的
    人学会批量粘声明句，硬门反而失效。

    bench 为 None（参照系/ 不存在）时跳过，向后兼容旧 run。
    """
    if bench is None:
        return []
    m = _OPENING_RE.search(report)
    if not m:
        return ["缺〈〇、开篇结论〉一节，无法校验参照系声明"]
    opening = m.group(1)

    decl = _DECL_RE.search(opening)
    if not decl:
        return ["开篇结论缺「> **参照系声明**」块——核心两点各压在哪个数上必须写明"]

    named = [w.strip() for w in _NAMED_RE.findall(decl.group(1))]
    matched = [w for w in named if w in bench]
    if not matched:
        return [
            "参照系声明未点名任何可匹配的承重数字："
            f"声明里提到 {named or '（无）'}，都不在 参照系/*.md 的清单里。"
            "声明必须原样引用清单里的 what 串，泛泛一句不算"
        ]

    errs = []
    for what in matched:
        if bench[what] in benchmark_lib.MUST_DOWNGRADE:
            if not any(w in decl.group(1) for w in _DOWNGRADE_WORDS):
                errs.append(
                    f"「{what}」参照系类型为「{bench[what]}」，但声明块没有降级措辞"
                    f"（需含 {'/'.join(_DOWNGRADE_WORDS[:3])} 之一）——"
                    "压在私有基准上的判断不得当作已证实的事实写"
                )
    return errs
```

在 `main()` 的硬约束 6 之后、软约束之前插入：

```python
    # ---- 硬约束 7：开篇结论的参照系声明 ----
    # 03858 实测：五条承重数字全部回原文核实通过，但按参照系归类没有一条是外部
    # 同口径——核查全过，判断照样悬空。而全篇空头结论正压在其中一条私有基准上。
    # 核查只管"抄对没有"，管不了"这个数在外面算什么水平"，这一条补的就是后者。
    hard.extend(check_opening_benchmark(report, benchmark_lib.parse_benchmarks(run_dir)))
```

- [ ] **Step 4: 运行测试确认通过**

Run: `python3 -m unittest tests.test_check_thesis_benchmark -v`
Expected: 5 tests PASS

- [ ] **Step 5: 回归——旧报告不得被新检查误伤**

Run: `python3 tools/check_thesis.py 03858 reports/03858_thesis_20260821/report.md; echo "EXIT=$?"`
Expected: 退出码与加这条检查之前一致（该 run 没有 `参照系/` 目录，`parse_benchmarks` 返回 None，硬约束 7 跳过）。
若退出码变了，说明向后兼容分支没生效，回到 Step 3。

- [ ] **Step 6: 全量测试**

Run: `python3 -m unittest discover -s tests -v`
Expected: 全绿

- [ ] **Step 7: 提交**

```bash
git add tools/check_thesis.py tests/test_check_thesis_benchmark.py
git commit -m "check_thesis 硬约束 7：开篇结论压在私有基准上而未声明即拦

只拦开篇不拦正文：悬空写在正文里是诚实，写在开篇第一句而不声明才是误导，
而读报告的人只读开篇。全面拦会让资源股每篇都被拦、写稿的人学会批量粘声明句。

防绕过靠第 3 步：声明必须原样引用参照系清单里的 what 串并能匹配上，泛泛一句
'本报告部分数据未经外部验证'匹配不到任何条目，照样 exit 1。

参照系/ 不存在时跳过，旧 run 不受影响（已对 03858_20260821 回归验证）。"
```

---

### Task 5: workflow 两个 agent

**Files:**
- Modify: `.claude/workflows/equity-thesis.mjs`

**Interfaces:**
- Consumes: `valuation_archetypes.md`（Task 1）、`discover_peers.py` CLI（Task 3）、参照系行格式（Task 2）
- Produces: `参照系/板块基准.md`、`参照系/补.md`，供 Task 4 的硬门与成稿 agent 消费

- [ ] **Step 1: 立疑 schema 改 archetype**

`DOUBT` schema 里 `industry_class` 改为：

```js
    archetype: {
      type: 'string',
      description:
        '估值原型，必须是 valuation_archetypes.md 里 15 个原型名之一（原样抄，含"型"字）。' +
        '这个判定会传给每个 lens 用来选阈值/口径/方法，也决定板块基准 agent 去比哪几个口径。判错会让五个 lens 一起错。',
    },
```

`required` 同步改为 `['archetype', 'doubts', 'written_file']`。
立疑 prompt 里「读 framework.md 开篇原则三的行业映射表」改为
「读 `${SKILL}/equity-thesis-cn/valuation_archetypes.md`，判本票属于 15 个估值原型中的哪一个」，
且 `疑惑.md` 第一行的约定从 `行业类别：<判定>` 改为 `估值原型：<判定>`。
五个 lens 的 prompt 里「第一行是行业类别」同步改为「第一行是估值原型」。

- [ ] **Step 2: 加 BENCHMARK schema**

```js
// 板块基准与补参照系共用。url/verbatim/fetched_date 是结构性护栏——
// debug-equity-thesis:92 记录过教训：prose 禁令无效（加禁令后越权反升到 299 次），
// 所以联网留痕靠 schema 校验强制，不靠叮嘱。
const BENCHMARK = {
  type: 'object',
  required: ['written_file', 'items'],
  properties: {
    written_file: { type: 'string', description: '你落盘的 参照系/*.md 绝对路径' },
    items: {
      type: 'array', minItems: 1,
      items: {
        type: 'object',
        required: ['what', 'value', 'strength', 'source'],
        properties: {
          what: { type: 'string', description: '这个数是什么。落盘与下游匹配都以它为键，用词要稳定' },
          value: { type: 'string' },
          strength: {
            type: 'string',
            enum: ['外部·可回溯', '外部·单源未交叉', '外部但口径存疑', '私有基准', '无参照系'],
            description:
              '本地数据层算出来的直接给「外部·可回溯」；搜来的若只有一个来源给「外部·单源未交叉」；' +
              '宽池子且池内无同品种一律「外部但口径存疑」，不得据此算"是中值 N 倍"',
          },
          source: { type: 'string', description: '出处。联网所得必须是 URL' },
          verbatim: { type: 'string', description: '联网所得必填：逐字原文片段' },
          fetched_date: { type: 'string', description: '联网所得必填：抓取日期 YYYY-MM-DD' },
        },
      },
    },
  },
}
```

- [ ] **Step 3: 加板块基准 agent，与五 lens 并行**

在 `phase('立疑')` 之后、`pipeline(LENSES, ...)` 之前，把两者包进 `parallel`：

```js
const [benchBase, lensResults] = await parallel([
  () =>
    doneBench
      ? Promise.resolve(null)
      : agent(
          `你是 ${SYMBOL} 的板块基准 agent。报告日 ${DATE}。

**先 Read ${RUN}/疑惑.md 第一行拿到估值原型**，再 Read
${SKILL}/equity-thesis-cn/valuation_archetypes.md 里该原型的「必比口径」那一段。
你的任务就是把那几条口径的**板块中位数/分位**取回来，一条不落。

取数方式，**本地优先是硬规矩**：
先跑 \`python3 ${ROOT}/tools/discover_peers.py ${SYMBOL}\`，它会产出
${DATA}/peers_curated.json（同品种同业 + 三个倍数的中位数）。
**凡它能给出的数，一律不许另找来源。** 本地数可复现、带交易日，天然进「外部·可回溯」。

它给不出的（例如 P/NAV 中位数、成本曲线分位、境外同业），才允许 WebSearch。
联网所得每条必须带 url、逐字原文 verbatim、抓取日期——**缺任一项这条就不要提交**。
**同一个数至少两个独立来源对得上才给「外部·可回溯」，只有一个来源一律给「外部·单源未交叉」。**

**你只查别人，不查标的公司自己的任何数字。** 标的自己的数由其他 agent 从 data/ 和年报取。

落盘到 ${RUN}/参照系/板块基准.md（先 mkdir -p），一行一条：
\`- [强度] what ｜ 值 ｜ 出处 ｜ 取数日\`
联网条目在下一行缩进补 \`    > 原文：<逐字片段>\`。
**注意：${DATA}/peers.json 是按交易所行业分类抓的宽池子。若池内无同品种，
它算出的倍数一律标「外部但口径存疑」，并且不要用它算"是中值 N 倍"这类倍数**——
03858 实测：用港股 72 家宽池算出"PE 是中值的 16.5 倍"，而用真正的钨业同业只有 2.82 倍，
错了一个数量级。取不到的口径要如实写成「无参照系」，不要编。`,
          { label: '板块基准', phase: '挖掘', schema: BENCHMARK }
        ),
  () => pipeline(LENSES, /* 现有两级不变 */),
])
```

- [ ] **Step 4: 加补参照系 agent，核查之后**

在 `phase('成稿')` 之前插入：

```js
// 只对仍悬空的承重数发力；一条都没有就整段跳过——这是拆两半消掉 barrier 代价的地方。
phase('补参照系')
const dangling = allChecked.filter((c) =>
  ['私有基准', '无参照系'].some((s) => (c.reference_type ?? '').includes(s))
)
let benchFill = null
if (dangling.length === 0) {
  log('补参照系：没有悬空的承重数，跳过')
} else {
  log(`补参照系：${dangling.length} 条悬空，逐条接地`)
  benchFill = await agent(
    `你是补参照系 agent。报告日 ${DATE}。下面这些承重数字在核查阶段被判为「私有基准」
或「无参照系」，意味着它们**没有外部同口径的比较对象**，而结论正压在它们上面：

${dangling.map((d, i) => `${i + 1}. ${d.what}｜当前值 ${d.value}`).join('\n')}

逐条去找外部同口径的参照系。**本地优先**：先看 ${DATA}/peers_curated.json 与
${RUN}/参照系/板块基准.md 里有没有现成的；没有才 WebSearch。

联网所得每条必须带 url、逐字原文 verbatim、抓取日期，缺任一项不要提交。
**至少两个独立来源对得上才给「外部·可回溯」，单源一律「外部·单源未交叉」。**
找不到就如实给「无参照系」——**找不到是可接受的结果，编一个不是。**

**你只查别人，不查标的公司自己的任何数字。**

落盘到 ${RUN}/参照系/补.md（先 mkdir -p），格式同 板块基准.md。`,
    { label: '补参照系', phase: '补参照系', schema: BENCHMARK }
  )
}
```

- [ ] **Step 5: 成稿 agent 加输入与数字纪律**

成稿 prompt 的「你的输入只有两样」改为三样，第 3 条：

```
3. ${RUN}/参照系/ 下的文件（用 Read 读全部）——每个承重数字的参照系强度，五档：
   外部·可回溯（可直接用）／外部·单源未交叉、外部但口径存疑（可用，正文须标注）／
   私有基准、无参照系（**不得当作已证实的事实，结论必须降级措辞**）
```

并在出口要求里加：

```
**开篇结论下方必须跟一个「> **参照系声明**」块**，逐条写明核心两点各压在哪个数上、
该数的参照系类型是什么。**点名时原样引用参照系文件里的 what 串并用「」括起来**——
check_thesis 按这个串精确匹配，写别的匹配不上会被硬门拦下。
若某数是私有基准或无参照系，声明里必须出现降级措辞（「无法回答」「未取得」「绝对口径下」之一）。
```

- [ ] **Step 6: 盘点加 参照系/**

`INVENTORY` schema 加 `bench_done: { type: 'array', items: { type: 'string' } }`，
描述为「参照系/ 下已存在且字节数 > 200 的文件名（不含 .md），只可能是 板块基准、补」。
盘点 prompt 的 `ls` 加上 `${RUN}/参照系/`。取 `const doneBench = new Set(inv?.bench_done ?? []).has('板块基准')`。

- [ ] **Step 7: 语法校验**

Run: `node --check .claude/workflows/equity-thesis.mjs`
Expected: 无输出（通过）。

> `--check` 只验语法。行为验证在 Task 8 的端到端跑，不要在这里试图跑 workflow。

- [ ] **Step 8: 提交**

```bash
git add .claude/workflows/equity-thesis.mjs
git commit -m "workflow 加板块基准与补参照系两个 agent，立疑改判估值原型

拆两半：板块基准只依赖原型与同业名单，立疑后即可开查，与五个 lens 同槽并行，
零额外墙钟；补参照系只对核查判为私有基准/无参照系的数发力，一条没有就整段跳过。

联网定向放行给这两个 agent，护栏写进 schema 而非 prose——url/verbatim/
fetched_date 缺任一项 schema 校验直接打回。debug-equity-thesis:92 记录过
prose 禁令无效（加禁令后越权反升到 299 次）。

立疑输出从自然语言 industry_class 改为 15 选 1 的 archetype：原型表同时承载
估值方法、必比口径和排雷阈值变体，一个分类喂三处。"
```

---

### Task 6: audit_overreach 加「查自己」判据

**Files:**
- Modify: `tools/audit_overreach.py`
- Test: `tests/test_audit_overreach.py`

**Interfaces:**
- Consumes: 无
- Produces: `audit_overreach.detect_self_lookup(transcript: str, symbol: str, company: str) -> list[str]`

- [ ] **Step 1: 写失败的测试**

`tests/test_audit_overreach.py`：

```python
import unittest
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "tools"))
import audit_overreach


class TestDetectSelfLookup(unittest.TestCase):
    def test_flags_websearch_on_own_financials(self):
        t = 'WebSearch(query="佳鑫国际资源投资 2025 净利润")'
        hits = audit_overreach.detect_self_lookup(t, "03858", "佳鑫国际资源投资")
        self.assertTrue(hits)

    def test_flags_symbol_plus_financial_field(self):
        t = 'WebSearch(query="03858 毛利率")'
        self.assertTrue(audit_overreach.detect_self_lookup(t, "03858", "佳鑫国际资源投资"))

    def test_allows_peer_lookup(self):
        """查同业是这个 agent 的本职，不能误报。"""
        t = 'WebSearch(query="Almonty Industries P/NAV")'
        self.assertEqual(audit_overreach.detect_self_lookup(t, "03858", "佳鑫国际资源投资"), [])

    def test_allows_company_name_without_financial_field(self):
        """提到公司名但不是在查它的财务数——例如查行业格局时顺带提及。"""
        t = 'WebSearch(query="全球钨矿产能格局 佳鑫国际资源投资 巴库塔")'
        self.assertEqual(audit_overreach.detect_self_lookup(t, "03858", "佳鑫国际资源投资"), [])


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: 运行确认失败**

Run: `python3 -m unittest tests.test_audit_overreach -v`
Expected: FAIL — `AttributeError: ... has no attribute 'detect_self_lookup'`

- [ ] **Step 3: 实现**

追加到 `tools/audit_overreach.py`：

```python
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
```

若 `audit_overreach.py` 顶部尚未 `import re`，加上。

- [ ] **Step 4: 运行确认通过**

Run: `python3 -m unittest tests.test_audit_overreach -v`
Expected: 4 tests PASS

- [ ] **Step 5: 提交**

```bash
git add tools/audit_overreach.py tests/test_audit_overreach.py
git commit -m "audit_overreach 加「查自己」判据：参照系 agent 只查别人

联网定向放行的第三条护栏。判据不看工具也不看路径，看'查的是谁的什么'——
同一次检索里既出现标的标识又出现财务字段才判违规。单独提公司名不算（查行业
格局时顺带提及正常），单独提财务字段更不算（查同业财务正是本职）。

宁可漏报不要误报：误报会让这条判据被忽略，那就等于没有。"
```

---

### Task 7: skill 文档同步

**Files:**
- Modify: `.claude/skills/equity-thesis-cn/lenses/核查.md`
- Modify: `.claude/skills/equity-thesis-cn/framework.md`（原则三）
- Modify: `.claude/skills/equity-thesis-cn/SKILL.md`

**Interfaces:**
- Consumes: Task 1 的原型名、Task 2 的五档枚举
- Produces: 无代码接口；这三份是自然语言路径（不走 workflow 时）的行为定义

- [ ] **Step 1: 核查.md 四档改五档**

`lenses/核查.md:59-63` 的四档表改为 Task 2 的五档，并在「外部·可回溯」一行注明
「本地数据层算出的直接进此档；搜来的需 ≥2 源交叉」。
保留 68-76 行那段 03858 实测依据不动——它是这条规则的来源，删了后人不知道能不能改。

- [ ] **Step 2: framework.md 原则三改为指向原型表**

`framework.md:33-47` 那张 8 行行业表替换为一句指向：

```markdown
### 三、按估值原型调整重心（第一步就判本票属于哪个原型）

12 节骨架不变，但**各节的强调和估值方法随估值原型变**。落笔前先判原型——
15 个原型的定义、必比口径、失效指标、排雷阈值变体全在
`valuation_archetypes.md`，那份是唯一权威，本节不再复述。

**不判原型就套成长股模板，是这套框架最容易翻车的地方。**
本框架派生自五份人工底稿（石基/乐鑫/中控/开立/澜起），全部是成长股——
遇到资源股、周期股、金融股时，成长股的「行业规模 × 市占率 × 净利率」会直接崩。
```

- [ ] **Step 3: SKILL.md 插入步骤 3.6 与数字纪律改五档**

在步骤 3.5 之后插入「步骤 3.6：补参照系」，说明它做什么、为什么只有它能联网、三条护栏。
「数字纪律」那张三行表改为五档表：

| 参照系强度 | 怎么办 |
|---|---|
| 外部·可回溯 | 直接用 |
| 外部·单源未交叉 / 外部但口径存疑 | 可以用，正文标注来源限制 |
| 私有基准 / 无参照系 | **不得当已证实的事实用**；若结论压在它上面，必须降级措辞，且开篇要写参照系声明 |

并在步骤 4 的出口要求里加上开篇参照系声明块的格式。

- [ ] **Step 4: 一致性自检**

Run:
```bash
grep -c "行业类别" .claude/skills/equity-thesis-cn/*.md .claude/skills/equity-thesis-cn/lenses/*.md .claude/workflows/equity-thesis.mjs
grep -rn "外部同口径" .claude/skills/ .claude/workflows/
```
Expected: 「行业类别」应全部被「估值原型」取代（计数为 0）；「外部同口径」这个旧四档
用语应只在解释历史的段落里出现，不得出现在任何规则定义处。

- [ ] **Step 5: 提交**

```bash
git add .claude/skills/equity-thesis-cn/
git commit -m "skill 文档同步五档强度与估值原型，framework 原则三改为单一权威指向

核查.md 四档改五档；framework.md 那张 8 行行业表删掉，改为指向
valuation_archetypes.md——两处各存一份行业方法论必然漂移，原型表是唯一权威。

SKILL.md 插入步骤 3.6 补参照系，数字纪律三行表改五档表。这三份定义的是自然
语言路径的行为；走 workflow 时由脚本保证，但两条路径的规则必须一致。"
```

---

### Task 8: 端到端验证与回归

**Files:**
- 无新文件；跑通并记录结果

**Interfaces:**
- Consumes: Task 1–7 全部
- Produces: 一次可验收的 run

- [ ] **Step 1: 全量单元测试**

Run: `python3 -m unittest discover -s tests -v`
Expected: 全绿（约 27 个测试）

- [ ] **Step 2: 数据层探针**

Run: `.venv/bin/python tools/probe_endpoints.py`
Expected: 记录退出码。若为 1 且失败项是 push2 族，属已知既存故障（Spec 第八节），
继续；若关键失败项是 `datacenter` / `sina` / `10jqka`，**停下**——`discover_peers.py`
的本地通道全断，这一跑没有意义。

- [ ] **Step 3: 同业检索端到端**

Run: `.venv/bin/python tools/discover_peers.py 03858 --force`
Expected: `peers_curated.json` 含 600549/000657/002378/002842，
`中位数.PE_TTM` ≈ 33、`中位数.PB` ≈ 9.4（Spec 第九节实测基线）。偏离超过 20% 说明
取数口径变了，先查 `stock_value_em` 的列名是否改版。

- [ ] **Step 4: 重跑 03858 判断稿**

先把旧 run 挪开以免盘点跳过：

```bash
mv reports/03858_thesis_20260821 reports/03858_thesis_20260821.before-grounding
```

Run: `/thesis-wf 03858 20260821`
Expected: 新 run 里出现 `参照系/板块基准.md`；`report.md` 开篇结论下有参照系声明块。

- [ ] **Step 5: 硬门双向验证**

```bash
python3 tools/check_thesis.py 03858 reports/03858_thesis_20260821/report.md; echo "EXIT=$?"
```
Expected: 0 或 2。

再造一个反例——把声明块整段删掉存为副本，重跑检查：
```bash
python3 - <<'EOF'
import re, pathlib
p = pathlib.Path("reports/03858_thesis_20260821/report.md")
d = p.parent / "report.nodecl.md"
d.write_text(re.sub(r">\s*\*\*参照系声明\*\*.*?(?=\n(?!\s*>))", "", p.read_text(encoding="utf-8"), flags=re.S), encoding="utf-8")
EOF
python3 tools/check_thesis.py 03858 reports/03858_thesis_20260821/report.nodecl.md; echo "EXIT=$?"
rm reports/03858_thesis_20260821/report.nodecl.md
```
Expected: EXIT=1，且输出里有「开篇结论缺「> **参照系声明**」块」。

- [ ] **Step 6: 旧 run 向后兼容回归**

```bash
python3 tools/check_thesis.py 03858 reports/03858_thesis_20260821.before-grounding/report.md; echo "EXIT=$?"
```
Expected: 与实施前的退出码一致（该 run 无 `参照系/`，硬约束 7 跳过）。

- [ ] **Step 7: 提交验收记录**

把 Step 2–6 的实际输出写进 `docs/superpowers/plans/2026-08-26-benchmark-grounding-验收.md` 并提交。
**如实记录，包括没达成的项**——这份记录的用途是让下一个人知道哪些结论有实测支撑、
哪些只是设计意图。

---

## Self-Review

**Spec 覆盖检查**（逐节对照 `2026-08-26-benchmark-grounding-design.md`）：

| Spec 节 | 对应任务 |
|---|---|
| 四、组件 1 估值原型标注表 | Task 1 |
| 五、组件 2 动态同业检索 | Task 3 |
| 六、组件 3 参照系接地（3a/3b/五档/成稿输入） | Task 2（格式）+ Task 5 |
| 六、护栏「只查别人不查自己」 | Task 6 |
| 七、组件 4 check_thesis 硬门 | Task 4 |
| 七、顺带改动（盘点、SKILL.md） | Task 5 Step 6、Task 7 |
| 八、通道优先级与 push2 降级 | Task 3 Step 5（每通道独立 try/except）、Task 8 Step 2 |
| 九、实测验证基线 | Task 3 Step 6、Task 8 Step 3 的断言值 |
| 十一、验收标准 1–5 | Task 1 Step 7、Task 8 Step 3–6、Task 8 Step 2 |

无未覆盖项。

**已知的计划外项**：Spec 第十二节的「月度商品价格序列」明确不在本次范围，无对应任务，
这是有意为之。

**类型一致性**：`parse_benchmarks` 在 Task 2 定义返回 `dict|None`，Task 4 的
`check_opening_benchmark(report, bench)` 对 `None` 有显式分支；`BENCHMARK` schema 的
`strength` 枚举与 `benchmark_lib.STRENGTHS` 逐字一致（含 U+00B7 分隔符）；
`merge_preserving_manual` 的行结构与 `peers_curated.json` 的 `peers` 字段一致。
