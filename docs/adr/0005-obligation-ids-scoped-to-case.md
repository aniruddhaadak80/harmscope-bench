# ADR 0005 — Obligation ids are scoped to a case

- **Status:** Accepted
- **Date:** 2026-10-05

## Context

The first version of the review schema made `obligations.id` the primary key, globally. It was
discovered by trying to review a second deployment: recording `appeal` for case A succeeded, and
recording `appeal` for case B failed with `obligation appeal already exists`.

That is not an exotic scenario. The whole point of this product is comparing several
deployments over time, and every one of them will have an appeal path, a consent notice and an
incident channel. A schema that gives those obligations a shared name space makes the second
review impossible.

## Decision

Obligation ids are unique **within a case**, not globally. `obligations` has a composite primary
key `(case_id, id)`, and `evidence` is keyed `(case_id, obligation_id, kind)` with a matching
composite foreign key. Every store method that touches an obligation takes the case id first.

This was shipped as **migration 4**, appended rather than folded into migration 3, so an existing
database upgrades in place. It rebuilds both tables, copies the rows, and recreates the indexes —
which is the honest way to change a primary key in SQLite, since it cannot `ALTER` one.

## Consequences

**Good**

- Two cases can both have `appeal`, and evidence for one is never confused with the other.
- Case ids are unique on their own, which is what an API and a directory name both need.
- The composite key makes the cross-case scoping impossible to forget at the type level: the
  methods refuse to compile without a case id.

**Bad**

- Every obligation lookup takes two arguments. This is deliberate friction: the alternative was
  an ambiguity that produced a wrong answer silently.
- `attempts` still stores a bare `obligation_id` without a foreign key. It is an audit log read
  only through `attemptsFor(caseId)`, so the case is established by the query. A future case that
  reuses an obligation id will have two historical entries for it, disambiguated by timestamp.

## Rejected alternative

Prefixing the stored id with the case (`c1/appeal`) was cheaper and needed no migration. It was
rejected because the composite key makes the scoping explicit in the schema and in the types,
where a prefix is a string convention that only a comment enforces.
