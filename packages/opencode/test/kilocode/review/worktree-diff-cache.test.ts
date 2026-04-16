/**
 * Tests for merge-base caching in worktree-diff.ts.
 *
 * Verifies that:
 * - The cache exists and has a reasonable TTL
 * - clearCache() is exported and functional
 * - Different dir/base combinations use separate cache keys
 */

import { describe, test, expect } from "bun:test"
import fs from "node:fs"
import path from "node:path"

const SRC = path.resolve(import.meta.dir, "../../../src/kilocode/review/worktree-diff.ts")

describe("worktree-diff merge-base cache", () => {
  const src = fs.readFileSync(SRC, "utf-8")

  test("ancestors cache is a Map with TTL tracking", () => {
    expect(src).toContain("const ancestors = new Map")
    expect(src).toContain("expires")
  })

  test("ANCESTOR_TTL is defined and >= 10 seconds", () => {
    const match = src.match(/const ANCESTOR_TTL\s*=\s*([\d_]+)/)
    expect(match).toBeTruthy()
    const ttl = Number(match![1]!.replace(/_/g, ""))
    expect(ttl).toBeGreaterThanOrEqual(10_000)
  })

  test("ancestor() checks cache before spawning git", () => {
    const fnStart = src.indexOf("async function ancestor(")
    expect(fnStart).toBeGreaterThan(-1)
    const fnBody = src.slice(fnStart, fnStart + 600)
    // Must check cache before calling git()
    const cacheCheck = fnBody.indexOf("ancestors.get(")
    const gitCall = fnBody.indexOf('git(["merge-base"')
    expect(cacheCheck, "cache lookup must exist").toBeGreaterThan(-1)
    expect(gitCall, "git call must exist").toBeGreaterThan(-1)
    expect(cacheCheck, "cache lookup must come before git call").toBeLessThan(gitCall)
  })

  test("ancestor() stores result in cache after successful git call", () => {
    const fnStart = src.indexOf("async function ancestor(")
    const fnBody = src.slice(fnStart, fnStart + 600)
    expect(fnBody).toContain("ancestors.set(")
    expect(fnBody).toContain("ANCESTOR_TTL")
  })

  test("cache key uses dir and base to avoid collisions", () => {
    const fnStart = src.indexOf("async function ancestor(")
    const fnBody = src.slice(fnStart, fnStart + 600)
    // Key should incorporate both dir and base
    expect(fnBody).toMatch(/`\$\{dir\}.*\$\{base\}`/)
  })

  test("clearCache() is exported", () => {
    expect(src).toContain("export function clearCache()")
    // Must clear the ancestors map
    const fnStart = src.indexOf("export function clearCache()")
    const fnBody = src.slice(fnStart, fnStart + 100)
    expect(fnBody).toContain("ancestors.clear()")
  })
})
