---
name: thesis-wf
description: 当用户要求在 Codex 中生成或续跑 A 股、港股判断型研究报告，或显式调用 thesis-wf 时使用。仅询问兼容性、修改研究方法或审查代码时不启动研究。
---

# 在 Codex 中运行判断稿 workflow

使用本仓库的确定性执行器推进研究、即时核查、成稿和交付。研究规则位于 `.codex/skills/`，流程定义位于 `.codex/workflows/`，所有研究阶段由 Codex CLI 执行。

从用户参数取得股票代码，以及可选报告日 `YYYYMMDD`。缺代码才询问；日期省略时让执行器采用本机当天日期。保留港股代码前导零。以本技能所在项目为根目录，用绝对路径执行：

```bash
node <仓库根>/tools/run_codex_workflow.mjs equity-thesis --symbol <代码> --date <YYYYMMDD> --root <仓库根>
```

日期未指定则省略 `--date`。用户要求不生成 PDF 时追加 `--no-pdf`。用户指定模型或并发数时分别传 `--model`、`--jobs`；未指定则采用执行器默认值。首次使用若缺 Node 依赖，在仓库根运行 `npm ci`。

调用执行器，不手工重编排各研究方向。执行器内的工作进程不得递归调用本技能。阶段与产物合同见 [研究编排](../equity-thesis-cn/orchestration.md)，研究与写作规则见 [判断稿技能](../equity-thesis-cn/SKILL.md)。

长任务保持运行并读取终端进度；向用户报告当前阶段。若终端工具提前返回会话 ID，继续轮询原进程，不能把“进程已启动”当成完成。发生中断或错误时报告失败阶段及日志路径，不自动追加绕过权限参数。

相同代码和日期再次执行即续跑，并沿用原先的模型、推理强度和 PDF 选项。缺少上次参数时先查看报告目录中的 `.codex-workflow/state.json` 和 `events.jsonl`；仍无法确定再询问，不用当天日期猜测。已有初稿或 v2 Store 且原始输入清单完整时，执行器直接恢复审查与交付；档案缺失或旧研究阶段失败不会重跑研究。提示脚本/数据/指南已变化时，保留当前文件并说明冲突；只有用户授权重跑才使用 `--reset`。该参数会把本次 workflow 旧产物移入隔离目录，保留持仓档案。

交付时读取执行器最终 JSON：报告及档案路径、硬门退出码、PDF 状态、累计/本轮核实数量、疑惑销账数量和数据警告。退出失败就说明未完成交付，不绕过硬门。`--no-pdf` 的结果必须说明未生成 PDF。

仅检查安装或兼容性时运行同一命令加 `--check`；它不调用模型、不获取行情、不生成报告。此时没有股票代码可用 `00700` 作为合成检查占位，无须向用户询问标的。选项、辅助 workflow 和恢复细节见 [操作说明](../../../docs/codex-workflow.md)。相对路径以本技能正文在 `.codex/skills/thesis-wf/` 的真实位置解析。

## 审查续跑与累计额度

已消耗两轮、用户授权累计三轮时，用原代码/原日期执行：

```bash
node <仓库根>/tools/audit_codex_workflow.mjs <原运行目录> --json
node <仓库根>/tools/run_codex_workflow.mjs equity-thesis --symbol <代码> --date <原日期> --root <仓库根> --review-max-rounds 3
```

`--review-max-rounds N` 为累计绝对上限，默认 2，正整数 1..10，不得低于已用轮数；省略沿用既有额度。扩额不清空历史、任务 ID 或 receipt；当前已通过且无需修订时延期扩额。默认两轮对应最多三次有效完整审查。局部提案沿用问题修订的冻结模型/强度/提供者，UTF-8 上下文最多 32 KiB / 两个目标节；完整修订和最终审查分别沿用修订成稿、成稿审查配置，实际值看 execution.json。

模型与强度按字段解析：CLI 覆盖 → stages 完整标签/同类前缀 → 脚本阶段提示 → 文件 default → 冻结有效默认；切换模型且未指定强度时采用该模型的目录默认强度。只有 equity-thesis 的盘点、peer-comparability 的盘点和读配置显式提示 low；其余阶段（含问题修订、修订成稿、成稿审查）没有脚本强度提示，沿用上述冻结解析结果。问题修订是合法阶段名，stages.问题修订.effort=high 仅覆盖局部提案，不改变成稿审查；CLI 覆盖仍优先。

仅审查已有候选时，可在临时 JSON 放 `{"review_only":true}` 并追加 `--args-file <该文件>`；缺候选或原始 input-manifest 则拒绝，不重新取数。额度只放 CLI，不放 args JSON。`budget_exhausted` 可按授权扩额；`needs_evidence` / `no_safe_edit` 停止并保留未决任务，不能靠清账或重复运行制造通过。

人工改过 report.md 或证据发生变动时，报告冲突并保留字节；本批没有自动采用外部改稿/证据的入口。旧 v1 状态只读诊断，哪怕历史可重建也不能直接续成可信 v2，不能将旧额度当零。详情与证据诊断见 [操作说明](../../../docs/codex-workflow.md)。
