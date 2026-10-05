<div align="center">

# Harmscope Bench

**Work an AI deployment review as a queue of contested harm claims. Every state change passes
through a state graph that refuses it unless the evidence is there.**

[![CI](https://github.com/aniruddhaadak80/harmscope-bench/actions/workflows/ci.yml/badge.svg)](https://github.com/aniruddhaadak80/harmscope-bench/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-cyan.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-blue.svg)](https://www.typescriptlang.org/)
[![Python](https://img.shields.io/badge/Python-3.11%2B-cyan.svg)](services/engine)

</div>

---

You are about to ship an AI system. Someone asks whether that is acceptable. If you ask a
model, you get a paragraph: confident, plausible, unciteable, and different next time you ask.
If you ask a spreadsheet, you get a checkbox nobody can audit six months later.

Harmscope Bench takes a third position. You do not record whether the deployment is ethical. You
record **what it owes** — one obligation per concrete duty — and each obligation can only advance
through a state graph that refuses any transition the evidence does not support. The tool's
normal output is a refusal with a named reason and the artefact that would satisfy it.

```
REFUSED (MISSING_EVIDENCE): appeal-path requires verified evidence for: policy_doc, appeal_channel
  fix: satisfy the gate above, then retry the same move
```

That is the product.

## Why

The review artefact an auditor accepts has one property a model-generated paragraph can never
have: **it is reproducible**. Two reviewers, six months apart, running the same case, get the
same verdict — because the state graph, the evidence gates and the exposure arithmetic are code,
not generation.

The second property is that a refusal is actionable. "This may be ethically problematic" cannot
be assigned. "Ratification of `incident` requires an `overrideRef` naming the person accepting
residual risk" can be — to a human, today.

## Quick start

```bash
git clone https://github.com/aniruddhaadak80/harmscope-bench
cd harmscope-bench
npm install
export PRODUCT_DATA_DIR=".data/bench.db"

node packages/cli/dist/bin.js doctor
```

```
harmscope-bench doctor
  [PASS] node       v22.23.2
  [PASS] package    harmscope-bench@0.1.0
  [PASS] skills     6 skills, 0 invalid
  [PASS] plugins    1 active, 0 disabled
  [WARN] config     no product.config.json — using defaults
         fix: run with defaults, or create product.config.json

  all required checks passed
```

## Walkthrough

Every command below was run to produce the output shown. Set `PRODUCT_DATA_DIR` first, or your
cases disappear when you close the shell.

### 1. Open a case and record what the system owes

```bash
node packages/cli/dist/bin.js case create --id rank-decisions \
  --title "Automated ranking in hiring review" --system "ranker v2"

node packages/cli/dist/bin.js obligation add --case rank-decisions --id appeal-path \
  --kind appeal_path --severity 4 --claimant operator --requires "policy_doc,appeal_channel"

node packages/cli/dist/bin.js obligation add --case rank-decisions --id incident \
  --kind incident_channel --severity 5 --claimant operator --requires "oncall_roster"

node packages/cli/dist/bin.js obligation add --case rank-decisions --id disclosure \
  --kind disclosure_notice --severity 3 --claimant operator --requires "notice_text"
```

```
created case rank-decisions — Automated ranking in hiring review
recorded appeal-path (appeal_path, severity 4) owed by operator
recorded incident (incident_channel, severity 5) owed by operator
recorded disclosure (disclosure_notice, severity 3) owed by operator
```

### 2. Try to advance one. It refuses, and says why

```bash
node packages/cli/dist/bin.js move --case rank-decisions --id appeal-path --to evidenced
```

```
REFUSED (MISSING_EVIDENCE): appeal-path requires verified evidence for: policy_doc, appeal_channel
  gate MISSING_EVIDENCE on appeal-path: appeal-path requires verified evidence for: policy_doc, appeal_channel
  fix: satisfy the gate above, then retry the same move
```

Note the exit code is **0**. A refusal is the product working, not the program failing. The
attempt is written to the audit trail regardless — refusals are the part an auditor reads.

### 3. Satisfy the gate, and retry

```bash
node packages/cli/dist/bin.js obligation evidence --case rank-decisions --id appeal-path \
  --kind policy_doc --ref "docs/appeal-policy.md" --verify
node packages/cli/dist/bin.js obligation evidence --case rank-decisions --id appeal-path \
  --kind appeal_channel --ref "support.ranker.example/appeal" --verify
node packages/cli/dist/bin.js move --case rank-decisions --id appeal-path --to evidenced
```

```
appeal-path evidence: policy_doc (verified)
applied: appeal-path may move drafted -> evidenced
```

### 4. Ask whether you can ship

```bash
node packages/cli/dist/bin.js queue --case rank-decisions
node packages/cli/dist/bin.js review --case rank-decisions
```

```
queue for 7 obligation(s):
  >  1. bias-audit         drafted    sev 4  disparity_bound blocked: MISSING_EVIDENCE
     2. incident           evidenced  sev 5  incident_channel blocked: NEEDS_OVERRIDE
     3. appeal-path        evidenced  sev 4  appeal_path
     4. disclosure         drafted    sev 3  disclosure_notice blocked: MISSING_EVIDENCE
     5. human-oversight    drafted    sev 3  human_oversight blocked: MISSING_EVIDENCE
     6. retention          drafted    sev 2  data_retention
     7. contest-log        challenged sev 2  contest_audit blocked: NEEDS_ARBITRATION

phase:            contested
obligations:      7 (0 settled)
residual exposure: 83/100
can sign off:     no
next action:      clear NOTHING_TO_RATIFY on bias-audit
```

The queue is ranked by outstanding weight, so row 1 is the blockage costing the most — not the
first one drafted. Each blocked row prints the gate it fails.

### 5. The severity-5 refusal

```bash
node packages/cli/dist/bin.js move --case rank-decisions --id incident --to ratified
```

```
REFUSED (NEEDS_OVERRIDE): incident is severity 5; ratifying it requires an overrideRef naming the person accepting the residual risk
```

It cannot be cleared by evidence, only by a person putting their name to it:

```bash
node packages/cli/dist/bin.js move --case rank-decisions --id incident --to ratified \
  --override-ref "dana@board"
# applied: incident may move evidenced -> ratified
```

### 6. Who is carrying the unfinished work

```bash
node packages/cli/dist/bin.js liability --case rank-decisions
```

```
total open weight: 104
concentration:    63.46% to the largest holder
  operator         63.46%  #########################
  regulator        19.23%  ########
  vendor            9.62%  ####
  worker_council    7.69%  ###
```

Shares are apportioned in integer micro-units that sum to exactly 1,000,000, so conservation is
an exact fact rather than a floating-point tolerance. A high concentration is a signal the
obligations were assigned to the wrong claimant.

### 7. Work it in the terminal bench

```bash
node packages/cli/dist/bin.js bench --case rank-decisions
```

```
harmscope bench  phase contested · exposure 83/100 · 7 gate(s) in the way

> * ████ bias-audit       drafted      disparity_bound   regulator
      └─ MISSING_EVIDENCE
   █████ incident         evidenced    incident_channel  operator
      └─ NEEDS_OVERRIDE
   ████ appeal-path      evidenced    appeal_path       operator
   ··· disclosure         drafted      disclosure_notice operator
      └─ MISSING_EVIDENCE
```

`j`/`k` or the arrow keys move, `enter` attempts the move, `q` quits. Piped rather than a TTY it
renders once and exits, so it never hangs a script.

### 8. Publish the review

```bash
node packages/cli/dist/bin.js export --case rank-decisions --out apps/web/content/case.json
```

```
wrote apps/web/content/case.json (7 obligations, phase contested)
```

The snapshot carries the engine's own verdict, and it is what the deployed web app renders. See
[ADR 0004](docs/adr/0004-web-snapshot-boundary.md) for why the web app never calls the engine
itself.

## How it works

```
              ┌─────────────────────────────────────────┐
   CLI ───►   │                                         │
   TUI ───►   │   packages/core — one Tool registry      │  ◄── plugins/
   MCP ───►   │   seven tools, the narrow waist          │
   Web ───►   │                                         │
              └──────────────────┬──────────────────────┘
                                 │  stdin/stdout, one JSON object
                                 ▼
              ┌─────────────────────────────────────────┐
              │   services/engine — pure Python         │
              │   adjudicate · queue · review           │
              │   liability_split · residual_exposure   │
              │   no clock, no network, no randomness    │
              └──────────────────┬──────────────────────┘
                                 │
                                 ▼
              ┌─────────────────────────────────────────┐
              │   packages/memory — SQLite, WAL          │
              │   cases · obligations · evidence         │
              │   attempts (every try, refusals too)     │
              └─────────────────────────────────────────┘
```

Every capability is a **Tool** in one registry, reachable identically from every surface. A new
surface is a transport, never a second implementation.

## The deterministic engine

`services/engine` is pure Python with **no dependencies**. It reads no clock, opens no socket,
uses no randomness. Five operations:

| Operation            | What it computes                                                    |
| -------------------- | ------------------------------------------------------------------- |
| `adjudicate`         | whether one transition is allowed, and every gate blocking it        |
| `queue`              | obligations ranked by open weight, annotated with their gates        |
| `review`             | phase, sign-off readiness, and every gate standing in the way        |
| `liability_split`    | exposure apportioned between the parties that owe it                 |
| `residual_exposure`  | a bounded, monotonic 0–100 score and its drivers                    |

**Why this must be code.** Ask a model whether an appeal path is adequate and it writes you a
paragraph. This returns `allowed: false` and names the two evidence kinds that would change the
answer. A probabilistic judgement here is not a limitation to work around — it is the bug the
product exists to prevent.

The eight states, and every legal move between them:

```
drafted    → evidenced, rejected, withdrawn
evidenced  → challenged, ratified, deferred, rejected, withdrawn
challenged → arbitrated, evidenced, deferred, rejected
arbitrated → ratified, rejected, deferred
ratified   → challenged          (reopening is the only way back)
rejected   → drafted             (appeal restarts at the beginning)
deferred   → evidenced, withdrawn
withdrawn  → drafted
```

Any move absent from that table is refused with the legal alternatives listed. Then, on top of
the table, gates:

| Gate                   | Refuses unless                                                    |
| ---------------------- | ----------------------------------------------------------------- |
| `MISSING_EVIDENCE`     | every required evidence kind is attached **and verified**          |
| `NEEDS_CONTESTANT`     | someone is actually recorded as contesting it                      |
| `NEEDS_ARBITRATION`    | a ruling reference is attached                                     |
| `NEEDS_OVERRIDE`       | severity is 5 and a person is named as accepting residual risk     |
| `NEEDS_DEFERRAL_DATE`  | a deferral carries the date it is deferred to                      |
| `NEEDS_REJECTION_REF`  | a rejection carries a recorded reason                              |
| `WRONG_PARTY`          | only the party that owes it may withdraw it                        |

An unverified artefact satisfies nothing. That is the load-bearing detail: attaching a document
is cheap, and claiming you read it is what the flag means.

**Two invariants, property-tested with hypothesis.** Conservation — liability shares sum to
exactly 1,000,000 micro-units. Monotonicity — adding an obligation can never lower the exposure
score. A golden-file test pins six known cases to hand-computed output, so a refactor that
changes behaviour shows up as a diff instead of being blessed.

```bash
python -m pytest services/engine -q
# 78 passed
python -m mypy --strict services/engine/src/harmscope_bench
# Success: no issues found in 5 source files
```

## MCP

Seven tools, exposed over stdio, all backed by the core registry — no duplicated logic.

```json
{
  "mcpServers": {
    "harmscope-bench": {
      "command": "node",
      "args": ["/abs/path/harmscope-bench/packages/cli/dist/bin.js", "mcp", "serve"],
      "env": { "PRODUCT_ROOT": "/abs/path/harmscope-bench" }
    }
  }
}
```

```
tools/list
----------
7 tools exposed:
  adjudicate_transition
  case_queue
  case_review
  liability_split
  list_plugins
  list_skills
  residual_exposure

tools/call adjudicate_transition (the refusal path)
---------------------------------------------------
{
  "allowed": false,
  "code": "MISSING_EVIDENCE",
  "detail": "disclosure requires verified evidence for: notice_text, locale_matrix",
  "obligationId": "disclosure",
  "fromState": "drafted",
  "toState": "evidenced",
  "blockingGates": [
    {
      "code": "MISSING_EVIDENCE",
      "obligationId": "disclosure",
      "detail": "disclosure requires verified evidence for: notice_text, locale_matrix",
      "severity": 3,
      "missingEvidence": ["notice_text", "locale_matrix"]
    }
  ],
  "nextObligationId": "incident",
  "nextObligationState": "ratified"
}

tools/call case_review with invalid input (error envelope)
----------------------------------------------------------
rejected as expected: VALIDATION_FAILED: obligations[0].kind must be a non-empty string

MCP PROOF PASSED
```

Reproduce all of that with a real SDK client, no mocks:

```bash
node scripts/mcp-proof.mjs
```

The five engine tools are stateless: the caller supplies the case, the server holds nothing.
That is what makes the verdict reproducible from another agent's side.

## CLI

```
Usage: harmscope-bench [options] [command]

Options:
  -v, --version        print the version
  -h, --help           display help for command

Commands:
  doctor [options]     diagnose every subsystem and print an actionable report
  tools [options]      list the registered tools — the authoritative capability list
  skills [options]     load the skill catalog from disk and report every validation issue
  plugins [options]    resolve the plugin registry and report why anything was rejected
  case                 create and inspect review cases
  obligation           record what a deployment owes
  move [options]       attempt a state change. The engine decides; this only records the outcome.
  queue [options]      the ordered work list, with the gates blocking each row
  review [options]     the whole-case verdict: phase, sign-off readiness, and every gate in the way
  liability [options]  split outstanding exposure between the parties that owe it
  exposure [options]   score the case 0-100 by outstanding weight, and list the drivers
  mcp                  Model Context Protocol commands
  export [options]     write the case plus the engine verdict as the portable snapshot the web app renders
  bench [options]      open the queue-first review bench
  version              print version and runtime information as JSON
```

Every read-only command takes `--json`. Exit codes: `0` ok — **including a refused move**,
`1` runtime failure, `2` usage error.

## Skills

```bash
node packages/cli/dist/bin.js skills
```

| Skill               | Use it when                                                        |
| ------------------- | ------------------------------------------------------------------ |
| `open-a-case`       | a deployment needs a review and no case exists yet                   |
| `attach-evidence`   | a row is blocked by `MISSING_EVIDENCE` and you have the artefact     |
| `sign-off-gate`     | someone asks whether a deployment is ready to ship                   |
| `expose-over-mcp`   | another agent should be able to ask whether a move is allowed        |
| `diagnose`          | a command failed or `doctor` reports red                             |
| `product-overview`  | you need the map rather than the detail                              |

Editing a skill body without bumping `metadata.version` fails CI.

## Configuration

| Variable              | Default      | Meaning                                          |
| --------------------- | ------------ | ------------------------------------------------ |
| `PRODUCT_ROOT`        | `process.cwd()` | where the CLI finds `services/engine/src`      |
| `PRODUCT_DATA_DIR`    | `:memory:`   | SQLite path; `:memory:` is discarded on exit     |
| `PRODUCT_MCP_PERMISSIONS` | union of declared | comma-separated ceiling for the MCP server  |

## Development

```bash
npm install
npm run check          # the aggregate gate CI runs
npm test               # 94 TypeScript tests (92 vitest + 2 node --test)
npm run pytest         # 78 Python tests
npm run build
node scripts/mcp-proof.mjs
npm run lint -- --fix
npm run format
```

`npm run check` runs, in order: `format:check`, `lint`, `typecheck`, `check:skill-version`,
`check:no-secrets`, `check:theme-tokens`, `check:boundaries`, `check:public-hygiene`,
`check:readme-commands`, `test`, `pytest`, `build`. The cheap policy gates run first on purpose —
a stray hex literal should fail in 200ms, not after a three-minute build.

Python:

```bash
python -m pytest services/engine -q
python -m mypy --strict services/engine/src/harmscope_bench
python -m ruff check services/engine
```

### The web app

```bash
npm run dev --workspace @harmscopebench/web
```

Next.js App Router, server-rendered on first paint, tokens-only styling enforced by
`check:theme-tokens`. The signature element is the **gate rail**: each obligation is a row with a
4px left bar in its state colour, and a blocked row is indented onto a bracket connector naming
the gate it fails — so the shape of the queue reads as the shape of the blockage.

## Architecture decisions

| ADR                                                                    | Decision                                              |
| ---------------------------------------------------------------------- | ----------------------------------------------------- |
| [0001](docs/adr/0001-narrow-waist.md)                                  | one registry, one `Tool` interface                    |
| [0002](docs/adr/0002-python-engine-boundary.md)                        | the engine is a pure Python function over stdin/stdout |
| [0003](docs/adr/0003-web-app-self-contained.md)                         | the web app has no workspace dependencies             |
| [0004](docs/adr/0004-web-snapshot-boundary.md)                         | the web renders an exported snapshot, never a live call |
| [0005](docs/adr/0005-obligation-ids-scoped-to-case.md)                 | obligation ids are unique within a case               |
| [0006](docs/adr/0006-no-judgement-operation.md)                        | no operation returns an ethical judgement             |

ADR 0006 is the one worth reading before you use this. The engine has no
`is_this_ethical(case) -> bool`, and adding one is not a feature request — it would launder a
normative commitment into an arithmetic result that then looks objective because a function
produced it.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). The footprint ladder, in order of preference: extend an
existing tool → add a CLI command plus a skill → add a service-gated tool → add a plugin → add an
MCP tool → add a new core tool. Core is last, not first.

## Security

See [SECURITY.md](SECURITY.md).

## License

MIT — [LICENSE](LICENSE).
