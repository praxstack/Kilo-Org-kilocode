import { Bus } from "@/bus"
import { Deferred, Effect } from "effect"
import { Wildcard } from "@/util/wildcard"
import type { Ruleset, Request, RejectedError, CorrectedError } from "@/permission/service"
import { Event, evaluate, DeniedError, RejectedError as RejectedErr } from "@/permission/service"
import { ConfigProtection } from "@/kilocode/permission/config-paths"

interface PendingEntry {
  info: Request
  ruleset: Ruleset
  deferred: Deferred.Deferred<void, RejectedError | CorrectedError>
}

/**
 * Auto-resolve pending permissions now fully covered by approved or denied rules.
 * When the user approves/denies a rule on subagent A, sibling subagent B's
 * pending permission for the same pattern resolves or rejects automatically.
 */
export function drainCovered(
  pending: Map<string, PendingEntry>,
  approved: Ruleset,
  _Denied: typeof DeniedError,
  exclude?: string,
): Effect.Effect<void> {
  return Effect.gen(function* () {
    for (const [id, entry] of pending) {
      if (id === exclude) continue
      // Never auto-resolve config file edit permissions
      if (ConfigProtection.isRequest(entry.info)) continue
      const actions = entry.info.patterns.map((pattern) =>
        evaluate(entry.info.permission, pattern, entry.ruleset, approved),
      )
      const denied = actions.some((r) => r.action === "deny")
      const allowed = !denied && actions.every((r) => r.action === "allow")
      if (!denied && !allowed) continue
      pending.delete(id)
      if (denied) {
        void Bus.publish(Event.Replied, {
          sessionID: entry.info.sessionID,
          requestID: entry.info.id,
          reply: "reject",
        })
        // Use RejectedError since DeniedError isn't in the deferred's error channel
        // (DeniedError is thrown synchronously in ask() for rule violations detected immediately)
        yield* Deferred.fail(entry.deferred, new RejectedErr())
      } else {
        void Bus.publish(Event.Replied, {
          sessionID: entry.info.sessionID,
          requestID: entry.info.id,
          reply: "always",
        })
        yield* Deferred.succeed(entry.deferred, undefined)
      }
    }
  })
}
