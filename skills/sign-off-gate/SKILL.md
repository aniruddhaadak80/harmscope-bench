---
name: sign-off-gate
description: Use when asked whether a deployment is ready to ship, because the answer is a computed list of blocking gates rather than an opinion.
metadata:
  version: 1.0.0
---

# Decide whether a case can be signed off

## When to use this

Someone asks "are we clear to ship?". Do not answer from the obligation count or from how far
along the review feels. Ask the engine.

## Steps

1. Get the verdict.

   ```bash
   harmscope-bench review --case <id>
   ```

2. Read `can sign off:` first. If it is `no`, the answer to the question is no, and the gates
   underneath are the reason. Each one names the obligation and the state it must reach.

3. Read `residual exposure:` as a trend, not a threshold. It is monotonic — adding an
   obligation never lowers it — so it is safe to compare across revisions. It is not a pass mark.

4. Work the queue rather than the gate list. The queue is ranked by outstanding weight, so the
   first row is the one whose blockage is costing the most.

   ```bash
   harmscope-bench queue --case <id>
   ```

5. Who is carrying it, if the question is about accountability rather than readiness:

   ```bash
   harmscope-bench liability --case <id>
   ```

   Shares are apportioned in integer micro-units that sum to exactly 1,000,000. A high
   concentration means one party is carrying most of the unfinished review — usually a sign the
   obligations were assigned to the wrong claimant.

## The one refusal that is not a bug

An obligation at severity 5 cannot be ratified without `--override-ref`. That is the design: the
highest-severity obligations require a named human to accept the residual risk in writing.

```bash
harmscope-bench move --case <id> --id <obligation> --to ratified --override-ref "name@org"
```

Do not supply an override to clear a gate you have not actually reviewed. The override is a
signature, and it is the one thing in this system that cannot be automated.

## Verify

```bash
harmscope-bench review --case <id>
```

`can sign off:` reads `yes` and `blocking gates (0)` is absent.
