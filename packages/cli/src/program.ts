import { Command } from 'commander'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { ValidationError, isObligationState, type ObligationState } from '@harmscopebench/core'
import type { CaseRow } from '@harmscopebench/memory'
import { buildRegistry as buildPluginRegistry } from '@harmscopebench/plugins'
import { loadCatalog } from '@harmscopebench/skills'
import { buildToolRegistry, createContext } from './bootstrap.js'
import { doctor, renderReport } from './doctor.js'
import { ReviewService } from './review.js'
import { runBench } from './tui.js'

const VERSION = '0.1.0'

/** Exit codes are part of the contract: 0 ok, 1 runtime failure, 2 usage error. */
export function buildProgram(): Command {
  const program = new Command()

  /** The repository root, so the engine resolves from the cwd the user launched in. */
  const rootOf = (): string => resolve(process.env.PRODUCT_ROOT ?? process.cwd())
  const dbOf = (): string => process.env.PRODUCT_DATA_DIR ?? ':memory:'

  const service = (): ReviewService => new ReviewService({ root: rootOf(), database: dbOf() })

  const emit = (value: unknown, asJson: boolean, render: (v: never) => string): void => {
    process.stdout.write(asJson ? `${JSON.stringify(value, null, 2)}\n` : `${render(value as never)}\n`)
  }

  program
    .name('harmscope-bench')
    .description(
      'Work an AI deployment review as a queue of contested harm claims. Every state change is ' +
        'gated by the deterministic engine, and a refused move names the evidence it wanted.',
    )
    .version(VERSION, '-v, --version', 'print the version')
    .exitOverride((error) => {
      process.exitCode = error.exitCode === 0 ? 0 : 2
      throw error
    })

  program
    .command('doctor')
    .description('diagnose every subsystem and print an actionable report')
    .option('--json', 'machine-readable output')
    .action(async (options: { json?: boolean }) => {
      const report = await doctor(rootOf())
      process.stdout.write(
        options.json === true ? `${JSON.stringify(report, null, 2)}\n` : `${renderReport(report)}\n`,
      )
      if (!report.ok) process.exitCode = 1
    })

  program
    .command('tools')
    .description('list the registered tools — the authoritative capability list')
    .option('--json', 'machine-readable output')
    .action((options: { json?: boolean }) => {
      const registry = buildToolRegistry(rootOf())
      const tools = registry.list().map((tool) => ({
        name: tool.name,
        description: tool.description,
        surface: registry.surfaceOf(tool.name),
        source: registry.sourceOf(tool.name),
        permissions: tool.permissions,
        inputSchema: tool.inputSchema,
      }))
      if (options.json === true) {
        process.stdout.write(`${JSON.stringify(tools, null, 2)}\n`)
        return
      }
      const width = Math.max(...tools.map((t) => t.name.length), 4)
      for (const tool of tools) {
        process.stdout.write(`  ${tool.name.padEnd(width)}  [${tool.surface}]  ${tool.description}\n`)
      }
    })

  program
    .command('skills')
    .description('load the skill catalog from disk and report every validation issue')
    .option('--json', 'machine-readable output')
    .option('--bodies', 'include each skill body', false)
    .action((options: { json?: boolean; bodies?: boolean }) => {
      const { skills, issues } = loadCatalog(join(rootOf(), 'skills'))
      if (options.json === true) {
        process.stdout.write(`${JSON.stringify({ skills, issues: [...issues] }, null, 2)}\n`)
      } else {
        const width = Math.max(...skills.map((s) => s.name.length), 5)
        process.stdout.write(
          `${skills.map((s) => `  ${s.name.padEnd(width)}  v${s.version}  ${s.description}`).join('\n')}\n`,
        )
        if (issues.length > 0)
          process.stdout.write(
            `\n  ${issues.length} issue(s):\n${issues.map((i) => `    ${i}`).join('\n')}\n`,
          )
      }
      if (issues.length > 0) process.exitCode = 1
    })

  program
    .command('plugins')
    .description('resolve the plugin registry and report why anything was rejected')
    .option('--json', 'machine-readable output')
    .action((options: { json?: boolean }) => {
      const result = buildPluginRegistry(join(rootOf(), 'plugins'))
      if (options.json === true) {
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
        return
      }
      const lines: string[] = []
      for (const active of result.active) {
        lines.push(
          `  [active]   ${active.manifest.name}@${active.manifest.version}  ${active.manifest.capabilities.join(', ')}`,
        )
      }
      for (const disabled of result.disabled) {
        lines.push(`  [disabled] ${disabled.manifest.name}`)
      }
      for (const rejected of result.rejected) {
        lines.push(`  [rejected] ${rejected.path}: ${rejected.issues.join('; ')}`)
      }
      process.stdout.write(`${lines.join('\n') || '  no plugins found'}\n`)
    })

  // ---------------------------------------------------------------- case

  const caseCmd = program.command('case').description('create and inspect review cases')

  caseCmd
    .command('create')
    .description('create a case')
    .requiredOption('--id <id>', 'case identifier, kebab-case')
    .requiredOption('--title <title>', 'human title')
    .requiredOption('--system <name>', 'the AI system being reviewed')
    .option('--json', 'machine-readable output')
    .action(async (options: { id: string; title: string; system: string; json?: boolean }) => {
      const svc = service()
      const now = Date.now()
      const row = svc.store.createCase({
        id: options.id,
        title: options.title,
        systemName: options.system,
        now,
      })
      emit(row, options.json === true, (v: typeof row) => `created case ${v.id} — ${v.title}`)
      svc.close()
    })

  caseCmd
    .command('list')
    .description('list cases, most recently touched first')
    .option('--json', 'machine-readable output')
    .action((options: { json?: boolean }) => {
      const svc = service()
      const rows = svc.store.listCases()
      emit(rows, options.json === true, (v: CaseRow[]) => {
        if (v.length === 0) return 'no cases yet — create one with `case create`'
        const width = Math.max(...v.map((r) => r.id.length), 4)
        return v.map((r) => `  ${r.id.padEnd(width)}  ${r.status.padEnd(8)}  ${r.title}`).join('\n')
      })
      svc.close()
    })

  // ---------------------------------------------------------------- obligation

  const obligationCmd = program.command('obligation').description('record what a deployment owes')

  obligationCmd
    .command('add')
    .description('record an obligation against a case')
    .requiredOption('--case <id>', 'case id')
    .requiredOption('--id <id>', 'obligation id, kebab-case')
    .requiredOption('--kind <kind>', 'what is owed, e.g. appeal_path')
    .requiredOption('--severity <n>', 'severity 1-5', (v: string) => Number.parseInt(v, 10))
    .option('--claimant <party>', 'who owes it', 'operator')
    .option('--requires <kinds>', 'comma-separated evidence kinds this obligation needs verified', '')
    .option('--json', 'machine-readable output')
    .action(
      async (options: {
        case: string
        id: string
        kind: string
        severity: number
        claimant: string
        requires: string
        json?: boolean
      }) => {
        const svc = service()
        const required = options.requires
          .split(',')
          .map((entry) => entry.trim())
          .filter(Boolean)
        const row = svc.store.addObligation(
          options.case,
          {
            id: options.id,
            kind: options.kind,
            severity: options.severity,
            claimant: options.claimant,
            ...(required.length > 0 ? { requiredEvidence: required } : {}),
          },
          Date.now(),
        )
        emit(
          row,
          options.json === true,
          (v: typeof row) => `recorded ${v.id} (${v.kind}, severity ${v.severity}) owed by ${v.claimant}`,
        )
        svc.close()
      },
    )

  obligationCmd
    .command('evidence')
    .description('attach evidence, or mark an attached artefact verified')
    .requiredOption('--case <id>', 'case id')
    .requiredOption('--id <obligation>', 'obligation id')
    .requiredOption('--kind <kind>', 'evidence kind')
    .requiredOption('--ref <ref>', 'where the artefact lives')
    .option('--verify', 'mark it verified immediately', false)
    .option('--json', 'machine-readable output')
    .action(
      async (options: {
        case: string
        id: string
        kind: string
        ref: string
        verify?: boolean
        json?: boolean
      }) => {
        const svc = service()
        const now = Date.now()
        svc.store.addEvidence(
          {
            caseId: options.case,
            obligationId: options.id,
            kind: options.kind,
            ref: options.ref,
            ...(options.verify === true ? { verified: true } : {}),
          },
          now,
        )
        const obligation = svc.store.getObligation(options.case, options.id)
        emit(
          obligation,
          options.json === true,
          (v: NonNullable<typeof obligation>) =>
            `${v.id} evidence: ${v.evidence.map((e) => `${e.kind}${e.verified ? ' (verified)' : ''}`).join(', ') || 'none'}`,
        )
        svc.close()
      },
    )

  obligationCmd
    .command('contest')
    .description('record a party contesting an obligation')
    .requiredOption('--case <id>', 'case id')
    .requiredOption('--id <obligation>', 'obligation id')
    .requiredOption('--party <party>', 'who is contesting it')
    .option('--json', 'machine-readable output')
    .action((options: { case: string; id: string; party: string; json?: boolean }) => {
      const svc = service()
      const parties = svc.store.addContestant(options.case, options.id, options.party, Date.now())
      emit(parties, options.json === true, (v: readonly string[]) => `contested by: ${v.join(', ')}`)
      svc.close()
    })

  // ---------------------------------------------------------------- the gated move

  program
    .command('move')
    .description('attempt a state change. The engine decides; this only records the outcome.')
    .requiredOption('--case <id>', 'case id')
    .requiredOption('--id <obligation>', 'obligation id')
    .requiredOption('--to <state>', 'target state')
    .option('--by <party>', 'who is attempting the move', 'reviewer')
    .option('--override-ref <ref>', 'arbitration, rejection or override reference')
    .option('--json', 'machine-readable output')
    .action(
      async (options: {
        case: string
        id: string
        to: string
        by: string
        overrideRef?: string
        json?: boolean
      }) => {
        if (!isObligationState(options.to)) {
          process.stderr.write(
            `VALIDATION_FAILED: "${options.to}" is not an obligation state\n` +
              `  fix: one of drafted, evidenced, challenged, arbitrated, ratified, rejected, deferred, withdrawn\n`,
          )
          process.exitCode = 2
          return
        }
        const svc = service()
        const outcome = await svc.move(options.case, options.id, options.to as ObligationState, Date.now(), {
          by: options.by,
          ...(options.overrideRef !== undefined ? { overrideRef: options.overrideRef } : {}),
        })
        emit(outcome, options.json === true, (v: typeof outcome) => {
          if (v.applied) return `applied: ${v.adjudication.detail}`
          const lines = [`REFUSED (${v.adjudication.code}): ${v.adjudication.detail}`]
          for (const gate of v.adjudication.blockingGates) {
            lines.push(`  gate ${gate.code} on ${gate.obligationId}: ${gate.detail}`)
          }
          lines.push(`  fix: satisfy the gate above, then retry the same move`)
          return lines.join('\n')
        })
        // A refusal is the product working, not the program failing: exit 0 either way.
        svc.close()
      },
    )

  // ---------------------------------------------------------------- engine views

  /** Register a read-only command that asks the engine a question about one case. */
  const view = (
    name: string,
    description: string,
    fetch: (svc: ReviewService, caseId: string) => Promise<unknown>,
    render: (value: never) => string,
  ): void => {
    program
      .command(name)
      .description(description)
      .requiredOption('--case <id>', 'case id')
      .option('--json', 'machine-readable output')
      .action(async (options: { case: string; json?: boolean }) => {
        const svc = service()
        try {
          const value = await fetch(svc, options.case)
          emit(value, options.json === true, render)
        } finally {
          svc.close()
        }
      })
  }

  view(
    'queue',
    'the ordered work list, with the gates blocking each row',
    async (svc, caseId) => await svc.queue(caseId),
    (v: never) => {
      const q = v as Awaited<ReturnType<ReviewService['queue']>>
      if (q.count === 0) return 'no obligations recorded yet'
      const lines = q.items.map((item, index) => {
        const marker = item.id === q.head ? '>' : ' '
        const blocked = item.blockedBy.length > 0 ? ` blocked: ${item.blockedBy.join(', ')}` : ''
        return `  ${marker} ${String(index + 1).padStart(2)}. ${item.id.padEnd(18)} ${item.state.padEnd(10)} sev ${item.severity}  ${item.kind}${blocked}`
      })
      return [`queue for ${q.count} obligation(s):`, ...lines].join('\n')
    },
  )

  view(
    'review',
    'the whole-case verdict: phase, sign-off readiness, and every gate in the way',
    async (svc, caseId) => await svc.review(caseId),
    (v: never) => {
      const r = v as Awaited<ReturnType<ReviewService['review']>>
      const head = [
        `phase:            ${r.phase}`,
        `obligations:      ${r.total} (${r.settled} settled)`,
        `residual exposure: ${r.residualExposure}/100`,
        `can sign off:     ${r.caseRatifiable ? 'yes' : 'no'}`,
        `next action:      ${r.nextAction}`,
      ]
      if (r.caseBlocking.length === 0) return head.join('\n')
      const gates = r.caseBlocking.map((g) => `  ${g.code.padEnd(22)} ${g.obligationId}: ${g.detail}`)
      return [...head, '', `blocking gates (${r.caseBlocking.length}):`, ...gates].join('\n')
    },
  )

  view(
    'liability',
    'split outstanding exposure between the parties that owe it',
    async (svc, caseId) => await svc.liability(caseId),
    (v: never) => {
      const l = v as Awaited<ReturnType<ReviewService['liability']>>
      if (l.shares.length === 0) return 'nothing outstanding — every obligation is settled'
      const width = Math.max(...l.shares.map((s) => s.party.length), 5)
      const bars = l.shares.map((s) => {
        const width_ = Math.round(s.share * 40)
        return `  ${s.party.padEnd(width)}  ${(s.share * 100).toFixed(2).padStart(6)}%  ${'#'.repeat(width_)}`
      })
      return [
        `total open weight: ${l.totalWeight}`,
        `concentration:    ${(l.concentration * 100).toFixed(2)}% to the largest holder`,
        ...bars,
      ].join('\n')
    },
  )

  view(
    'exposure',
    'score the case 0-100 by outstanding weight, and list the drivers',
    async (svc, caseId) => await svc.exposure(caseId),
    (v: never) => {
      const e = v as Awaited<ReturnType<ReviewService['exposure']>>
      const head = [`score: ${e.score}/100   open weight: ${e.openWeight}   max severity: ${e.maxSeverity}`]
      if (e.drivers.length === 0) return [...head, 'no open obligations'].join('\n')
      const drivers = e.drivers.map(
        (d) =>
          `  ${d.id.padEnd(18)} ${d.state.padEnd(10)} sev ${d.severity}  weight ${String(d.weight).padStart(3)}  ${d.kind}`,
      )
      return [...head, '', ...drivers].join('\n')
    },
  )

  // ---------------------------------------------------------------- mcp

  const mcp = program.command('mcp').description('Model Context Protocol commands')

  mcp
    .command('serve')
    .description('run the MCP server over stdio')
    .action(async () => {
      const { serveStdio } = await import('@harmscopebench/mcp')
      const registry = buildToolRegistry(rootOf())
      // stdout belongs to the protocol from here on; diagnostics must go to stderr.
      await serveStdio(registry, createContext('mcp'))
    })

  mcp
    .command('call')
    .description('invoke one tool directly, without MCP')
    .argument('<tool>', 'tool name')
    .argument('<input>', 'JSON input document')
    .action(async (tool: string, raw: string) => {
      let parsed: unknown
      try {
        parsed = JSON.parse(raw)
      } catch (cause) {
        process.stderr.write(`error: input is not valid JSON — ${String(cause)}\n`)
        process.exitCode = 2
        return
      }
      const registry = buildToolRegistry(rootOf())
      try {
        const value = await registry.invoke(tool, parsed, createContext('cli'), [
          'fs:read',
          'net:fetch',
          'proc:spawn',
        ])
        process.stdout.write(`${JSON.stringify(value ?? null, null, 2)}\n`)
      } catch (cause) {
        const code = (cause as { code?: string }).code ?? 'INTERNAL'
        process.stderr.write(`${code}: ${cause instanceof Error ? cause.message : String(cause)}\n`)
        process.exitCode = 1
      }
    })

  // ---------------------------------------------------------------- export

  program
    .command('export')
    .description('write the case plus the engine verdict as the portable snapshot the web app renders')
    .requiredOption('--case <id>', 'case id')
    .option('--out <path>', 'output file', 'apps/web/content/case.json')
    .action(async (options: { case: string; out: string }) => {
      const svc = service()
      const snapshot = await svc.snapshot(options.case)
      const target = resolve(rootOf(), options.out)
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8')
      process.stdout.write(
        `wrote ${options.out} (${snapshot.queue.count} obligations, phase ${snapshot.review.phase})\n`,
      )
      svc.close()
    })

  program
    .command('bench')
    .description('open the queue-first review bench')
    .requiredOption('--case <id>', 'case id')
    .action(async (options: { case: string }) => {
      const svc = service()
      try {
        await runBench(svc, options.case)
      } finally {
        svc.close()
      }
    })

  program
    .command('version')
    .description('print version and runtime information as JSON')
    .action(() => {
      process.stdout.write(
        `${JSON.stringify(
          {
            name: 'harmscope-bench',
            version: VERSION,
            node: process.versions.node,
            platform: process.platform,
            tools: buildToolRegistry(rootOf()).size,
          },
          null,
          2,
        )}\n`,
      )
    })

  return program
}

export { ValidationError }
