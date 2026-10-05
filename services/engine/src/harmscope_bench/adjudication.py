"""The deterministic core: an obligation state graph that refuses unsupported transitions.

Every function here is pure. No clock, no network, no randomness, no filesystem. Time arrives
as an integer argument and randomness is never used. Two identical inputs always produce
identical output, which is the whole point: this is the part of an ethics review that must be
reproducible by an auditor six months later.

The central idea is that the product has no code path which produces a judgement. It has code
paths which produce *refusals with a named reason*. An LLM asked "is this appeal path adequate?"
will answer with prose; asked the same question here, it returns
``allowed: false, code: NEEDS_ARBITRATION`` and names the obligation and the missing artefact.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any, Final, TypedDict

from .protocol import EngineError

# --------------------------------------------------------------------------- states

DRAFTED: Final = "drafted"
EVIDENCED: Final = "evidenced"
CHALLENGED: Final = "challenged"
ARBITRATED: Final = "arbitrated"
RATIFIED: Final = "ratified"
REJECTED: Final = "rejected"
DEFERRED: Final = "deferred"
WITHDRAWN: Final = "withdrawn"

STATES: Final[frozenset[str]] = frozenset(
    {DRAFTED, EVIDENCED, CHALLENGED, ARBITRATED, RATIFIED, REJECTED, DEFERRED, WITHDRAWN}
)

#: States that no longer hold open exposure.
SETTLED: Final[frozenset[str]] = frozenset({RATIFIED, REJECTED, WITHDRAWN})

#: The transition table. A move absent from here is refused, always, with no heuristics.
TRANSITIONS: Final[dict[str, frozenset[str]]] = {
    DRAFTED: frozenset({EVIDENCED, REJECTED, WITHDRAWN}),
    EVIDENCED: frozenset({CHALLENGED, RATIFIED, DEFERRED, REJECTED, WITHDRAWN}),
    CHALLENGED: frozenset({ARBITRATED, EVIDENCED, DEFERRED, REJECTED}),
    ARBITRATED: frozenset({RATIFIED, REJECTED, DEFERRED}),
    # Reopening is allowed and one-way: a ratified obligation can be contested again, which is
    # the only way a ratified claim ever returns to the queue.
    RATIFIED: frozenset({CHALLENGED}),
    # Rejected and withdrawn obligations can be appealed or reinstated, but only back to the
    # start of the graph. There is no path from here straight back to ratified.
    REJECTED: frozenset({DRAFTED}),
    DEFERRED: frozenset({EVIDENCED, WITHDRAWN}),
    WITHDRAWN: frozenset({DRAFTED}),
}

#: The transition a reviewer should attempt next for each state, used to explain a blockage.
NATURAL_NEXT: Final[dict[str, str]] = {
    DRAFTED: EVIDENCED,
    EVIDENCED: RATIFIED,
    CHALLENGED: ARBITRATED,
    ARBITRATED: RATIFIED,
    DEFERRED: EVIDENCED,
    REJECTED: DRAFTED,
    RATIFIED: CHALLENGED,
    WITHDRAWN: DRAFTED,
}

#: How far along the ratification path each state sits. Queue ordering is by state rank.
STATE_RANK: Final[dict[str, int]] = {
    DRAFTED: 0,
    DEFERRED: 1,
    EVIDENCED: 2,
    CHALLENGED: 3,
    ARBITRATED: 4,
    RATIFIED: 5,
    REJECTED: 6,
    WITHDRAWN: 7,
}

#: Exposure weight per state. Every state that still holds open risk multiplies severity by at
#: least 2, which is what makes ``residual_exposure`` monotonic when an obligation is added.
OPEN_MULTIPLIER: Final[dict[str, int]] = {
    DRAFTED: 5,
    EVIDENCED: 4,
    CHALLENGED: 4,
    ARBITRATED: 2,
    DEFERRED: 3,
    REJECTED: 3,
    RATIFIED: 0,
    WITHDRAWN: 0,
}

MIN_SEVERITY: Final = 1
MAX_SEVERITY: Final = 5
CRITICAL_SEVERITY: Final = 5

#: Denominator constant for the saturating exposure curve. Chosen so that 20 units of open
#: weight reads as 50 and 80 units reads as 80.
EXPOSURE_HALF_POINT: Final = 20

#: Shares are apportioned in integer micro-units so conservation is exact rather than floating
#: point approximate. 1_000_000 micro == 1.0.
MICRO: Final = 1_000_000

# --------------------------------------------------------------------------- types


class Evidence(TypedDict, total=False):
    kind: str
    ref: str
    verified: bool


class Obligation(TypedDict, total=False):
    id: str
    kind: str
    severity: int
    claimant: str
    state: str
    requiredEvidence: list[str]
    evidence: list[Evidence]
    contestedBy: list[str]
    arbitrationRef: str
    deferUntil: int
    rejectionRef: str
    overrideRef: str


class Transition(TypedDict, total=False):
    obligationId: str
    to: str
    by: str
    overrideRef: str


class Gate(TypedDict):
    code: str
    obligationId: str
    detail: str
    severity: int
    missingEvidence: list[str]


class AdjudicationOutput(TypedDict):
    allowed: bool
    code: str
    detail: str
    obligationId: str
    fromState: str
    toState: str
    blockingGates: list[Gate]
    nextObligationId: str
    nextObligationState: str


class QueueItem(TypedDict):
    id: str
    kind: str
    claimant: str
    state: str
    severity: int
    openWeight: int
    nextState: str
    blockedBy: list[str]
    settled: bool


class QueueOutput(TypedDict):
    head: str
    count: int
    byState: dict[str, int]
    items: list[QueueItem]


class ReviewOutput(TypedDict):
    phase: str
    total: int
    settled: int
    byState: dict[str, int]
    caseRatifiable: bool
    caseBlocking: list[Gate]
    residualExposure: int
    nextAction: str


class Share(TypedDict):
    party: str
    micro: int
    share: float
    weight: int


class LiabilityOutput(TypedDict):
    totalWeight: int
    apportionmentUnit: int
    shares: list[Share]
    concentration: float


class Driver(TypedDict):
    id: str
    kind: str
    state: str
    severity: int
    weight: int
    claimant: str


class ExposureOutput(TypedDict):
    score: int
    openWeight: int
    maxSeverity: int
    openCount: int
    drivers: list[Driver]


# --------------------------------------------------------------------------- codes

OK: Final = "OK"
ILLEGAL_TRANSITION: Final = "ILLEGAL_TRANSITION"
UNKNOWN_OBLIGATION: Final = "UNKNOWN_OBLIGATION"
UNKNOWN_STATE: Final = "UNKNOWN_STATE"
MISSING_EVIDENCE: Final = "MISSING_EVIDENCE"
NEEDS_CONTESTANT: Final = "NEEDS_CONTESTANT"
NEEDS_ARBITRATION: Final = "NEEDS_ARBITRATION"
NEEDS_DEFERRAL_DATE: Final = "NEEDS_DEFERRAL_DATE"
NEEDS_REJECTION_REF: Final = "NEEDS_REJECTION_REF"
NEEDS_OVERRIDE: Final = "NEEDS_OVERRIDE"
WRONG_PARTY: Final = "WRONG_PARTY"
NOTHING_TO_RATIFY: Final = "NOTHING_TO_RATIFY"

_REQUIRED_FIELDS: Final[tuple[str, ...]] = ("id", "kind", "severity", "claimant", "state")


# --------------------------------------------------------------------------- parsing


def _require_obligations(payload: Any) -> list[Obligation]:
    if not isinstance(payload, dict):
        raise EngineError("BAD_SHAPE", "expected an object with 'obligations'")
    raw = payload.get("obligations")
    if not isinstance(raw, list):
        raise EngineError("BAD_SHAPE", "'obligations' must be a list")

    seen: set[str] = set()
    for index, item in enumerate(raw):
        if not isinstance(item, dict):
            raise EngineError("BAD_SHAPE", f"obligations[{index}] must be an object")
        for field in _REQUIRED_FIELDS:
            if field not in item:
                raise EngineError("MISSING_FIELD", f"obligations[{index}] is missing {field!r}")
        identifier = item["id"]
        if not isinstance(identifier, str) or not identifier:
            raise EngineError("BAD_SHAPE", f"obligations[{index}].id must be a non-empty string")
        if identifier in seen:
            raise EngineError("DUPLICATE_ID", f"duplicate obligation id {identifier!r}")
        seen.add(identifier)
        if not isinstance(item["claimant"], str) or not item["claimant"]:
            raise EngineError("BAD_SHAPE", f"{identifier}.claimant must be a non-empty string")
        if item["state"] not in STATES:
            raise EngineError(
                "UNKNOWN_STATE",
                f"{identifier}.state is {item['state']!r}; known states: {', '.join(sorted(STATES))}",
            )
        severity = item["severity"]
        if isinstance(severity, bool) or not isinstance(severity, int):
            raise EngineError("BAD_SHAPE", f"{identifier}.severity must be an integer")
        if not MIN_SEVERITY <= severity <= MAX_SEVERITY:
            raise EngineError(
                "BAD_SHAPE",
                f"{identifier}.severity is {severity}; must be "
                f"{MIN_SEVERITY}..{MAX_SEVERITY}",
            )
    return raw


def _list_field(obligation: Obligation, field: str) -> list[str]:
    value = obligation.get(field)
    if value is None:
        return []
    if not isinstance(value, list) or any(not isinstance(entry, str) for entry in value):
        raise EngineError("BAD_SHAPE", f"{obligation['id']}.{field} must be a list of strings")
    return value


def _verified_kinds(obligation: Obligation) -> set[str]:
    found: set[str] = set()
    evidence = obligation.get("evidence") or []
    if not isinstance(evidence, list):
        raise EngineError("BAD_SHAPE", f"{obligation['id']}.evidence must be a list")
    for item in evidence:
        if not isinstance(item, dict):
            raise EngineError("BAD_SHAPE", f"{obligation['id']}.evidence entries must be objects")
        if item.get("verified") is True and isinstance(item.get("kind"), str):
            found.add(item["kind"])
    return found


def _missing_evidence(obligation: Obligation) -> list[str]:
    """Required evidence kinds with no verified artefact, in declaration order."""
    verified = _verified_kinds(obligation)
    missing = [kind for kind in _list_field(obligation, "requiredEvidence") if kind not in verified]
    return missing


def _open_weight(obligation: Obligation) -> int:
    return obligation["severity"] * OPEN_MULTIPLIER[obligation["state"]]


def _gate(
    code: str,
    obligation: Obligation,
    detail: str,
    missing: list[str] | None = None,
) -> Gate:
    return {
        "code": code,
        "obligationId": obligation["id"],
        "detail": detail,
        "severity": obligation["severity"],
        "missingEvidence": missing if missing is not None else [],
    }


# --------------------------------------------------------------------------- adjudicate


def _gates_evidence(obligation: Obligation, transition: Transition) -> list[Gate]:
    missing = _missing_evidence(obligation)
    if not missing:
        return []
    identifier = obligation["id"]
    return [
        _gate(
            MISSING_EVIDENCE,
            obligation,
            f"{identifier} requires verified evidence for: {', '.join(missing)}",
            missing,
        )
    ]


def _gates_contestant(obligation: Obligation, transition: Transition) -> list[Gate]:
    if _list_field(obligation, "contestedBy"):
        return []
    return [
        _gate(
            NEEDS_CONTESTANT,
            obligation,
            f"nothing contests {obligation['id']}; record who is contesting it before "
            "marking it challenged",
        )
    ]


def _gates_arbitration(obligation: Obligation, transition: Transition) -> list[Gate]:
    if obligation.get("arbitrationRef"):
        return []
    identifier = obligation["id"]
    return [
        _gate(
            NEEDS_ARBITRATION,
            obligation,
            f"{identifier} is contested but carries no arbitrationRef; attach the "
            "ruling that settles it",
        )
    ]


def _gates_deferral(obligation: Obligation, transition: Transition) -> list[Gate]:
    if obligation.get("deferUntil") is not None:
        return []
    identifier = obligation["id"]
    return [
        _gate(
            NEEDS_DEFERRAL_DATE,
            obligation,
            f"deferring {identifier} requires deferUntil; a deferral with no date is "
            "an open obligation",
        )
    ]


def _gates_rejection(obligation: Obligation, transition: Transition) -> list[Gate]:
    if obligation.get("rejectionRef"):
        return []
    identifier = obligation["id"]
    return [
        _gate(
            NEEDS_REJECTION_REF,
            obligation,
            f"rejecting {identifier} requires a rejectionRef; a refusal with no "
            "recorded reason is unreviewable",
        )
    ]


def _gates_withdrawal(obligation: Obligation, transition: Transition) -> list[Gate]:
    actor = transition.get("by")
    claimant = obligation["claimant"]
    if actor in (None, "", claimant):
        return []
    identifier = obligation["id"]
    return [
        _gate(
            WRONG_PARTY,
            obligation,
            f"only {claimant} may withdraw {identifier}; {actor} cannot",
        )
    ]


def _gates_override(obligation: Obligation, transition: Transition) -> list[Gate]:
    # An override may be proposed with the transition or already recorded on the obligation.
    # Reading both is what lets a reviewer supply the name in the same breath as the move,
    # instead of having to write to the record first just to ask the question.
    proposed = transition.get("overrideRef")
    recorded = obligation.get("overrideRef")
    if obligation["severity"] < CRITICAL_SEVERITY or proposed or recorded:
        return []
    identifier = obligation["id"]
    return [
        _gate(
            NEEDS_OVERRIDE,
            obligation,
            f"{identifier} is severity {CRITICAL_SEVERITY}; ratifying it requires an "
            "overrideRef naming the person accepting the residual risk",
        )
    ]


#: The gate rules are themselves a table, keyed by the state being entered. Adding a state
#: means adding a row here, not another branch in a growing if/elif chain.
GATE_RULES: Final[dict[str, Callable[[Obligation, Transition], list[Gate]]]] = {
    EVIDENCED: _gates_evidence,
    CHALLENGED: _gates_contestant,
    ARBITRATED: _gates_arbitration,
    DEFERRED: _gates_deferral,
    REJECTED: _gates_rejection,
    WITHDRAWN: _gates_withdrawal,
    RATIFIED: _gates_override,
}


def _gate_transition(
    obligation: Obligation,
    to_state: str,
    transition: Transition,
) -> list[Gate]:
    """Every gate that must hold for one obligation to move to ``to_state``.

    A state with no row in :data:`GATE_RULES` is entered unconditionally, because reaching it
    is already constrained by the transition table alone.
    """
    rule = GATE_RULES.get(to_state)
    return rule(obligation, transition) if rule is not None else []


def _queue_order(obligations: list[Obligation]) -> list[Obligation]:
    """Deterministic work order: highest open exposure first, then least progress, then id."""
    return sorted(
        obligations,
        key=lambda item: (-_open_weight(item), STATE_RANK[item["state"]], item["id"]),
    )


def _head_of(obligations: list[Obligation]) -> tuple[str, str]:
    """The next obligation to work, and why. Empty case reports a deliberate sentinel."""
    ordered = [item for item in _queue_order(obligations) if item["state"] not in SETTLED]
    if not ordered:
        return "", "none outstanding"
    head = ordered[0]
    return head["id"], NATURAL_NEXT[head["state"]]


def adjudicate(payload: Any) -> AdjudicationOutput:
    """Decide one transition, and refuse it with a named gate if the evidence is absent.

    ``payload`` is ``{"obligations": [...], "transition": {"obligationId", "to", "by"?,
    "overrideRef"?}}``. The transition is never applied here; this function only answers
    whether it would be allowed, which is what makes it safe to call speculatively from a
    reviewer UI.
    """
    obligations = _require_obligations(payload)
    raw_transition = payload.get("transition") if isinstance(payload, dict) else None
    if not isinstance(raw_transition, dict):
        raise EngineError("BAD_SHAPE", "'transition' must be an object")

    identifier = raw_transition.get("obligationId")
    to_state = raw_transition.get("to")
    if not isinstance(identifier, str) or not identifier:
        raise EngineError("MISSING_FIELD", "transition.obligationId must be a non-empty string")
    if not isinstance(to_state, str) or not to_state:
        raise EngineError("MISSING_FIELD", "transition.to must be a non-empty string")

    head, head_next = _head_of(obligations)

    base: AdjudicationOutput = {
        "allowed": False,
        "code": OK,
        "detail": "",
        "obligationId": identifier,
        "fromState": "",
        "toState": to_state,
        "blockingGates": [],
        "nextObligationId": head,
        "nextObligationState": head_next,
    }

    if to_state not in STATES:
        return {
            **base,
            "code": UNKNOWN_STATE,
            "detail": f"{to_state!r} is not a state; known states: {', '.join(sorted(STATES))}",
        }

    target = next((item for item in obligations if item["id"] == identifier), None)
    if target is None:
        return {
            **base,
            "code": UNKNOWN_OBLIGATION,
            "detail": f"no obligation {identifier!r} in this case",
        }

    from_state = target["state"]
    if to_state not in TRANSITIONS[from_state]:
        allowed_from = ", ".join(sorted(TRANSITIONS[from_state]))
        return {
            **base,
            "code": ILLEGAL_TRANSITION,
            "detail": (
                f"{identifier} cannot move {from_state} -> {to_state}; from {from_state} the "
                f"only legal moves are: {allowed_from}"
            ),
            "fromState": from_state,
        }

    transition: Transition = {
        "obligationId": identifier,
        "to": to_state,
        "by": raw_transition["by"] if isinstance(raw_transition.get("by"), str) else "",
        **(
            {"overrideRef": raw_transition["overrideRef"]}
            if isinstance(raw_transition.get("overrideRef"), str)
            else {}
        ),
    }
    gates = _gate_transition(target, to_state, transition)
    if gates:
        first = gates[0]
        return {
            **base,
            "code": first["code"],
            "detail": first["detail"],
            "fromState": from_state,
            "blockingGates": gates,
        }

    return {
        **base,
        "allowed": True,
        "code": OK,
        "detail": f"{identifier} may move {from_state} -> {to_state}",
        "fromState": from_state,
    }


# --------------------------------------------------------------------------- queue


def queue(payload: Any) -> QueueOutput:
    """The work list, ordered, each row annotated with the gates blocking it right now."""
    obligations = _require_obligations(payload)

    by_state: dict[str, int] = {state: 0 for state in sorted(STATES)}
    items: list[QueueItem] = []

    for obligation in _queue_order(obligations):
        state = obligation["state"]
        by_state[state] = by_state.get(state, 0) + 1
        nxt = NATURAL_NEXT[state]
        gates = (
            []
            if state in SETTLED
            else _gate_transition(obligation, nxt, {"obligationId": obligation["id"], "to": nxt})
        )
        items.append(
            {
                "id": obligation["id"],
                "kind": obligation["kind"],
                "claimant": obligation["claimant"],
                "state": state,
                "severity": obligation["severity"],
                "openWeight": _open_weight(obligation),
                "nextState": nxt,
                "blockedBy": [gate["code"] for gate in gates],
                "settled": state in SETTLED,
            }
        )

    head = next((item["id"] for item in items if not item["settled"]), "")
    return {"head": head, "count": len(items), "byState": by_state, "items": items}


# --------------------------------------------------------------------------- review


def _case_gates(obligations: list[Obligation]) -> list[Gate]:
    """Why the case as a whole cannot be signed off."""
    gates: list[Gate] = []
    for obligation in _queue_order(obligations):
        identifier = obligation["id"]
        state = obligation["state"]
        if state not in SETTLED:
            nxt = NATURAL_NEXT[state]
            gates.append(
                _gate(
                    NOTHING_TO_RATIFY,
                    obligation,
                    f"{identifier} is {state}; it must reach {nxt} before the case can be signed off",
                )
            )
        elif state == RATIFIED and (
            obligation["severity"] >= CRITICAL_SEVERITY and not obligation.get("overrideRef")
        ):
            gates.append(
                _gate(
                    NEEDS_OVERRIDE,
                    obligation,
                    f"{identifier} is ratified at severity {CRITICAL_SEVERITY} but carries no "
                    "overrideRef",
                )
            )
    return gates


def _within(*allowed: str) -> Callable[[frozenset[str]], bool]:
    allowed_set = frozenset(allowed)
    return lambda states: states <= allowed_set


def _any_of(*triggers: str) -> Callable[[frozenset[str]], bool]:
    trigger_set = frozenset(triggers)
    return lambda states: bool(states & trigger_set)


#: The case phase, as an ordered rule table over the set of states present. The first matching
#: row wins, so precedence is data rather than control flow — which is what keeps "contested"
#: beating "arbitrating" a matter of record rather than of statement order.
PHASE_RULES: Final[tuple[tuple[str, Callable[[frozenset[str]], bool]], ...]] = (
    ("ratified", _within(RATIFIED)),
    ("closed", _within(RATIFIED, REJECTED, WITHDRAWN)),
    ("contested", _any_of(CHALLENGED)),
    ("arbitrating", _any_of(ARBITRATED)),
    ("ready", _within(EVIDENCED)),
    ("gathering", _within(EVIDENCED, DEFERRED, RATIFIED)),
    ("appealing", _any_of(REJECTED)),
)


def _phase(obligations: list[Obligation]) -> str:
    """The case phase, from the state multiset alone. Precedence is fixed and total."""
    if not obligations:
        return "empty"
    states = frozenset(obligation["state"] for obligation in obligations)
    for phase, predicate in PHASE_RULES:
        if predicate(states):
            return phase
    return "drafting"


def review(payload: Any) -> ReviewOutput:
    """The whole-case verdict: phase, whether it can be signed off, and every gate in the way."""
    obligations = _require_obligations(payload)
    exposure = residual_exposure({"obligations": obligations})
    blocking = _case_gates(obligations)
    by_state: dict[str, int] = {state: 0 for state in sorted(STATES)}
    for obligation in obligations:
        by_state[obligation["state"]] = by_state.get(obligation["state"], 0) + 1
    settled = sum(1 for obligation in obligations if obligation["state"] in SETTLED)

    if blocking:
        next_action = f"clear {blocking[0]['code']} on {blocking[0]['obligationId']}"
    elif not obligations:
        next_action = "record an obligation to start the review"
    else:
        next_action = "sign off: every obligation is settled"

    return {
        "phase": _phase(obligations),
        "total": len(obligations),
        "settled": settled,
        "byState": by_state,
        "caseRatifiable": bool(obligations) and not blocking,
        "caseBlocking": blocking,
        "residualExposure": exposure["score"],
        "nextAction": next_action,
    }


# --------------------------------------------------------------------------- liability


def _apportion(weights: dict[str, int], units: int) -> dict[str, int]:
    """Largest-remainder apportionment in integers, so the shares sum to ``units`` exactly.

    Floating-point shares would sum to 1.0 only by luck. Doing it in integer micro-units makes
    conservation an exact, testable fact rather than a tolerance.
    """
    total = sum(weights.values())
    if total <= 0:
        return {party: 0 for party in weights}
    quotas = {party: weights[party] * units for party in weights}
    shares = {party: quota // total for party, quota in quotas.items()}
    remainders = {party: quota % total for party, quota in quotas.items()}
    leftover = units - sum(shares.values())
    # Deterministic tie-break: largest remainder first, then party name.
    for party in sorted(weights, key=lambda name: (-remainders[name], name))[:leftover]:
        shares[party] += 1
    return shares


def liability_split(payload: Any) -> LiabilityOutput:
    """Split outstanding exposure between the parties that owe it, conserving exactly.

    An obligation's weight is ``severity * open multiplier``. Ratified and withdrawn
    obligations carry no outstanding exposure and contribute nothing. Shares are returned in
    micro-units as well as as fractions, and the micro-units always sum to ``MICRO``.
    """
    obligations = _require_obligations(payload)

    weights: dict[str, int] = {}
    for obligation in obligations:
        weight = _open_weight(obligation)
        if weight <= 0:
            continue
        weights[obligation["claimant"]] = weights.get(obligation["claimant"], 0) + weight

    total_weight = sum(weights.values())
    if total_weight == 0:
        return {
            "totalWeight": 0,
            "apportionmentUnit": MICRO,
            "shares": [],
            "concentration": 0.0,
        }

    shares_micro = _apportion(weights, MICRO)
    ordered = sorted(weights, key=lambda party: (-shares_micro[party], party))
    shares: list[Share] = [
        {
            "party": party,
            "micro": shares_micro[party],
            "share": round(shares_micro[party] / MICRO, 6),
            "weight": weights[party],
        }
        for party in ordered
    ]
    top = shares_micro[ordered[0]] if ordered else 0
    return {
        "totalWeight": total_weight,
        "apportionmentUnit": MICRO,
        "shares": shares,
        "concentration": round(top / MICRO, 6),
    }


# --------------------------------------------------------------------------- exposure


def residual_exposure(payload: Any) -> ExposureOutput:
    """A bounded 0..100 score from outstanding obligation weight.

    The curve is ``100 * w / (w + K)`` floored, which is monotonically non-decreasing in the
    open weight ``w``. Because every state that still holds risk contributes at least twice its
    severity, adding an obligation can never lower this score.
    """
    obligations = _require_obligations(payload)

    drivers: list[Driver] = []
    open_weight = 0
    max_severity = 0
    for obligation in _queue_order(obligations):
        weight = _open_weight(obligation)
        if weight <= 0:
            continue
        open_weight += weight
        max_severity = max(max_severity, obligation["severity"])
        drivers.append(
            {
                "id": obligation["id"],
                "kind": obligation["kind"],
                "state": obligation["state"],
                "severity": obligation["severity"],
                "weight": weight,
                "claimant": obligation["claimant"],
            }
        )

    score = 0
    if open_weight > 0:
        raw = 100 * open_weight / (open_weight + EXPOSURE_HALF_POINT)
        score = min(100, int(raw))

    return {
        "score": score,
        "openWeight": open_weight,
        "maxSeverity": max_severity,
        "openCount": len(drivers),
        "drivers": drivers,
    }
