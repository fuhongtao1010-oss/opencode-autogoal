import type { Plugin, PluginModule, PluginInput, Hooks, ToolContext, ToolResult } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin/tool"
import { createOpencodeClient } from "@opencode-ai/sdk/v2"
import type { Session } from "@opencode-ai/sdk/v2"
import {
  GOAL_COMMAND_TEMPLATE,
  VERIFY_AGENT_PROMPT,
  continuationPrompt,
  subagentGoalContext,
} from "./prompts"
import {
  type GoalData,
  type GoalBudget,
  type GoalStatus,
  createGoal,
  canTransition,
  isOverBudget,
  getWallClockMs,
  formatGoalForModel,
  formatDuration,
} from "./goal"

async function readGoal(
  client: ReturnType<typeof createOpencodeClient>,
  sessionID: string,
): Promise<GoalData | null> {
  const session = await getSession(client, sessionID)
  return (session?.metadata?.goal as GoalData) ?? null
}

async function writeGoal(
  client: ReturnType<typeof createOpencodeClient>,
  sessionID: string,
  goal: GoalData | null,
): Promise<void> {
  const session = await getSession(client, sessionID)
  if (!session) throw new Error("Failed to get session")

  const existing: Record<string, unknown> = session.metadata ?? {}
  let metadata: Record<string, unknown>
  if (goal === null) {
    const { goal: _, ...rest } = existing
    metadata = rest
  } else {
    goal.updatedAt = Date.now()
    metadata = { ...existing, goal }
  }
  await client.session.update({ sessionID, metadata })
}

async function getSession(
  client: ReturnType<typeof createOpencodeClient>,
  sessionID: string,
): Promise<Session | null> {
  try {
    const result = await client.session.get({ sessionID })
    return ((result as any)?.data as Session) ?? null
  } catch {
    return null
  }
}

function isSubAgent(session: Session | null): boolean {
  return !!session?.parentID
}

function targetSessionID(session: Session | null): string {
  return session?.parentID ?? session?.id ?? ""
}

const serverPlugin: Plugin = async (input: PluginInput): Promise<Hooks> => {
  const v1Client = (input.client as any)._client
  const v1Config = v1Client?.getConfig?.() ?? {}
  const client = createOpencodeClient({
    baseUrl: input.serverUrl.origin,
    headers: v1Config.headers,
    fetch: v1Config.fetch,
  })

  const abortedSessions = new Set<string>()
  const inFlight = new Set<string>()

  async function pauseOnAbort(sessionID: string) {
    if (!abortedSessions.has(sessionID)) return
    abortedSessions.delete(sessionID)
    const goal = await readGoal(client, sessionID)
    if (!goal || goal.status !== "active") return
    goal.status = "paused"
    goal.wallClockAccumulatedMs += Date.now() - goal.wallClockStartedAt
    await writeGoal(client, sessionID, goal)
  }

  async function queueContinuation(sessionID: string) {
    if (inFlight.has(sessionID)) return
    inFlight.add(sessionID)
    try {
      await pauseOnAbort(sessionID)
      const goal = await readGoal(client, sessionID)
      if (!goal || goal.status !== "active") return

      const over = isOverBudget(goal)
      if (over) {
        goal.status = "blocked"
        goal.wallClockAccumulatedMs += Date.now() - goal.wallClockStartedAt
        goal.terminalReason = over
        await writeGoal(client, sessionID, goal)
        return
      }

      goal.continuationCount++
      await writeGoal(client, sessionID, goal)

      await client.session.promptAsync({
        sessionID,
        parts: [{
          type: "text" as const,
          text: continuationPrompt(goal),
          synthetic: true,
        }],
      })
    } catch {
    } finally {
      inFlight.delete(sessionID)
    }
  }

  const createGoalTool = tool({
    description: `Create a new goal for the current session. Requires objective and completion_criterion. Optionally set turn or wall-clock budget limits. Use this when entering goal mode via /goal or when user asks for autonomous multi-turn work.`,
    args: {
      objective: tool.schema.string().describe("The goal objective - what needs to be achieved"),
      completion_criterion: tool.schema.string().describe("Concrete, checkable conditions that prove the goal is done"),
      turn_budget: tool.schema.number().optional().describe("Maximum number of autonomous continuation turns"),
      wall_clock_budget_ms: tool.schema.number().optional().describe("Maximum wall clock time in milliseconds"),
    },
    async execute(args, ctx: ToolContext): Promise<ToolResult> {
      const session = await getSession(client, ctx.sessionID)
      if (isSubAgent(session)) {
        return "Error: sub-agents cannot create goals. Only the main session can create goals."
      }
      const existing = await readGoal(client, ctx.sessionID)
      if (existing && existing.status !== "complete") {
        return `Error: a goal already exists with status "${existing.status}". Cancel it first with update_goal({status:"cancelled"}) or resume it with update_goal({status:"active"}).`
      }

      if (!args.objective?.trim()) return "Error: objective is required"
      if (!args.completion_criterion?.trim()) return "Error: completion_criterion is required"

      const budget: GoalBudget = {}
      if (args.turn_budget) budget.turnBudget = args.turn_budget
      if (args.wall_clock_budget_ms) budget.wallClockBudgetMs = args.wall_clock_budget_ms

      const goal = createGoal(args.objective, args.completion_criterion, budget)
      await writeGoal(client, ctx.sessionID, goal)
      return `Goal created successfully.

${formatGoalForModel(goal)}

Now work autonomously toward this goal. Use get_goal to check status, update_goal to change state, and set_goal_budget to adjust limits.`
    },
  })

  const getGoalTool = tool({
    description: `Get the current goal state for this session. Returns objective, completion criterion, status, turn count, wall clock time, and budget usage.`,
    args: {},
    async execute(_args, ctx: ToolContext): Promise<ToolResult> {
      const session = await getSession(client, ctx.sessionID)
      const target = targetSessionID(session)
      if (!target) return "No session found."
      const goal = await readGoal(client, target)
      if (!goal) return "No active goal."
      return formatGoalForModel(goal)
    },
  })

  const updateGoalTool = tool({
    description: `Update the status of the current goal.

Status options:
- "complete": Mark goal as complete (main session → BLOCKED, must use goal-verify sub-agent; sub-agent → allowed)
- "paused": Pause an active goal
- "blocked": Mark goal as blocked with a reason
- "active": Resume a paused or blocked goal
- "cancelled": Discard the goal entirely

Use "blocked" when you cannot proceed (bugs, missing deps, budget exhausted). Use "cancelled" to start fresh.`,
    args: {
      status: tool.schema.enum(["complete", "paused", "blocked", "active", "cancelled"]).describe("New goal status"),
      reason: tool.schema.string().optional().describe("Required when status is 'blocked'. Reason for blocking."),
    },
    async execute(args, ctx: ToolContext): Promise<ToolResult> {
      const session = await getSession(client, ctx.sessionID)
      const isSub = isSubAgent(session)
      const target = targetSessionID(session)
      if (!target) return "No session found."

      if (args.status === "complete") {
        if (isSub) {
          const parentGoal = await readGoal(client, target)
          if (!parentGoal) return "No goal to complete in the parent session."
          if (parentGoal.status !== "active") {
            return `Parent session goal is not active (status: ${parentGoal.status}). Cannot complete.`
          }
          parentGoal.status = "complete"
          parentGoal.wallClockAccumulatedMs += Date.now() - parentGoal.wallClockStartedAt
          await writeGoal(client, target, parentGoal)
          return `Goal completed and verified: "${parentGoal.objective}"`
        }
        return `BLOCKED: Call the \`goal-verify\` sub-agent via the Task tool to independently verify all requirements before marking the goal complete.

If the sub-agent reports missing work, fix it and try again.`
      }

      if (isSub) {
        return `Error: sub-agents can only call update_goal with status "complete". Lifecycle operations (paused, blocked, active, cancelled) are restricted to the main session.`
      }

      if (args.status === "cancelled") {
        const goal = await readGoal(client, ctx.sessionID)
        if (!goal) return "No goal to cancel."
        await writeGoal(client, ctx.sessionID, null)
        return `Goal cancelled: "${goal.objective}"`
      }

      const goal = await readGoal(client, ctx.sessionID)
      if (!goal) return "No goal to update."

      if (!canTransition(goal, args.status)) {
        return `Goal cannot transition from "${goal.status}" to "${args.status}".`
      }

      if (args.status === "blocked") {
        if (!args.reason?.trim()) {
          return "Error: reason is required when status is 'blocked'. Provide a clear explanation of why the goal cannot proceed."
        }
        goal.wallClockAccumulatedMs += Date.now() - goal.wallClockStartedAt
        goal.terminalReason = args.reason.trim()
      }

      if (args.status === "paused") {
        goal.wallClockAccumulatedMs += Date.now() - goal.wallClockStartedAt
      }

      if (args.status === "active") {
        goal.wallClockStartedAt = Date.now()
        goal.continuationCount = 0
      }

      goal.status = args.status
      await writeGoal(client, ctx.sessionID, goal)
      return `Goal ${args.status}: "${goal.objective}"${goal.terminalReason ? `\nReason: ${goal.terminalReason}` : ""}`
    },
  })

  const setGoalBudgetTool = tool({
    description: `Set or update budget limits on the current active goal. At least one budget limit must be provided.`,
    args: {
      turn_budget: tool.schema.number().optional().describe("Maximum number of autonomous continuation turns"),
      wall_clock_budget_ms: tool.schema.number().optional().describe("Maximum wall clock time in milliseconds"),
    },
    async execute(args, ctx: ToolContext): Promise<ToolResult> {
      const session = await getSession(client, ctx.sessionID)
      if (isSubAgent(session)) {
        return "Error: sub-agents cannot set goal budgets."
      }
      const goal = await readGoal(client, ctx.sessionID)
      if (!goal) return "No active goal to set budget on."
      if (goal.status !== "active") {
        return `Cannot set budget on a ${goal.status} goal. Only active goals can have budgets.`
      }

      const hasTurn = typeof args.turn_budget === "number"
      const hasWall = typeof args.wall_clock_budget_ms === "number"
      if (!hasTurn && !hasWall) {
        return "Error: provide at least one budget limit (turn_budget or wall_clock_budget_ms)."
      }

      if (hasTurn) {
        if (args.turn_budget! < 1) return "Error: turn_budget must be at least 1."
        goal.budget.turnBudget = args.turn_budget!
      }
      if (hasWall) {
        if (args.wall_clock_budget_ms! < 1000) return "Error: wall_clock_budget_ms must be at least 1000 (1 second)."
        goal.budget.wallClockBudgetMs = args.wall_clock_budget_ms!
      }

      await writeGoal(client, ctx.sessionID, goal)
      return `Budget updated.

${formatGoalForModel(goal)}`
    },
  })

  return {
    tool: {
      create_goal: createGoalTool,
      get_goal: getGoalTool,
      update_goal: updateGoalTool,
      set_goal_budget: setGoalBudgetTool,
    },

    config(cfg: Record<string, unknown>) {
      if (!cfg.command) cfg.command = {}
      const commands = cfg.command as Record<string, { template: string; description?: string }>
      if (!commands["goal"]) {
        commands["goal"] = {
          template: GOAL_COMMAND_TEMPLATE,
          description: "Start autonomous goal mode - the agent will work autonomously until the objective is achieved",
        }
      }

      if (!cfg.agent) cfg.agent = {}
      const agents = cfg.agent as Record<string, Record<string, unknown>>
      if (!agents["goal-verify"]) {
        agents["goal-verify"] = {
          mode: "subagent",
          description: "Goal verification agent. Calls get_goal() to retrieve the objective and completion criterion, then independently inspects the current codebase state to determine whether all requirements are satisfied. Use via Task tool when update_goal({status:'complete'}) returns BLOCKED.",
          prompt: VERIFY_AGENT_PROMPT,
        }
      }
    },

    async "chat.message"(input, output) {
      if (input.agent !== "goal-verify") return
      const session = await getSession(client, input.sessionID)
      if (!session?.parentID) return
      const goal = await readGoal(client, session.parentID)
      if (!goal) return

      for (const part of output.parts) {
        if (part.type === "text" && (part as any).text) {
          (part as any).text = subagentGoalContext(goal.objective, goal.completionCriterion, (part as any).text)
        }
      }
    },

    async "command.execute.before"(input, output) {
      if (input.command !== "goal") return
      for (const part of output.parts) {
        if (part.type === "text") {
          (part as any).synthetic = true
        }
      }
      const objective = input.arguments?.trim()
      output.parts.unshift({
        type: "text" as const,
        text: objective ? `🎯 ${objective}` : "🎯 Starting goal mode",
      })
    },

    async event({ event }) {
      const evt = event as { type: string; properties: Record<string, any> }

      if (evt.type === "session.error") {
        const errorName = evt.properties?.error?.name
        if (errorName === "MessageAbortedError") {
          const sessionID: string | undefined = evt.properties.sessionID
          if (sessionID) abortedSessions.add(sessionID)
        }
      }

      if (evt.type === "session.status" && evt.properties?.status?.type === "idle") {
        const sessionID: string | undefined = evt.properties.sessionID
        if (!sessionID) return
        const session = await getSession(client, sessionID)
        if (session?.parentID) return
        void queueContinuation(sessionID)
      }

      if (evt.type === "message.updated" && evt.properties?.info?.role === "user") {
        const sessionID: string | undefined = evt.properties.sessionID
        if (!sessionID) return
        abortedSessions.delete(sessionID)
        const goal = await readGoal(client, sessionID)
        if (goal) {
          goal.continuationCount = 0
          await writeGoal(client, sessionID, goal)
        }
      }
    },
  }
}

const pluginModule: PluginModule = {
  id: "opencode-goal-plugin",
  server: serverPlugin,
}

export default pluginModule
