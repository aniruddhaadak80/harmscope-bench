/**
 * The product's domain vocabulary, mirrored from the deterministic engine.
 *
 * These are types and constants only — no logic and no I/O. The transition table and the gate
 * rules deliberately live ONLY in the Python engine: a second copy here would drift, and a
 * drifted copy is exactly the failure mode this product exists to prevent. Any surface that
 * needs to know what is legal asks the engine.
 */

/** The eight states an obligation can occupy. Mirrors `adjudication.STATES`. */
export const OBLIGATION_STATES = [
  'drafted',
  'evidenced',
  'challenged',
  'arbitrated',
  'ratified',
  'rejected',
  'deferred',
  'withdrawn',
] as const

export type ObligationState = (typeof OBLIGATION_STATES)[number]

export const SETTLED_STATES: readonly ObligationState[] = ['ratified', 'rejected', 'withdrawn']

/** States that still hold open exposure. */
export const OPEN_STATES: readonly ObligationState[] = [
  'drafted',
  'deferred',
  'evidenced',
  'challenged',
  'arbitrated',
]

export function isObligationState(value: unknown): value is ObligationState {
  return typeof value === 'string' && (OBLIGATION_STATES as readonly string[]).includes(value)
}

/**
 * Refusal codes the engine can return. A refusal always names one of these, so the UI can
 * group gate failures without string-matching prose.
 */
export const GATE_CODES = [
  'ILLEGAL_TRANSITION',
  'UNKNOWN_OBLIGATION',
  'UNKNOWN_STATE',
  'MISSING_EVIDENCE',
  'NEEDS_CONTESTANT',
  'NEEDS_ARBITRATION',
  'NEEDS_DEFERRAL_DATE',
  'NEEDS_REJECTION_REF',
  'NEEDS_OVERRIDE',
  'WRONG_PARTY',
  'NOTHING_TO_RATIFY',
] as const

export type GateCode = (typeof GATE_CODES)[number]

/**
 * Refusals that come from the shape of the state graph rather than from absent evidence.
 * They carry no gate list, because there is no missing artefact to name.
 */
export const STRUCTURAL_GATE_CODES: readonly GateCode[] = [
  'ILLEGAL_TRANSITION',
  'UNKNOWN_OBLIGATION',
  'UNKNOWN_STATE',
]

export const MIN_SEVERITY = 1
export const MAX_SEVERITY = 5
export const CRITICAL_SEVERITY = 5

export interface EvidenceItem {
  readonly kind: string
  readonly ref?: string
  readonly verified: boolean
}

/**
 * The shape the engine accepts and returns. Field names are camelCase on purpose: they cross
 * the JSON boundary unchanged, so there is no rename layer to get wrong.
 */
export interface Obligation {
  readonly id: string
  readonly kind: string
  readonly severity: number
  readonly claimant: string
  readonly state: ObligationState
  readonly requiredEvidence?: readonly string[]
  readonly evidence?: readonly EvidenceItem[]
  readonly contestedBy?: readonly string[]
  readonly arbitrationRef?: string
  readonly deferUntil?: number
  readonly rejectionRef?: string
  readonly overrideRef?: string
}

export interface TransitionRequest {
  readonly obligationId: string
  readonly to: ObligationState | string
  readonly by?: string
  readonly overrideRef?: string
}

export interface Gate {
  readonly code: GateCode
  readonly obligationId: string
  readonly detail: string
  readonly severity: number
  readonly missingEvidence: readonly string[]
}

export interface Adjudication {
  readonly allowed: boolean
  readonly code: string
  readonly detail: string
  readonly obligationId: string
  readonly fromState: ObligationState | ''
  readonly toState: string
  readonly blockingGates: readonly Gate[]
  readonly nextObligationId: string
  readonly nextObligationState: string
}

export interface QueueItem {
  readonly id: string
  readonly kind: string
  readonly claimant: string
  readonly state: ObligationState
  readonly severity: number
  readonly openWeight: number
  readonly nextState: string
  readonly blockedBy: readonly GateCode[]
  readonly settled: boolean
}

export interface QueueView {
  readonly head: string
  readonly count: number
  readonly byState: Record<string, number>
  readonly items: readonly QueueItem[]
}

export interface ReviewVerdict {
  readonly phase: string
  readonly total: number
  readonly settled: number
  readonly byState: Record<string, number>
  readonly caseRatifiable: boolean
  readonly caseBlocking: readonly Gate[]
  readonly residualExposure: number
  readonly nextAction: string
}

export interface LiabilityShare {
  readonly party: string
  readonly micro: number
  readonly share: number
  readonly weight: number
}

export interface LiabilitySplit {
  readonly totalWeight: number
  readonly apportionmentUnit: number
  readonly shares: readonly LiabilityShare[]
  readonly concentration: number
}

export interface ExposureDriver {
  readonly id: string
  readonly kind: string
  readonly state: ObligationState
  readonly severity: number
  readonly weight: number
  readonly claimant: string
}

export interface ResidualExposure {
  readonly score: number
  readonly openWeight: number
  readonly maxSeverity: number
  readonly openCount: number
  readonly drivers: readonly ExposureDriver[]
}

/** Every operation the engine exposes, mirrored so the TS side cannot invent an op name. */
export const ENGINE_OPERATIONS = [
  'adjudicate',
  'queue',
  'review',
  'liability_split',
  'residual_exposure',
] as const

export type EngineOperation = (typeof ENGINE_OPERATIONS)[number]
