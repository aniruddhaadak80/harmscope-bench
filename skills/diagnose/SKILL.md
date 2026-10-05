---
name: diagnose
description: Use when Harmscope Bench refuses a move or reports a failing subsystem and the cause is not obvious, because the diagnostic order below finds the fault without guesswork.
metadata:
  version: 2.0.0
---

# Diagnose Harmscope Bench

## When to use this

A command failed, `doctor` reports a red row, or a move was refused and you do not yet know
which subsystem is at fault.

## Steps

1. `harmscope-bench doctor` — read the failing row and its **fix** line. Do not skip to step 2.
2. If `skills` is failing: `harmscope-bench skills` lists every validation issue with its file.
   Fix the frontmatter; do not delete the skill.
3. If `plugins` is warning: `harmscope-bench plugins` shows each rejection with its reason. A
   version mismatch names the required and the running range.
4. If a capability is missing: `harmscope-bench tools` is the authoritative list. A tool absent
   here was never registered, and no transport can reach it.
5. If a tool call fails: `harmscope-bench mcp call <tool> '<json>'` shows the error envelope with
   its stable code, without involving MCP at all.
6. If the engine is the suspect: run the op directly.

   ```bash
   echo '{"op":"review","input":{"obligations":[]}}' | python -m harmscope_bench
   ```

   Run it from `services/engine/src`. A non-zero exit or a `{"ok":false,...}` body means the
   Python side is broken, not the TypeScript side.

## Error codes

| Code                | Meaning                               | First move                            |
| ------------------- | ------------------------------------- | ------------------------------------- |
| `VALIDATION_FAILED` | input did not match the tool's schema | print the schema, fix the caller      |
| `PERMISSION_DENIED` | tool needs a permission not granted   | check the declared permissions        |
| `CONFLICT`          | duplicate name at registration        | find the other registrant             |
| `NOT_FOUND`         | no such case or obligation            | `harmscope-bench case list`           |
| `UPSTREAM_FAILED`   | the Python engine returned an error   | run the op directly, see `durationMs` |
| `TIMEOUT`           | exceeded the engine timeout           | raise it or make the op cheaper       |

## Gate codes are not errors

A refusal from `harmscope-bench move` is the product working. `MISSING_EVIDENCE`,
`NEEDS_OVERRIDE`, `ILLEGAL_TRANSITION`, `NEEDS_ARBITRATION`, `WRONG_PARTY`,
`NEEDS_CONTESTANT`, `NEEDS_DEFERRAL_DATE`, `NEEDS_REJECTION_REF` and `UNKNOWN_OBLIGATION` are
answers, not faults. Read the `detail` line — it names the artefact that is missing.

## Verify

`harmscope-bench doctor` exits 0.
