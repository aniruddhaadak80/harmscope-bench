#!/usr/bin/env node
/**
 * End-to-end proof that the MCP surface is real.
 *
 * Starts the server as a subprocess over stdio, speaks the protocol to it with the SDK client,
 * lists tools, calls one that reaches the Python engine, and deliberately calls one with bad
 * input to prove the error envelope. Prints everything it observed.
 *
 *   node scripts/mcp-proof.mjs
 *
 * Exits non-zero if any step fails, so it can be run in CI.
 */

import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = resolve(import.meta.dirname, '..')
const CLI = resolve(ROOT, 'packages', 'cli', 'dist', 'bin.js')

const step = (label, value) => console.log(`\n${label}\n${'-'.repeat(label.length)}\n${value}`)

// A case the engine has something to refuse: a severity-5 obligation with no override named,
// and a drafted obligation still missing verified evidence.
const obligations = [
  {
    id: 'appeal-path',
    kind: 'appeal_path',
    severity: 4,
    claimant: 'operator',
    state: 'evidenced',
    requiredEvidence: ['policy_doc', 'appeal_channel'],
    evidence: [
      { kind: 'policy_doc', verified: true },
      { kind: 'appeal_channel', verified: true },
    ],
    contestedBy: [],
  },
  {
    id: 'incident',
    kind: 'incident_channel',
    severity: 5,
    claimant: 'operator',
    state: 'evidenced',
    requiredEvidence: [],
    evidence: [],
    contestedBy: [],
  },
  {
    id: 'disclosure',
    kind: 'disclosure_notice',
    severity: 3,
    claimant: 'operator',
    state: 'drafted',
    requiredEvidence: ['notice_text', 'locale_matrix'],
    evidence: [{ kind: 'notice_text', verified: false }],
    contestedBy: [],
  },
]

const { McpClient } = await import(
  pathToFileURL(resolve(ROOT, 'packages', 'mcp', 'dist', 'index.js')).href
).then((m) => m)

const client = new McpClient()
let failed = false

try {
  await client.connect({
    id: 'harmscope-bench',
    command: process.execPath,
    args: [CLI, 'mcp', 'serve'],
    enabled: true,
    env: { PRODUCT_ROOT: ROOT },
  })
  step('connected', 'MCP client connected to `harmscope-bench mcp serve` over stdio')

  const tools = await client.listTools()
  step('tools/list', `${tools.length} tools exposed:\n${tools.map((t) => `  ${t.name}`).join('\n')}`)

  if (tools.length < 5) {
    console.error(`\nFAILED: the product contract is at least 5 MCP tools, got ${tools.length}`)
    failed = true
  }

  const review = await client.callTool('case_review', { obligations })
  step('tools/call case_review (hits the Python engine)', JSON.stringify(review, null, 2))

  const adjudication = await client.callTool('adjudicate_transition', {
    obligations,
    transition: { obligationId: 'disclosure', to: 'evidenced' },
  })
  step('tools/call adjudicate_transition (the refusal path)', JSON.stringify(adjudication, null, 2))

  if (adjudication.allowed !== false || adjudication.code !== 'MISSING_EVIDENCE') {
    console.error('\nFAILED: expected a MISSING_EVIDENCE refusal over MCP')
    failed = true
  }

  const override = await client.callTool('adjudicate_transition', {
    obligations,
    transition: {
      obligationId: 'incident',
      to: 'ratified',
      overrideRef: 'dana@board',
    },
  })
  step('tools/call adjudicate_transition (severity 5 with an override)', JSON.stringify(override, null, 2))

  if (override.allowed !== true) {
    console.error('\nFAILED: a severity-5 ratification with a named override should be allowed')
    failed = true
  }

  const bad = await client.callTool('case_review', { obligations: [{ id: 'x' }] }).then(
    (value) => ({ rejected: false, value }),
    (error) => ({ rejected: true, message: String(error.message) }),
  )
  step(
    'tools/call case_review with invalid input (error envelope)',
    bad.rejected
      ? `rejected as expected: ${bad.message}`
      : `FAILED: invalid input was accepted, returned ${JSON.stringify(bad.value)}`,
  )
  if (!bad.rejected) failed = true
} catch (cause) {
  console.error(`\nFAILED: ${cause instanceof Error ? cause.stack : String(cause)}`)
  failed = true
} finally {
  await client.close().catch(() => undefined)
}

console.log(`\n${failed ? 'MCP PROOF FAILED' : 'MCP PROOF PASSED'}`)
process.exit(failed ? 1 : 0)
