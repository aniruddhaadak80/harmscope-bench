"""Operation dispatch for the deterministic engine.

Every operation is a pure function from one JSON value to another. There is no server, no
port, and no state that survives a call, so two concurrent invocations cannot interfere.

The operations are the product. There is deliberately no operation that returns an ethical
judgement — only operations that return a refusal with a named reason, or an arithmetic
result that a reviewer can check by hand.
"""

from __future__ import annotations

from typing import Any, Final

from .adjudication import (
    adjudicate,
    liability_split,
    queue,
    residual_exposure,
    review,
)
from .protocol import EngineError

#: op name -> implementation. The TS side mirrors these names in the tool registry.
OPERATIONS: Final[dict[str, Any]] = {
    "adjudicate": adjudicate,
    "queue": queue,
    "review": review,
    "liability_split": liability_split,
    "residual_exposure": residual_exposure,
}


def analyse(op: str, payload: Any) -> Any:
    handler = OPERATIONS.get(op)
    if handler is None:
        known = ", ".join(sorted(OPERATIONS))
        raise EngineError("UNKNOWN_OP", f"unknown op {op!r}; available: {known}")
    return handler(payload)
