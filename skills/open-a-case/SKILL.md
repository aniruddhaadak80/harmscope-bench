---
name: open-a-case
description: Use when a deployment needs an ethics review and no case exists yet, because a review starts by recording what the system owes rather than by asking whether it is ethical.
metadata:
  version: 1.0.0
---

# Open a review case

## When to use this

A team wants a deployment reviewed and there is no case to work. You are establishing what the
system owes, not judging whether it is acceptable.

## Steps

1. Create the case.

   ```bash
   harmscope-bench case create --id <kebab-case> --title "<what is shipping>" --system "<name and version>"
   ```

2. Record one obligation per concrete duty the deployment owes. Each is separately gated,
   separately ratifiable and separately blocked, which is the whole point.

   ```bash
   harmscope-bench obligation add --case <id> --id appeal-path \
     --kind appeal_path --severity 4 --claimant operator \
     --requires "policy_doc,appeal_channel"
   ```

   Kinds worth recording for almost any deployment: `appeal_path`, `consent`,
   `disclosure_notice`, `incident_channel`, `disparity_bound`, `human_oversight`,
   `data_retention`, `contest_audit`.

3. Set `--claimant` to the party that actually owes it — `operator`, `vendor`, `worker_council`
   or `regulator`. This is what `harmscope-bench liability` apportions against later, so
   guessing here distorts the whole split.

4. Set `--severity` 1–5 honestly. 5 means ratifying it requires naming a person who accepts the
   residual risk, which is a real signature and should not be cheap. `--requires` lists the
   evidence kinds that must be attached **and verified** before the obligation can be evidenced.

## What not to do

- Do not write one obligation called "ethics". It cannot be gated, so it can never be blocked,
  which makes it decorative.
- Do not pre-attach evidence you have not seen. Verified evidence is a claim someone can check.
- Do not raise severity to get attention. Severity drives the queue order and the exposure score.

## Verify

```bash
harmscope-bench queue --case <id>
```

Every row appears, and each row lists the gate that currently blocks it.
