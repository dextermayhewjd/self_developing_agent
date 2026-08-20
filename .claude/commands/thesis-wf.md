用 **workflow**（不是 skill）生成判断稿。

这条命令存在的理由：`/equity-thesis-cn` 走的是 skill 的散文编排，由模型自行决定
派谁、什么时候成稿——601678 实测连续五轮都在核查阶段耗尽预算，report.md 一次都
没产出。第六轮改用 workflow 脚本（成稿是脚本里的 `await`，不由模型决定要不要走）
一次通过硬门。所以要产出报告，走这条。

## 参数

`$ARGUMENTS` 里按顺序取：

1. **代码**（必填）：A 股 6 位或港股 5 位。`03858` / `03858.HK` / `601678` 都认。
2. **报告日**（选填，`YYYYMMDD`）：不给就用今天。

## 执行

1. 取仓库根：`git rev-parse --show-toplevel`。
   **必须传给 workflow**——脚本里 `ROOT` 默认指向 `~/projects/sda-dev`，
   在别的 worktree（如港股分支）不传就会读错目录的 skill 与 data。
2. 确认数据就位：`python3 tools/validate.py <代码>`。
   退出 0 直接进下一步；退出 1 先跑 `.venv/bin/python tools/run_pipeline.py <代码>`
   再校验。**港股 5 位代码 run_pipeline 会自动分派到港股管道，命令不用改。**
3. 调 Workflow 工具：

```
Workflow({
  name: 'equity-thesis',
  args: { symbol: '<归一化后的代码>', date: '<YYYYMMDD>', root: '<第 1 步的仓库根>' }
})
```

4. 跑完读 workflow 的返回，把结论转述给用户：run 目录、是否过 `check_thesis.py`
   硬门、几条疑惑销账、承重数字核实了多少条。**不要只说"跑完了"。**

## 提醒用户

- 这一跑不便宜：601678 那次 93.8 分钟、12 个 agent、197 万 tokens、598 次工具调用。
- 跑的时候可以用 `/workflows` 看实时进度树。
- 港股跑之前先看 `docs/hk-data-layer.md` 的「缺口分两类」：
  A 类（扣非、季报、销售收现比）制度上不存在，不要去年报找；
  B 类（商誉、其他应收款拆分）年报里有但 aggregate.json 里是 null，**别当成公司没有**。

$ARGUMENTS
