# 开发指南

> **一句话规矩：永远不要在这个目录里执行 `git checkout <分支>`。**
> 开发一律去 `../sda-dev/`。原因见下。

## 为什么这个目录特殊

这个目录的**工作区本身就是生产环境**，没有部署步骤。飞书上的股票研报请求，最终会 `cd` 进这里，直接执行当时签出的代码：

```
飞书消息
  → openclaw gateway（常驻进程，端口 18789）
    → equity-research 插件
      → ~/projects/openclaw-equity-plugin/bin/openclaw-stock-research
        → cd ~/projects/self_developing_agent          ← 脚本第 13 行硬编码
          → claude-deepseek --permission-mode bypassPermissions "/equity-report-cn <代码>"
```

所以在这里切分支，**下一次飞书触发就会跑到未完成的代码上**，而且 `bypassPermissions` 意味着它不会停下来问任何问题。触发是按需的（不是定时的），不存在"安全时间窗"。

为此我们用 git worktree 把开发隔离出去：生产目录永远停在 `main`，开发在另一个目录进行。

## 目录分工

| 路径 | 分支 | 用途 |
|---|---|---|
| `~/projects/self_developing_agent` | `main` | **生产**。openclaw 读这里。只接受 merge，不切分支。 |
| `~/projects/sda-dev` | `dev` | **开发**。随便改，随便跑。 |

两个目录共享同一份 git 历史（不是复制），提交互相可见。

**就这两个，不再多。** 不按业务线拆目录（不要"港股一个、A 股一个"），也不按 feature
拆 worktree。所有开发都在 `sda-dev` 里做，需要并行的分支就在 `sda-dev` 内部切
（那里切分支是安全的，生产不受影响）。

> 曾经有过 `~/projects/sda-hk`（`feat/benchmark-type`，港股数据层）。它带来的问题是：
> 产物散在两个目录 —— 03858 / 300633 的数据和判断稿只在 sda-hk 里，生产目录看不到，
> 而 `data/` `reports/` 都被 gitignore，git 也帮不上忙。2026-08-26 已把产物并回生产
> 目录、删掉该 worktree 与分支。**别再按业务线开新目录。**

## 日常流程

### 开发

```bash
cd ~/projects/sda-dev
# 改代码、跑测试、随便折腾
git add -A && git commit -m "..."
```

期间飞书那边一直用稳定版，不受任何影响。

### 上线

```bash
cd ~/projects/self_developing_agent
git merge dev
```

**这条命令就是发布**，执行完的下一次触发才用新代码。

### 回滚

```bash
cd ~/projects/self_developing_agent
git reset --hard v1.0        # 或任何已知good的 commit
```

### 查看冻结的稳定版

```bash
git show v1.0                # 看 tag 信息
git diff v1.0 dev            # 看 dev 相对稳定版改了什么
```

## 怎么切回纯生产状态

不想要 dev 环境了，彻底清干净：

```bash
cd ~/projects/self_developing_agent
git worktree remove ../sda-dev --force   # 删掉开发目录
git branch -D dev                        # 删掉分支（改动全丢）
git worktree list                        # 确认只剩生产目录
```

如果 dev 的改动想留着以后再说，就只删目录、保留分支：

```bash
git worktree remove ../sda-dev --force
# 不执行 git branch -D，分支还在，以后 git worktree add ../sda-dev dev 可恢复
```

## 开发时的两个坑

1. **`data/` 和 `reports/` 不在 git 里**（见 `.gitignore`），所以 `sda-dev` 里这两个目录是空的。要跑通完整流程得自己造测试数据，或从生产目录软链一份过去。

2. **PDF 输出路径是硬编码到生产目录的**。`openclaw-equity-plugin/index.js:33` 写死了：

   ```
   REPORTS_PDF_DIR = "/home/hongshi/projects/self_developing_agent/reports/pdf"
   ```

   即使在 `sda-dev` 里跑，PDF 也会写进**生产目录**，测试产物会混进真实报告里。开发时注意别触发 PDF 生成，或临时改这个路径。

## 相关组件位置

| 组件 | 路径 |
|---|---|
| openclaw 配置 | `~/.openclaw/openclaw.json` |
| 插件仓库 | `~/projects/openclaw-equity-plugin/` |
| 插件 skill 软链 | `~/.openclaw/plugin-skills/stock` → 上面那个仓库 |
| 生产 Claude wrapper | `~/.local/bin/claude-deepseek` |
| wrapper 版本钉死工具 | `scripts/pin-claude-prod` |

注：`~/.openclaw/daily-report/` 那个每天 08:40 的任务跑的是 `~/projects/daily_report`，**与本仓库无关**。
