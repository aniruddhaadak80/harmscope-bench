import { describe, expect, it } from 'vitest'
import { ValidationError } from '@harmscopebench/core'
import { CaseStore } from './cases.js'
import { LATEST_VERSION, Store } from './store.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function seeded(now = 1_700_000_000_000): CaseStore {
  const store = new CaseStore()
  store.createCase({ id: 'c1', title: 'Triage assistant rollout', systemName: 'triage-assist', now })
  store.addObligation(
    'c1',
    {
      id: 'appeal',
      kind: 'appeal_path',
      severity: 4,
      claimant: 'operator',
      requiredEvidence: ['policy_doc'],
    },
    now,
  )
  store.addObligation(
    'c1',
    { id: 'consent', kind: 'consent', severity: 3, claimant: 'operator', requiredEvidence: [] },
    now,
  )
  return store
}

describe('migrations', () => {
  it('migrates an empty database to the latest version', () => {
    const store = new Store(':memory:')
    expect(store.version).toBe(LATEST_VERSION)
    expect(store.isPending).toBe(false)
  })

  it('is idempotent when run repeatedly', () => {
    const store = new Store(':memory:')
    store.migrate()
    store.migrate()
    expect(store.version).toBe(LATEST_VERSION)
  })

  it('reports no pending migrations after construction', () => {
    const store = new Store(':memory:')
    expect(store.isPending).toBe(false)
  })

  it('upgrades a v2 database in place rather than rebuilding it', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'harmscope-')), 'bench.db')
    try {
      // Simulate a database created before the review domain existed.
      const legacy = new Store(path)
      legacy.raw.pragma('user_version = 2')
      legacy.close()

      const upgraded = new Store(path)
      expect(upgraded.version).toBe(LATEST_VERSION)
      const tables = upgraded.raw
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'obligations'")
        .all()
      expect(tables).toHaveLength(1)
      upgraded.close()
    } finally {
      rmSync(join(path, '..'), { recursive: true, force: true })
    }
  })
})

describe('cases', () => {
  it('creates a case and reads it back', () => {
    const store = seeded()
    expect(store.getCase('c1')?.title).toBe('Triage assistant rollout')
    expect(store.getCase('missing')).toBeUndefined()
  })

  it('rejects an empty case id', () => {
    const store = new CaseStore()
    expect(() => store.createCase({ id: '  ', title: 'x', systemName: 'y', now: 1 })).toThrow(ValidationError)
  })

  it('lists obligations in drafting order', () => {
    const store = seeded()
    expect(store.listObligations('c1').map((o) => o.id)).toEqual(['appeal', 'consent'])
  })
})

describe('obligations', () => {
  it('starts every obligation in drafted', () => {
    const store = seeded()
    expect(store.listObligations('c1').every((o) => o.state === 'drafted')).toBe(true)
  })

  it.each([0, 6, -1, 2.5])('rejects severity %s', (severity) => {
    const store = seeded()
    expect(() =>
      store.addObligation('c1', { id: `x${severity}`, kind: 'k', severity, claimant: 'operator' }, 1),
    ).toThrow(ValidationError)
  })

  it('rejects a duplicate obligation id', () => {
    const store = seeded()
    expect(() =>
      store.addObligation('c1', { id: 'appeal', kind: 'k', severity: 1, claimant: 'operator' }, 1),
    ).toThrow(/already exists in case c1/)
  })

  it('rejects an obligation for an unknown case', () => {
    const store = seeded()
    expect(() =>
      store.addObligation('nope', { id: 'x', kind: 'k', severity: 1, claimant: 'operator' }, 1),
    ).toThrow(/does not exist/)
  })

  it('lets two different cases use the same obligation id', () => {
    // Two deployments will both have an `appeal` obligation. A globally unique obligation id
    // made that impossible, which is why migration 4 scoped the primary key to the case.
    const store = seeded()
    store.createCase({ id: 'c2', title: 'Second review', systemName: 'other', now: 1 })
    const other = store.addObligation(
      'c2',
      { id: 'appeal', kind: 'appeal_path', severity: 2, claimant: 'operator' },
      1,
    )
    expect(other.caseId).toBe('c2')
    expect(store.getObligation('c1', 'appeal')?.severity).toBe(4)
    expect(store.getObligation('c2', 'appeal')?.severity).toBe(2)
  })

  it('keeps evidence for the same kind separate per case', () => {
    const store = seeded()
    store.createCase({ id: 'c2', title: 'Second review', systemName: 'other', now: 1 })
    store.addObligation(
      'c2',
      {
        id: 'appeal',
        kind: 'appeal_path',
        severity: 2,
        claimant: 'operator',
        requiredEvidence: ['policy_doc'],
      },
      1,
    )
    store.addEvidence({ caseId: 'c1', obligationId: 'appeal', kind: 'policy_doc', ref: 'a.md' }, 1)
    store.addEvidence({ caseId: 'c2', obligationId: 'appeal', kind: 'policy_doc', ref: 'b.md' }, 1)
    expect(store.getObligation('c1', 'appeal')?.evidence).toHaveLength(1)
    expect(store.getObligation('c1', 'appeal')?.evidence[0]?.ref).toBe('a.md')
    expect(store.getObligation('c2', 'appeal')?.evidence[0]?.ref).toBe('b.md')
  })

  it('applies a state the engine has approved', () => {
    const store = seeded()
    store.applyState('c1', 'appeal', 'evidenced', 2)
    expect(store.getObligation('c1', 'appeal')?.state).toBe('evidenced')
  })

  it('refuses to apply a state that is not a real state', () => {
    const store = seeded()
    expect(() => store.applyState('c1', 'appeal', 'shipped' as never, 2)).toThrow(/not a valid/)
  })
})

describe('evidence', () => {
  it('is stored unverified by default', () => {
    const store = seeded()
    store.addEvidence({ caseId: 'c1', obligationId: 'appeal', kind: 'policy_doc', ref: 'docs/policy.md' }, 1)
    expect(store.getObligation('c1', 'appeal')?.evidence).toEqual([
      { kind: 'policy_doc', ref: 'docs/policy.md', verified: false },
    ])
  })

  it('can be verified, which is what satisfies a gate', () => {
    const store = seeded()
    store.addEvidence({ caseId: 'c1', obligationId: 'appeal', kind: 'policy_doc', ref: 'docs/policy.md' }, 1)
    expect(store.verifyEvidence('c1', 'appeal', 'policy_doc', 2)).toBe(true)
    expect(store.getObligation('c1', 'appeal')?.evidence[0]?.verified).toBe(true)
  })

  it('reports false when there is nothing to verify', () => {
    const store = seeded()
    expect(store.verifyEvidence('c1', 'appeal', 'never_added', 2)).toBe(false)
  })

  it('rejects evidence for an unknown obligation', () => {
    const store = seeded()
    expect(() => store.addEvidence({ caseId: 'c1', obligationId: 'ghost', kind: 'k', ref: 'r' }, 1)).toThrow(
      /does not exist/,
    )
  })
})

describe('contestants', () => {
  it('accumulates and de-duplicates, sorted for determinism', () => {
    const store = seeded()
    store.addContestant('c1', 'appeal', 'worker_council', 1)
    store.addContestant('c1', 'appeal', 'regulator', 2)
    store.addContestant('c1', 'appeal', 'worker_council', 3)
    expect(store.getObligation('c1', 'appeal')?.contestedBy).toEqual(['regulator', 'worker_council'])
  })
})

describe('attempts', () => {
  it('records refused attempts as well as allowed ones', () => {
    const store = seeded()
    store.recordAttempt(
      {
        caseId: 'c1',
        obligationId: 'appeal',
        fromState: 'drafted',
        toState: 'evidenced',
        allowed: false,
        code: 'MISSING_EVIDENCE',
        actor: 'reviewer',
      },
      10,
    )
    store.recordAttempt(
      {
        caseId: 'c1',
        obligationId: 'consent',
        fromState: 'drafted',
        toState: 'withdrawn',
        allowed: true,
        code: 'OK',
      },
      11,
    )
    const trail = store.attemptsFor('c1')
    expect(trail).toHaveLength(2)
    expect(trail.map((row) => row.allowed)).toEqual([1, 0])
  })

  it('returns newest first', () => {
    const store = seeded()
    store.recordAttempt(
      {
        caseId: 'c1',
        obligationId: 'a',
        fromState: 'drafted',
        toState: 'evidenced',
        allowed: false,
        code: 'X',
      },
      1,
    )
    store.recordAttempt(
      {
        caseId: 'c1',
        obligationId: 'b',
        fromState: 'drafted',
        toState: 'evidenced',
        allowed: false,
        code: 'Y',
      },
      2,
    )
    expect(store.attemptsFor('c1')[0]?.obligation_id).toBe('b')
  })
})

describe('engine payload', () => {
  it('emits exactly the shape the engine consumes', () => {
    const store = seeded()
    store.addEvidence({ caseId: 'c1', obligationId: 'appeal', kind: 'policy_doc', ref: 'docs/policy.md' }, 1)
    store.verifyEvidence('c1', 'appeal', 'policy_doc', 2)
    const [appeal] = store.enginePayload('c1')
    expect(appeal).toEqual({
      id: 'appeal',
      kind: 'appeal_path',
      severity: 4,
      claimant: 'operator',
      state: 'drafted',
      requiredEvidence: ['policy_doc'],
      evidence: [{ kind: 'policy_doc', ref: 'docs/policy.md', verified: true }],
      contestedBy: [],
    })
  })

  it('omits unset optional references rather than sending nulls', () => {
    const store = seeded()
    const [appeal] = store.enginePayload('c1')
    expect(appeal).not.toHaveProperty('arbitrationRef')
    expect(appeal).not.toHaveProperty('deferUntil')
  })

  it('includes a reference once it is set', () => {
    const store = seeded()
    store.setObligationRefs('c1', 'appeal', { arbitrationRef: 'ruling-42' }, 1)
    expect(store.enginePayload('c1')[0]?.arbitrationRef).toBe('ruling-42')
  })
})

describe('lifecycle', () => {
  it('closes a case with a terminal status', () => {
    const store = seeded()
    store.closeCase('c1', 'closed', 5)
    expect(store.getCase('c1')?.status).toBe('closed')
  })

  it('bumps the case timestamp when an obligation changes', () => {
    const store = seeded(1)
    store.applyState('c1', 'appeal', 'evidenced', 9_999)
    expect(store.getCase('c1')?.updated_at).toBe(9_999)
  })
})
