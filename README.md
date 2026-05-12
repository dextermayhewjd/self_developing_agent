# 自开发代理 - 股票研究报告生成系统

使用 Claude Code 和自定义 skills 生成结构化的 A 股研究报告。

## 快速开始

### 生成单个报告
```bash
/equity-report-cn 688981
```

输入 A 股 6 位代码，系统自动生成完整的研究报告。

### 定期运行报告
```bash
/loop 24h /equity-report-cn [股票代码]
```

### 定时任务
```bash
/schedule "0 9 * * 1-5" /equity-report-cn [股票代码]
```

每个工作日上午 9 点自动生成报告。

## 替换 Claude Code 后端

Claude Code 默认使用 Anthropic 官方模型，你可以通过创建 wrapper 脚本来替换成其他 AI 后端（如 DeepSeek、本地模型等）。

### 方式一：使用 DeepSeek 后端

1. **创建 wrapper 脚本** `/home/hongshi/.local/bin/claude-deepseek`:

```bash
#!/usr/bin/env bash

# 避免官方 Anthropic key 和 DeepSeek token 混在一起
unset ANTHROPIC_API_KEY

export ANTHROPIC_BASE_URL="https://api.deepseek.com/anthropic"
export ANTHROPIC_AUTH_TOKEN="${DEEPSEEK_API_KEY}"

export ANTHROPIC_MODEL='deepseek-v4-pro'
export ANTHROPIC_DEFAULT_OPUS_MODEL='deepseek-v4-pro'
export ANTHROPIC_DEFAULT_SONNET_MODEL='deepseek-v4-pro'
export ANTHROPIC_DEFAULT_HAIKU_MODEL='deepseek-v4-flash'

export CLAUDE_CODE_SUBAGENT_MODEL='deepseek-v4-flash'
export CLAUDE_CODE_EFFORT_LEVEL="xhigh"

exec claude "$@"
```

2. **设置执行权限**:
```bash
chmod +x /home/hongshi/.local/bin/claude-deepseek
```

3. **设置环境变量**:
```bash
export DEEPSEEK_API_KEY="your-deepseek-api-key"
```

4. **使用 DeepSeek 后端运行 Claude Code**:
```bash
claude-deepseek
```

### 方式二：自定义后端模板

创建你自己的 wrapper 脚本（例如 `claude-local` 或 `claude-openai`）：

```bash
#!/usr/bin/env bash

# 你的自定义后端配置
export ANTHROPIC_BASE_URL="https://your-backend.com/v1"
export ANTHROPIC_AUTH_TOKEN="${YOUR_API_KEY}"
export ANTHROPIC_MODEL="your-model-name"

exec claude "$@"
```

### 关键环境变量说明

| 变量 | 说明 | 示例 |
|------|------|------|
| `ANTHROPIC_BASE_URL` | API 端点 | `https://api.deepseek.com/anthropic` |
| `ANTHROPIC_AUTH_TOKEN` | 认证令牌 | `$DEEPSEEK_API_KEY` |
| `ANTHROPIC_MODEL` | 主模型 | `deepseek-v4-pro` |
| `ANTHROPIC_DEFAULT_OPUS_MODEL` | Opus 级别模型 | `deepseek-v4-pro` |
| `ANTHROPIC_DEFAULT_SONNET_MODEL` | Sonnet 级别模型 | `deepseek-v4-pro` |
| `ANTHROPIC_DEFAULT_HAIKU_MODEL` | Haiku 级别模型 | `deepseek-v4-flash` |
| `CLAUDE_CODE_EFFORT_LEVEL` | 工作量级别 | `xhigh`, `high`, `medium`, `low` |

## 项目结构

```
.
├── .claude/                           # Claude Code 配置
│   └── skills/
│       └── equity-report-cn/          # 股票报告生成 skill
├── tools/                             # 数据处理和报告工具
│   ├── fetch_annual_pdf.py           # 获取年报 PDF
│   ├── fetch_earnings_call.py         # 获取财报电话会记录
│   ├── fetch_peers.py                 # 获取同行数据
│   ├── run_pipeline.py                # 数据处理流水线
│   ├── md_to_pdf.py                   # Markdown 转 PDF
│   └── lib.py                         # 共享工具库
├── .gitignore                         # Git 忽略规则
└── README.md                          # 项目文档
```

## 相关 Claude Code Skills

- **equity-report-cn** - 生成股票研究报告
- **loop** - 定期运行任务
- **schedule** - 定时任务调度
- **simplify** - 代码优化审查
- **review** - 代码审查
- **security-review** - 安全审查
- **claude-api** - 集成 Claude API

## 开发

### 增强报告模板
编辑 `.claude/skills/equity-report-cn/template.md`

### 修改数据获取逻辑
编辑 `tools/` 目录下对应的 Python 脚本

### 调整 Skill 行为
修改 `.claude/skills/equity-report-cn/` 下的配置文件：
- `reasoning_protocol.md` - 推理策略
- `data_contract.md` - 数据契约
- `style_guide.md` - 风格指南

## 许可证

仅供研究参考，不构成投资建议。
