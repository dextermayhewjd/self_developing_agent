# calibrate-equity-thesis Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 写出 `.claude/skills/calibrate-equity-thesis/SKILL.md`——一个用 5 篇人工底稿反向审计 `equity-thesis-cn` 方法论、产出诊断报告与 before/after 改写稿的 skill。

**Architecture:** 单文件 skill。五道工序：盲抽（5 个子 agent 读 PDF，不给 skill）→ 归纳（1 个，仍不给 skill）→ 规则测绘（1 个，只给 skill）→ 对撞（编排器亲自做）→ 抽查（1 个，只查会触发改写的判定）。隔离墙靠**降低提问的抽象层级**而非禁令实现，并用标记块 + grep lint 使其可机器验证。

**Tech Stack:** Markdown（skill 文件）；`pdftotext -layout` / `pdftoppm -r 300`（读底稿）；`grep` / `awk`（结构与隔离校验）。无新增 Python 依赖。

**Spec:** `docs/superpowers/specs/2026-08-19-calibrate-equity-thesis-design.md`

## Global Constraints

- 交付物只有一个文件：`.claude/skills/calibrate-equity-thesis/SKILL.md`。`evidence/` 是首次运行的产物，**不属于本次实现**（spec §12）。
- **不提交 git。** 用户已明确"暂时不提交"，且本仓工作目录生产耦合（`DEVELOPMENT.md`）。每个 Task 末尾的 commit 步骤默认**不执行**，仅在用户明确要求时才跑。
- 底稿路径首段含**前导空格**：`/home/hongshi/ work_document/模板报告（之前的文件）/`，与同级 `/home/hongshi/work_document` 是两个不同目录。写进 skill 的命令必须整体加引号。
- 5 篇底稿代号固定为：石基 / 澜起 / 开立 / 中控 / 乐鑫。
- 支持度分母 = **适用域内的篇数**，不是恒定的 5。
- 象限②（遗漏）需 **≥3 篇适用底稿支持**才生成改写稿。
- 工序 4 抽查覆盖**象限②与③**（会触发 lens 写操作的），象限①④不查。
- 不自动改写 `lenses/`；不写校验脚本；不拆多文件（spec §13）。

---

## File Structure

| 文件 | 职责 | 本计划中的动作 |
|---|---|---|
| `.claude/skills/calibrate-equity-thesis/SKILL.md` | 唯一交付物。入口、定位边界、数据源、产物分层、五道工序、判据、产出格式、自检清单 | Task 1–3 依次写入 |
| `docs/superpowers/specs/2026-08-19-calibrate-equity-thesis-design.md` | 设计依据 | 只读，不改 |
| `.claude/skills/equity-thesis-cn/**` | 审计对象 | 只读，**本次实现不改** |

单文件的理由（spec §5）：`equity-thesis-cn` 是长到 1,286 行才拆成 framework/lenses/orchestration 的；本 skill 预计约 200 行，现在拆是过度工程。

任务切分按**读者可以单独否决**来划：Task 2（隔离墙）是整个设计的关键，值得单独一道门；Task 3（判据）是另一处实质判断。Task 1 是承载它们的骨架。

---

### Task 1: 骨架、定位、边界、数据源、产物分层

**Files:**
- Create: `.claude/skills/calibrate-equity-thesis/SKILL.md`

**Interfaces:**
- Consumes: 无（首个任务）
- Produces: 供 Task 2/3 追加内容的文件；固定的一级标题集合 `## 为什么需要它` / `## 与 debug-equity-thesis 的分工` / `## 两条天花板` / `## 数据源` / `## 产物分层`；固定的底稿代号（石基/澜起/开立/中控/乐鑫）与持久层路径 `.claude/skills/calibrate-equity-thesis/evidence/`

- [ ] **Step 1: 写会失败的结构校验命令**

新建 scratchpad 校验脚本（不入库，仅供本次实现使用）：

```bash
cat > /tmp/check_task1.sh <<'EOF'
F=.claude/skills/calibrate-equity-thesis/SKILL.md
fail=0
for h in "^name: calibrate-equity-thesis" "^## 为什么需要它" "^## 与 debug-equity-thesis 的分工" "^## 两条天花板" "^## 数据源" "^## 产物分层"; do
  grep -qE "$h" "$F" 2>/dev/null || { echo "MISSING: $h"; fail=1; }
done
grep -q "work_document" "$F" 2>/dev/null || { echo "MISSING: 底稿路径"; fail=1; }
for code in 石基 澜起 开立 中控 乐鑫; do
  grep -q "$code" "$F" 2>/dev/null || { echo "MISSING: 代号 $code"; fail=1; }
done
grep -q "evidence/" "$F" 2>/dev/null || { echo "MISSING: 持久层 evidence/"; fail=1; }
[ $fail -eq 0 ] && echo "PASS: Task1 结构完整" || echo "FAIL: Task1"
EOF
chmod +x /tmp/check_task1.sh
```

- [ ] **Step 2: 跑校验，确认它失败**

Run: `bash /tmp/check_task1.sh`
Expected: 一连串 `MISSING:` 行，最后 `FAIL: Task1`（文件还不存在）

- [ ] **Step 3: 写入骨架内容**

创建 `.claude/skills/calibrate-equity-thesis/SKILL.md`，内容为：

````markdown
---
name: calibrate-equity-thesis
description: 用 5 篇人工底稿反向审计 equity-thesis-cn 的方法论——哪些规则是从单一样本外推的（该降级）、哪些做法底稿在做而 lenses 没写（该补）、5 篇是否都符合 12 节骨架。产出诊断报告 + before/after 改写稿，由人逐条采纳，不自动改写。
---

# 校准 equity-thesis-cn

## 为什么需要它

`equity-thesis-cn` 的方法论派生自 5 篇人工底稿，但**这层派生关系从未被复核过**。已知它至少犯过一次可查证的过拟合——`framework.md` 自己记录：

> 曾经按单一样本（3.4→B）外推出一张五档表（A/B+/B/B−/C），第二份底稿直接证伪了它。这是个教训：用一个观测点固化映射表，得到的是伪精度。

一次被抓到，说明这类错误是**结构性**的而非偶发。本 skill 把那次抓捕系统化，回答两个问题：

1. 5 篇底稿是否都符合 12 节骨架的分析逻辑？
2. lenses 里哪些是单一样本外推（该降级）、哪些是底稿在做而 lenses 没写（该补）？

## 与 debug-equity-thesis 的分工

| | debug-equity-thesis | calibrate-equity-thesis（本 skill） |
|---|---|---|
| 审什么 | **行为**——编排器跑得对不对 | **方法论**——skill 教的东西对不对 |
| 方法 | 隔离跑一遍 + 审计转录 | 底稿盲抽 + 规则对撞 |
| 出口 | 已知偏离清单 + 改法 | 诊断报告 + before/after 改写稿 |

两者接力：本 skill 修**教什么**，debug 验**执行成什么样**。改完 lenses 之后应当再跑一次 debug，否则不知道改动有没有真的让行为变好。

## 两条天花板

**必须在报告里写明，不许含糊过去：**

1. **判定不了"改完之后跑得更好"。** 那是行为问题，归 debug-equity-thesis。
2. **上限就是这 5 篇底稿。** 若 5 位作者集体存在盲区，本 skill 只会看到"0/5，不该写进 lens"，无法发现该盲区。补那个要靠底稿之外的来源，不在射程内。

## 数据源

```
/home/hongshi/ work_document/模板报告（之前的文件）/
```

**路径首段含前导空格**（`/home/hongshi/ work_document`，与同级的 `/home/hongshi/work_document` 是两个不同目录）。所有命令必须把路径整体加引号，否则会静默指向另一个目录。

| 代号 | 文件 | 页数 |
|---|---|---|
| 石基 | 次新小组研究框架（石基信息）by 井井.pdf | 23 |
| 澜起 | 次新股小组-澜起科技-钟央.pdf | 23 |
| 开立 | 【次新组作业】 开立医疗- BY Kenny.pdf | 19 |
| 中控 | 次新研究-中控技术-BING.pdf | 15 |
| 乐鑫 | 9月-乐鑫科技-汤智尧.pdf | 13 |

共 93 页，只读，表格与截图占比高。`pdftotext -layout` 取正文；表格/截图页用 `pdftoppm -r 300` 渲染成图再 Read（同 `equity-thesis-cn/lenses/核查.md` 的做法）。

## 产物分层

```
.claude/skills/calibrate-equity-thesis/
  SKILL.md
  evidence/{代号}.md      ← 持久，入库。5 篇底稿的动作清单（工序 1）
  evidence/methods.md     ← 持久，入库。跨篇方法清单 D'（工序 1.5）

reports/calibrate_{YYYYMMDD}/   ← 一次 run 的产物，随 /reports/ gitignore
  报告.md                  ← 12节符合度矩阵 + 四象限总表 + 抽查记录
  rules.md                 ← 规则清单 R1…Rn（工序 2）
  patches/{目标文件}.md    ← before/after 改写稿，逐条编号
```

**分层准则：只依赖底稿的产物入持久层，依赖 skill 现状的产物入 run 文件夹。** 工序 1、1.5 只看底稿 → 持久；工序 2、3、4 都要看 skill 当前的样子 → 一次性。

**所以 `evidence/` 存在时，复审从工序 2 起跑，PDF 一页都不用再读。** 93 页底稿的内容不会变，变的是 lenses——别把最贵的一步做成最常做的一步。

**写文件一律用绝对路径**（同 `equity-thesis-cn/orchestration.md` 的教训）：本流程频繁 `cd` 读 PDF，cwd 会漂且不报错，相对路径写出的产物会静默落在别处。
````

- [ ] **Step 4: 跑校验，确认通过**

Run: `bash /tmp/check_task1.sh`
Expected: `PASS: Task1 结构完整`

- [ ] **Step 5: 提交（默认不执行）**

用户已声明暂不提交。**跳过此步**，除非用户明确要求。若要求，则：

```bash
git add .claude/skills/calibrate-equity-thesis/SKILL.md
git commit -m "feat(calibrate): 骨架、定位边界、数据源、产物分层"
```

---

### Task 2: 五道工序与隔离墙（含可机器验证的词汇 lint）

**Files:**
- Modify: `.claude/skills/calibrate-equity-thesis/SKILL.md`（在 `## 产物分层` 之后追加）

**Interfaces:**
- Consumes: Task 1 产出的文件与底稿代号、`evidence/` 路径
- Produces: 一级标题 `## 五道工序`；五个二级标题 `### 工序 1 · 盲抽` / `### 工序 1.5 · 归纳` / `### 工序 2 · 规则测绘` / `### 工序 3 · 对撞` / `### 工序 4 · 抽查`；两处隔离区标记 `<!-- ISOLATED-PROMPT-START -->` … `<!-- ISOLATED-PROMPT-END -->`（供 Task 2 的 lint 与后续复用）；动作清单四栏格式 `动作 / 页码 / 原文摘录 / 服务于什么判断`

- [ ] **Step 1: 写会失败的隔离墙 lint**

这是本计划里最重要的一条校验——它把"隔离墙"从靠自觉变成可验证：

```bash
cat > /tmp/check_task2.sh <<'EOF'
F=.claude/skills/calibrate-equity-thesis/SKILL.md
fail=0

# (a) 五道工序标题齐全
for h in "^### 工序 1 · 盲抽" "^### 工序 1.5 · 归纳" "^### 工序 2 · 规则测绘" "^### 工序 3 · 对撞" "^### 工序 4 · 抽查"; do
  grep -qE "$h" "$F" 2>/dev/null || { echo "MISSING: $h"; fail=1; }
done

# (b) 隔离区标记成对出现（工序 1 与 1.5 各一对 = 2 对）
s=$(grep -c '^<!-- ISOLATED-PROMPT-START -->$' "$F" 2>/dev/null); s=${s:-0}
e=$(grep -c '^<!-- ISOLATED-PROMPT-END -->$' "$F" 2>/dev/null); e=${e:-0}
[ "$s" = "2" ] && [ "$e" = "2" ] || { echo "BAD MARKERS: start=$s end=$e，应各为 2"; fail=1; }

# (c) 核心：隔离区内不得出现 equity-thesis-cn 的词汇
hits=$(awk '/^<!-- ISOLATED-PROMPT-START -->$/,/^<!-- ISOLATED-PROMPT-END -->$/' "$F" 2>/dev/null \
  | grep -nE "三段式|观点总结|三分法|五维评分|疑惑|基本盘|第二曲线|销账|赔率|决定性变量|假设记分板|equity-thesis|财务排雷|战略驱动|核查|lens|判断稿")
if [ -n "$hits" ]; then echo "CONTAMINATED 隔离区出现 skill 词汇："; echo "$hits"; fail=1; fi

[ $fail -eq 0 ] && echo "PASS: Task2 工序齐全且隔离区干净" || echo "FAIL: Task2"
EOF
chmod +x /tmp/check_task2.sh
```

**标记必须锚定整行**（`^<!-- … -->$`）：skill 正文里会正当地提到这两个标记名（那是给维护者看的说明），若用子串匹配，这类提及会被计入标记数、并让 awk 的区间起点错位，把非隔离区的正文卷进检查。实测过：`` `<!-- ISOLATED-PROMPT-START/END -->` `` 这种合写形式含 START 子串却不含 END 子串，会得到 start=3 / end=2 并连带误报 CONTAMINATED。锚定整行之后，正文怎么提标记名都不影响判定。

**词表 lint 不是完整的验收。** 它挡的是名词性构造词，泄漏的却可能是**规则语句**——实测踩过：隔离区里混入了被审计 skill 的章节标题「口径重算」和一句逐字规则「先检查分部结构是否可比」，词表 lint 全程 PASS、零告警。这类泄漏比词汇泄漏严重，因为泄的是规则本体而不是标签，会把一条本该落在象限③的规则推进象限①，且报告长得完全正常。

**所以验收必须加第二道：把两段隔离区文本与 `equity-thesis-cn/**/*.md` 做重合比对**——(a) ≥8 个连续汉字重合；(b) 命中对方的章节标题或加粗术语（3–12 字）。两道都过才算隔离墙成立。

**为什么词表里排除「产业」「竞争」**：它们是常用中文词，会在中性语境里合法出现（"这家公司所处产业"），列入会产生假阳性。隔离墙防的是 skill 的**专有构造词**，不是普通名词。

- [ ] **Step 2: 跑 lint，确认它失败**

Run: `bash /tmp/check_task2.sh`
Expected: 五条 `MISSING: ### 工序…` + `BAD MARKERS: start=0 end=0，应各为 2`，最后 `FAIL: Task2`

- [ ] **Step 3: 追加五道工序内容**

在 `SKILL.md` 的 `## 产物分层` 一节之后追加：

````markdown
## 五道工序

```
   ┌─ 工序1   盲抽 ×5（并行，一篇一个）  只给 PDF，不给 skill
   │            ↓
   ├─ 工序1.5 归纳 ×1                    只给 5 份动作清单，不给 skill
   │            ↓
   └─ 工序2   规则测绘 ×1（与 1/1.5 并行）只给 skill，不给底稿
                ↓
        工序3   对撞（编排器亲自做）
                ↓
        工序4   抽查 ×1（串行）
                ↓
        报告.md + patches/（编排器写）
```

**`evidence/` 已存在时，工序 1 与 1.5 整体跳过，从工序 2 起跑。**

### 隔离墙的原理（先读这里，否则后面两道工序会写坏）

**污染的入口是提问的抽象层级，不是禁令。**

问"这篇用了哪些方法论"，模型会去够它已知的方法名，于是**只认得出 skill 里写过的东西**——象限②（遗漏）当场清零，整个 skill 白做。
问"第 7 页这位作者做了什么"，它只能照着页面说。

`debug-equity-thesis` 已经用实测证明禁令无效：round2 加了"分工边界"禁令，越权调用反而从 257 升到 299。**所以隔离靠的是提问方式，不是靠写"不许看 skill"。** 禁令仍然写，但它是第二道保险，不是第一道。

被 `<!-- ISOLATED-PROMPT-START/END -->` 包起来的段落是**隔离区**：里面不得出现 `equity-thesis-cn` 的任何专有构造词。改动这两段之后必须重跑词汇 lint。

### 工序 1 · 盲抽（5 个子 agent 并行，一篇一个）

派活模板：

<!-- ISOLATED-PROMPT-START -->
```
你是文档记录员。任务只有一件：把 {PDF 绝对路径} 这份研究报告逐节读完，
记录**这位作者实际做了哪些分析动作**。

用 pdftotext -layout 取正文；表格或截图看不清时用 pdftoppm -r 300 渲染成图再看。
路径含空格，命令里整体加引号。

每条动作记成四栏：

| 动作 | 页码 | 原文或表格摘录 | 这个动作服务于什么判断 |

要求：
- 用你自己的话描述动作，**不要给动作起名字、不要归类、不要总结方法论**。
  例：写"作者把这一页的数字和前面某页的同名数字并排列出，指出两者对不上，
  并说明他采信哪一个"，而不是给这个动作起一个名字（如"××法""××分析"）。
- 第四栏必须填。它是这条动作存在的理由；填不出来说明你没读懂这一段。
- 只记你在页面上真正看到的东西。看不清就写"该页为图片，未能辨认"。

另外单独列一节「标的客观属性」，只填事实：
产品线数量 / 是否周期性行业 / 报告期内是否盈利 / 有无并购史 / 是否多分部经营 /
是否有海外收入。查不到就写"未提及"。

不要读 .claude/ 下的任何文件。不要 WebSearch。
返回上述两节，不要写成散文。
```
<!-- ISOLATED-PROMPT-END -->

**落盘由编排器保证**：收到返回后编排器自己 Write 到
`.claude/skills/calibrate-equity-thesis/evidence/{代号}.md`（绝对路径）。
不指望子 agent 自写——`equity-thesis-cn` 实测子 agent 常写不成。

### 工序 1.5 · 归纳（1 个子 agent，工序 1 全部返回后）

**这道工序不能省，也不能由编排器代做。** 编排器已通读过 `equity-thesis-cn`，由它把"动作"抽象成"方法"，会不自觉地抽象成 skill 已有的形状，使象限②静默塌进象限①——而象限②是本 skill 的全部价值。编排器第一次接触"方法"这个抽象层级，必须在 `D'` 与 `R` 都成型之后。

派活模板：

<!-- ISOLATED-PROMPT-START -->
```
你拿到 5 份研究报告的动作记录（{evidence 目录绝对路径} 下 5 个 .md）。
任务：把这些具体动作归纳成**可复用的分析方法**。

一条方法的判准：换一家完全不同的公司，照着它还能执行。
绑死在某一家公司、某一个年份、某一个具体数字上的描述，不是方法；
能写成"凡遇到 X 情形，就先做 Y、再据此决定 Z"这种形式的，才是方法。

每条方法写成：

| 方法陈述 | 哪几份在做 | 各自页码 | 这个方法解决什么问题 |

要求：
- 只从这 5 份记录里归纳，**不要补充你自己知道的其他研究方法**。
- 一份都没在做的，不要写。
- 只有一份在做的也要写，标清楚只有一份——后面另有用处。
- 不要给方法排优先级，不要评价好坏。

不要读 .claude/ 下的任何文件（那 5 个 .md 除外）。不要 WebSearch。
```
<!-- ISOLATED-PROMPT-END -->

编排器把返回写到 `evidence/methods.md`（绝对路径）。

### 工序 2 · 规则测绘（1 个子 agent，可与工序 1/1.5 并行）

输入：`equity-thesis-cn/SKILL.md`、`framework.md`、`lenses/*.md`、`financial-redflags-cn/SKILL.md`。**不给底稿。**

输出 `rules.md`，每条：

```
R-{来源}-{序号}  一句话摘要
出处   {文件}:{行号}
原文   「逐字抄的规定性语句」
适用域 {无条件 / 条件：xxx}
形态   {方法型 / 例子型 / 伪方法}
```

**什么算规定性语句**：含"必须/要/应当/不许/固定/一律"的句子；以及无这些词但实际在规定动作的句子（如"每节挑 2–4 个深答"）。纯背景描述不计。

### 工序 3 · 对撞（编排器亲自做，不外包）

不外包的理由同 `equity-thesis-cn` 的综合成稿：判断必须由一个脑子统一做，否则口径会散。

**动作一：四象限。** 把 `evidence/methods.md` 的 `D'` 与 `rules.md` 的 `R` 对齐：

| | 底稿在做 | 底稿不做 |
|---|---|---|
| **skill 有写** | ① 已固化 | ③ **过拟合 / 无源之水** |
| **skill 没写** | ② **遗漏** | ④ 不管 |

**动作二：12 节符合度矩阵**（回答问题 1）。判据是**该节的分析动作有没有发生**，不是有没有同名章节、不是顺序对不对。三档：

- **做了** — 该节要回答的问题，底稿实质回答了（哪怕散落别处、标题完全不同）
- **未做** — 没有对应的分析动作
- **不适用** — 该节对这家公司无意义（如单一产品线公司的产品三分法）

分母只算「做了 + 未做」。**某节若在适用篇里支持度 ≤ 1/2，那是骨架过度规范化的证据，结论指向 `framework.md` 而不是 lenses。**

### 工序 4 · 抽查（1 个子 agent，串行，出改写稿之前）

**只查会触发 lens 写操作的判定**：

| 象限 | 会否改 lens | 抽查 |
|---|---|---|
| ② 遗漏 → 新增 | 会 | **要** |
| ③ 过拟合 → 删/降级 | 会 | **要** |
| ① 已固化 → 不动 | 否 | 不查 |
| ④ 双方都无 | 否 | 不查 |

按**是否触发写操作**划线，不按象限直觉划线：误判过拟合会删掉好方法；误判遗漏会往 lens 里加一条假方法、污染此后每一份报告。**两类误判代价对称，都要查。**

抽查方式：回到"据称支持/不支持"的那几篇底稿原文复核，逐条抄页码与原文，明确区分「底稿确实没做」与「我没找到」。这是 `equity-thesis-cn/lenses/核查.md` 那道工序的同构物。
````

- [ ] **Step 4: 跑 lint，确认通过**

Run: `bash /tmp/check_task2.sh`
Expected: `PASS: Task2 工序齐全且隔离区干净`

若报 `CONTAMINATED`，说明派活模板里混进了 skill 的专有词——**改模板，不要改词表**。词表是这道门的规格，放宽词表等于拆掉门。

- [ ] **Step 5: 提交（默认不执行）**

跳过，除非用户明确要求。若要求：

```bash
git add .claude/skills/calibrate-equity-thesis/SKILL.md
git commit -m "feat(calibrate): 五道工序与隔离墙，含词汇 lint 标记"
```

---

### Task 3: 判据、产出格式、自检清单与冒烟用例

**Files:**
- Modify: `.claude/skills/calibrate-equity-thesis/SKILL.md`（在 `### 工序 4 · 抽查` 之后追加）

**Interfaces:**
- Consumes: Task 2 产出的象限编号（①②③④）、规则编号规则 `R-{来源}-{序号}`
- Produces: 一级标题 `## 判据` / `## 产出格式` / `## 自检清单`；改写稿编号 `P-{来源}-{序号}`（与 `R-` 一一对应）；冒烟用例（3.4→B 五档表）

- [ ] **Step 1: 写会失败的校验命令**

```bash
cat > /tmp/check_task3.sh <<'EOF'
F=.claude/skills/calibrate-equity-thesis/SKILL.md
fail=0
# 断言只在本 Task 新增的区间（`## 判据` 到文末）里跑。
# 若对全文跑，"伪方法"/"3.4"/"不自动" 会被 Task 1/2 的既有内容提前满足，
# 这三条断言就等于没在验 Task 3——实测踩过，见计划末尾 Self-Review。
SEC=$(awk '/^## 判据$/,0' "$F" 2>/dev/null)
for h in "^## 判据" "^## 产出格式" "^## 自检清单"; do
  echo "$SEC" | grep -qE "$h" || { echo "MISSING: $h"; fail=1; }
done
echo "$SEC" | grep -q "适用域内的篇数" || { echo "MISSING: 支持度分母定义"; fail=1; }
echo "$SEC" | grep -q "伪方法" || { echo "MISSING: 形态三分"; fail=1; }
echo "$SEC" | grep -qE "≥ ?3 篇" || { echo "MISSING: 象限②入 lens 门槛"; fail=1; }
echo "$SEC" | grep -qE "P-\{来源\}" || { echo "MISSING: 改写稿编号规则"; fail=1; }
echo "$SEC" | grep -q "3.4" || { echo "MISSING: 冒烟用例"; fail=1; }
echo "$SEC" | grep -q "不自动" || { echo "MISSING: 不自动改写声明"; fail=1; }
[ $fail -eq 0 ] && echo "PASS: Task3 判据与产出完整" || echo "FAIL: Task3"
EOF
chmod +x /tmp/check_task3.sh
```

- [ ] **Step 2: 跑校验，确认它失败**

Run: `bash /tmp/check_task3.sh`
Expected: 九条 `MISSING:` 行，最后 `FAIL: Task3`（`## 判据` 尚不存在，`awk` 取到空串，九条断言全数落空）

- [ ] **Step 3: 追加判据、产出格式、自检清单**

在 `SKILL.md` 末尾追加：

````markdown
## 判据

### 支持度：分母是适用域内的篇数

```
支持度 = 该方法命中的篇数 / 适用域内的篇数
```

**分母不是恒定的 5。** 否则"周期股用穿越周期 P/B"这类只对周期股成立的规则，会被 1/5 误判成过拟合。适用域由工序 2 打标签，与工序 1 记录的「标的客观属性」机械匹配——不要临场拍。

5 篇一人一票，等权。

### 形态三分（这是"不要过度依赖具体例子"的可执行版）

| 形态 | 定义 | 改写方向 |
|---|---|---|
| **方法型** | 说清了怎么做，换一家公司照样执行 | 升格进正文 |
| **例子型** | 只给了"某篇怎么做的"，换家公司无从下手 | 降级为脚注/附录 |
| **伪方法** | 看着像方法，实为单一样本外推 | 删除，或降级为"待更多样本" |

**不是删例子。** 是把例子和它想教的方法拆开，让方法能独立站住；拆完例子留作佐证。判据很简单：**把例子那几行遮住，剩下的字还够不够一个没读过底稿的人照着做？** 不够就是例子型。

### 象限②的入 lens 门槛

需 **≥ 3 篇适用底稿支持**才生成改写稿。只有 1–2 篇的记为「候选」，写进报告但**不生成 patch**。

这道门槛防的是：5 篇是不同作者的小组作业，质量未必齐，单篇独有的做法可能是个人习惯甚至坏习惯，不该被当成方法学进 lens。

## 产出格式

**规则判定卡**（`报告.md` 的基本单元）：

```
R-产业-03  三分法（基本盘 / 第二曲线 / 第二曲线储备）
出处       lenses/产业.md:18
形态       方法型
适用域     条件：多产品线公司 → 适用 4/5 篇（乐鑫单一产品线，不计票）
支持度     3/4
象限       ① 已固化
判定       保留。但 lens 现有表述里例子占三行、方法占一行，
           建议按「方法升格、例子降级」重排，内容不变。
```

编号 `R-{来源}-{序号}`；改写稿一一对应 `P-{来源}-{序号}`，便于逐条采纳（"采纳 P-产业-03 与 P-竞争-01，其余不动"）。

**`报告.md` 三块**：
1. 12节 × 5篇 符合度矩阵（答问题 1）
2. 四象限总表（答问题 2）
3. 抽查记录（哪些判定被复核、有无翻案）

**`patches/{目标文件}.md`**：每条给 before / after 原文块 + 一句改写理由 + 挂靠的规则号。

**处置权：诊断 + 改写稿，不自动落盘。** 由人逐条挑选后再落到 `lenses/`。理由：判过拟合用的是 5 票支持度，N=5 极小；一条规则拿 1/5，可能是过拟合，也可能只是另外 4 位作者没想到——两者形状相同，只有人能分。自动改写等于把这个判断交给投票，而那正是本 skill 要治的病。

## 自检清单

交付前逐条过。**不写校验脚本**——本 skill 跑得不频繁，等它跑到第三次仍在犯同类错误再固化成脚本（同 `check_thesis.py` 的演化路径：那些硬约束都是实测踩过之后才加的）。

- [ ] **冒烟用例**：`framework.md` 自记的"按 3.4→B 单点外推出五档表"是一个**已确认的伪方法**。本次跑完若没把它标为伪方法或低支持度，**说明判据失灵，结果不可信**，回去查工序 2 的形态判定。
- [ ] 每条判定都带页码
- [ ] 每条 patch 都挂着规则号
- [ ] 每条象限② 的 patch 都有 ≥ 3 篇支持（1–2 篇的应停在「候选」）
- [ ] 12节矩阵的 5 列都非空
- [ ] 象限②③ 全部经工序 4 抽查，且抽查结论区分了「底稿确实没做」与「我没找到」
- [ ] 报告里写明了两条天花板
- [ ] 产物落在正确位置：`evidence/` 用绝对路径写，run 文件夹在 `reports/calibrate_{YYYYMMDD}/`
````

- [ ] **Step 4: 跑三个校验，确认全部通过**

Run:
```bash
bash /tmp/check_task1.sh && bash /tmp/check_task2.sh && bash /tmp/check_task3.sh
```
Expected:
```
PASS: Task1 结构完整
PASS: Task2 工序齐全且隔离区干净
PASS: Task3 判据与产出完整
```

- [ ] **Step 5: 人工通读一遍全文**

Run: `wc -l .claude/skills/calibrate-equity-thesis/SKILL.md`
Expected: 280–300 行。若显著超出，检查是不是把例子写多了——本 skill 自己就不该犯"例子淹没方法"的病。

- [ ] **Step 6: 提交（默认不执行）**

跳过，除非用户明确要求。若要求：

```bash
git add .claude/skills/calibrate-equity-thesis/SKILL.md
git commit -m "feat(calibrate): 判据、产出格式、自检清单与冒烟用例"
```

---

## 实现完成后的下一步（不属于本计划）

按 spec §12，实现到 SKILL.md 落盘为止。随后的独立动作是**首次实跑**：

1. 跑 `calibrate-equity-thesis`，产出 `evidence/`（5 份动作清单 + `methods.md`）与 `reports/calibrate_20260819/`
2. 用冒烟用例检验判据是否失灵
3. 人工逐条挑选 patch
4. 落到 `lenses/` 后跑 `debug-equity-thesis` 验证行为确实变好

---

## Self-Review

**Spec 覆盖检查**（逐节对照 spec）：

| spec 节 | 对应任务 | 状态 |
|---|---|---|
| §1 要解决的问题 | Task 1 Step 3「为什么需要它」 | ✓ |
| §2 与 debug 的分工 | Task 1 Step 3 分工表 | ✓ |
| §3 两条天花板 | Task 1 Step 3；Task 3 自检清单 | ✓ |
| §4 数据源（前导空格） | Task 1 Step 3；Global Constraints | ✓ |
| §5 架构与产物分层 | Task 1 Step 3「产物分层」 | ✓ |
| §6 五道工序 + 隔离墙 | Task 2 全部 | ✓ |
| §7 判据（支持度/形态/门槛） | Task 3 Step 3「判据」 | ✓ |
| §8 产出格式 | Task 3 Step 3「产出格式」 | ✓ |
| §9 处置权 | Task 3 Step 3 末段 | ✓ |
| §10 失败模式与对策 | 分散落在各工序正文（隔离墙原理、绝对路径、抽查、≥3票、evidence 缓存） | ✓ |
| §11 验收测试 | Task 3 Step 3「自检清单」含冒烟用例 | ✓ |
| §12 实现边界 | Global Constraints + 文末「下一步」 | ✓ |
| §13 YAGNI | Global Constraints | ✓ |

**占位符扫描**：全文无 TBD / TODO / "类似 Task N" / "补充适当的错误处理"。每个内容步骤都给了可直接写入的完整正文；每个校验步骤都给了可直接运行的完整命令。

**类型/命名一致性**：
- 规则编号 `R-{来源}-{序号}` 与改写稿编号 `P-{来源}-{序号}` 在 Task 2（工序 2 输出格式）与 Task 3（判定卡、patches）中一致
- 象限编号 ①②③④ 的语义在 Task 2（工序 3、工序 4）与 Task 3（门槛、自检清单）中一致
- 持久层路径 `.claude/skills/calibrate-equity-thesis/evidence/` 在 Task 1（产物分层）、Task 2（工序 1/1.5 落盘）中一致
- run 文件夹 `reports/calibrate_{YYYYMMDD}/` 在 Task 1、Task 3 自检清单中一致
- 隔离区标记 `ISOLATED-PROMPT-START/END` 在 Task 2 的 lint 与两处派活模板中一致，数量断言为各 2

**发现并已修的两处**：

其一，Task 2 的 lint 里标记计数原写作 `grep -c ... || echo 0`——文件存在但零匹配时 `grep -c` 会打印 `0` 并以退出码 1 返回，于是 `|| echo 0` 再补一个 `0`，变量拿到两行。**而这正是 Task 2 RED 步骤的真实状态**（Task 1 已建好文件、标记尚未加入），报错会印成 `start=0\n0`。已改为 `grep -o ... | wc -l`，任何情况下都返回单个干净数字。这条是把校验命令真跑了一遍才发现的，不是读出来的。

其二，Task 2 的 lint 词表最初含「产业」「竞争」，会对中性语境（"这家公司所处产业"）产生假阳性，已移出词表并在计划中写明理由——隔离墙防的是专有构造词，不是普通名词。
