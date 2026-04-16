/**
 * Guardrail tests: polling interval minimums.
 *
 * Aggressive polling (< 10s) caused runaway native memory growth by spawning
 * too many git processes per minute. These tests prevent accidental regression.
 */

import { describe, it, expect } from "bun:test"
import fs from "node:fs"
import path from "node:path"

const ROOT = path.resolve(import.meta.dir, "../..")

describe("Memory — polling intervals", () => {
  it("WorktreeDiffController polls at >= 10 000 ms", () => {
    const src = fs.readFileSync(path.join(ROOT, "src/agent-manager/worktree-diff-controller.ts"), "utf-8")
    const match = src.match(/setInterval\(\s*\(\)\s*=>\s*\{[^}]*\}\s*,\s*([\d_]+)\s*\)/)
    expect(match, "setInterval call must exist in WorktreeDiffController").toBeTruthy()
    const ms = Number(match![1]!.replace(/_/g, ""))
    expect(ms).toBeGreaterThanOrEqual(10_000)
  })

  it("GitStatsPoller default interval is >= 10 000 ms", () => {
    const src = fs.readFileSync(path.join(ROOT, "src/agent-manager/GitStatsPoller.ts"), "utf-8")
    const match = src.match(/options\.intervalMs\s*\?\?\s*([\d_]+)/)
    expect(match, "default intervalMs must exist in GitStatsPoller").toBeTruthy()
    const ms = Number(match![1]!.replace(/_/g, ""))
    expect(ms).toBeGreaterThanOrEqual(10_000)
  })
})
