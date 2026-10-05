import { NextResponse } from 'next/server'
import { PRODUCT, readSnapshot, resolveVersion, validateSnapshot } from '@/lib/product'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

type Status = 'ok' | 'warn' | 'fail'
interface Check {
  name: string
  status: Status
  detail: string
  fix?: string
}

const startedAt = Date.now()

/**
 * A health endpoint that reports only things it can actually observe at runtime. It does
 * not claim a probe it did not run — a health check that lies is worse than none.
 *
 * In particular it does NOT claim the Python engine is healthy: this app runs on Vercel,
 * where the engine is an out-of-process subprocess and cannot be probed at all. Saying so is
 * the honest answer, and `harmscope-bench doctor` is where the engine is actually checked.
 */
function probe(): { ok: boolean; checks: Check[] } {
  const checks: Check[] = []

  const nodeMajor = Number(process.versions.node.split('.')[0] ?? '0')
  checks.push(
    nodeMajor >= 22
      ? { name: 'runtime', status: 'ok', detail: `node ${process.versions.node}` }
      : {
          name: 'runtime',
          status: 'fail',
          detail: `node ${process.versions.node} is below the required v22.12.0`,
          fix: 'target Node 22 in the deployment runtime',
        },
  )

  checks.push({
    name: 'package',
    status: 'ok',
    detail: `${PRODUCT.slug}@${resolveVersion()}`,
  })

  // The real content check: can this deployment actually serve the review?
  try {
    const snapshot = readSnapshot()
    const issues = validateSnapshot(snapshot)
    checks.push(
      issues.length === 0
        ? {
            name: 'snapshot',
            status: 'ok',
            detail: `${snapshot.queue.count} obligations, phase ${snapshot.review.phase}, ${snapshot.review.caseBlocking.length} blocking gates`,
          }
        : {
            name: 'snapshot',
            status: 'fail',
            detail: `snapshot is structurally invalid: ${issues.slice(0, 3).join('; ')}`,
            fix: 're-run: harmscope-bench export --case <id> --out apps/web/content/case.json',
          },
    )
  } catch (cause) {
    checks.push({
      name: 'snapshot',
      status: 'fail',
      detail: cause instanceof Error ? cause.message : String(cause),
      fix: 'run: harmscope-bench export --case <id> --out apps/web/content/case.json',
    })
  }

  checks.push({
    name: 'engine',
    status: 'warn',
    detail: 'not probeable from this runtime — it is an out-of-process Python subprocess',
    fix: 'run `harmscope-bench doctor` locally to probe the engine',
  })

  const region = process.env.VERCEL_REGION ?? 'local'
  checks.push({ name: 'region', status: 'ok', detail: region })

  const ok = checks.every((check) => check.status !== 'fail')
  return { ok, checks }
}

export function GET() {
  const { ok, checks } = probe()
  return NextResponse.json(
    {
      ok,
      name: PRODUCT.slug,
      version: resolveVersion(),
      commit: process.env.VERCEL_GIT_COMMIT_SHA ?? 'local',
      runtime: process.versions.node,
      region: process.env.VERCEL_REGION ?? 'local',
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
      checks,
    },
    { status: ok ? 200 : 503, headers: { 'cache-control': 'no-store' } },
  )
}
