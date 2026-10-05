# ADR 0006 — The engine exposes no operation that returns a judgement

- **Status:** Accepted
- **Date:** 2026-10-05

## Context

The engine has five operations: `adjudicate`, `queue`, `review`, `liability_split` and
`residual_exposure`. Four of them return arithmetic or graph results. `review` returns a
`phase` and a `caseRatifiable` boolean, which is the closest thing here to a verdict, and it is
worth being precise about why it is not one.

The obvious missing operation is `is_this_ethical(case) -> bool`. It is missing on purpose.

A deterministic function that returned a single yes/no about whether a deployment is ethical
would either be trivially true (the case is ratified iff every obligation settled) or
unfalsifiable (the answer depends on whose values you encode). The first teaches an operator
nothing; the second launders a normative commitment into an arithmetic result that then looks
objective because it came out of a function.

## Decision

No operation accepts a request for an ethical judgement, and none is planned. Every refusal
names the specific artefact that is missing and the party who owes it:

```json
{
  "allowed": false,
  "code": "MISSING_EVIDENCE",
  "detail": "disclosure requires verified evidence for: notice_text, locale_matrix",
  "blockingGates": [{ "code": "MISSING_EVIDENCE", "obligationId": "disclosure", "missingEvidence": ["notice_text", "locale_matrix"] }]
}
```

`caseRatifiable` is reported as *what is still outstanding*, not as *whether this is ethical*.
The severity-5 override is the deliberate exception: it requires a human to put their name
against accepting residual risk, because that is a decision a person should be accountable for
and no function should be able to discharge it.

## Consequences

**Good**

- A refusal is actionable in a way an opinion is not. It names a file to produce.
- Two reviewers running the same case get identical output, because there is no model in the
  path that could disagree with itself.
- The product cannot be cited as saying a deployment is ethical, because it never said so.

**Bad**

- The tool will disappoint anyone who wanted a yes/no, and that disappointment is the feature.
- Someone will put the judgement outside the tool, in the surrounding conversation. That is
  outside this boundary by construction; the audit trail makes it visible when it happens,
  because the human's reasoning has to become an `overrideRef` or a `rejectionRef`.
