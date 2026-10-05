import { mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import {
  ValidationError,
  type Adjudication,
  type LiabilitySplit,
  type ObligationState,
  type QueueView,
  type ResidualExposure,
  type ReviewVerdict,
} from '@harmscopebench/core'
import { EngineBridge } from '@harmscopebench/engine-client'
import { CaseStore, type AttemptRow } from '@harmscopebench/memory'

export const ENGINE_MODULE = 'harmscope_bench'

export interface ReviewOptions {
  /** Repository root — the engine is invoked as a module from `services/engine/src`. */
  readonly root: string
  /** SQLite path, or `:memory:`. */
  readonly database?: string
  readonly timeoutMs?: number
}

export interface MoveOutcome {
  readonly applied: boolean
  readonly adjudication: Adjudication
  /** The audit row, written whether the move was allowed or refused. */
  readonly attempt: AttemptRow
}

/**
 * The application service. It owns the only legitimate path from a user's intent to a changed
 * state, and that path always passes through the Python engine first.
 *
 * The ordering is the whole point: `recordAttempt` runs for refused moves too, so the trail
 * shows what was tried and what blocked it. A review that only records successes cannot be
 * audited.
 */
export class ReviewService {
  readonly #store: CaseStore
  readonly #bridge: EngineBridge
  readonly #root: string

  constructor(options: ReviewOptions) {
    this.#root = options.root
    const database = options.database ?? ':memory:'
    // better-sqlite3 will not create intermediate directories, and "the command failed
    // because you did not mkdir" is a terrible first-run experience.
    if (database !== ':memory:') {
      mkdirSync(dirname(resolve(database)), { recursive: true })
    }
    this.#store = new CaseStore(database)
    this.#bridge = new EngineBridge({
      module: ENGINE_MODULE,
      cwd: join(options.root, 'services', 'engine', 'src'),
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    })
  }

  get store(): CaseStore {
    return this.#store
  }

  /** A cheap liveness probe for `doctor`; does not mutate anything. */
  async engineReachable(): Promise<{ ok: boolean; detail: string }> {
    const response = await this.#bridge.invoke({ op: 'review', input: { obligations: [] } })
    return response.ok
      ? { ok: true, detail: `python engine responding in ${response.durationMs}ms` }
      : { ok: false, detail: response.error?.message ?? 'engine did not respond' }
  }

  async #obligations(caseId: string) {
    return this.#store.enginePayload(caseId)
  }

  async queue(caseId: string): Promise<QueueView> {
    return await this.#bridge.call<QueueView>({
      op: 'queue',
      input: { obligations: await this.#obligations(caseId) },
    })
  }

  async review(caseId: string): Promise<ReviewVerdict> {
    return await this.#bridge.call<ReviewVerdict>({
      op: 'review',
      input: { obligations: await this.#obligations(caseId) },
    })
  }

  async liability(caseId: string): Promise<LiabilitySplit> {
    return await this.#bridge.call<LiabilitySplit>({
      op: 'liability_split',
      input: { obligations: await this.#obligations(caseId) },
    })
  }

  async exposure(caseId: string): Promise<ResidualExposure> {
    return await this.#bridge.call<ResidualExposure>({
      op: 'residual_exposure',
      input: { obligations: await this.#obligations(caseId) },
    })
  }

  /**
   * Ask the engine whether a transition is permitted, and apply it only if it is.
   *
   * Refusals are not errors: they are the product's normal output, so this resolves with
   * `applied: false` and the gate list rather than throwing.
   */
  async move(
    caseId: string,
    obligationId: string,
    to: ObligationState,
    now: number,
    options: { by?: string; overrideRef?: string } = {},
  ): Promise<MoveOutcome> {
    const adjudication = await this.#bridge.call<Adjudication>({
      op: 'adjudicate',
      input: {
        obligations: await this.#obligations(caseId),
        transition: {
          obligationId,
          to,
          ...(options.by !== undefined ? { by: options.by } : {}),
          // The override travels WITH the proposal. The gate decides whether it is
          // acceptable; only then does anything get written to the record.
          ...(options.overrideRef !== undefined ? { overrideRef: options.overrideRef } : {}),
        },
      },
    })

    const attempt = this.#store.recordAttempt(
      {
        caseId,
        obligationId,
        fromState: adjudication.fromState,
        toState: to,
        allowed: adjudication.allowed,
        code: adjudication.code,
        ...(options.by !== undefined ? { actor: options.by } : {}),
      },
      now,
    )

    if (!adjudication.allowed) return { applied: false, adjudication, attempt }

    // Persist whatever the gate required to be on the record, then move it.
    const refs: Parameters<CaseStore['setObligationRefs']>[2] = {}
    if (options.overrideRef !== undefined) refs.overrideRef = options.overrideRef
    if (to === 'arbitrated') {
      refs.arbitrationRef = options.overrideRef ?? `auto:${attempt.id}`
    }
    if (to === 'rejected') refs.rejectionRef = options.overrideRef ?? `auto:${attempt.id}`
    if (Object.keys(refs).length > 0) this.#store.setObligationRefs(caseId, obligationId, refs, now)

    this.#store.applyState(caseId, obligationId, to, now)
    return { applied: true, adjudication, attempt }
  }

  /**
   * The portable artefact: the whole case plus the engine's own verdict on it. This is what
   * the web app renders, because Vercel cannot run the Python engine.
   */
  async snapshot(caseId: string): Promise<CaseSnapshot> {
    const record = this.#store.getCase(caseId)
    if (record === undefined) {
      throw new ValidationError(`case ${caseId} does not exist`, { caseId })
    }
    const obligations = await this.#obligations(caseId)
    const [queue, review, liability, exposure] = await Promise.all([
      this.queue(caseId),
      this.review(caseId),
      this.liability(caseId),
      this.exposure(caseId),
    ])
    return {
      case: {
        id: record.id,
        title: record.title,
        systemName: record.system_name,
        status: record.status,
        createdAt: record.created_at,
        updatedAt: record.updated_at,
      },
      obligations,
      queue,
      review,
      liability,
      exposure,
      attempts: this.#store.attemptsFor(caseId).map((row) => ({
        obligationId: row.obligation_id,
        fromState: row.from_state,
        toState: row.to_state,
        allowed: row.allowed === 1,
        code: row.code,
        actor: row.actor,
        at: row.at,
      })),
      states: OBLIGATION_STATES_FOR_UI,
    }
  }

  /** Root of the repository this service was built for. */
  get root(): string {
    return this.#root
  }

  close(): void {
    this.#store.close()
  }
}

/** Mirrors `OBLIGATION_STATES` in core, re-exported so a snapshot is self-describing. */
const OBLIGATION_STATES_FOR_UI = [
  'drafted',
  'evidenced',
  'challenged',
  'arbitrated',
  'ratified',
  'rejected',
  'deferred',
  'withdrawn',
] as const

export interface CaseSnapshot {
  readonly case: {
    readonly id: string
    readonly title: string
    readonly systemName: string
    readonly status: string
    readonly createdAt: number
    readonly updatedAt: number
  }
  readonly obligations: readonly unknown[]
  readonly queue: QueueView
  readonly review: ReviewVerdict
  readonly liability: LiabilitySplit
  readonly exposure: ResidualExposure
  readonly attempts: readonly {
    readonly obligationId: string
    readonly fromState: string
    readonly toState: string
    readonly allowed: boolean
    readonly code: string
    readonly actor: string
    readonly at: number
  }[]
  readonly states: readonly string[]
}
