# Codex workflow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在当前 Codex CLI 中运行共享研究 workflow，保留调度、续跑、结构化返回与交付硬门。

**Architecture:** Node 执行器包装现有 `.mjs` 并注入兼容运行时。每个 agent 调用独立的 `codex exec`；业务外层完成数据、档案、校验和 PDF。状态文件与业务产物共目录。

**Tech Stack:** Node.js 22 原生测试与进程接口，Ajv 8.20.0，现有 Python 工具，Codex CLI 0.162.1。

**Spec:** `docs/superpowers/specs/2026-10-15-codex-workflow-design.md`

## Global Constraints

- 继续在 sda-dev/dev 工作，不修改生产环境及用户已有改动。
- 共用三份 `.claude/workflows/*.mjs` 与研究指南，不另写一套业务流程。
- 默认 jobs=3；Codex worker 使用 workspace-write 和自动审批，不自动绕过沙箱。
- 必须参数数组启动子进程；保留代码前导零；日期做日历验证。
- 未通过硬门不生成 PDF；没有真实研报测试时不宣称研报端到端通过。

## Review Focus

- 进程中断或半成品不能在恢复时被当成成功。
- 并发限流不能使每条 pipeline 变为整批屏障或形成嵌套死锁。
- 严格 schema 转换不能丢失 enum、数组长度和缺省语义。
- 同一标的同时运行、路径含空格、输入非法日期均须明确处理。
- 旧产物可导入，但脚本/指南改变、缺少产物时不得使用过期缓存。

### Task 1: Schema transport

**Files:** Create `package.json`, `tests/codex_workflow/schema.test.mjs`, `tools/codex_workflow/schema.mjs`; modify `.gitignore` for node_modules and execution metadata.

**Interfaces:** Produces `transportSchema(schema)`, `decodeResult(schema,value)`, `validateEvidence(value)`.

- [ ] Write failing tests for optional nulls, Chinese enum, nested arrays, minItems, unsupported schema, and external evidence requirements.
- [ ] Run `node --test tests/codex_workflow/schema.test.mjs`; expect feature missing.
- [ ] Implement schema adapter using Ajv; pin dependency and lockfile.
- [ ] Run schema tests; expect all pass.
- [ ] Commit only Task 1 files.

### Task 2: Runtime and Codex backend

**Files:** Create `runtime.mjs`, `backend.mjs`, runtime/backend tests and process fixtures under the same module/test directories.

**Interfaces:** `createRuntime({runAgent,jobs,signal,emit})` produces agent/parallel/pipeline/phase/log; `loadWorkflow(path)` produces callable script; `createBackend(options)` produces validated `runAgent(prompt,options)`.

- [ ] Write failing tests for pipelined timing, ordered results, jobs limit and cancellation; backend tests execute a fake CLI subprocess at the external boundary.
- [ ] Run `node --test tests/codex_workflow/runtime.test.mjs tests/codex_workflow/backend.test.mjs`; expect missing implementation.
- [ ] Implement runtime and backend, unique attempt files, bounded format retry, model alias filtering, stdin prompts, and terminal/JSONL events.
- [ ] Run all Node tests; expect pass.
- [ ] Commit Task 2 files.

### Task 3: Durable state and restore

**Files:** Create `state.mjs` and state tests; integrate state callbacks in runtime/backend.

**Interfaces:** `openState({dir,fingerprint,artifactRoots,reset})` returns lock/release, begin/succeed/fail stage operations, cached results and artifact validation; stale/failed artifacts are quarantined inside the state directory before running the shared script.

- [ ] Write failing tests for duplicate lock, dead lock owner, interrupted output quarantine, unchanged success replay, missing artifact, and changed fingerprint requiring explicit reset.
- [ ] Run state tests and observe failures.
- [ ] Implement atomic state files and path checks; successful returned file paths must be within allowed roots and nonempty.
- [ ] Run all Node tests; expect pass.
- [ ] Commit Task 3 files.

### Task 4: Complete thesis delivery and CLI

**Files:** Create `thesis.mjs`, `tools/run_codex_workflow.mjs`, thesis/CLI tests; add integration fixtures.

**Interfaces:** `runThesis({root,args,runtime,runCommand,noPdf,...})` returns delivery summary. CLI validates flags, resolves named scripts, preflights dependencies and owns state/runtime lifecycle. `--check` runs schema/syntax and fake execution without state or business writes.

- [ ] Write failing tests for zero-preserving codes, invalid dates, three real workflow check runs, warning propagation, position→gate→PDF ordering, failing gate bounded repair, and already-delivered reuse.
- [ ] Run tests and observe missing feature failures.
- [ ] Implement data validation, shared script execution, scoped prompts, position update, maximum two repair attempts, PDF verification and summary counts.
- [ ] Implement CLI and recovery flags; tests use a temp root and external-boundary fixtures.
- [ ] Run all Node tests and existing Python regression suite; report baseline dependency errors separately if still present.
- [ ] Commit Task 4 files.

### Task 5: Codex skill, documentation and live probe

**Files:** Create `.agents/skills/thesis-wf/SKILL.md`, `agents/openai.yaml`, `docs/codex-workflow.md`; update README with a link.

**Interfaces:** `$thesis-wf SYMBOL [DATE]` calls the same tested CLI; docs expose install/check/run/resume/reset commands.

- [ ] Read skill authoring requirements; add the thin entry and exact operational instructions.
- [ ] Run an isolated real Codex probe for structured output and file writing; record sandbox/network limitations if blocked.
- [ ] Run CLI `--check` for all three workflows and Node suite, complete available Python suite.
- [ ] Request one fresh whole-change review, fix important findings with regression tests, and update docs to the actually verified behavior.
- [ ] Commit task files and report usage plus verification limits; do not merge or publish.
