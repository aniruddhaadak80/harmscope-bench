import { join } from 'node:path'
import {
  MAX_SEVERITY,
  MIN_SEVERITY,
  ToolRegistry,
  ValidationError,
  isObligationState,
  type Tool,
  type ToolContext,
} from '@harmscopebench/core'
import { buildRegistry } from '@harmscopebench/plugins'
import { loadCatalog } from '@harmscopebench/skills'
import { ENGINE_MODULE } from './review.js'

export { ENGINE_MODULE }

const OBLIGATIONS_SCHEMA = {
  type: 'array',
  description:
    'The obligations in a case, in the shape the engine consumes. Each needs an id, kind, ' +
    'severity (1-5), claimant and state; requiredEvidence and evidence are what gates read.',
  items: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      kind: { type: 'string' },
      severity: { type: 'integer', minimum: MIN_SEVERITY, maximum: MAX_SEVERITY },
      claimant: { type: 'string' },
      state: { type: 'string' },
      requiredEvidence: { type: 'array', items: { type: 'string' } },
      evidence: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            kind: { type: 'string' },
            ref: { type: 'string' },
            verified: { type: 'boolean' },
          },
          required: ['kind', 'verified'],
        },
      },
      contestedBy: { type: 'array', items: { type: 'string' } },
      arbitrationRef: { type: 'string' },
      deferUntil: { type: 'integer' },
      rejectionRef: { type: 'string' },
      overrideRef: { type: 'string' },
    },
    required: ['id', 'kind', 'severity', 'claimant', 'state'],
  },
} as const

/**
 * Validate obligations at the tool boundary. The engine validates again — this exists so a
 * caller gets a precise field-level error before paying for a subprocess.
 */
function validateObligations(input: unknown): readonly unknown[] {
  const obligations = (input as { obligations?: unknown }).obligations
  if (!Array.isArray(obligations)) {
    throw new ValidationError('"obligations" must be an array', { field: 'obligations' })
  }
  obligations.forEach((raw, index) => {
    const item = raw as Record<string, unknown>
    if (typeof item !== 'object' || item === null) {
      throw new ValidationError(`obligations[${index}] must be an object`, { index })
    }
    for (const field of ['id', 'kind', 'claimant', 'state']) {
      if (typeof item[field] !== 'string' || item[field] === '') {
        throw new ValidationError(`obligations[${index}].${field} must be a non-empty string`, {
          index,
          field,
        })
      }
    }
    if (!isObligationState(item.state)) {
      throw new ValidationError(
        `obligations[${index}].state is "${String(item.state)}", which is not one of the eight states`,
        { index, field: 'state', value: item.state },
      )
    }
    const severity = item.severity
    if (
      typeof severity !== 'number' ||
      !Number.isInteger(severity) ||
      severity < MIN_SEVERITY ||
      severity > MAX_SEVERITY
    ) {
      throw new ValidationError(
        `obligations[${index}].severity must be an integer in ${MIN_SEVERITY}..${MAX_SEVERITY}`,
        { index, field: 'severity', value: severity },
      )
    }
  })
  return obligations
}

/**
 * Builds the one registry every surface shares.
 *
 * Seven tools ship working on a fresh install. Five of them are the product: they take a
 * case's obligations and return a deterministic verdict from the Python engine. They are
 * stateless, so the same call over the CLI and over MCP returns the same answer — which is
 * what makes the engine trustworthy from another agent's side.
 *
 * Every name matches ^[a-z][a-z0-9_]*$ so it is directly exposable over MCP.
 */
export function buildToolRegistry(cwd = process.cwd()): ToolRegistry {
  const registry = new ToolRegistry()

  const runEngine = async (op: string, input: unknown): Promise<unknown> => {
    const { EngineBridge } = await import('@harmscopebench/engine-client')
    const bridge = new EngineBridge({ module: ENGINE_MODULE, cwd: join(cwd, 'services', 'engine', 'src') })
    return await bridge.call({ op, input })
  }

  const withObligations = (properties: Record<string, unknown> = {}) =>
    ({
      type: 'object',
      properties: { obligations: OBLIGATIONS_SCHEMA, ...properties },
      required: ['obligations'],
      additionalProperties: false,
    }) as const

  const engineTool = (
    name: string,
    description: string,
    inputSchema: Record<string, unknown>,
    op: string,
  ): Tool<unknown, unknown> =>
    ({
      name,
      description,
      inputSchema,
      outputSchema: { type: 'object' },
      permissions: ['proc:spawn'],
      surface: 'core',
      handler: async (input: unknown) => {
        validateObligations(input)
        return await runEngine(op, input)
      },
    }) as Tool<unknown, unknown>

  registry.register(
    engineTool(
      'adjudicate_transition',
      'Decide whether one obligation may move to a new state, and if not, name exactly which ' +
        'evidence is missing. This is the refusal tool: it never returns a judgement, only ' +
        'allowed plus the gates blocking the move. Use it before recording any state change.',
      {
        ...withObligations({
          transition: {
            type: 'object',
            description: 'The proposed move.',
            properties: {
              obligationId: { type: 'string' },
              to: { type: 'string', description: 'The target state.' },
              by: { type: 'string', description: 'Who is attempting the move.' },
            },
            required: ['obligationId', 'to'],
          },
        }),
        required: ['obligations', 'transition'],
      },
      'adjudicate',
    ),
    { source: 'core' },
  )

  registry.register(
    engineTool(
      'case_queue',
      'Order the obligations in a case by outstanding exposure and annotate each row with the ' +
        'gate codes currently blocking it. Use this to decide what a reviewer should work on ' +
        'next rather than reading the case in the order it was drafted.',
      withObligations(),
      'queue',
    ),
    { source: 'core' },
  )

  registry.register(
    engineTool(
      'case_review',
      'Report whether a whole case can be signed off: its phase, how many obligations are ' +
        'settled, the residual exposure score, and every gate standing between the case and ' +
        'ratification. Use this to answer "can we ship this yet" without guessing.',
      withObligations(),
      'review',
    ),
    { source: 'core' },
  )

  registry.register(
    engineTool(
      'liability_split',
      'Split outstanding exposure between the parties that owe it. Shares are apportioned in ' +
        'integer micro-units that sum to exactly 1000000. Use this to show who is carrying ' +
        'which share of an unfinished review.',
      withObligations(),
      'liability_split',
    ),
    { source: 'core' },
  )

  registry.register(
    engineTool(
      'residual_exposure',
      'Score a case from 0 to 100 by outstanding obligation weight, and list the drivers. The ' +
        'score is monotonic: adding an obligation can never lower it. Use this as a trend line ' +
        'across revisions of a review.',
      withObligations(),
      'residual_exposure',
    ),
    { source: 'core' },
  )

  registry.register(
    {
      name: 'list_skills',
      description:
        'List the skill catalog with each skill name, version and description. Use this to discover what the agent can do before guessing a command.',
      inputSchema: {
        type: 'object',
        properties: {
          includeBodies: { type: 'boolean', description: 'Include each skill body.' },
        },
        additionalProperties: false,
      },
      outputSchema: {
        type: 'object',
        properties: {
          count: { type: 'number' },
          issues: { type: 'array', items: { type: 'string' } },
          skills: { type: 'array', items: { type: 'object' } },
        },
        required: ['count', 'issues', 'skills'],
      },
      permissions: ['fs:read'],
      surface: 'core',
      handler: async (input: { includeBodies?: boolean }) => {
        const { skills, issues } = loadCatalog(join(cwd, 'skills'))
        return {
          count: skills.length,
          issues: [...issues],
          skills: skills.map((skill) => ({
            name: skill.name,
            version: skill.version,
            description: skill.description,
            ...(input.includeBodies === true ? { body: skill.body } : {}),
          })),
        }
      },
    } satisfies Tool<{ includeBodies?: boolean }, unknown>,
    { source: 'core' },
  )

  registry.register(
    {
      name: 'list_plugins',
      description:
        'List the resolved plugin registry, including plugins that were shadowed, disabled or rejected and why. Use this to explain why an expected capability is missing.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      outputSchema: { type: 'object' },
      permissions: ['fs:read'],
      surface: 'core',
      handler: async () => {
        const result = buildRegistry(join(cwd, 'plugins'))
        return {
          active: result.active.map((p) => ({
            name: p.manifest.name,
            version: p.manifest.version,
            capabilities: p.manifest.capabilities,
            shadowed: p.shadowed,
          })),
          disabled: result.disabled.map((p) => p.manifest.name),
          rejected: result.rejected.map((p) => ({ path: p.path, issues: p.issues })),
        }
      },
    } satisfies Tool<Record<string, never>, unknown>,
    { source: 'core' },
  )

  return registry
}

/** A minimal, dependency-free logger for the tool context. */
export function createContext(requestId = 'cli'): ToolContext {
  return {
    requestId,
    now: () => Date.now(),
    log: (level, message, fields) => {
      process.stderr.write(`${JSON.stringify({ level, message, requestId, ...fields })}\n`)
    },
    dataDir: process.env.PRODUCT_DATA_DIR ?? '.data',
  }
}
