---
name: expose-over-mcp
description: Use when another agent needs to ask this product whether a transition is allowed, because the engine is exposed over MCP and returns the same verdict the CLI does.
metadata:
  version: 1.0.0
---

# Expose Harmscope Bench over MCP

## When to use this

You want an agent to be able to ask whether a deployment's obligation may advance, without
giving it shell access or a copy of the state machine.

## Steps

1. Add the server to the agent's MCP config.

   ```json
   {
     "mcpServers": {
       "harmscope-bench": {
         "command": "node",
         "args": ["/absolute/path/to/harmscope-bench/packages/cli/dist/bin.js", "mcp", "serve"],
         "env": { "PRODUCT_ROOT": "/absolute/path/to/harmscope-bench" }
       }
     }
   }
   ```

   `PRODUCT_ROOT` is how the server finds `services/engine/src`. Without it the engine call
   fails with a spawn error rather than a useful message.

2. The server exposes seven tools:

   | Tool                    | Returns                                                    |
   | ----------------------- | ---------------------------------------------------------- |
   | `adjudicate_transition` | whether one move is allowed, and the gates blocking it     |
   | `case_queue`            | obligations ranked by outstanding weight, with their gates |
   | `case_review`           | phase, sign-off readiness, residual exposure, blockers     |
   | `liability_split`       | exposure apportioned between the parties that owe it       |
   | `residual_exposure`     | the 0–100 score and its drivers                            |
   | `list_skills`           | the skill catalog                                          |
   | `list_plugins`          | the resolved plugin registry and why anything was rejected |

3. Every tool is stateless and takes the case's `obligations` array as input. The agent supplies
   the case; the server holds nothing. That is what makes the verdict reproducible — the same
   obligations always produce the same answer, on any machine.

4. Prove it without the agent:

   ```bash
   node scripts/mcp-proof.mjs
   ```

   This connects a real SDK client over stdio, lists the tools, calls two that reach the Python
   engine, and asserts the error envelope for bad input. It exits non-zero on failure, so it is
   safe in CI.

## Calling one directly

```bash
harmscope-bench mcp call case_review '{"obligations":[{"id":"a","kind":"consent","severity":5,"claimant":"vendor","state":"evidenced"}]}'
```

## What to tell the agent

Send the tool the case, not a conclusion. `case_review` returns `caseRatifiable` and
`caseBlocking`; there is no tool that returns an ethical judgement, by design. If an agent asks
whether a deployment is ethical, the honest answer is that this product does not answer that
question — it answers whether the evidence for a specific transition exists.

## Verify

`node scripts/mcp-proof.mjs` prints `MCP PROOF PASSED` and exits 0.
