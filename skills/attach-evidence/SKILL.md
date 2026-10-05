---
name: attach-evidence
description: Use when an obligation is blocked by MISSING_EVIDENCE and you have the artefact in hand, because an unverified artefact satisfies no gate.
metadata:
  version: 1.0.0
---

# Attach evidence to clear a gate

## When to use this

`harmscope-bench queue --case <id>` shows a row with `MISSING_EVIDENCE`, and you have the
document, export, log or channel the obligation requires.

## Steps

1. Read the gate first — it names the exact kinds it wants, in declaration order.

   ```bash
   harmscope-bench queue --case <id>
   ```

   A gate reading `requires verified evidence for: policy_doc, appeal_channel` means **both**.
   Attaching one clears neither.

2. Attach each kind with a reference a reviewer can actually follow.

   ```bash
   harmscope-bench obligation evidence --case <id> --id <obligation> \
     --kind policy_doc --ref "docs/appeal-policy.md"
   ```

3. Verify it only once you have confirmed the artefact says what the obligation claims.

   ```bash
   harmscope-bench obligation evidence --case <id> --id <obligation> \
     --kind policy_doc --ref "docs/appeal-policy.md" --verify
   ```

   `--verify` is a claim that someone checked. Do not pass it in the same breath as attaching a
   reference you have not opened. An unverified artefact is stored and reported, but it does not
   satisfy the gate — that is deliberate.

4. Retry the move.

   ```bash
   harmscope-bench move --case <id> --id <obligation> --to evidenced
   ```

## Re-attaching the same kind

Attaching a kind that already exists replaces its reference and verification flag. Use it to
correct a wrong reference rather than to paper over a missing artefact.

## What counts as evidence

| Obligation kind    | Evidence that satisfies it                                      |
| ------------------ | --------------------------------------------------------------- |
| `appeal_path`      | the published policy, and a channel a person can actually reach |
| `consent`          | the notice as served, with the locale matrix it was served in   |
| `incident_channel` | the on-call roster and the escalation path into it              |
| `disparity_bound`  | the report **and** the sample size it was computed over         |
| `data_retention`   | the deletion job and its schedule                               |

A document that asserts a control exists is not evidence the control exists.

## Verify

The row's `blockedBy` no longer lists `MISSING_EVIDENCE`, and the retry reports `applied:`.
