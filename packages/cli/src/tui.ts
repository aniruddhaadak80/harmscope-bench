import { isObligationState, type QueueView, type ReviewVerdict } from '@harmscopebench/core'
import type { ReviewService } from './review.js'

const ESC = ''
const CLEAR = `${ESC}[2J${ESC}[H`
const HIDE_CURSOR = `${ESC}[?25l`
const SHOW_CURSOR = `${ESC}[?25h`

const DIM = `${ESC}[2m`
const BOLD = `${ESC}[1m`
const RESET = `${ESC}[0m`

/** State colour, expressed only through the escape codes the terminal already knows. */
const STATE_STYLE: Record<string, string> = {
  ratified: `${ESC}[32m`,
  evidenced: `${ESC}[36m`,
  drafted: `${ESC}[90m`,
  challenged: `${ESC}[33m`,
  arbitrated: `${ESC}[35m`,
  deferred: `${ESC}[90m`,
  rejected: `${ESC}[31m`,
  withdrawn: `${ESC}[90m`,
}

/** Severity 1..5 rendered as a bar. Index is severity - 1, so severity 5 is the full bar. */
const SEVERITY_LABEL = ['·', '··', '···', '████', '█████']

interface BenchOptions {
  readonly input?: NodeJS.ReadStream
  readonly output?: NodeJS.WriteStream
  /** Non-interactive render, used by the test and by `--json`-less CI runs. */
  readonly once?: boolean
}

function style(state: string, text: string): string {
  return `${STATE_STYLE[state] ?? ''}${text}${RESET}`
}

function severityMark(severity: number): string {
  const index = Math.max(0, Math.min(SEVERITY_LABEL.length - 1, Math.trunc(severity) - 1))
  return SEVERITY_LABEL[index] ?? '?'
}

/**
 * Render the queue the way the reviewer works it: one row per obligation, ranked by what is
 * blocking the most, with the blocking gate printed under its row rather than hidden in a
 * column nobody reads.
 */
export function renderBench(queue: QueueView, review: ReviewVerdict, selected: number): string {
  const width = Math.max(...queue.items.map((item) => item.id.length), 6)
  const lines: string[] = []

  lines.push(
    `${BOLD}harmscope bench${RESET}  ${DIM}phase ${review.phase} · exposure ${review.residualExposure}/100 · ${
      review.caseRatifiable ? 'ready to sign off' : `${review.caseBlocking.length} gate(s) in the way`
    }${RESET}`,
  )
  lines.push('')

  if (queue.count === 0) {
    lines.push(`${DIM}  no obligations recorded. add one with:${RESET}`)
    lines.push(
      `${DIM}    harmscope-bench obligation add --case <id> --id <id> --kind <kind> --severity <1-5>${RESET}`,
    )
    return `${lines.join('\n')}\n`
  }

  queue.items.forEach((item, index) => {
    const isSelected = index === selected
    const isHead = item.id === queue.head
    const pointer = isSelected ? `${BOLD}>${RESET}` : ' '
    const flag = isHead ? `${ESC}[33m*${RESET}` : ' '
    const state = item.settled ? style(item.state, item.state) : style(item.state, item.state)
    lines.push(
      `${pointer}${flag} ${DIM}${severityMark(item.severity)}${RESET} ${item.id.padEnd(width)}  ${state.padEnd(
        22,
      )}${DIM}${item.kind.padEnd(18)}${item.claimant}${RESET}`,
    )
    if (item.blockedBy.length > 0) {
      for (const code of item.blockedBy) {
        lines.push(`      ${ESC}[31m└─${RESET} ${ESC}[31m${code}${RESET}`)
      }
    }
  })

  lines.push('')
  lines.push(`${DIM}  * next to work · arrows/jk move · enter attempt the move · q quit${RESET}`)
  return `${lines.join('\n')}\n`
}

type KeyName = 'up' | 'down' | 'enter' | 'quit' | 'escape' | 'unknown'

/**
 * Raw-mode stdin sends escape sequences, not field names: an arrow key arrives as `ESC [ A`,
 * not as `'up'`. Parsing the chunk is the only honest way to map it.
 */
function parseKey(chunk: string): KeyName {
  switch (chunk) {
    case '[A':
    case 'k':
      return 'up'
    case '[B':
    case 'j':
      return 'down'
    case '\r':
    case '\n':
      return 'enter'
    case 'q':
    case 'Q':
      return 'quit'
    case '':
      return 'escape'
    default:
      return 'unknown'
  }
}

/**
 * The interactive bench.
 *
 * When stdin is not a TTY — a pipe, a test, CI — it renders once and returns rather than
 * blocking on a keypress that will never come. That is the difference between a TUI that is
 * usable in a script and one that hangs a pipeline forever.
 */
export async function runBench(
  svc: ReviewService,
  caseId: string,
  options: BenchOptions = {},
): Promise<void> {
  const output = options.output ?? process.stdout
  const input = options.input ?? process.stdin
  const interactive = input.isTTY === true && options.once !== true

  let selected = 0

  const draw = async (): Promise<void> => {
    const [queue, review] = await Promise.all([svc.queue(caseId), svc.review(caseId)])
    if (selected >= queue.items.length) selected = Math.max(0, queue.items.length - 1)
    if (interactive) output.write(CLEAR)
    output.write(renderBench(queue, review, selected))
  }

  if (!interactive) {
    await draw()
    return
  }

  output.write(HIDE_CURSOR)
  await draw()

  const cleanup = (): void => {
    output.write(SHOW_CURSOR)
    input.setRawMode?.(false)
    input.pause()
  }

  input.setRawMode?.(true)
  input.resume()
  input.setEncoding('utf8')

  await new Promise<void>((resolve) => {
    const onData = (chunk: string): void => {
      const key = parseKey(chunk)
      if (key === 'quit' || key === 'escape') {
        cleanup()
        resolve()
        return
      }
      if (key === 'enter') {
        void attempt(svc, caseId, selected).then(async () => {
          await draw()
        })
        return
      }
      if (key === 'up') {
        selected = Math.max(0, selected - 1)
      } else if (key === 'down') {
        selected += 1
      } else {
        return
      }
      void draw()
    }

    input.on('data', onData)
    input.once('end', () => {
      cleanup()
      resolve()
    })
  })
}

/** Move the selected row to the state the engine says comes next, and report the outcome. */
async function attempt(svc: ReviewService, caseId: string, index: number): Promise<void> {
  const queue = await svc.queue(caseId)
  const item = queue.items[index]
  if (item === undefined) return
  // The queue reports the next state as a string because it comes back over the JSON
  // boundary; it is one of the eight, so narrowing it here is safe and keeps the service
  // signature honest about only accepting real states.
  if (!isObligationState(item.nextState)) return
  const now = Date.now()
  const outcome = await svc.move(caseId, item.id, item.nextState, now, { by: 'bench' })
  if (outcome.applied) {
    process.stdout.write(`${ESC}[32m${item.id} -> ${item.nextState}${RESET}\n`)
    return
  }
  const gate = outcome.adjudication.blockingGates[0]
  process.stdout.write(
    `${ESC}[31mrefused${RESET} ${item.id} -> ${item.nextState}: ${outcome.adjudication.code}\n` +
      (gate === undefined ? '' : `  ${gate.detail}\n`),
  )
}
