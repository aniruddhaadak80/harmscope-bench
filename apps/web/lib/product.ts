import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The typed read model.
 *
 * This app renders a review snapshot exported by the CLI, because the deterministic engine is
 * a Python subprocess and cannot run inside a Vercel function. Every number on screen came out
 * of the engine — see `harmscope-bench export --case <id>`. Nothing here recomputes a verdict,
 * because recomputing it in TypeScript would mean a second implementation of the state graph,
 * which is the one thing this product exists to avoid.
 */
export interface SnapshotObligation {
  readonly id: string
  readonly kind: string
  readonly severity: number
  readonly claimant: string
  readonly state: string
  readonly requiredEvidence?: readonly string[]
  readonly evidence?: readonly { kind: string; ref?: string; verified: boolean }[]
  readonly contestedBy?: readonly string[]
  readonly arbitrationRef?: string
  readonly overrideRef?: string
  readonly rejectionRef?: string
}

export interface SnapshotGate {
  readonly code: string
  readonly obligationId: string
  readonly detail: string
  readonly severity: number
  readonly missingEvidence: readonly string[]
}

export interface SnapshotQueueItem {
  readonly id: string
  readonly kind: string
  readonly claimant: string
  readonly state: string
  readonly severity: number
  readonly openWeight: number
  readonly nextState: string
  readonly blockedBy: readonly string[]
  readonly settled: boolean
}

export interface Snapshot {
  readonly case: {
    readonly id: string
    readonly title: string
    readonly systemName: string
    readonly status: string
    readonly createdAt: number
    readonly updatedAt: number
  }
  readonly obligations: readonly SnapshotObligation[]
  readonly queue: {
    readonly head: string
    readonly count: number
    readonly byState: Record<string, number>
    readonly items: readonly SnapshotQueueItem[]
  }
  readonly review: {
    readonly phase: string
    readonly total: number
    readonly settled: number
    readonly byState: Record<string, number>
    readonly caseRatifiable: boolean
    readonly caseBlocking: readonly SnapshotGate[]
    readonly residualExposure: number
    readonly nextAction: string
  }
  readonly liability: {
    readonly totalWeight: number
    readonly apportionmentUnit: number
    readonly shares: readonly { party: string; micro: number; share: number; weight: number }[]
    readonly concentration: number
  }
  readonly exposure: {
    readonly score: number
    readonly openWeight: number
    readonly maxSeverity: number
    readonly openCount: number
    readonly drivers: readonly {
      readonly id: string
      readonly kind: string
      readonly state: string
      readonly severity: number
      readonly weight: number
      readonly claimant: string
    }[]
  }
  readonly attempts: readonly {
    readonly obligationId: string
    readonly fromState: string
    readonly toState: string
    readonly allowed: boolean
    readonly code: string
    readonly actor: string
    readonly at: number
  }[]
}

export interface Surface {
  readonly id: string
  readonly title: string
  readonly summary: string
  readonly status: 'shipped' | 'omitted'
  readonly why?: string
}

export const PRODUCT = {
  name: 'Harmscope Bench',
  slug: 'harmscope-bench',
  version: '0.1.0',
  tagline:
    'Work an AI deployment review as a queue of contested harm claims. Every state change passes through a state graph that refuses it unless the evidence is there.',
} as const

export const SURFACES: readonly Surface[] = [
  {
    id: 'cli',
    title: 'CLI',
    summary: 'Every capability is reachable without a browser. The gated move lives here.',
    status: 'shipped',
  },
  {
    id: 'tui',
    title: 'Terminal bench',
    summary: 'The queue-first review surface: ranked work list, blocking gate under each row.',
    status: 'shipped',
  },
  {
    id: 'web',
    title: 'This app',
    summary: 'Server-rendered read model over an exported snapshot, with real loading and empty states.',
    status: 'shipped',
  },
  {
    id: 'mcp',
    title: 'MCP server and client',
    summary: 'Five engine tools exposed to any MCP client, so the product is a provider for other agents.',
    status: 'shipped',
  },
  {
    id: 'skills',
    title: 'Skills catalog',
    summary: 'Markdown skills loaded from disk, frontmatter validated, version-gated in CI.',
    status: 'shipped',
  },
  {
    id: 'plugins',
    title: 'Plugin registry',
    summary: 'Manifest-driven extensions with priority-based conflict resolution.',
    status: 'shipped',
  },
  {
    id: 'memory',
    title: 'Memory',
    summary: 'SQLite with WAL, numbered idempotent migrations, and an audit trail of every attempt.',
    status: 'shipped',
  },
  {
    id: 'desktop',
    title: 'Desktop shell',
    summary:
      'The primary interface is a terminal workbench, so an Electron shell would be a strictly worse copy of the TUI.',
    status: 'omitted',
    why: 'a GUI wrapper is a downgrade when the real interface is a TUI',
  },
  {
    id: 'channels',
    title: 'Channels',
    summary:
      'This is a local-first review artefact with no remote delivery surface, so a channel adapter would have nothing to send.',
    status: 'omitted',
    why: 'no remote surface means no channel to speak to',
  },
]

const SNAPSHOT_PATH = join(process.cwd(), 'content', 'case.json')

let cached: Snapshot | null = null

/** Read the exported snapshot. Throws a typed message the error boundary can render. */
export function readSnapshot(): Snapshot {
  if (cached !== null) return cached
  let raw: string
  try {
    raw = readFileSync(SNAPSHOT_PATH, 'utf8')
  } catch {
    throw new Error(
      'No review snapshot found. Run: harmscope-bench export --case <id> --out apps/web/content/case.json',
    )
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (cause) {
    throw new Error(`The review snapshot is not valid JSON: ${String(cause)}`)
  }
  cached = parsed as Snapshot
  return cached
}

/** A snapshot that is structurally usable, used by /api/health. */
export function validateSnapshot(value: unknown): readonly string[] {
  const issues: string[] = []
  if (typeof value !== 'object' || value === null) return ['snapshot is not an object']
  const root = value as Record<string, unknown>
  for (const key of ['case', 'obligations', 'queue', 'review', 'liability', 'exposure', 'attempts']) {
    if (!(key in root)) issues.push(`missing "${key}"`)
  }
  const queue = root.queue as { items?: unknown } | undefined
  if (queue !== undefined && !Array.isArray(queue.items)) issues.push('queue.items is not an array')
  const obligations = root.obligations
  if (!Array.isArray(obligations)) {
    issues.push('obligations is not an array')
  } else {
    obligations.forEach((item, index) => {
      const obligation = item as Record<string, unknown>
      for (const field of ['id', 'kind', 'severity', 'claimant', 'state']) {
        if (!(field in obligation)) issues.push(`obligations[${index}] missing "${field}"`)
      }
    })
  }
  return issues
}

export function resolveVersion(): string {
  try {
    const raw = readFileSync(join(process.cwd(), 'package.json'), 'utf8')
    const parsed = JSON.parse(raw) as { version?: string }
    return parsed.version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
}

export function shippedSurfaces(): readonly Surface[] {
  return SURFACES.filter((surface) => surface.status === 'shipped')
}

export function omittedSurfaces(): readonly Surface[] {
  return SURFACES.filter((surface) => surface.status === 'omitted')
}
