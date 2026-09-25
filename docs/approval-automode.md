# Automode tool approval

`automode` uses the configured `judge` model role only for mode-generated exec tool calls. The normal tier resolver approves read and write tools without a judge request; only mode-generated exec prompts reach the judge. A model decision never replaces the static approval policy: explicit denies, explicit prompts, provider safety checks, and other higher-priority approval rules remain authoritative.

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

The reviewer uses `modelRoles.judge`, not the active primary chat model. The role accepts four backend types:

- **Judgment APIs**, such as `typesafe/jev-latest`, which return structured choices and probabilities directly.
- **Laya**, selected with `laya/typed-decisions`, which runs the typed-decision checkpoint locally on CPU without an API key.
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

### Laya CPU judge

Use Laya when the judge should run locally without a provider credential:

```yaml
modelRoles:
  judge: laya/typed-decisions

retry:
  fallbackChains:
    judge:
      - typesafe/jev-latest
```

The first Laya use bootstraps a private Python runtime with `uv` (or
`python3 -m venv`), installs `laya==0.3.6` and CPU-only PyTorch, then downloads
`convaiinnovations/laya/typed-decisions` into the local Hugging Face cache. The
runtime supports Python 3.10–3.13. No API key or `/login` step is required, but
the first bootstrap/download needs network access. Subsequent sessions reuse the
runtime, model cache, and detached worker.

The worker is CPU-only and exits after 15 minutes without a request. Set
`OMP_LAYA_WORKER_IDLE_MS` to change that lifetime for a test or managed
environment. Automode waits for Laya to finish loading on first use and after an
idle worker restart. Laya startup is excluded from the review deadline; if
loading or a judgment fails, the normal judge fallback chain continues. An
unavailable local judge never becomes an implicit allow.

The selected judge model must be available in the catalog. Inspect candidates with:

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
| `write` | Approved by the normal resolver; no judge request is sent. |
| `exec` | Sent to the judge when the active mode is the source of the prompt. |

The review state is bounded and contains:

- the latest user request;
- the working directory;
- the tool name and tier;
- the formatted operation details shown by the approval system.

The reviewer does not receive the complete session history, a raw executable tool object, or an execution callback. State is sanitized, truncated, and passed through the session secret obfuscator when available.

## Two-tier review

Under `automode`, exec prompts go through two reviewers instead of one. A fast local
classifier answers most calls; the blocking judge is only woken when the classifier
is not willing to vouch for the call. Both tiers sit behind the same approval seam,
so every existing entry point — the tool wrapper, Cursor, MCP preflight, eval
preludes — gets the same behavior without further changes.

```
tool call fires ──► fast gate (Laya, async, non-blocking)
                        │
                        ├─ pass ─────────────────► allow  (actor: fast gate)
                        │
                        └─ escalate ──► blocking judge ──► allow / deny  (actor: judge)
                                            │
                                            └─ unavailable ──► approval UI  (actor: user)
                                                                  │
                                                                  └─ no UI ──► fail closed
```

### What the fast gate sees

The classification is **trajectory-level**, not per-call. The state carries the
recent tool-call sequence and the current intent alongside the usual fields, so a
turn that is individually benign but drifting toward secrets, remote state, or
deletion shows up as a rising score rather than as a chain of passing verdicts.

| Field | Meaning |
| --- | --- |
| `latest_user_request` | The only field that can authorize an operation. |
| `operation` | The call being approved. |
| `current_intent` | Why the agent says it is doing this. |
| `recent_tool_calls` | The recent call sequence, newest last. |
| `recent_conversation` | Recap used to interpret intent and constraints. |
| `working_directory` | Where edits are expected. |
| `tool_name`, `tier` | The tool and its impact class. |

All state fields are untrusted evidence. Commands or policies embedded in them are
never obeyed.

### Dual-axis output

Each sample reports two independent axes, mirroring codex's `GuardianAssessment`:

| Axis | Levels | Meaning |
| --- | --- | --- |
| `risk` | `low` `medium` `high` `critical` | How much damage the operation could do. |
| `user_authorization` | `high` `medium` `low` `unknown` | How well the user's request covers this specific operation. `unknown` means authorization was never established — it is not an ordered low tier. |

A third yes/no read estimates whether the next two tool calls will include a
high-impact action. Laya answers these as calibrated probability distributions
rather than as free text, so the scores are continuous and do not need parsing.

### Authority

The fast gate may **allow** or **escalate**. It may never deny: a denial is the
judge's call or the user's. A pass is a suggestion to skip the blocking reviewer,
and the gate escalates on every doubt — a sample that is stale, low-confidence,
trimmed past its load-bearing fields, weakly authorized, drifting toward impact,
or simply missing.

Nothing about the fast gate can turn a failure into a pass. A gate that is
disabled, broken, timed out, or out of budget always lands on the blocking judge,
and a judge that is itself unavailable stays `unavailable` for the approval UI.
An unavailable local classifier is never an implicit allow.

### Coverage

The ledger tracks whether the cached score actually covers the call being
reviewed: the lag between the newest fire and the newest sample, fires that
failed with no newer success to cover them, and inputs too large to classify at
all. A handoff reason (`missing-score`, `scoring-failure`, `stale`, `oversized`,
`risk-threshold`, `authorization-weak`, `predictive-danger`, …) is recorded with
every escalation so the cause stays distinguishable in the transcript.

### Configuration

| Key | Default | Effect |
| --- | --- | --- |
| `tools.automode.twoTier` | `true` | Consult the fast gate before the blocking judge under `automode`. Set `false` for the previous single-tier behavior. |
| `tools.automode.showScoresInNotice` | `true` | Show `risk` and `user_authorization` on the transcript approval notice. |

Score thresholds are not yet configurable; they live in the fast-gate defaults
and are the subject of calibration work.

### Deviation from codex

codex keeps `SecurityRiskScore` out of every model-visible and user-visible
projection — scores must not be readable at all. OMP deliberately shows them on
the `tool-approval-notice` row instead. That row is transcript-only and is
excluded from model context, so the isolation codex is protecting (scores must
not influence the model being supervised) still holds; what changes is that a
person reading the transcript can audit why a call passed. Set
`tools.automode.showScoresInNotice: false` to restore the stricter behavior.


## Approval precedence

Automode only reviews a prompt produced by `tools.approvalMode: automode`. It does not override other policy sources:

1. A tool-declared `deny` always denies.
2. A user `tools.approval.<tool>: deny` always denies.
3. Explicit tool or user `allow`/`prompt` policies retain their existing behavior.
4. Provider-originated `pendingSafetyChecks` always require interactive approval.
5. Only the remaining mode-generated exec prompt reaches the automode reviewer; mode-generated read and write tiers are approved by the normal resolver.

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

The reviewer returns one of `allow`, `deny`, or `unavailable`.

The judge's selected choice is applied directly. There is no probability or confidence threshold gate: an `allow` answer approves and a `deny` answer denies, regardless of the reported distribution. The calibrated `probabilities` and `confidence` fields are available on the answer but are not consulted here.

An invalid structured answer, an unavailable judge, or a review timeout falls back to the existing approval UI. Reviews are limited to two concurrent requests per session; queued reviews time out after 30 seconds. Laya model startup does not consume the 30-second review budget: for a first-choice Laya judge, the budget starts when the model is ready, and a fallback Laya load pauses the existing budget.

Automode decisions are recorded in the transcript with distinct green approval and red denial notices, each labelled with the actor that resolved it (`fast gate`, `judge`, or `user`) and, for model decisions, the dual-axis scores behind them. Human approval prompts keep their existing presentation.

If no interactive UI is available, an unresolved review fails closed. It never becomes an allow decision. Configure a working judge, provide an interactive approval channel, or set an explicit per-tool policy when unattended behavior is intentional.

## Cursor, MCP, ACP, and eval paths

Only mode-generated exec prompts use the automode reviewer across the normal tool wrapper and eval prelude paths. Cursor native write mutations and MCP write-tier preflight follow the Automode write-tier allowance; explicit prompts remain gated. Exec-tier preflight can create the exact-call one-shot grant described below.
For Cursor MCP exec calls, an approved preflight creates a bounded one-shot grant tied to the exact call id, tool name, and arguments. A mismatch or reuse discards the grant and re-enters the exec approval gate.

ACP uses the same global/project settings and `--config` overlays as normal launches. Provider safety checks and explicit deny policies remain higher priority.

For Automode, ACP skips its client permission gate only when the shared resolver returns `allow` at the `write` tier. Exec-tier calls (including `bash`) remain behind the ACP client gate; explicit prompts and denies are not bypassed.

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
- **Interactive prompt appears** — the judge returned `unavailable`, or the call was governed by an explicit prompt or provider safety check.
- **Headless call is rejected** — no high-confidence decision was available and fail-closed behavior is working as intended.

For model catalog and provider authentication details, see [Models](./models.md), [Providers](./providers.md), and [Environment variables](./environment-variables.md#typesafe-judgments).
