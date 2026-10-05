import type { EvidenceItem, Obligation, ObligationState } from '@harmscopebench/core'
import { MAX_SEVERITY, MIN_SEVERITY, ValidationError, isObligationState } from '@harmscopebench/core'
import type Database from 'better-sqlite3'
import { Store } from './store.js'

export interface CaseRow {
  id: string
  title: string
  system_name: string
  status: string
  created_at: number
  updated_at: number
}

export interface AttemptRow {
  id: number
  case_id: string
  obligation_id: string
  from_state: string
  to_state: string
  allowed: number
  code: string
  actor: string
  at: number
}

/** An obligation joined with its evidence, which is what the engine actually consumes. */
export interface ObligationView extends Obligation {
  readonly caseId: string
  readonly position: number
  readonly evidence: readonly EvidenceItem[]
}

/** The raw SQLite row. Snake case columns; the view above is what callers should see. */
interface ObligationRow {
  id: string
  case_id: string
  kind: string
  severity: number
  claimant: string
  state: string
  required_evidence: string
  contested_by: string
  arbitration_ref: string | null
  defer_until: number | null
  rejection_ref: string | null
  override_ref: string | null
  position: number
  created_at: number
  updated_at: number
}

export interface NewObligation {
  readonly id: string
  readonly kind: string
  readonly severity: number
  readonly claimant: string
  readonly requiredEvidence?: readonly string[]
}

/** Serialised list columns are a deliberate choice: SQLite has no array type. */
function encodeList(values: readonly string[]): string {
  return JSON.stringify([...values])
}

function decodeList(value: string, field: string, id: string): readonly string[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    throw new ValidationError(`${id}.${field} is not valid JSON`, { id, field })
  }
  if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== 'string')) {
    throw new ValidationError(`${id}.${field} must be a JSON array of strings`, { id, field })
  }
  return parsed as string[]
}

/**
 * The product's store. `Store` holds the generic record/FTS tables; this adds the review
 * domain on top and is the only thing that writes to it.
 *
 * Every write goes through the inherited `transaction()` helper, so a rejected transition
 * cannot leave a half-applied state behind.
 */
export class CaseStore {
  readonly #store: Store

  constructor(pathOrStore: string | Store = ':memory:') {
    this.#store = typeof pathOrStore === 'string' ? new Store(pathOrStore) : pathOrStore
  }

  get schemaVersion(): number {
    return this.#store.version
  }

  get migrationsPending(): boolean {
    return this.#store.isPending
  }

  /** Bump a case's modified time. Called from inside the caller's transaction. */
  touchCase(caseId: string, now: number): void {
    this.#store.raw.prepare('UPDATE cases SET updated_at = ? WHERE id = ?').run(now, caseId)
  }

  /** Direct database access, for callers that need a query the API does not expose. */
  get raw(): Database.Database {
    return this.#store.raw
  }

  // ------------------------------------------------------------------ cases

  createCase(input: { id: string; title: string; systemName: string; now: number }): CaseRow {
    const { id, title, systemName, now } = input
    if (!id.trim()) throw new ValidationError('case id must not be empty', { field: 'id' })
    if (!title.trim()) throw new ValidationError('case title must not be empty', { field: 'title' })
    return this.#store.transaction(() => {
      this.#store.raw
        .prepare(
          `INSERT INTO cases (id, title, system_name, status, created_at, updated_at)
           VALUES (?, ?, ?, 'open', ?, ?)`,
        )
        .run(id, title, systemName, now, now)
      return this.getCase(id) as CaseRow
    })
  }

  getCase(id: string): CaseRow | undefined {
    return this.#store.raw.prepare('SELECT * FROM cases WHERE id = ?').get(id) as CaseRow | undefined
  }

  listCases(limit = 50): readonly CaseRow[] {
    return this.#store.raw
      .prepare('SELECT * FROM cases ORDER BY updated_at DESC LIMIT ?')
      .all(limit) as CaseRow[]
  }

  // ------------------------------------------------------------------ obligations

  /** The next free ordering slot, so obligations keep the order they were drafted in. */
  #nextPosition(caseId: string): number {
    const row = this.#store.raw
      .prepare('SELECT COALESCE(MAX(position), -1) AS last FROM obligations WHERE case_id = ?')
      .get(caseId) as { last: number }
    return (row?.last ?? -1) + 1
  }

  addObligation(caseId: string, input: NewObligation, now: number): ObligationView {
    const { id, kind, severity, claimant } = input
    if (!id.trim()) throw new ValidationError('obligation id must not be empty', { field: 'id' })
    if (!Number.isInteger(severity) || severity < MIN_SEVERITY || severity > MAX_SEVERITY) {
      throw new ValidationError(
        `obligation severity must be an integer in ${MIN_SEVERITY}..${MAX_SEVERITY}`,
        { id, severity },
      )
    }
    if (this.getCase(caseId) === undefined) {
      throw new ValidationError(`case ${caseId} does not exist`, { caseId })
    }
    const clash = this.#store.raw
      .prepare('SELECT 1 FROM obligations WHERE case_id = ? AND id = ?')
      .get(caseId, id)
    if (clash !== undefined) {
      throw new ValidationError(`obligation ${id} already exists in case ${caseId}`, { id, caseId })
    }
    const required = input.requiredEvidence ?? []

    return this.#store.transaction(() => {
      this.#store.raw
        .prepare(
          `INSERT INTO obligations
             (case_id, id, kind, severity, claimant, state, required_evidence, contested_by,
              position, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'drafted', ?, '[]', ?, ?, ?)`,
        )
        .run(caseId, id, kind, severity, claimant, encodeList(required), this.#nextPosition(caseId), now, now)
      this.touchCase(caseId, now)
      return this.getObligation(caseId, id) as ObligationView
    })
  }

  getObligation(caseId: string, id: string): ObligationView | undefined {
    const row = this.#store.raw
      .prepare('SELECT * FROM obligations WHERE case_id = ? AND id = ?')
      .get(caseId, id) as ObligationRow | undefined
    if (row === undefined) return undefined
    return this.#toView(row)
  }

  listObligations(caseId: string): readonly ObligationView[] {
    const rows = this.#store.raw
      .prepare('SELECT * FROM obligations WHERE case_id = ? ORDER BY position')
      .all(caseId) as readonly ObligationRow[]
    return rows.map((row) => this.#toView(row))
  }

  #toView(row: ObligationRow): ObligationView {
    const evidence = this.#store.raw
      .prepare(
        'SELECT kind, ref, verified FROM evidence WHERE case_id = ? AND obligation_id = ? ORDER BY created_at',
      )
      .all(row.case_id, row.id) as readonly { kind: string; ref: string; verified: number }[]
    return {
      id: row.id,
      caseId: row.case_id,
      kind: row.kind,
      severity: row.severity,
      claimant: row.claimant,
      state: isObligationState(row.state) ? row.state : 'drafted',
      requiredEvidence: decodeList(row.required_evidence, 'requiredEvidence', row.id),
      contestedBy: decodeList(row.contested_by, 'contestedBy', row.id),
      evidence: evidence.map((item) => ({
        kind: item.kind,
        ref: item.ref,
        verified: item.verified === 1,
      })),
      position: row.position,
      ...(row.arbitration_ref !== null ? { arbitrationRef: row.arbitration_ref } : {}),
      ...(row.defer_until !== null ? { deferUntil: row.defer_until } : {}),
      ...(row.rejection_ref !== null ? { rejectionRef: row.rejection_ref } : {}),
      ...(row.override_ref !== null ? { overrideRef: row.override_ref } : {}),
    }
  }

  // ------------------------------------------------------------------ evidence

  addEvidence(
    input: { caseId: string; obligationId: string; kind: string; ref: string; verified?: boolean },
    now: number,
  ): void {
    const { caseId, obligationId, kind, ref } = input
    if (this.getObligation(caseId, obligationId) === undefined) {
      throw new ValidationError(`obligation ${obligationId} does not exist in case ${caseId}`, {
        caseId,
        obligationId,
      })
    }
    this.#store.transaction(() => {
      this.#store.raw
        .prepare(
          `INSERT INTO evidence (case_id, obligation_id, kind, ref, verified, created_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (case_id, obligation_id, kind) DO UPDATE SET
             ref = excluded.ref,
             verified = excluded.verified`,
        )
        .run(caseId, obligationId, kind, ref, input.verified === true ? 1 : 0, now)
      this.touchCase(caseId, now)
    })
  }

  verifyEvidence(caseId: string, obligationId: string, kind: string, now: number): boolean {
    return this.#store.transaction(() => {
      const result = this.#store.raw
        .prepare('UPDATE evidence SET verified = 1 WHERE case_id = ? AND obligation_id = ? AND kind = ?')
        .run(caseId, obligationId, kind)
      this.touchCase(caseId, now)
      return result.changes > 0
    })
  }

  /** Record who is contesting an obligation, without touching its state. */
  addContestant(caseId: string, obligationId: string, party: string, now: number): readonly string[] {
    const obligation = this.getObligation(caseId, obligationId)
    if (obligation === undefined) {
      throw new ValidationError(`obligation ${obligationId} does not exist in case ${caseId}`, {
        caseId,
        obligationId,
      })
    }
    const existing = new Set(obligation.contestedBy)
    existing.add(party)
    const next = [...existing].sort()
    this.#store.transaction(() => {
      this.#store.raw
        .prepare('UPDATE obligations SET contested_by = ?, updated_at = ? WHERE case_id = ? AND id = ?')
        .run(encodeList(next), now, caseId, obligationId)
      this.touchCase(caseId, now)
    })
    return next
  }

  // ------------------------------------------------------------------ transitions

  /**
   * Persist an adjudication outcome. Refused attempts are stored too — the trail of what was
   * blocked is the part an auditor actually reads.
   */
  recordAttempt(
    input: {
      caseId: string
      obligationId: string
      fromState: ObligationState | ''
      toState: string
      allowed: boolean
      code: string
      actor?: string
    },
    now: number,
  ): AttemptRow {
    return this.#store.transaction(() => {
      this.#store.raw
        .prepare(
          `INSERT INTO attempts
             (case_id, obligation_id, from_state, to_state, allowed, code, actor, at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.caseId,
          input.obligationId,
          input.fromState,
          input.toState,
          input.allowed ? 1 : 0,
          input.code,
          input.actor ?? '',
          now,
        )
      this.touchCase(input.caseId, now)
      return this.#store.raw
        .prepare('SELECT * FROM attempts WHERE id = last_insert_rowid()')
        .get() as AttemptRow
    })
  }

  /** Apply a state the engine has already approved. Never call this without that approval. */
  applyState(caseId: string, obligationId: string, to: ObligationState, now: number): void {
    if (!isObligationState(to)) {
      throw new ValidationError(`${to} is not a valid obligation state`, { to })
    }
    if (this.getObligation(caseId, obligationId) === undefined) {
      throw new ValidationError(`obligation ${obligationId} does not exist in case ${caseId}`, {
        caseId,
        obligationId,
      })
    }
    this.#store.transaction(() => {
      this.#store.raw
        .prepare('UPDATE obligations SET state = ?, updated_at = ? WHERE case_id = ? AND id = ?')
        .run(to, now, caseId, obligationId)
      this.touchCase(caseId, now)
    })
  }

  setObligationRefs(
    caseId: string,
    obligationId: string,
    refs: { arbitrationRef?: string; deferUntil?: number; rejectionRef?: string; overrideRef?: string },
    now: number,
  ): void {
    if (this.getObligation(caseId, obligationId) === undefined) {
      throw new ValidationError(`obligation ${obligationId} does not exist in case ${caseId}`, {
        caseId,
        obligationId,
      })
    }
    const columns: string[] = []
    const values: unknown[] = []
    if (refs.arbitrationRef !== undefined) {
      columns.push('arbitration_ref = ?')
      values.push(refs.arbitrationRef)
    }
    if (refs.deferUntil !== undefined) {
      columns.push('defer_until = ?')
      values.push(refs.deferUntil)
    }
    if (refs.rejectionRef !== undefined) {
      columns.push('rejection_ref = ?')
      values.push(refs.rejectionRef)
    }
    if (refs.overrideRef !== undefined) {
      columns.push('override_ref = ?')
      values.push(refs.overrideRef)
    }
    if (columns.length === 0) return
    this.#store.transaction(() => {
      this.#store.raw
        .prepare(`UPDATE obligations SET ${columns.join(', ')}, updated_at = ? WHERE case_id = ? AND id = ?`)
        .run(...values, now, caseId, obligationId)
      this.touchCase(caseId, now)
    })
  }

  attemptsFor(caseId: string, limit = 100): readonly AttemptRow[] {
    return this.#store.raw
      .prepare('SELECT * FROM attempts WHERE case_id = ? ORDER BY at DESC, id DESC LIMIT ?')
      .all(caseId, limit) as AttemptRow[]
  }

  // ------------------------------------------------------------------ lifecycle

  closeCase(id: string, status: 'closed' | 'ratified' | 'archived', now: number): void {
    this.#store.transaction(() => {
      this.#store.raw.prepare('UPDATE cases SET status = ?, updated_at = ? WHERE id = ?').run(status, now, id)
    })
  }

  close(): void {
    this.#store.close()
  }

  /** Every obligation in a case, in exactly the shape the engine's `obligations` array takes. */
  enginePayload(caseId: string): readonly Obligation[] {
    return this.listObligations(caseId).map((view) => ({
      id: view.id,
      kind: view.kind,
      severity: view.severity,
      claimant: view.claimant,
      state: view.state,
      ...(view.requiredEvidence !== undefined ? { requiredEvidence: view.requiredEvidence } : {}),
      ...(view.evidence !== undefined ? { evidence: view.evidence } : {}),
      ...(view.contestedBy !== undefined ? { contestedBy: view.contestedBy } : {}),
      ...(view.arbitrationRef !== undefined ? { arbitrationRef: view.arbitrationRef } : {}),
      ...(view.deferUntil !== undefined ? { deferUntil: view.deferUntil } : {}),
      ...(view.rejectionRef !== undefined ? { rejectionRef: view.rejectionRef } : {}),
      ...(view.overrideRef !== undefined ? { overrideRef: view.overrideRef } : {}),
    }))
  }
}
