#!/usr/bin/env node
// Audit every `uses:` pin in the workflows.
//
// A pin to a commit SHA that does not exist makes the job fail at "Set up job" with an
// "Unable to resolve action" error — which looks like a runner problem and is not. This
// script finds them before CI does, and can be run as a local gate.
//
//   node scripts/check-action-pins.mjs            # report only
//   node scripts/check-action-pins.mjs --fix      # report and rewrite broken pins to the
//                                                  # current major tag, printing the mapping
//
// Offline-safe: with no network it reports what it can prove locally and exits 0, because a
// gate that always fails without connectivity trains people to ignore it.

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const WORKFLOWS = join(process.cwd(), '.github', 'workflows')
const FIX = process.argv.includes('--fix')

// A SHA is exactly 40 hex characters. Anything shorter is a truncated pin, which GitHub
// cannot resolve — the job then fails at "Set up job" with "Unable to resolve action", which
// reads like a runner problem and is not. So the length is checked here as well as the
// existence of the commit.
//
// The action name may carry a sub-path (`github/codeql-action/init`), so the name group
// accepts one or more path segments and the repository is its first two. Getting this wrong
// makes the audit skip exactly the pins it exists to catch.
const PIN = /uses:\s*([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*)@([0-9a-f]{30,44})(.*)$/
const TAG = /#\s*v?(\d+)(\.\d+)*/
const SHA_LENGTH = 40

/** `github/codeql-action/init` -> `github/codeql-action` */
function ownerRepo(action) {
  const parts = action.split('/')
  return parts.slice(0, 2).join('/')
}

/** Every (file, repo, sha, trailing comment) pin in the tree. */
function collect() {
  const pins = []
  for (const file of readdirSync(WORKFLOWS)) {
    if (!file.endsWith('.yml') && !file.endsWith('.yaml')) continue
    const lines = readFileSync(join(WORKFLOWS, file), 'utf8').split('\n')
    lines.forEach((line, index) => {
      const match = PIN.exec(line)
      if (match === null) return
      pins.push({
        file,
        line: index + 1,
        repo: match[1],
        sha: match[2],
        comment: (match[3] ?? '').trim(),
        major: (TAG.exec(match[3] ?? '') ?? [])[1] ?? null,
        raw: line,
      })
    })
  }
  return pins
}

async function resolveTag(repo, tag) {
  const response = await fetch(`https://api.github.com/repos/${repo}/git/ref/tags/${tag}`, {
    headers: {
      Accept: 'application/vnd.github+json',
      ...(process.env.GITHUB_TOKEN !== undefined
        ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` }
        : {}),
    },
  })
  if (!response.ok) return { ok: false, reason: `ref lookup ${response.status}` }
  const body = await response.json()
  let sha = body.object.sha
  if (body.object.type === 'tag') {
    const inner = await fetch(`https://api.github.com/repos/${repo}/git/tags/${sha}`, {
      headers: { Accept: 'application/vnd.github+json' },
    })
    if (!inner.ok) return { ok: false, reason: `tag lookup ${inner.status}` }
    sha = (await inner.json()).object.sha
  }
  return { ok: true, sha }
}

const pins = collect()
const uniq = [...new Set(pins.map((p) => `${p.repo}@${p.sha}`))]
console.log(`found ${pins.length} pin(s), ${uniq.length} unique`)

const results = new Map()

for (const key of uniq) {
  const [action, sha] = key.split('@')
  const repo = ownerRepo(action)
  if (sha.length !== SHA_LENGTH) {
    results.set(key, false)
    console.log(`  [SHORT ] ${key} — ${sha.length} chars, expected ${SHA_LENGTH} (truncated pin)`)
    continue
  }
  let verdict = 'ok'
  try {
    const response = await fetch(`https://api.github.com/repos/${repo}/commits/${sha}`, {
      headers: { Accept: 'application/vnd.github+json' },
    })
    if (response.status === 404) verdict = 'broken'
    else if (!response.ok) {
      // 403 and 429 mean we are rate limited or unauthenticated, which says nothing about
      // whether the pin is valid. Reporting "broken" here would fail CI for the wrong reason,
      // and a gate that cries wolf gets deleted.
      verdict = response.status === 403 || response.status === 429 ? 'unknown' : 'broken'
    }
  } catch {
    verdict = 'unknown'
  }
  if (verdict === 'unknown') {
    console.log(`  [SKIP  ] ${key} — GitHub API unavailable or rate limited, cannot verify`)
    continue
  }
  results.set(key, verdict === 'ok')
  console.log(`  [${verdict === 'ok' ? 'OK   ' : 'BROKEN'}] ${key}`)
}

const broken = pins.filter((p) => results.get(`${p.repo}@${p.sha}`) === false)

if (broken.length === 0) {
  console.log(`\ncheck:action-pins — clean (${uniq.length} unique pins resolve)`)
  process.exit(0)
}

console.log(`\ncheck:action-pins FAILED — ${broken.length} broken pin(s)`)
for (const pin of broken) {
  console.log(`  ${pin.file}:${pin.line}  ${pin.repo}@${pin.sha}  ${pin.comment}`)
}

if (!FIX) {
  console.log('    fix: rerun with --fix to rewrite broken pins to the current major tag')
  process.exit(1)
}

console.log('\n--fix: resolving current tags')
for (const pin of broken) {
  const repo = ownerRepo(pin.repo)
  const tag = `v${pin.major ?? '1'}`
  const resolved = await resolveTag(repo, tag)
  if (!resolved.ok) {
    console.error(`  ${repo}: could not resolve ${tag} (${resolved.reason})`)
    process.exit(1)
  }
  console.log(`  ${repo}@${pin.sha} -> ${resolved.sha}  (${tag})`)
  const replacement = pin.raw.replace(pin.sha, resolved.sha)
  const file = join(WORKFLOWS, pin.file)
  const lines = readFileSync(file, 'utf8').split('\n')
  lines[pin.line - 1] = replacement
  // Write via the same path each time so line numbers stay valid within one pass.
  const { writeFileSync } = await import('node:fs')
  writeFileSync(file, lines.join('\n'), 'utf8')
}
console.log('\nrewritten. review the diff, then re-run this script.')
