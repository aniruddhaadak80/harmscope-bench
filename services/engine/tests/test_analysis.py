"""Tests for the obligation state graph.

Three kinds of test, on purpose:
  - unit tests that pin the refusal codes, because a wrong code is a wrong review outcome
  - property tests for the two invariants the product's credibility rests on
  - a golden-file test, so a refactor that changes an output is caught rather than blessed
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest
from hypothesis import given, settings
from hypothesis import strategies as st

from harmscope_bench.adjudication import (
    MICRO,
    adjudicate,
    liability_split,
    queue,
    residual_exposure,
    review,
)
from harmscope_bench.protocol import EngineError

GOLDEN = Path(__file__).parent / "golden" / "review_case.json"


def obligation(
    identifier: str,
    *,
    kind: str = "appeal_path",
    severity: int = 3,
    claimant: str = "operator",
    state: str = "drafted",
    required: tuple[str, ...] = (),
    evidence: tuple[tuple[str, bool], ...] = (),
    contested_by: tuple[str, ...] = (),
    arbitration_ref: str = "",
    defer_until: int | None = None,
    rejection_ref: str = "",
    override_ref: str = "",
) -> dict[str, Any]:
    item: dict[str, Any] = {
        "id": identifier,
        "kind": kind,
        "severity": severity,
        "claimant": claimant,
        "state": state,
        "requiredEvidence": list(required),
        "evidence": [{"kind": kind_name, "verified": ok} for kind_name, ok in evidence],
        "contestedBy": list(contested_by),
    }
    if arbitration_ref:
        item["arbitrationRef"] = arbitration_ref
    if defer_until is not None:
        item["deferUntil"] = defer_until
    if rejection_ref:
        item["rejectionRef"] = rejection_ref
    if override_ref:
        item["overrideRef"] = override_ref
    return item


def move(identifier: str, to_state: str, **extra: Any) -> dict[str, Any]:
    return {"obligations": [], "transition": {"obligationId": identifier, "to": to_state, **extra}}


# --------------------------------------------------------------------------- parsing guards


class TestParsing:
    def test_rejects_a_non_list(self) -> None:
        with pytest.raises(EngineError) as caught:
            queue({"obligations": "nope"})
        assert caught.value.code == "BAD_SHAPE"

    def test_rejects_a_missing_field(self) -> None:
        broken = obligation("a")
        del broken["claimant"]
        with pytest.raises(EngineError) as caught:
            queue({"obligations": [broken]})
        assert caught.value.code == "MISSING_FIELD"

    def test_rejects_an_unknown_state(self) -> None:
        with pytest.raises(EngineError) as caught:
            queue({"obligations": [obligation("a", state="vibes")]})
        assert caught.value.code == "UNKNOWN_STATE"

    def test_rejects_duplicate_ids(self) -> None:
        with pytest.raises(EngineError) as caught:
            queue({"obligations": [obligation("a"), obligation("a")]})
        assert caught.value.code == "DUPLICATE_ID"

    @pytest.mark.parametrize("severity", [0, 6, -1, 100])
    def test_rejects_severity_outside_the_scale(self, severity: int) -> None:
        with pytest.raises(EngineError) as caught:
            queue({"obligations": [obligation("a", severity=severity)]})
        assert caught.value.code == "BAD_SHAPE"

    @pytest.mark.parametrize("severity", [1, 5])
    def test_accepts_both_severity_boundaries(self, severity: int) -> None:
        assert queue({"obligations": [obligation("a", severity=severity)]})["count"] == 1

    def test_rejects_a_boolean_severity(self) -> None:
        with pytest.raises(EngineError) as caught:
            queue({"obligations": [obligation("a", severity=True)]})  # type: ignore[arg-type]
        assert caught.value.code == "BAD_SHAPE"

    def test_rejects_a_bad_transition_object(self) -> None:
        with pytest.raises(EngineError) as caught:
            adjudicate({"obligations": [obligation("a")]})
        assert caught.value.code == "BAD_SHAPE"


# --------------------------------------------------------------------------- adjudicate


class TestAdjudicate:
    def test_drafted_to_evidenced_refuses_when_evidence_is_missing(self) -> None:
        target = obligation("appeal", required=("policy_doc", "appeal_channel"))
        result = adjudicate(
            {"obligations": [target], "transition": {"obligationId": "appeal", "to": "evidenced"}}
        )
        assert result["allowed"] is False
        assert result["code"] == "MISSING_EVIDENCE"
        assert result["blockingGates"][0]["missingEvidence"] == ["policy_doc", "appeal_channel"]

    def test_unverified_evidence_does_not_satisfy_a_required_kind(self) -> None:
        target = obligation(
            "appeal", required=("policy_doc",), evidence=(("policy_doc", False),)
        )
        result = adjudicate(
            {"obligations": [target], "transition": {"obligationId": "appeal", "to": "evidenced"}}
        )
        assert result["allowed"] is False
        assert result["code"] == "MISSING_EVIDENCE"

    def test_verified_evidence_allows_the_transition(self) -> None:
        target = obligation(
            "appeal", required=("policy_doc",), evidence=(("policy_doc", True),)
        )
        result = adjudicate(
            {"obligations": [target], "transition": {"obligationId": "appeal", "to": "evidenced"}}
        )
        assert result["allowed"] is True
        assert result["code"] == "OK"
        assert result["fromState"] == "drafted"

    def test_a_transition_absent_from_the_table_is_refused_by_name(self) -> None:
        target = obligation("a", state="drafted")
        result = adjudicate(
            {"obligations": [target], "transition": {"obligationId": "a", "to": "ratified"}}
        )
        assert result["allowed"] is False
        assert result["code"] == "ILLEGAL_TRANSITION"
        assert "only legal moves" in result["detail"]

    def test_rejected_cannot_jump_straight_back_to_ratified(self) -> None:
        target = obligation("a", state="rejected")
        result = adjudicate(
            {"obligations": [target], "transition": {"obligationId": "a", "to": "ratified"}}
        )
        assert result["code"] == "ILLEGAL_TRANSITION"

    def test_challenged_needs_someone_actually_contesting(self) -> None:
        target = obligation("a", state="evidenced")
        result = adjudicate(
            {"obligations": [target], "transition": {"obligationId": "a", "to": "challenged"}}
        )
        assert result["code"] == "NEEDS_CONTESTANT"

    def test_challenged_is_allowed_once_a_contestant_is_recorded(self) -> None:
        target = obligation("a", state="evidenced", contested_by=("worker_council",))
        result = adjudicate(
            {"obligations": [target], "transition": {"obligationId": "a", "to": "challenged"}}
        )
        assert result["allowed"] is True

    def test_arbitrated_needs_an_arbitration_reference(self) -> None:
        target = obligation("a", state="challenged", contested_by=("council",))
        result = adjudicate(
            {"obligations": [target], "transition": {"obligationId": "a", "to": "arbitrated"}}
        )
        assert result["code"] == "NEEDS_ARBITRATION"

    def test_deferring_without_a_date_is_refused(self) -> None:
        target = obligation("a", state="evidenced")
        result = adjudicate(
            {"obligations": [target], "transition": {"obligationId": "a", "to": "deferred"}}
        )
        assert result["code"] == "NEEDS_DEFERRAL_DATE"

    def test_deferring_with_a_date_is_allowed(self) -> None:
        target = obligation("a", state="evidenced", defer_until=1800000000)
        result = adjudicate(
            {"obligations": [target], "transition": {"obligationId": "a", "to": "deferred"}}
        )
        assert result["allowed"] is True

    def test_rejecting_needs_a_recorded_reason(self) -> None:
        target = obligation("a", state="evidenced")
        result = adjudicate(
            {"obligations": [target], "transition": {"obligationId": "a", "to": "rejected"}}
        )
        assert result["code"] == "NEEDS_REJECTION_REF"

    def test_only_the_claimant_may_withdraw(self) -> None:
        target = obligation("a", claimant="operator")
        result = adjudicate(
            {
                "obligations": [target],
                "transition": {"obligationId": "a", "to": "withdrawn", "by": "reviewer"},
            }
        )
        assert result["code"] == "WRONG_PARTY"

    def test_the_claimant_may_withdraw(self) -> None:
        target = obligation("a", claimant="operator")
        result = adjudicate(
            {
                "obligations": [target],
                "transition": {"obligationId": "a", "to": "withdrawn", "by": "operator"},
            }
        )
        assert result["allowed"] is True

    def test_critical_severity_needs_a_named_override(self) -> None:
        target = obligation("a", state="evidenced", severity=5)
        result = adjudicate(
            {"obligations": [target], "transition": {"obligationId": "a", "to": "ratified"}}
        )
        assert result["code"] == "NEEDS_OVERRIDE"

    def test_critical_severity_ratifies_once_an_override_is_named(self) -> None:
        target = obligation("a", state="evidenced", severity=5, override_ref="dana@board")
        result = adjudicate(
            {"obligations": [target], "transition": {"obligationId": "a", "to": "ratified"}}
        )
        assert result["allowed"] is True

    def test_an_override_may_be_proposed_with_the_transition(self) -> None:
        # The reviewer supplies the name in the same breath as the move, rather than having to
        # write it to the record just to ask the question.
        target = obligation("a", state="evidenced", severity=5)
        result = adjudicate(
            {
                "obligations": [target],
                "transition": {
                    "obligationId": "a",
                    "to": "ratified",
                    "overrideRef": "dana@board",
                },
            }
        )
        assert result["allowed"] is True
        assert result["code"] == "OK"

    def test_severity_four_does_not_need_an_override(self) -> None:
        target = obligation("a", state="evidenced", severity=4)
        result = adjudicate(
            {"obligations": [target], "transition": {"obligationId": "a", "to": "ratified"}}
        )
        assert result["allowed"] is True

    def test_unknown_obligation_is_named(self) -> None:
        result = adjudicate(
            {"obligations": [obligation("a")], "transition": {"obligationId": "zzz", "to": "ratified"}}
        )
        assert result["code"] == "UNKNOWN_OBLIGATION"

    def test_unknown_target_state_is_named(self) -> None:
        result = adjudicate(
            {"obligations": [obligation("a")], "transition": {"obligationId": "a", "to": "shipped"}}
        )
        assert result["code"] == "UNKNOWN_STATE"

    def test_reports_the_next_obligation_to_work(self) -> None:
        obligations = [
            obligation("low", severity=1),
            obligation("high", severity=5),
        ]
        result = adjudicate(
            {"obligations": obligations, "transition": {"obligationId": "low", "to": "withdrawn"}}
        )
        assert result["nextObligationId"] == "high"
        assert result["nextObligationState"] == "evidenced"


# --------------------------------------------------------------------------- queue


class TestQueue:
    def test_empty_case_has_no_head(self) -> None:
        result = queue({"obligations": []})
        assert result["head"] == ""
        assert result["count"] == 0
        assert sum(result["byState"].values()) == 0

    def test_orders_by_open_weight_then_state_rank_then_id(self) -> None:
        obligations = [
            obligation("z", severity=3),
            obligation("a", severity=3),
            obligation("critical", severity=5),
            obligation("settled", severity=5, state="ratified"),
        ]
        result = queue({"obligations": obligations})
        # The ratified obligation contributes zero open weight so it sorts last regardless.
        assert [item["id"] for item in result["items"]] == ["critical", "a", "z", "settled"]

    def test_head_is_the_first_unsettled_row(self) -> None:
        obligations = [
            obligation("done", severity=5, state="ratified"),
            obligation("todo", severity=2),
        ]
        assert queue({"obligations": obligations})["head"] == "todo"

    def test_annotates_each_row_with_its_blocking_codes(self) -> None:
        result = queue({"obligations": [obligation("a", required=("policy_doc",))]})
        assert result["items"][0]["blockedBy"] == ["MISSING_EVIDENCE"]

    def test_settled_rows_carry_no_blocking_codes(self) -> None:
        result = queue({"obligations": [obligation("a", state="ratified")]})
        assert result["items"][0]["blockedBy"] == []
        assert result["items"][0]["settled"] is True

    def test_by_state_counts_every_known_state(self) -> None:
        result = queue({"obligations": [obligation("a")]})
        assert len(result["byState"]) == 8
        assert result["byState"]["drafted"] == 1


# --------------------------------------------------------------------------- review


class TestReview:
    def test_empty_case_is_ratifiable_only_as_a_non_case(self) -> None:
        result = review({"obligations": []})
        assert result["phase"] == "empty"
        assert result["caseRatifiable"] is False

    def test_a_fully_ratified_case_is_ratifiable(self) -> None:
        result = review({"obligations": [obligation("a", state="ratified"), obligation("b", state="ratified")]})
        assert result["phase"] == "ratified"
        assert result["caseRatifiable"] is True
        assert result["nextAction"] == "sign off: every obligation is settled"

    def test_an_unsettled_obligation_blocks_sign_off(self) -> None:
        result = review({"obligations": [obligation("a", state="ratified"), obligation("b")]})
        assert result["caseRatifiable"] is False
        assert result["caseBlocking"][0]["code"] == "NOTHING_TO_RATIFY"
        assert "b" in result["nextAction"]

    def test_critical_ratified_without_override_blocks_sign_off(self) -> None:
        result = review({"obligations": [obligation("a", state="ratified", severity=5)]})
        assert result["caseBlocking"][0]["code"] == "NEEDS_OVERRIDE"

    def test_phase_reports_contention_first(self) -> None:
        result = review({"obligations": [obligation("a"), obligation("b", state="challenged")]})
        assert result["phase"] == "contested"

    def test_phase_ready_when_everything_is_evidenced(self) -> None:
        result = review({"obligations": [obligation("a", state="evidenced")]})
        assert result["phase"] == "ready"

    def test_phase_closed_when_mixed_settled_states(self) -> None:
        result = review(
            {"obligations": [obligation("a", state="ratified"), obligation("b", state="rejected")]}
        )
        assert result["phase"] == "closed"

    def test_settled_count_is_reported(self) -> None:
        result = review({"obligations": [obligation("a", state="ratified"), obligation("b")]})
        assert result["settled"] == 1
        assert result["total"] == 2


# --------------------------------------------------------------------------- liability


class TestLiabilitySplit:
    def test_nothing_outstanding_yields_no_shares(self) -> None:
        result = liability_split({"obligations": [obligation("a", state="ratified")]})
        assert result["totalWeight"] == 0
        assert result["shares"] == []
        assert result["concentration"] == 0.0

    def test_a_single_party_takes_the_whole_share(self) -> None:
        result = liability_split({"obligations": [obligation("a", claimant="operator")]})
        assert len(result["shares"]) == 1
        assert result["shares"][0]["micro"] == MICRO
        assert result["shares"][0]["share"] == 1.0

    def test_shares_are_sorted_by_size_then_name(self) -> None:
        obligations = [
            obligation("a", severity=1, claimant="vendor"),
            obligation("b", severity=5, claimant="operator"),
            obligation("c", severity=3, claimant="operator"),
        ]
        result = liability_split({"obligations": obligations})
        assert [share["party"] for share in result["shares"]] == ["operator", "vendor"]

    def test_ratified_obligations_contribute_no_weight(self) -> None:
        obligations = [
            obligation("a", severity=5, claimant="operator"),
            obligation("b", severity=5, claimant="vendor", state="ratified"),
        ]
        result = liability_split({"obligations": obligations})
        assert [share["party"] for share in result["shares"]] == ["operator"]


# --------------------------------------------------------------------------- exposure


class TestResidualExposure:
    def test_no_open_obligations_scores_zero(self) -> None:
        result = residual_exposure({"obligations": [obligation("a", state="ratified")]})
        assert result["score"] == 0
        assert result["openWeight"] == 0
        assert result["drivers"] == []

    def test_score_is_bounded(self) -> None:
        obligations = [obligation(f"o{i}", severity=5) for i in range(200)]
        result = residual_exposure({"obligations": obligations})
        assert 0 <= result["score"] <= 100

    def test_more_open_weight_never_lowers_the_score(self) -> None:
        light = residual_exposure({"obligations": [obligation("a", severity=1)]})["score"]
        heavy = residual_exposure({"obligations": [obligation("a", severity=5)]})["score"]
        assert heavy > light

    def test_drivers_are_listed_in_queue_order(self) -> None:
        obligations = [obligation("low", severity=1), obligation("high", severity=5)]
        result = residual_exposure({"obligations": obligations})
        assert [driver["id"] for driver in result["drivers"]] == ["high", "low"]

    def test_max_severity_reflects_only_open_obligations(self) -> None:
        obligations = [
            obligation("open", severity=2),
            obligation("done", severity=5, state="ratified"),
        ]
        assert residual_exposure({"obligations": obligations})["maxSeverity"] == 2


# --------------------------------------------------------------------------- golden


class TestGolden:
    """The anti-drift test: a known case must produce byte-identical output."""

    def test_matches_the_recorded_golden_file(self) -> None:
        recorded = json.loads(GOLDEN.read_text(encoding="utf8"))
        for call in recorded["calls"]:
            actual = adjudicate({"obligations": call["obligations"], "transition": call["transition"]})
            assert actual == call["expected"], f"drift in call {call['name']}"

    def test_the_golden_file_is_loadable_and_covers_several_calls(self) -> None:
        recorded = json.loads(GOLDEN.read_text(encoding="utf8"))
        assert len(recorded["calls"]) >= 4
        assert {call["name"] for call in recorded["calls"]} >= {"legal", "missing_evidence"}


# --------------------------------------------------------------------------- properties


PARTIES = st.sampled_from(["operator", "vendor", "worker_council", "regulator"])
KINDS = st.sampled_from(["appeal_path", "consent", "incident_channel", "data_retention"])
NON_SETTLED = st.sampled_from(["drafted", "evidenced", "challenged", "arbitrated", "deferred"])


@st.composite
def any_obligation(draw: st.DrawFn) -> dict[str, Any]:
    kind = draw(KINDS)
    required = draw(st.lists(st.sampled_from(["policy_doc", "appeal_channel", "log_export"]), unique=True))
    evidence = [
        {"kind": kind_name, "verified": draw(st.booleans())} for kind_name in required
    ]
    return obligation(
        draw(st.text(min_size=1, max_size=4, alphabet="abcdef")),
        kind=kind,
        severity=draw(st.integers(min_value=1, max_value=5)),
        claimant=draw(PARTIES),
        state=draw(st.sampled_from(["drafted", "evidenced", "challenged", "arbitrated", "ratified", "rejected", "deferred", "withdrawn"])),
        required=tuple(required),
        evidence=tuple((entry["kind"], bool(entry["verified"])) for entry in evidence),
        contested_by=draw(st.lists(PARTIES, unique=True, max_size=2)),
        arbitration_ref=draw(st.sampled_from(["", "ruling-42"])),
        defer_until=draw(st.sampled_from([None, 1800000000])),
        rejection_ref=draw(st.sampled_from(["", "reason-7"])),
        override_ref=draw(st.sampled_from(["", "dana@board"])),
    )


@st.composite
def obligation_list(draw: st.DrawFn) -> list[dict[str, Any]]:
    return draw(st.lists(any_obligation(), max_size=8, unique_by=lambda item: item["id"]))


class TestProperties:
    """The two invariants the product's credibility rests on."""

    @settings(max_examples=200, deadline=None)
    @given(obligations=obligation_list())
    def test_conservation_micro_units_sum_to_the_unit_exactly(
        self, obligations: list[dict[str, Any]]
    ) -> None:
        result = liability_split({"obligations": obligations})
        if result["totalWeight"] == 0:
            assert result["shares"] == []
            return
        assert sum(int(share["micro"]) for share in result["shares"]) == MICRO

    @settings(max_examples=200, deadline=None)
    @given(obligations=obligation_list())
    def test_every_share_is_a_valid_fraction(
        self, obligations: list[dict[str, Any]]
    ) -> None:
        result = liability_split({"obligations": obligations})
        for share in result["shares"]:
            assert 0 < int(share["micro"]) <= MICRO

    @settings(max_examples=200, deadline=None)
    @given(base=obligation_list(), extra=any_obligation())
    def test_adding_an_open_obligation_never_lowers_the_score(
        self, base: list[dict[str, Any]], extra: dict[str, Any]
    ) -> None:
        extra = {**extra, "id": "added-" + extra["id"], "state": "drafted"}
        before = residual_exposure({"obligations": base})["score"]
        after = residual_exposure({"obligations": [*base, extra]})["score"]
        assert after >= before

    @settings(max_examples=200, deadline=None)
    @given(obligations=obligation_list())
    def test_the_score_is_always_within_bounds(self, obligations: list[dict[str, Any]]) -> None:
        score = residual_exposure({"obligations": obligations})["score"]
        assert 0 <= score <= 100

    @settings(max_examples=150, deadline=None)
    @given(obligations=obligation_list())
    def test_ordering_the_input_does_not_change_any_answer(
        self, obligations: list[dict[str, Any]]
    ) -> None:
        forward = queue({"obligations": obligations})
        backward = queue({"obligations": list(reversed(obligations))})
        assert forward == backward

    @settings(max_examples=150, deadline=None)
    @given(obligations=obligation_list(), index=st.integers(min_value=0))
    def test_adjudication_is_a_pure_function_of_its_input(
        self, obligations: list[dict[str, Any]], index: int
    ) -> None:
        if not obligations:
            return
        target = obligations[index % len(obligations)]
        states = ["drafted", "evidenced", "challenged", "ratified", "rejected", "deferred"]
        to_state = states[index % len(states)]
        call = {"obligations": obligations, "transition": {"obligationId": target["id"], "to": to_state}}
        assert adjudicate(call) == adjudicate(call)

    @settings(max_examples=150, deadline=None)
    @given(obligations=obligation_list())
    def test_an_allowed_transition_has_no_gates_and_a_gate_refusal_has_gates(
        self, obligations: list[dict[str, Any]]
    ) -> None:
        if not obligations:
            return
        target = obligations[0]
        result = adjudicate(
            {
                "obligations": obligations,
                "transition": {"obligationId": target["id"], "to": NATURAL_TARGET},
            }
        )
        if result["allowed"]:
            assert result["blockingGates"] == []
        elif result["code"] not in STRUCTURAL_REFUSALS:
            # A structural refusal is about the graph itself and has no evidence gate to
            # report. Every other refusal must say exactly which artefact is missing.
            assert result["blockingGates"]

    @settings(max_examples=150, deadline=None)
    @given(obligations=obligation_list())
    def test_a_ratifiable_case_has_no_blocking_gates(
        self, obligations: list[dict[str, Any]]
    ) -> None:
        result = review({"obligations": obligations})
        assert result["caseRatifiable"] == (bool(obligations) and not result["caseBlocking"])


# A target used by one property above; drafted -> evidenced is the most common first move.
NATURAL_TARGET = "evidenced"

#: Refusals that come from the shape of the graph rather than from absent evidence, and so
#: legitimately carry no gate.
STRUCTURAL_REFUSALS = frozenset({"ILLEGAL_TRANSITION", "UNKNOWN_OBLIGATION", "UNKNOWN_STATE"})
