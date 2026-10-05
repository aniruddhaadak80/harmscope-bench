# ADR 0004 — The web app renders an exported snapshot, never a live engine call

- **Status:** Accepted
- **Date:** 2026-10-05

## Context

ADR 0002 fixes the deterministic engine as a Python subprocess invoked over stdin/stdout. That
is the right shape for correctness, and it is also a hard constraint on deployment: a Vercel
function cannot spawn a Python process, and shipping the engine as a hosted service would mean
the web app depends on a network call for the one thing that must never be wrong.

So the deployed web app cannot compute a verdict. The question is what it renders instead.

The tempting answers are both wrong. Reimplementing the state graph in TypeScript gives the web
app a second source of truth that drifts from the engine within two releases — and a drifted
state graph produces confidently wrong ethics verdicts, which is the worst possible failure for
this product. Calling a hosted copy of the engine over HTTP re-creates the "call the model and
parse the output" dependency that ADR 0002 exists to avoid.

## Decision

The web app is a **read-only view over an exported snapshot**. The CLI owns the only path that
may change a case, and it writes the snapshot:

```bash
harmscope-bench export --case <id> --out apps/web/content/case.json
```

The snapshot carries the obligations *and* the engine's own verdict on them — `queue`, `review`,
`liability`, `exposure` — plus the audit trail of every attempt, refusals included. The web app
renders those numbers and recomputes nothing.

## Consequences

**Good**

- There is exactly one implementation of the state graph, and it is the one that is tested.
- The deployed page and the CLI cannot disagree, because both display the same engine output.
- The web app stays dependency-free, per ADR 0003, and builds from a bare checkout.
- The snapshot is a review artefact in its own right: commit it and the diff of the file is the
  diff of the review.

**Bad**

- The deployed view is stale until someone re-exports. This is a real cost and it is deliberate:
  a stale verdict is visibly stale, whereas a recomputed verdict is silently divergent.
- `/api/health` cannot probe the engine from the Vercel runtime. It says so explicitly
  (`"not probeable from this runtime — it is an out-of-process Python subprocess"`) instead of
  claiming a probe it did not run. `harmscope-bench doctor` is where the engine is actually
  checked.

## Revisit when

The engine gains a second runtime target, or the case data moves behind an API. Either would let
the web app compute live again — and would have to justify why two implementations of the state
graph are now acceptable.
