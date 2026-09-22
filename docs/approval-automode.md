# Automode tool approval

`automode` uses the configured `judge` model role to review write and exec tool calls. Read-only tools are approved by the normal tier resolver. A model decision never replaces the static approval policy: explicit denies, provider safety checks, and other higher-priority approval rules remain authoritative.

## Quick start

Add this to the global configuration at `~/.omp/agent/config.yml`:

```yaml
tools:
  approvalMode: automode

modelRoles:
  judge: typesafe/jev-latest

retry:
  fallbackChains:
    judge:
      - typesafe/jev-preview
      - "@tiny"
      - "@smol"
```

Then start a session normally, or enable automode for one process only:

```bash
omp --approval-mode automode
```

`--approval-mode automode` is a runtime override and is not persisted. To persist the mode through the settings command, use:

```bash
omp config set tools.approvalMode automode
```

For ACP, pass the same flag when starting the server:

```bash
omp acp --approval-mode automode
```

## Configure the judge

The reviewer uses `modelRoles.judge`, not the active primary chat model. The role accepts three backend types:

- **Judgment APIs**, such as `typesafe/jev-latest`, which return structured choices and probabilities directly.
- **Local models**, selected with `local/<model-id>` and adapted through the existing text-judgment backend.
- **Chat models**, selected with a normal `provider/model-id` selector and adapted to the same typed judgment interface.

TypeSafe is a judgment API rather than a conventional chat LLM. To use it, authenticate with either:

```bash
export TYPESAFE_API_KEY=...
```

or `/login typesafe` inside a session. The API root can be changed with `TYPESAFE_BASE_URL`.

A local configuration looks like this:

```yaml
modelRoles:
  judge: local/lfm2-1.2b

retry:
  fallbackChains:
    judge: []
```

The local model must be available in the local model catalog. Inspect candidates with:

```bash
omp models --kind judge
```

Use `/model`, then the **Roles** view, to select the Judge role interactively. `retry.fallbackChains.judge` controls ordered fallback candidates; `[]` disables fallback for that role. If the role is unset, OMP uses its built-in judge chain.

Global settings are read from `~/.omp/agent/config.yml`. A project may override them in `<repo>/.omp/config.yml`. `--config <file>` supplies a one-process overlay. See [Settings](./settings.md) for precedence and storage details.

## What automode reviews

The static resolver first classifies the tool call as `read`, `write`, or `exec`:

| Tier | Automode behavior |
| --- | --- |
| `read` | Approved by the normal resolver; no judge request is sent. |
| `write` | Sent to the judge when the active mode is the source of the prompt. |
| `exec` | Sent to the judge when the active mode is the source of the prompt. |

The review state is bounded and contains:

- the latest user request;
- the working directory;
- the tool name and tier;
- the formatted operation details shown by the approval system.

The reviewer does not receive the complete session history, a raw executable tool object, or an execution callback. State is sanitized, truncated, and passed through the session secret obfuscator when available.

## Approval precedence

Automode only reviews a prompt produced by `tools.approvalMode: automode`. It does not override other policy sources:

1. A tool-declared `deny` always denies.
2. A user `tools.approval.<tool>: deny` always denies.
3. Explicit tool or user `allow`/`prompt` policies retain their existing behavior.
4. Provider-originated `pendingSafetyChecks` always require interactive approval.
5. Only the remaining mode-generated write/exec prompt reaches the automode reviewer.

For sensitive tools, keep a human gate explicitly:

```yaml
tools:
  approvalMode: automode
  approval:
    bash: prompt
    mcp__filesystem_delete: deny
```

An explicit `prompt` is not converted into model approval. It continues through the normal interactive approval path.

## Review outcomes

The reviewer returns one of `allow`, `deny`, or `ask_human`.

A model `allow` is accepted only when both the selected-choice probability and confidence meet the tier threshold:

| Decision | `write` | `exec` |
| --- | ---: | ---: |
| `allow` | `0.90` | `0.97` |
| `deny` | `0.95` | `0.95` |

Anything below the threshold, an invalid structured answer, `ask_human`, an unavailable judge, or a review timeout falls back to the existing approval UI. The review deadline is 10 seconds and concurrent reviews are limited to two per session.

If no interactive UI is available, an unresolved review fails closed. It never becomes an allow decision. Configure a working judge, provide an interactive approval channel, or set an explicit per-tool policy when unattended behavior is intentional.

## Cursor, MCP, ACP, and eval paths

Automode uses the same static policy and reviewer for the normal tool wrapper, eval prelude calls, Cursor native mutations, and Cursor MCP approval-only frames.

For Cursor MCP calls, an approved preflight creates a bounded one-shot grant tied to the exact call id, tool name, and arguments. A mismatch or reuse discards the grant and re-enters the approval gate.

ACP uses the same global/project settings and `--config` overlays as normal launches. Provider safety checks and explicit deny policies remain higher priority than automode.

Subagents retain their existing headless approval behavior: the parent task approval remains the authorization boundary, and subagent prompts are not made unattended-safe merely by enabling automode in the parent session.

## Inspect and troubleshoot

Check the effective mode and role configuration:

```bash
omp config get tools.approvalMode
omp config get modelRoles --json
omp config list
omp config path
```

Common symptoms:

- **`Automode review unavailable`** — no judge candidate resolved, credentials are missing, or every fallback failed.
- **Interactive prompt appears** — the judge returned `ask_human`, lacked sufficient confidence, or the call was governed by an explicit prompt or provider safety check.
- **Headless call is rejected** — no high-confidence decision was available and fail-closed behavior is working as intended.

For model catalog and provider authentication details, see [Models](./models.md), [Providers](./providers.md), and [Environment variables](./environment-variables.md#typesafe-judgments).
