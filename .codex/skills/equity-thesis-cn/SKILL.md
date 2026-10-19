---
name: equity-thesis-cn
description: 当用户要求对 A 股或港股做进不进池子、盯哪个变量的判断型研究，或续跑深度 thesis 报告时使用。只需全量数据底稿时用 equity-report-cn；讨论方法或兼容性不启动研究。
---

# Codex 判断型研究

产出五维评分、字母评级、赔率区间与决定性变量，并持续更新个股档案。股票代码和报告日沿用用户输入；日期省略时使用执行器当天日期，港股代码保留前导零。

本技能与 `$thesis-wf` 是同一条完整研究流程的两个入口。先确定当前技能真实路径所属仓库根，再执行：

```bash
node <仓库根>/tools/run_codex_workflow.mjs equity-thesis --symbol <代码> --date <YYYYMMDD> --root <仓库根>
```

未给日期省略 `--date`；明确不需要 PDF 时加 `--no-pdf`。模型、推理强度和并发数使用用户指定值或执行器当前配置。执行器冻结运行配置，同一次续跑沿用原配置。

执行器负责数据就位、档案输入、立疑、五方向挖掘及即时核查、板块基准、补参照系、独立成稿、独立审查及最多两轮修订、档案更新、硬门与 PDF。不要在入口亲自重排这些阶段，也不要在阶段工作进程中递归调用本技能。

持续跟进原进程与运行日志，进程启动不等于报告完成。失败时保留已落盘证据并说明失败阶段；不自行改成单体写稿。中断后以相同命令续跑；执行器提示输入变更时，只在用户授权重新生成后使用 `--reset`，它会归档已有本次产物。

研究或审查方法时读取所需资料；启动报告时直接使用执行器，不需要在父会话把全部方法文件重读一遍：

| 资料 | 内容与使用时机 |
|---|---|
| [writing_contract.md](writing_contract.md) | 三段式、跨期档案、决策疑惑、数字纪律、统一判断、参照系声明、估值和评分；成稿及校准必读 |
| [framework.md](framework.md) | 十二节骨架、行业适配、必比口径和评分方法 |
| [valuation_archetypes.md](valuation_archetypes.md) | 立疑时选择估值原型，传给各研究方向 |
| [orchestration.md](orchestration.md) | 实际阶段依赖、落盘职责、审查和交付顺序 |
| [position_file.md](position_file.md) | 档案格式、人工输入、跨期更新规则 |
| [style_guide.md](style_guide.md) | 中文术语、金额单位、CY 口径及第一人称语气 |
| [尽调](lenses/尽调.md)、[产业](lenses/产业.md)、[竞争](lenses/竞争.md)、[战略驱动](lenses/战略驱动.md) | 四方向研究方法 |
| [核查](lenses/核查.md)、[可比性判定](lenses/可比性判定.md) | 承重数字原文核实与同业可比性 |
| [财务排雷](../financial-redflags-cn/SKILL.md) | 第四节财务方法，可独立调用 |

Codex 中读写文件使用文件工具或终端；PDF 先用 `pdftotext -layout`，表格、截图或负号不清楚时用 `pdftoppm` 渲染指定页再用图像工具读。`data/<代码>/annual_pdf/` 缓存的往期年报用于核对商誉减值、借款用途、分部重分类和激励目标兑现，不能仅看最新一期就把跨期问题记成无法核实。网页证据使用可用的搜索和读取工具。所有输出路径取仓库根拼成绝对路径，遵循当前 Codex 权限。

交付前以执行器最终 JSON 和实际产物为准：独立审查通过并绑定当前报告 SHA，`check_thesis.py` 硬门不得失败，最后才生成 PDF。最终说明结论、报告/档案/PDF 路径、疑惑销账、本轮核实数及仍存限制。完整 CLI 与恢复选项见 [操作说明](../../../docs/codex-workflow.md)。
