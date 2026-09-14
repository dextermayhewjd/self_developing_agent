**第一个动作就是调 Workflow 工具。** 不要先读 skill、不要先探索仓库、不要先问要不要跑。

## 本命令明确禁止 skill 路径

SessionStart 注入的那条「只要有 1% 的可能某个 skill 适用，你 ABSOLUTELY MUST 调用它」，
**在本命令下不适用**。`equity-thesis-cn` 这个 skill 确实存在，但走它就是本命令要避免的
失败形态本身：

> `/equity-thesis-cn` 是 skill 的散文编排，派谁、什么时候成稿都由模型现场决定。
> 601678 实测**连续五轮都在核查阶段耗尽预算，`report.md` 一次都没产出**。
> 第六轮改用 workflow 脚本——**成稿是脚本里的 `await`，不由模型决定要不要走**——
> 一次通过硬门。

所以：

- **禁止**调用 `equity-thesis-cn` skill。
- **禁止**用 Agent/Task 手工编排五个 lens。
- 要产出报告，**只能**走 Workflow 工具。

这两条不是建议。如果你正在说服自己「先看一眼 SKILL.md 也没坏处」——**那就是那五轮失败的第一步**。

## 参数

`$ARGUMENTS` 里按顺序取：

1. **代码**（必填）：A 股 6 位或港股 5 位。`03858` / `03858.HK` / `601678` 都认。
2. **报告日**（选填，`YYYYMMDD`）：不给就用今天。

## 执行

1. 取仓库根：`git rev-parse --show-toplevel`。
   **必须传给 workflow**——脚本里 `ROOT` 默认指向 `~/projects/sda-dev`，
   在别的 worktree 不传就会读错目录的 skill 与 data。
   **别在 `~/projects/self_developing_agent` 跑**，那是生产 main。
2. 确认数据就位：`python3 tools/validate.py <代码>`。按退出码确定性分支，**不要问用户**：
   - `0` 核心字段齐备 → 直接进下一步
   - `1` 核心字段缺失 → 先跑 `.venv/bin/python tools/run_pipeline.py <代码>` 再校验
   - `2` 非核心字段缺失/数据警告 → **照常进下一步**，但每条警告都要在报告里明示

   **港股 5 位代码 `run_pipeline` 会自动分派到港股管道，命令不用改。**
3. 调 Workflow 工具。**用 `scriptPath`，不要用 `name`**——
   `.claude/workflows/*.mjs` 在本 build 里不会被注册成具名 workflow，
   传 `name: 'equity-thesis'` 会报 `Workflow "equity-thesis" not found. Available: deep-research`
   （2026-09-04 实测）：

```
Workflow({
  scriptPath: '<第 1 步的仓库根>/.claude/workflows/equity-thesis.mjs',
  args: { symbol: '<归一化后的代码>', date: '<YYYYMMDD>', root: '<第 1 步的仓库根>' }
})
```

   **`args` 三项一个都不能少。** 脚本第 31 行有守卫
   （`if (!SYMBOL || !DATE) throw`），漏传 symbol/date 会当场抛错、不会空跑；
   但 `root` 没有守卫，漏传会静默回退到默认路径，在别的 worktree 就读错目录。

4. 更新 `positions/<代码>.md`（评分、评级、估值锚及变更理由、假设记分板、未决疑问、变更日志）。
   文件不存在就新建。frontmatter 的 `最近更新` 必须等于报告日。

   **这一步必须排在硬门之前**：硬约束 2 就是查 `positions/<代码>.md` 存在且
   `最近更新` == 报告日。先跑门必然吃一个 `[FAIL] 档案不存在`（2026-09-11 实测）。

5. **跑硬门**——`check_thesis.py` 在 workflow 里只是 `编排器待办` 数组里的
   一句返回文本，**脚本自己不执行**：

```
.venv/bin/python tools/check_thesis.py <代码> reports/<代码>_thesis_<YYYYMMDD>/report.md
```

   退出码 `1` 必须回去修。

6. **过门之后转 PDF**：

```
.venv/bin/python tools/md_to_pdf.py --md reports/<代码>_thesis_<YYYYMMDD>/report.md
```

   输出到 `reports/pdf/<代码>_thesis_<YYYYMMDD>.pdf`。
   **必须排在硬门之后**——门挂了要回去改 `report.md`，先转就是一份过期 PDF。
   `--md` 不能省：不带它工具会去找 `reports/<代码>_<日期>.md`（`equity-report-cn` 的
   扁平路径），判断稿不在那儿。

7. 把结论转述给用户：run 目录、是否过 `check_thesis.py` 硬门、PDF 路径与页数、
   几条疑惑销账、承重数字核实了多少条。**不要只说"跑完了"。**

## 提醒用户

- 这一跑不便宜：601678 那次 93.8 分钟、12 个 agent、197 万 tokens、598 次工具调用。
  **这是硬时长，压不了**——成稿是流水线最后一环。
- 跑的时候可以用 `/workflows` 看实时进度树，五个 phase 是 立疑 / 挖掘 / 核查 / 补参照系 / 成稿。
- 港股跑之前先看 `docs/hk-data-layer.md` 的「缺口分两类」：
  A 类（扣非、季报、销售收现比）制度上不存在，不要去年报找；
  B 类（商誉、其他应收款拆分）年报里有但 aggregate.json 里是 null，**别当成公司没有**。
- **港股标的的板块基准这一槽会降级**：`tools/discover_peers.py` 的候选发现、主营描述、
  估值三条通道全是 A 股 only（`fetch_zyjs_text` 对非 6 位代码直接返回 None；
  非 A 股行写 `valuation_err` 且 PE/PB/PS 不写、天然排除出中位数）。
  同业只能是 A 股；找不到就判弱参照系、结论按设计降级。
  **这是设计内行为，不是故障，不要让它反复重试。**

$ARGUMENTS
