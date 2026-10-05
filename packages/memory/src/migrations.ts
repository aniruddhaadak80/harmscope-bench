/**
 * Migrations are numbered, ordered, and idempotent. Never edit an applied migration —
 * append a new one. `user_version` is the source of truth for the applied prefix.
 */
export interface Migration {
  readonly version: number
  readonly name: string
  readonly up: readonly string[]
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'initial',
    up: [
      `CREATE TABLE IF NOT EXISTS records (
         id         TEXT PRIMARY KEY,
         kind       TEXT NOT NULL,
         payload    TEXT NOT NULL,
         created_at INTEGER NOT NULL,
         updated_at INTEGER NOT NULL
       )`,
      `CREATE INDEX IF NOT EXISTS records_kind_idx ON records (kind, updated_at DESC)`,
    ],
  },
  {
    version: 2,
    name: 'full_text',
    up: [
      `CREATE VIRTUAL TABLE IF NOT EXISTS records_fts USING fts5 (
         id UNINDEXED, body, tokenize = 'porter unicode61'
       )`,
    ],
  },
  {
    // The review domain. Appended, never folded into v1, so an existing database upgrades
    // in place rather than needing a rebuild.
    version: 3,
    name: 'review_domain',
    up: [
      `CREATE TABLE IF NOT EXISTS cases (
         id          TEXT PRIMARY KEY,
         title       TEXT NOT NULL,
         system_name TEXT NOT NULL,
         status      TEXT NOT NULL DEFAULT 'open',
         created_at  INTEGER NOT NULL,
         updated_at  INTEGER NOT NULL
       )`,
      `CREATE TABLE IF NOT EXISTS obligations (
         id               TEXT PRIMARY KEY,
         case_id          TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
         kind             TEXT NOT NULL,
         severity         INTEGER NOT NULL CHECK (severity BETWEEN 1 AND 5),
         claimant         TEXT NOT NULL,
         state            TEXT NOT NULL,
         required_evidence TEXT NOT NULL DEFAULT '[]',
         contested_by     TEXT NOT NULL DEFAULT '[]',
         arbitration_ref  TEXT,
         defer_until      INTEGER,
         rejection_ref    TEXT,
         override_ref     TEXT,
         position         INTEGER NOT NULL,
         created_at       INTEGER NOT NULL,
         updated_at       INTEGER NOT NULL
       )`,
      `CREATE INDEX IF NOT EXISTS obligations_case_idx
         ON obligations (case_id, position)`,
      `CREATE INDEX IF NOT EXISTS obligations_state_idx ON obligations (case_id, state)`,
      `CREATE TABLE IF NOT EXISTS evidence (
         id            TEXT PRIMARY KEY,
         obligation_id TEXT NOT NULL REFERENCES obligations(id) ON DELETE CASCADE,
         kind          TEXT NOT NULL,
         ref           TEXT NOT NULL,
         verified      INTEGER NOT NULL DEFAULT 0,
         created_at    INTEGER NOT NULL
       )`,
      `CREATE INDEX IF NOT EXISTS evidence_obligation_idx ON evidence (obligation_id)`,
      // The audit trail. Every adjudication attempt is recorded, including the refused ones:
      // a review is only credible if you can show what was tried and what stopped it.
      `CREATE TABLE IF NOT EXISTS attempts (
         id            INTEGER PRIMARY KEY AUTOINCREMENT,
         case_id       TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
         obligation_id TEXT NOT NULL,
         from_state    TEXT NOT NULL,
         to_state      TEXT NOT NULL,
         allowed       INTEGER NOT NULL,
         code          TEXT NOT NULL,
         actor         TEXT NOT NULL DEFAULT '',
         at            INTEGER NOT NULL
       )`,
      `CREATE INDEX IF NOT EXISTS attempts_case_idx ON attempts (case_id, at DESC)`,
      `CREATE INDEX IF NOT EXISTS attempts_obligation_idx ON attempts (obligation_id, at DESC)`,
    ],
  },
  {
    // Obligation ids are only unique WITHIN a case. Two different deployments will both have
    // an `appeal` obligation, and a global primary key made that impossible. Appended rather
    // than folded into v3 so an existing database upgrades in place.
    version: 4,
    name: 'scope_obligation_ids_to_case',
    up: [
      `PRAGMA foreign_keys = OFF`,
      `CREATE TABLE obligations_v4 (
         case_id           TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
         id                TEXT NOT NULL,
         kind              TEXT NOT NULL,
         severity          INTEGER NOT NULL CHECK (severity BETWEEN 1 AND 5),
         claimant          TEXT NOT NULL,
         state             TEXT NOT NULL,
         required_evidence TEXT NOT NULL DEFAULT '[]',
         contested_by      TEXT NOT NULL DEFAULT '[]',
         arbitration_ref   TEXT,
         defer_until       INTEGER,
         rejection_ref     TEXT,
         override_ref      TEXT,
         position          INTEGER NOT NULL,
         created_at        INTEGER NOT NULL,
         updated_at        INTEGER NOT NULL,
         PRIMARY KEY (case_id, id)
       )`,
      `CREATE TABLE evidence_v4 (
         case_id       TEXT NOT NULL,
         obligation_id TEXT NOT NULL,
         kind          TEXT NOT NULL,
         ref           TEXT NOT NULL,
         verified      INTEGER NOT NULL DEFAULT 0,
         created_at    INTEGER NOT NULL,
         PRIMARY KEY (case_id, obligation_id, kind),
         FOREIGN KEY (case_id, obligation_id) REFERENCES obligations_v4 (case_id, id) ON DELETE CASCADE
       )`,
      `INSERT INTO obligations_v4
         SELECT case_id, id, kind, severity, claimant, state, required_evidence, contested_by,
                arbitration_ref, defer_until, rejection_ref, override_ref, position,
                created_at, updated_at
         FROM obligations`,
      `INSERT INTO evidence_v4 (case_id, obligation_id, kind, ref, verified, created_at)
         SELECT o.case_id, e.obligation_id, e.kind, e.ref, e.verified, e.created_at
         FROM evidence e JOIN obligations o ON o.id = e.obligation_id`,
      `DROP TABLE evidence`,
      `DROP TABLE obligations`,
      `ALTER TABLE obligations_v4 RENAME TO obligations`,
      `ALTER TABLE evidence_v4 RENAME TO evidence`,
      `CREATE INDEX obligations_case_idx ON obligations (case_id, position)`,
      `CREATE INDEX obligations_state_idx ON obligations (case_id, state)`,
      `CREATE INDEX evidence_obligation_idx ON evidence (case_id, obligation_id)`,
      `PRAGMA foreign_keys = ON`,
    ],
  },
]

export const LATEST_VERSION = MIGRATIONS[MIGRATIONS.length - 1]?.version ?? 0

export function pendingMigrations(current: number): readonly Migration[] {
  return MIGRATIONS.filter((m) => m.version > current).sort((a, b) => a.version - b.version)
}
