import { Bus } from "@/bus"
import { BusEvent } from "@/bus/bus-event"
import { Config } from "@/config/config"
import { Instance } from "@/project/instance"
import { ProjectID } from "@/project/schema"
import { MessageID, SessionID } from "@/session/schema"
import { PermissionTable } from "@/session/session.sql"
import { Database, eq } from "@/storage/db"
import { InstanceState } from "@/util/instance-state"
import { Log } from "@/util/log"
import { Wildcard } from "@/util/wildcard"
import { Deferred, Effect, Layer, Schema, ServiceMap } from "effect"
import z from "zod"
import { PermissionID } from "./schema"
import { ConfigProtection } from "@/kilocode/permission/config-paths" // kilocode_change
import { Identifier } from "@/id/id" // kilocode_change
import { drainCovered } from "@/kilocode/permission/drain" // kilocode_change

const log = Log.create({ service: "permission" })

export const Action = z.enum(["allow", "deny", "ask"]).meta({
  ref: "PermissionAction",
})
export type Action = z.infer<typeof Action>

export const Rule = z
  .object({
    permission: z.string(),
    pattern: z.string(),
    action: Action,
  })
  .meta({
    ref: "PermissionRule",
  })
export type Rule = z.infer<typeof Rule>

export const Ruleset = Rule.array().meta({
  ref: "PermissionRuleset",
})
export type Ruleset = z.infer<typeof Ruleset>

export const Request = z
  .object({
    id: PermissionID.zod,
    sessionID: SessionID.zod,
    permission: z.string(),
    patterns: z.string().array(),
    metadata: z.record(z.string(), z.any()),
    always: z.string().array(),
    tool: z
      .object({
        messageID: MessageID.zod,
        callID: z.string(),
      })
      .optional(),
  })
  .meta({
    ref: "PermissionRequest",
  })
export type Request = z.infer<typeof Request>

export const Reply = z.enum(["once", "always", "reject"])
export type Reply = z.infer<typeof Reply>

export const Approval = z.object({
  projectID: ProjectID.zod,
  patterns: z.string().array(),
})

export const Event = {
  Asked: BusEvent.define("permission.asked", Request),
  Replied: BusEvent.define(
    "permission.replied",
    z.object({
      sessionID: SessionID.zod,
      requestID: PermissionID.zod,
      reply: Reply,
    }),
  ),
}

export class RejectedError extends Schema.TaggedErrorClass<RejectedError>()("PermissionRejectedError", {}) {
  override get message() {
    return "The user rejected permission to use this specific tool call."
  }
}

export class CorrectedError extends Schema.TaggedErrorClass<CorrectedError>()("PermissionCorrectedError", {
  feedback: Schema.String,
}) {
  override get message() {
    return `The user rejected permission to use this specific tool call with the following feedback: ${this.feedback}`
  }
}

export class DeniedError extends Schema.TaggedErrorClass<DeniedError>()("PermissionDeniedError", {
  ruleset: Schema.Any,
}) {
  override get message() {
    return `The user has specified a rule which prevents you from using this specific tool call. Here are some of the relevant rules ${JSON.stringify(this.ruleset)}`
  }
}

export type PermissionError = DeniedError | RejectedError | CorrectedError

interface PendingEntry {
  info: Request
  ruleset: Ruleset // kilocode_change
  deferred: Deferred.Deferred<void, RejectedError | CorrectedError>
}

type State = {
  pending: Map<PermissionID, PendingEntry>
  approved: Ruleset
  session: Record<string, Ruleset> // kilocode_change
}

export const AskInput = Request.partial({ id: true }).extend({
  ruleset: Ruleset,
})

export const ReplyInput = z.object({
  requestID: PermissionID.zod,
  reply: Reply,
  message: z.string().optional(),
})

// kilocode_change start
export const SaveAlwaysRulesInput = z.object({
  requestID: PermissionID.zod,
  approvedAlways: z.string().array().optional(),
  deniedAlways: z.string().array().optional(),
})

export const AllowEverythingInput = z.object({
  enable: z.boolean(),
  requestID: Identifier.schema("permission").optional(),
  sessionID: Identifier.schema("session").optional(),
})
// kilocode_change end

export declare namespace PermissionService {
  export interface Api {
    readonly ask: (input: z.infer<typeof AskInput>) => Effect.Effect<void, PermissionError>
    readonly reply: (input: z.infer<typeof ReplyInput>) => Effect.Effect<void>
    readonly list: () => Effect.Effect<Request[]>
    readonly saveAlwaysRules: (input: z.infer<typeof SaveAlwaysRulesInput>) => Effect.Effect<void> // kilocode_change
    readonly allowEverything: (input: z.infer<typeof AllowEverythingInput>) => Effect.Effect<void> // kilocode_change
    readonly pending: (id: string) => Effect.Effect<Request | undefined> // kilocode_change
  }
}

export class PermissionService extends ServiceMap.Service<PermissionService, PermissionService.Api>()(
  "@opencode/PermissionNext",
) {
  static readonly layer = Layer.effect(
    PermissionService,
    Effect.gen(function* () {
      const instanceState = yield* InstanceState.make<State>(() =>
        Effect.sync(() => {
          const row = Database.use((db) =>
            db.select().from(PermissionTable).where(eq(PermissionTable.project_id, Instance.project.id)).get(),
          )
          return {
            pending: new Map<PermissionID, PendingEntry>(),
            approved: row?.data ?? [],
            session: {}, // kilocode_change
          }
        }),
      )

      const ask = Effect.fn("PermissionService.ask")(function* (input: z.infer<typeof AskInput>) {
        const state = yield* InstanceState.get(instanceState)
        const { ruleset, ...request } = input
        const local = state.session[request.sessionID] ?? [] // kilocode_change
        let pending = false

        // kilocode_change start — force "ask" for config file edits
        const isProtected = ConfigProtection.isRequest(request)
        // kilocode_change end

        for (const pattern of request.patterns) {
          const rule = evaluate(request.permission, pattern, ruleset, state.approved, local) // kilocode_change — include session rules
          log.info("evaluated", { permission: request.permission, pattern, action: rule })
          if (rule.action === "deny") {
            return yield* new DeniedError({
              ruleset: ruleset.filter((rule) => Wildcard.match(request.permission, rule.permission)),
            })
          }
          // kilocode_change start — override "allow" to "ask" for config paths
          if (rule.action === "allow" && !isProtected) continue
          // kilocode_change end
          pending = true
        }

        if (!pending) return

        const id = request.id ?? PermissionID.ascending()
        // kilocode_change start — inject disableAlways metadata for config paths
        const info: Request = {
          id,
          ...request,
          metadata: {
            ...request.metadata,
            ...(isProtected ? { [ConfigProtection.DISABLE_ALWAYS_KEY]: true } : {}),
          },
        }
        // kilocode_change end
        log.info("asking", { id, permission: info.permission, patterns: info.patterns })

        const deferred = yield* Deferred.make<void, RejectedError | CorrectedError>()
        state.pending.set(id, { info, ruleset, deferred }) // kilocode_change — store ruleset
        void Bus.publish(Event.Asked, info)
        return yield* Effect.ensuring(
          Deferred.await(deferred),
          Effect.sync(() => {
            state.pending.delete(id)
          }),
        )
      })

      const reply = Effect.fn("PermissionService.reply")(function* (input: z.infer<typeof ReplyInput>) {
        const state = yield* InstanceState.get(instanceState)
        const existing = state.pending.get(input.requestID)
        if (!existing) return

        state.pending.delete(input.requestID)
        void Bus.publish(Event.Replied, {
          sessionID: existing.info.sessionID,
          requestID: existing.info.id,
          reply: input.reply,
        })

        if (input.reply === "reject") {
          yield* Deferred.fail(
            existing.deferred,
            input.message ? new CorrectedError({ feedback: input.message }) : new RejectedError(),
          )

          for (const [id, item] of state.pending.entries()) {
            if (item.info.sessionID !== existing.info.sessionID) continue
            state.pending.delete(id)
            void Bus.publish(Event.Replied, {
              sessionID: item.info.sessionID,
              requestID: item.info.id,
              reply: "reject",
            })
            yield* Deferred.fail(item.deferred, new RejectedError())
          }
          return
        }

        yield* Deferred.succeed(existing.deferred, undefined)
        if (input.reply === "once") return

        // kilocode_change start — downgrade "always" to "once" for config file edits
        if (ConfigProtection.isRequest(existing.info)) return
        // kilocode_change end

        for (const pattern of existing.info.always) {
          state.approved.push({
            permission: existing.info.permission,
            pattern,
            action: "allow",
          })
        }

        for (const [id, item] of state.pending.entries()) {
          if (item.info.sessionID !== existing.info.sessionID) continue
          const ok = item.info.patterns.every(
            (pattern) => evaluate(item.info.permission, pattern, item.ruleset, state.approved).action === "allow", // kilocode_change — include original ruleset
          )
          if (!ok) continue
          state.pending.delete(id)
          void Bus.publish(Event.Replied, {
            sessionID: item.info.sessionID,
            requestID: item.info.id,
            reply: "always",
          })
          yield* Deferred.succeed(item.deferred, undefined)
        }

        // TODO: we don't save the permission ruleset to disk yet until there's
        // UI to manage it
        // db().insert(PermissionTable).values({ projectID: Instance.project.id, data: s.approved })
        //   .onConflictDoUpdate({ target: PermissionTable.projectID, set: { data: s.approved } }).run()

        // kilocode_change start — persist always-rules to global config
        const alwaysRules: Ruleset = existing.info.always.map((pattern) => ({
          permission: existing.info.permission,
          pattern,
          action: "allow" as const,
        }))
        if (alwaysRules.length > 0) {
          yield* Effect.promise(() => Config.updateGlobal({ permission: toConfig(alwaysRules) }, { dispose: false }))
        }
        // kilocode_change end
      })

      const list = Effect.fn("PermissionService.list")(function* () {
        const state = yield* InstanceState.get(instanceState)
        return Array.from(state.pending.values(), (item) => item.info)
      })

      // kilocode_change start
      const saveAlwaysRules = Effect.fn("PermissionService.saveAlwaysRules")(function* (
        input: z.infer<typeof SaveAlwaysRulesInput>,
      ) {
        const state = yield* InstanceState.get(instanceState)
        const existing = state.pending.get(input.requestID)
        if (!existing) return

        // Skip rule persistence for config file edits
        if (ConfigProtection.isRequest(existing.info)) return

        const validRules = new Set([...(existing.info.metadata?.rules ?? []), ...existing.info.always])
        const permission = existing.info.permission

        const approvedSet = new Set(input.approvedAlways ?? [])
        const deniedSet = new Set(input.deniedAlways ?? [])
        const newRules: Ruleset = []
        for (const pattern of validRules) {
          if (approvedSet.has(pattern)) newRules.push({ permission, pattern, action: "allow" })
          if (deniedSet.has(pattern)) newRules.push({ permission, pattern, action: "deny" })
        }
        state.approved.push(...newRules)

        if (newRules.length > 0) {
          yield* Effect.promise(() => Config.updateGlobal({ permission: toConfig(newRules) }, { dispose: false }))
        }

        // Auto-resolve other pending permissions now covered by new rules
        yield* drainCovered(
          state.pending as unknown as Map<string, PendingEntry>,
          state.approved,
          DeniedError,
          input.requestID as unknown as string,
        )
      })

      const allowEverything = Effect.fn("PermissionService.allowEverything")(function* (
        input: z.infer<typeof AllowEverythingInput>,
      ) {
        const state = yield* InstanceState.get(instanceState)

        if (!input.enable) {
          if (input.sessionID) {
            delete state.session[input.sessionID]
            return
          }
          const idx = state.approved.findLastIndex(
            (r) => r.permission === "*" && r.pattern === "*" && r.action === "allow",
          )
          if (idx >= 0) state.approved.splice(idx, 1)
          return
        }

        const rule = { permission: "*", pattern: "*", action: "allow" } as const
        if (input.sessionID) state.session[input.sessionID] = [rule]
        else state.approved.push(rule)

        if (input.requestID) {
          const entry = state.pending.get(PermissionID.make(input.requestID))
          if (entry && (!input.sessionID || entry.info.sessionID === input.sessionID)) {
            state.pending.delete(PermissionID.make(input.requestID))
            void Bus.publish(Event.Replied, {
              sessionID: entry.info.sessionID,
              requestID: entry.info.id,
              reply: "once",
            })
            yield* Deferred.succeed(entry.deferred, undefined)
          }
        }

        for (const [id, entry] of state.pending) {
          if (input.sessionID && entry.info.sessionID !== input.sessionID) continue
          if (ConfigProtection.isRequest(entry.info)) continue
          state.pending.delete(id)
          void Bus.publish(Event.Replied, {
            sessionID: entry.info.sessionID,
            requestID: entry.info.id,
            reply: "once",
          })
          yield* Deferred.succeed(entry.deferred, undefined)
        }
      })

      const pending = Effect.fn("PermissionService.pending")(function* (id: string) {
        const state = yield* InstanceState.get(instanceState)
        return state.pending.get(PermissionID.make(id))?.info
      })
      // kilocode_change end

      return PermissionService.of({ ask, reply, list, saveAlwaysRules, allowEverything, pending })
    }),
  )
}

export function evaluate(permission: string, pattern: string, ...rulesets: Ruleset[]): Rule {
  const merged = rulesets.flat()
  log.info("evaluate", { permission, pattern, ruleset: merged })
  const match = merged.findLast(
    (rule) => Wildcard.match(permission, rule.permission) && Wildcard.match(pattern, rule.pattern),
  )
  return match ?? { action: "ask", permission, pattern: "*" }
}

// kilocode_change start
/**
 * Permissions typed as PermissionAction in the config schema (scalar-only).
 * These must be serialized as "allow"/"deny"/"ask", not as { "*": "allow" }.
 */
const SCALAR_ONLY_PERMISSIONS = new Set([
  "todowrite",
  "todoread",
  "question",
  "webfetch",
  "websearch",
  "codesearch",
  "doom_loop",
])

export function toConfig(rules: Ruleset): Config.Permission {
  const result: Config.Permission = {}
  for (const rule of rules) {
    const existing = result[rule.permission]

    if (SCALAR_ONLY_PERMISSIONS.has(rule.permission)) {
      if (rule.pattern === "*") result[rule.permission] = rule.action
      continue
    }

    if (existing === undefined || existing === null) {
      result[rule.permission] = { [rule.pattern]: rule.action }
      continue
    }
    if (typeof existing === "string") {
      result[rule.permission] = { "*": existing, [rule.pattern]: rule.action }
      continue
    }
    existing[rule.pattern] = rule.action
  }
  return result
}
// kilocode_change end
