# Thesis parity implementation plan

> **For agentic workers:** Use superpowers:executing-plans for each assigned unit. Steps use checkbox syntax for tracking.

**Goal:** Freeze effective Codex stage configuration and enforce independent, evidence-based manuscript review.

**Architecture:** Extend the current backend and state ledger; add review and bounded revision to the shared thesis script. Both entrypoints use a deterministic review validator before delivery.

**Tech Stack:** Node.js 22, existing Ajv, Codex CLI, existing Python checks.

**Spec:** ../specs/2026-10-16-thesis-parity-design.md

## Global constraints

- Preserve existing user edits and real reports. Do not start a real research run.
- Keep approval/network settings unchanged. Never record secrets or full user configuration.
- Shared research rules remain under .claude/. No minimum-page or minimum-word quality proxy.

## Review focus

- Missing defaults or unknown stage names must fail clearly.
- Resume must not silently drift to different model settings.
- Partial or fabricated review evidence must not authorize delivery.
- Every report mutation must invalidate the review for that report.
- Failure recovery must preserve prior valid files and existing compatibility checks.

## Task 1: Effective stage settings

Files: tools/codex_workflow/config.mjs (new), backend.mjs, state.mjs, run_codex_workflow.mjs; corresponding Node tests.

- [x] Add failing tests for resolution/precedence, freeze/resume, explicit worker argv and redacted metadata.
- [x] Implement CLI-backed effective config resolution with dependency-injectable probes, stage overrides and validation.
- [x] Integrate frozen configuration into fingerprint, state keys, worker metadata and events.
- [x] Run focused tests, then confirm existing fixtures remain meaningful.

## Task 2: Shared manuscript review

Files: .claude/workflows/equity-thesis.mjs; tools/check_thesis_review.mjs (new); Node review tests.

- [x] Add failing tests for independent review, two revision limit, all sections/lenses, real citations and report digest.
- [x] Implement shared review/revision phases and review-only branch with JSON evidence artifact.
- [x] Implement deterministic review validator with exported function and CLI.
- [x] Run focused tests against realistic temporary artifacts.

## Task 3: Delivery integration and documentation

Files: tools/codex_workflow/thesis.mjs, state/dependency integration, .claude/commands/thesis-wf.md, docs/codex-workflow.md. The existing Codex skill delegates to the unchanged entry command and documentation link, so its instructions require no edit.

- [x] Test old-report review and re-review after hard-gate mutations; verify no PDF on failure.
- [x] Integrate review validation into both entrypoints and preserve transaction recovery.
- [x] Document stage settings and new review artifacts/behavior.
- [x] Run all Node tests, relevant Python regressions and no-model CLI checks; review final diff.

## Verification and review record

- Final Node suite: 74 tests passed. Existing Python suite: 172 tests passed; existing data-tool ResourceWarnings remain outside this change.
- No-model workflow check includes the independent review stage. Read-only real Codex probe resolved version 0.162.1 and existing gpt-6.1-sol/xhigh configuration; no inference or real stock regeneration was performed.
- Independent review found that unchanged explicit arguments and invalid current defaults could break frozen resumes, and that unused invalid defaults could defeat explicit overrides. Reproduced with failing tests and fixed. Resume now reads only CLI version when configuration is unchanged.
- A stale position cache after manuscript revision was reproduced and fixed; review, revision and position synchronization do not reuse mutable file inputs by prompt alone.
- Scope clarification: stage-specific labels currently cover equity-thesis; auxiliary workflows retain global configuration. Documented explicitly.
- Existing 301248 report and unrelated user edits were preserved.
