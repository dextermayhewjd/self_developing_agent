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

   **`args` 三项一个都不能少。** 脚本有守卫
   （`if (!SYMBOL || !DATE) throw`），漏传 symbol/date 会当场抛错、不会空跑；
   但 `root` 没有守卫，漏传会静默回退到默认路径，在别的 worktree 就读错目录。

4. **验证独立成稿审查**。共享 workflow 在成稿后派独立 agent 读取完整 findings、核查、
   参照系、疑惑及写作指南，对十二节与五个 lens 的关键发现逐项审查，写入
   `reports/<代码>_thesis_<YYYYMMDD>/成稿审查.json`。其中记录保留、遗漏、矛盾、有理由排除，
   并给出 `source_quote`、`report_quote`、修订要求和当前报告的 `report_sha256`。
   不合格时共享 workflow 最多进行两轮仅利用现有证据的修订，每轮由独立 agent 复审；
   缺外部证据必须保留限制，不能编造或自行扩展为重采集。两轮后仍不合格就停止交付。

   **Workflow 返回后必须运行同一检查器**，不能只看返回摘要或 JSON 里一个 `pass`：

```
node tools/check_thesis_review.mjs reports/<代码>_thesis_<YYYYMMDD>
```

   检查器核对十二节/五方向覆盖、状态、引用是否存在于底稿及报告，以及 SHA 是否绑定当前报告。
   失败时不得更新交付档案或生成 PDF。结构与引用完整性通过不等于事实真值获得保证，
   未披露、未查到和弱参照系仍须如实呈现；不以字数或页数考核研究深度。

5. 更新 `positions/<代码>.md`（评分、评级、估值锚及变更理由、假设记分板、未决疑问、变更日志）。
   文件不存在就新建。frontmatter 的 `最近更新` 必须等于报告日（`YYYY-MM-DD`）。

   **这一步必须排在硬门之前**：硬约束 2 就是查 `positions/<代码>.md` 存在且
   `最近更新` == 报告日。先跑门必然吃一个 `[FAIL] 档案不存在`（2026-09-11 实测）。

6. **跑硬门**——`check_thesis.py` 在 workflow 里只是 `编排器待办` 数组里的
   一句返回文本，**脚本自己不执行**：

```
.venv/bin/python tools/check_thesis.py <代码> reports/<代码>_thesis_<YYYYMMDD>/report.md
```

   退出码 `1` 必须回去修。**硬门修复或其他后续操作只要改变 `report.md`，旧审查就不能继续授权交付。**
   修复后必须用同一脚本的 `review_only` 分支复审：

```
Workflow({
  scriptPath: '<第 1 步的仓库根>/.claude/workflows/equity-thesis.mjs',
  args: {
    symbol: '<归一化后的代码>', date: '<YYYYMMDD>', root: '<第 1 步的仓库根>',
    review_only: true
  }
})
```

   复审返回后重新运行第 4 步检查器；通过后重新更新第 5 步档案，再运行本步硬门。
   每次后续报告改动都重复这个顺序，不能仅凭旧 `pass` 或一次硬门通过跳过复审。

7. **审查与硬门都通过之后转 PDF**：

```
.venv/bin/python tools/md_to_pdf.py --md reports/<代码>_thesis_<YYYYMMDD>/report.md
```

   输出到 `reports/pdf/<代码>_thesis_<YYYYMMDD>.pdf`。
   **必须排在硬门之后**——门挂了要回去改 `report.md`，先转就是一份过期 PDF。
   `--md` 不能省：不带它工具会去找 `reports/<代码>_<日期>.md`（`equity-report-cn` 的
   扁平路径），判断稿不在那儿。

8. 把结论转述给用户：run 目录、独立成稿审查是否通过、是否过 `check_thesis.py` 硬门、PDF 路径与页数、
   几条疑惑销账、承重数字核实了多少条。**不要只说"跑完了"。**

## 提醒用户

- 这一跑不便宜：601678 那次 93.8 分钟、12 个 agent、197 万 tokens、598 次工具调用。
  这是历史单次运行记录，不代表每次耗时或用量；新增独立审查及可能的修订也需要执行时间。
- 跑的时候可以用 `/workflows` 看实时进度树：立疑 / 挖掘 / 核查 / 补参照系 / 成稿 / 成稿审查，
  不合格时还会进入修订成稿并再次审查。
- 港股跑之前先看 `docs/hk-data-layer.md` 的「缺口分两类」：
  A 类（扣非、季报、销售收现比）制度上不存在，不要去年报找；
  B 类（商誉、其他应收款拆分）年报里有但 aggregate.json 里是 null，**别当成公司没有**。
- **港股标的的板块基准这一槽会降级**：`tools/discover_peers.py` 的候选发现、主营描述、
  估值三条通道全是 A 股 only（`fetch_zyjs_text` 对非 6 位代码直接返回 None；
  非 A 股行写 `valuation_err` 且 PE/PB/PS 不写、天然排除出中位数）。
  同业只能是 A 股；找不到就判弱参照系、结论按设计降级。
  **这是设计内行为，不是故障，不要让它反复重试。**

$ARGUMENTS
