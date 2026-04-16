/**
 * Memory regression test for WorktreeDiff.summary().
 *
 * Runs summary() in a loop and asserts RSS doesn't grow beyond a threshold.
 * This catches regressions where git output buffering changes could
 * re-introduce unbounded native memory growth.
 *
 * Uses the kilocode repo itself as the test fixture — it always has diffs
 * available against the default branch.
 */

import { describe, test, expect, afterEach } from "bun:test"
import path from "node:path"
import { WorktreeDiff } from "@/kilocode/review/worktree-diff"

const REPO = path.resolve(import.meta.dir, "../../../../..")
const ITERATIONS = 30
// Generous margin: mimalloc retains 64 MB segments and this repo has a large
// diff surface. The test guards against catastrophic regressions (multi-GB
// leaks), not tight bounds. Pre-fix behavior was 6+ GB; post-fix should stay
// well under 1 GB even on large repos.
const MAX_GROWTH_MB = 512

describe("worktree-diff memory", () => {
  afterEach(() => {
    WorktreeDiff.clearCache()
  })

  test(
    "summary() does not leak memory over repeated calls",
    async () => {
      // Resolve a base branch that exists in this repo
      const base = await resolveBase()
      if (!base) {
        console.log("Skipping memory test: no suitable base branch found")
        return
      }

      // Force GC and take baseline
      Bun.gc(true)
      const baseline = process.memoryUsage().rss

      for (let i = 0; i < ITERATIONS; i++) {
        await WorktreeDiff.summary({ dir: REPO, base })
      }

      // Force GC and measure
      Bun.gc(true)
      const after = process.memoryUsage().rss
      const growth = (after - baseline) / 1024 / 1024

      console.log(
        `Memory: baseline=${(baseline / 1024 / 1024).toFixed(1)} MB, after=${(after / 1024 / 1024).toFixed(1)} MB, growth=${growth.toFixed(1)} MB`,
      )

      expect(growth).toBeLessThan(MAX_GROWTH_MB)
    },
    { timeout: 120_000 },
  )
})

/** Find a base branch that exists in the repo (main or master). */
async function resolveBase(): Promise<string | undefined> {
  for (const branch of ["main", "master", "origin/main", "origin/master"]) {
    const proc = Bun.spawnSync(["git", "rev-parse", "--verify", branch], {
      cwd: REPO,
      stdout: "pipe",
      stderr: "pipe",
      windowsHide: true,
    })
    if (proc.exitCode === 0) return branch
  }
  return undefined
}
