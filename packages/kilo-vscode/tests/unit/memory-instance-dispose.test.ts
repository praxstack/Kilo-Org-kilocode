/**
 * Guardrail tests: CLI instance disposal on worktree deletion.
 *
 * Deleted worktrees must have their CLI Instance disposed to release
 * file watchers, LSP, snapshot repos, and PubSub queues. Without
 * disposal, these resources accumulate permanently in the kilo serve
 * process.
 */

import { describe, it, expect } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { Project, SyntaxKind } from "ts-morph"

const ROOT = path.resolve(import.meta.dir, "../..")
const PROVIDER_FILE = path.join(ROOT, "src/agent-manager/AgentManagerProvider.ts")

function body(name: string): string {
  const project = new Project({ compilerOptions: { allowJs: true } })
  const source = project.addSourceFileAtPath(PROVIDER_FILE)
  const cls = source.getFirstDescendantByKind(SyntaxKind.ClassDeclaration)
  const method = cls?.getMethod(name)
  expect(method, `method ${name} not found in AgentManagerProvider`).toBeTruthy()
  return method!.getText()
}

describe("Memory — CLI instance disposal", () => {
  it("onDeleteWorktree calls instance.dispose() with the worktree directory", () => {
    const text = body("onDeleteWorktree")
    expect(text).toContain("instance.dispose(")
    expect(text).toContain("worktree.path")
  })

  it("onRemoveStaleWorktree calls instance.dispose()", () => {
    const text = body("onRemoveStaleWorktree")
    expect(text).toContain("instance.dispose(")
    expect(text).toContain("worktree.path")
  })

  it("instance.dispose() failure does not block worktree deletion", () => {
    const text = body("onDeleteWorktree")
    // The dispose call must be wrapped in try/catch so failures don't
    // prevent disk removal or state cleanup.
    const disposeIdx = text.indexOf("instance.dispose(")
    const catchIdx = text.indexOf("catch", disposeIdx)
    const removeIdx = text.indexOf("manager.removeWorktree", disposeIdx)
    expect(disposeIdx, "dispose call must exist").toBeGreaterThan(-1)
    expect(catchIdx, "catch must follow dispose").toBeGreaterThan(disposeIdx)
    expect(removeIdx, "disk removal must follow dispose+catch").toBeGreaterThan(catchIdx)
  })

  it("instance.dispose() failure does not block stale worktree removal", () => {
    const text = body("onRemoveStaleWorktree")
    const disposeIdx = text.indexOf("instance.dispose(")
    const catchIdx = text.indexOf("catch", disposeIdx)
    const clearIdx = text.indexOf("clearStaleTracking", disposeIdx)
    expect(disposeIdx, "dispose call must exist").toBeGreaterThan(-1)
    expect(catchIdx, "catch must follow dispose").toBeGreaterThan(disposeIdx)
    expect(clearIdx, "clearStaleTracking must follow dispose+catch").toBeGreaterThan(catchIdx)
  })
})
