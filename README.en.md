# custodiet

> *Quis custodiet ipsos custodes?* — Who watches the watchmen?
>
> [中文版 →](README.md)

**custodiet** is a governance system for Claude Code built from two parts: **Stop-time gates** and a **constitution + law-code** layout. Each time the agent says it is done, a Stop hook runs deterministic predicates over the turn's tool-call record and blocks if something it said it did never happened there; every blocking rule must point to a clause a human signed.
**lanes** is its companion UI: it moves gate notices, tool calls and edited files out of the transcript into their own lanes.

This repository is also a Claude Code plugin marketplace (`.claude-plugin/marketplace.json`).

| Component | Current form | Install |
|---|---|---|
| custodiet | Gate scripts + example constitution/law files + red-team agent + copy-mode installer. **Not a plugin yet** | `node scripts/custodiet-init.mjs --target <repo> --mode copy` |
| lanes | Claude Code plugin (a mod: a plugin with a hooks module), in `plugins/lanes/` | `/plugin install lanes --marketplace inoichi1009207/custodiet` |

## Install

### custodiet (copy mode)

Requirements: node ≥ 20; the target must be the **root of a git repository** (the script will not `git init` for you).

```bash
git clone https://github.com/inoichi1009207/custodiet
node custodiet/scripts/custodiet-init.mjs --target <your-repo-root> --mode copy
```

What it does:

- Copies the gate files (`scripts/hook-stop-closure.mjs`, `scripts/batch-goal.mjs`, the engine files under `scripts/lib/`), the example constitution `AGENTS.md`, the example law files `docs/laws/collab.md` and `docs/laws/reporting.md`, `docs/noun-diary.md`, and the red-team agent `.claude/agents/_gate-bypass-hunter.md` into the target, and generates `CLAUDE.md` (content: `@AGENTS.md`).
- Merges two hooks, `Stop` and `SubagentStop`, into the target's `.claude/settings.json` (deduplicated by command).
- Appends the gate's runtime ledger paths to the target's `.gitignore`.
- **Never overwrites an existing file**: when contents differ it writes a sidecar `<name>.custodiet<ext>`, and the JSON manifest on the last stdout line lists each one. It does not commit, does not touch the network, and does not touch `~/.claude/`.

After installing:

1. Self-test inside the target: `node --no-warnings scripts/hook-stop-closure.mjs --self-test`.
   Known: 2 rule-I cases read the target's **real git history**; they are red while the installed files are uncommitted, or while the install commit is HEAD, and turn green after one more commit.
2. **Start a new session before you commit the install.** Whether a newly written agent can be invoked in the same session has not been tested, and the install commit triggers rule P, which on gate-engine files accepts only that red-team agent. A new session sidesteps the untested case.

Current limits:

- The text-based rules match Chinese sentence patterns, so for now they only fit repositories where the collaboration happens in Chinese. In an English repository they do not misfire, but they also stay silent.
- Plugin install is not built yet: `/plugin install custodiet` **does not work** today, and `--mode plugin` exits with code 5.
- Dev-only files the installer does not copy: `scripts/coverage-check.mjs`, `scripts/gate-migrate-check.mjs`, `scripts/lib/ledger-anchor.mjs`. They work inside this repository only.

### lanes (plugin marketplace)

Inside a Claude Code session (requires Claude Code v2.1.275 or later):

```text
/plugin install lanes --marketplace inoichi1009207/custodiet
```

From your shell (requires v2.1.292 or later):

```bash
claude plugin install lanes --marketplace inoichi1009207/custodiet
```

Or in two steps: `/plugin marketplace add inoichi1009207/custodiet`, then `/plugin install lanes@custodiet`.
Third-party marketplaces do not auto-update by default; update with `claude plugin update lanes@custodiet`.
The lanes UI text is currently in Chinese; its tests (`claude plugin test plugins/lanes`) were run on Claude Code 2.1.295.

## Capabilities and commands

### custodiet

| Capability | One line | Command |
|---|---|---|
| Stop gate | At Stop, runs 26 engine rules + 2 built-in rules over the turn's tool-call record; a hit on a blocking rule keeps the turn from ending | `node --no-warnings scripts/hook-stop-closure.mjs --self-test` |
| Batch goals | Arm checkable completion conditions at the start; a condition may carry a machine check that `--clear` runs, refusing to clear on failure | `node --no-warnings scripts/batch-goal.mjs --arm 001 --cond "render is out" --check "ffprobe -v error -show_entries format=duration -of csv=p=0 out.mp4" --expect-re "^218\."` |
| Rule acceptance | Per-rule positive/negative fixtures + mutation acceptance; a fixture set that cannot kill its mutants does not ship (run inside this repo) | `npm run gate:accept` |
| Ledger integrity chain | The alert-denominator, false-positive and batch-goal ledgers carry a per-row hash chain; rewrites, insertions and mid-chain deletions go red | `node --no-warnings scripts/lib/ledger-chain.mjs verify <file.jsonl>` |
| External anchor (this repo) | Snapshots a prefix fingerprint of the ledgers to `~/.custodiet/`; rewrites or truncation before the anchor go red. Limits below | `node scripts/lib/ledger-anchor.mjs snapshot` |
| Escape hatches | Each blocking rule can be switched off on its own (rule P deliberately has none) | `STOP_CLOSURE_BLOCK_<id>=0` |
| Red-team agent | After you change gate-engine files, it looks for ways not to be caught by a rule, each with a minimal fixture | invoke the subagent `_gate-bypass-hunter` in a session |

Batch-goal order: arm → work → write `条件N: 达成/未达成/不适用` (achieved / not achieved / not applicable) for each condition → **commit** → only then `node --no-warnings scripts/batch-goal.mjs --clear`. Clearing before the commit is what rule K0 blocks.

### lanes

| Capability | One line | Command |
|---|---|---|
| Pane | One lane each for this turn's gate notices (first three lines of each), edited files and tool calls, plus a separate bucket for subagents; opens by itself at session start (terminals ≥144 columns), run again to close | `/lanes` |
| Summary line | When the turn has activity, one line above the prompt: gates (blocks) · files edited · tool calls · subagents | no command |
| Text-only transcript | Tool-call rows are not drawn in the conversation (running ones included) and gate feedback shrinks to one dim line; toggle back to see them | `/lanes-show` |
| Gate relay (on by default) | For Stop-hook blocks and additional context, the transcript keeps one short line and the full text goes to the model as a session row the model can read but the person does not see; custodiet's Stop gate recognises that row and does not treat it as a new user turn | `/lanes-relay` |
| Long commands to background (on by default) | In the main session, foreground Bash / PowerShell timeouts are capped at 10 seconds, so a long command moves to the background instead of blocking the conversation; subagents are not capped | no command |
| Switches for the model | The model can call `mcp__lanes__control` to flip the three settings above (relay / showAll / autoBg) | no command |

## Why

Coding agents produce **false success**: they assert completion the environment doesn't support. On AppWorld self-assessing coding-agent trajectories with explicit status claims, **75.8%** of failures are false successes; LLM judges max out at **AUROC 0.65 (tau2-bench) / 0.54 (AppWorld)** while lightweight deterministic detectors reach **0.83–0.95 at ~3,300× lower latency** ([arXiv 2606.09863](https://arxiv.org/abs/2606.09863)). The paper's conclusion: *"production monitoring should use lightweight, domain-calibrated detectors **as triage signals** rather than relying on LLM judges as the primary monitor for false success."*

Upstream, the fabrication problem was reported and the issue **closed as not planned** ([anthropics/claude-code#2969](https://github.com/anthropics/claude-code/issues/2969)).

<p>
<img src="assets/catch-saying-not-doing.jpg" alt="The gate catches the agent describing work instead of doing it" width="640">
</p>

> *"Are you actually doing it?" — "No. My last message was **saying**, not **doing**. Doing it now."*
> (real session; the engine's messages are in Chinese — see FAQ)

## Not prompts. Predicates.

| Approach | Enforcement | Fails when |
|---|---|---|
| CLAUDE.md instructions | none — the model may ignore them | always, eventually |
| LLM reviews LLM | another model's opinion | judge AUROC ≤ 0.65 on this task family |
| **This repo** | **deterministic predicates over tool-call records** | only where a rule's stated ceiling says so |

The 26 engine rules read a **structured context** built only from `assistant` text blocks and `tool_use` **inputs** — tool *outputs* never enter their evidence window, so *reading a file that mentions `git commit` cannot count as having committed* (that exact exploit is a regression test). The two not-yet-migrated built-in rules (A delegation-closure, R past-tense claims) still scan raw text including tool outputs; that ceiling is documented in their header comments.

## Constitution and law code

- Every rule carries a `law:` anchor pointing back to a human-signed clause (e.g. rule J → `AGENTS.md#承重规则的载体门槛`); the engine checks at load time and in self-tests that each anchor resolves. A rule with no source of law is an unowned predicate anyone can delete.
- The example constitution `AGENTS.md` holds short standing clauses — per-session defaults, decision boundaries, permanent red lines — and marks which rule each one is the source of law for; details live in the example law files `docs/laws/collab.md` and `docs/laws/reporting.md`.
- The installer copies these three files as **examples**: replace them with clauses you actually signed and move the anchors with them.

## What it catches (selection of the 28 rules: 26 engine + 2 built-in; `gate:accept` output is authoritative — hand counts drift)

- **B / R — promise vs. deed**: "I'll go fix X" / "I fixed X" with no matching action in the turn ⇒ flagged. Future-tense promises and past-tense claims are separate rules.
- **A / U — delegation must close the loop**: a background task you launched and never read back is debt, not progress.
- **K / K0 — batch goals**: arm machine-checkable completion conditions at start (`batch-goal --arm`); committing without a verdict on each condition blocks the turn.
- **M — write-backs need read-backs**: `node -e`/`sed -i`/redirects that fail silently still exit 0; only an actual re-read (Read/Grep/diff of the same path) counts.
- **I — search before you build**: creating a new tool/script without evidence of having scanned for existing implementations (local registry **and** web) blocks.
- **P — load-bearing commits owe three independent checks**: cross-model review, read-only subagent, and external precedent — counted from tool actions only; *saying* you ran them counts zero. When the commit touches gate-engine files, the independent-view check accepts only the bundled red-team agent `_gate-bypass-hunter`.
- **E0/E1/E2 — causal claims need mechanical evidence** or an independent check; a bare "the root cause is…" doesn't leave the room.

Since 0.4.2 the CW rule (re-checking concurrent writer sessions at Stop) is gone — concurrent writes are isolated with git worktrees/branches instead; see [CHANGELOG](CHANGELOG.md).

Full tour and build order: [`docs/playbook.md`](docs/playbook.md) (the construction manual, written for an agent to follow: each build step ships the artifact shape, an executable checkpoint and the incident behind it; currently in Chinese).

## The gate gates itself

As of our survey we have **not observed** this combination elsewhere (*not observed*, not *doesn't exist*):

- **Mutation-tested rules**: a rule cannot ship without ≥2 mutations of its own predicate that its fixtures demonstrably kill (`gate-migrate-check.mjs`). Before this harness existed we measured 40/97 mutants surviving under an all-green suite.
- **Load-time invariants**: blocking rules must cite a human-signed law anchor, must carry positive *and* negative fixtures, and are checked inside the production hook, not only in CI.
- **False-positive & miss ledgers**: every alert lands in a denominator ledger; claimed false positives are filed with reasons; the report always prints `RECALL=UNKNOWN` because an absence of complaints is not an absence of misses.
- **Debt with expiry**: every known limitation is a ledger row with a batch-count expiry; expiry reactivates the debt via `batch-goal --arm`. The mechanism ships; our own debt table stays in the source project.
- **Ledger integrity chain**: see the table above. It is tamper *alerting*, not tamper *proofing*; limits are in the header of `ledger-chain.mjs` — it does not defend against a deliberate rewrite or whole-suffix truncation.
- **External anchor** (`ledger-anchor.mjs`, `snapshot | verify | install-task`). **Where the guarantee stops:**
  "External" means **the same machine, the same user's home directory** (`~/.custodiet/`) — not another host, not another trust domain. Any process that can run commands as you can also rewrite the anchor; the anchor carries no signature and no chain of its own. It is a **soft boundary**: it raises the cost of forgery, it does not isolate.
  It covers only up to the **last snapshot point**, and only given that the anchor file itself was not rewritten by a same-identity process and that `verify` actually ran.
  Content appended after that snapshot and then deleted — while the file is still at least as long as the snapshot — is caught by **neither** mechanism.
  This repo does **not** wire a wake-up path for you, and `install-task` is Windows-only (`schtasks`) so far. See the 0.1.1 entry in CHANGELOG and that file's header.
- **Fail-closed**: a rule that can't get its required input channel reports UNKNOWN and blocks.
- **Escape hatches are reconciled**: a self-test checks the escape hatches against the blocking table, so a hatch that doesn't open is caught. Rule P has no escape hatch, by signed-off design.

<p>
<img src="assets/same-shape-errors.jpg" alt="Every error today was the Nth instance of the same shape" width="640">
<img src="assets/catch-lost-delegation.jpg" alt="Waiting for a review that was never fetched — caught" width="640">
</p>

## Relation to neighbors

- [guardrails-ai](https://github.com/guardrails-ai/guardrails) / [NeMo Guardrails](https://github.com/NVIDIA-NeMo/Guardrails) validate **what the model says** (content). We audit **whether what it said it did actually happened** (conduct).
- [tdd-guard](https://github.com/nizos/tdd-guard) / [probity](https://github.com/nizos/probity) gate **each write** for process compliance (probity also reads transcripts). We gate **the whole turn's claims** at Stop time. They can run together.
- Claude Code ships a built-in `/goal` (goal tracking) — a **built-in slash command the model cannot invoke; only the user can type it** (tested 2026-08-19), and its Stop-time evaluation is an LLM judge (a session-level prompt hook). `batch-goal --arm/--clear` is the in-repo equivalent: arming is the agent's opening move, the verdict check is the Stop gate's mechanical move.
- [unlazy](https://github.com/Leonxlnx/unlazy) (surveyed 2026-09; each claim re-checked sentence by sentence by a second model against its README/SKILL) also uses a Stop hook as a wall, but treats **under-effort** (a Depth Tree splits the task by the requested depth; a gates file verifies with `CHECK:` commands + `EXPECT:` tokens); we treat **false claims**. Two ideas worth borrowing: a guard that releases after 6 consecutive blocked stops with no progress, and a failure-style handoff `ABANDON: <id> <non-empty reason>` — our equivalents are the streak cap with auto-downgrade and "⏸ needs your confirmation + one of three legal reasons".
- Per our survey (2026-08-25, re-checked 2026-09-02), the combination here — promise-vs-action comparison + mutation-tested acceptance + expiring debt ledger — was **not observed** in existing open source. That's an observation, not a proof of absence.

## FAQ

**False positives?** Filed in a ledger with reasons and measured against an automatic alert denominator (9.7% claimed rate at last count); several rules were narrowed through exactly that loop.

**Overhead?** Zero dependencies. Measured on a 21k-entry transcript: 330–600 ms per Stop, of which ~40 ms is transcript reading (timing is stamped into the heartbeat ledger).

**Infinite loops?** The hook checks `stop_hook_active`, and the engine records its own consecutive-block streak with a pressure valve (`STOP_CLOSURE_BLOCK_CAP`) that demotes to warnings rather than deadlocking — and the demotion is logged as a demotion, never as a pass.

**How do I add my own rule?** In `scripts/lib/gate-rules.mjs`, copy the **five parts** of any rule — `detect` (a pure function over the structured ctx; never reads disk itself), `law` (an anchor to a clause you signed), `blocking`, positive/negative `cases`, ≥2 `mutations` — append it to the `RULES` array at the end of the file, and run `npm run gate:accept` in this repo. Load-time invariants reject rules without a law anchor or fixtures; the acceptance harness rejects fixtures that cannot kill their mutants. Then red-team it with `_gate-bypass-hunter`. The full walkthrough is in steps 3–4 of [`docs/playbook.md`](docs/playbook.md).

**Why is everything in Chinese?** This is a reference implementation extracted from the project that built it, comments and verdict messages included. The architecture (structured ctx / rules / registry / acceptance harness) is language-neutral; an English message pack is a welcome first contribution.

**Are the war-story numbers audited?** They are the author's own ledgers (git log, alert ledger, debt table). The playbook marks them as author-attested. Read them the way you'd read any postmortem.

## License

MIT
