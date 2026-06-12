export type GoalStatus = "active" | "paused" | "blocked" | "complete"

export interface GoalBudget {
  turnBudget?: number
  wallClockBudgetMs?: number
}

export interface GoalData {
  id: string
  objective: string
  completionCriterion: string
  status: GoalStatus
  continuationCount: number
  wallClockStartedAt: number
  wallClockAccumulatedMs: number
  budget: GoalBudget
  createdAt: number
  updatedAt: number
  terminalReason?: string
}

export const MAX_CONTINUATIONS = 50

export function createGoal(
  objective: string,
  completionCriterion: string,
  budget?: GoalBudget,
): GoalData {
  const now = Date.now()
  return {
    id: `goal_${now}_${Math.random().toString(36).slice(2, 8)}`,
    objective: objective.trim(),
    completionCriterion: completionCriterion.trim(),
    status: "active",
    continuationCount: 0,
    wallClockStartedAt: now,
    wallClockAccumulatedMs: 0,
    budget: budget ?? {},
    createdAt: now,
    updatedAt: now,
  }
}

export function canTransition(goal: GoalData, newStatus: GoalStatus): boolean {
  if (goal.status === "complete") return false
  switch (newStatus) {
    case "active":
      return goal.status === "paused" || goal.status === "blocked"
    case "paused":
      return goal.status === "active"
    case "blocked":
      return goal.status === "active"
    case "complete":
      return goal.status === "active"
    default:
      return false
  }
}

export function getWallClockMs(goal: GoalData): number {
  if (goal.status === "active") {
    return goal.wallClockAccumulatedMs + (Date.now() - goal.wallClockStartedAt)
  }
  return goal.wallClockAccumulatedMs
}

export function isOverBudget(goal: GoalData): string | null {
  if (goal.budget.turnBudget && goal.continuationCount >= goal.budget.turnBudget) {
    return `Turn budget exhausted (${goal.continuationCount}/${goal.budget.turnBudget})`
  }
  const wallMs = getWallClockMs(goal)
  if (goal.budget.wallClockBudgetMs && wallMs >= goal.budget.wallClockBudgetMs) {
    return `Wall clock budget exhausted (${Math.round(wallMs / 1000)}s/${Math.round(goal.budget.wallClockBudgetMs / 1000)}s)`
  }
  if (goal.continuationCount >= MAX_CONTINUATIONS) {
    return `Max continuations reached (${MAX_CONTINUATIONS})`
  }
  return null
}

export function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const secs = seconds % 60
  if (minutes < 60) return `${minutes}m ${secs}s`
  const hours = Math.floor(minutes / 60)
  const mins = minutes % 60
  return `${hours}h ${mins}m`
}

export function formatGoalForModel(goal: GoalData): string {
  const wallMs = getWallClockMs(goal)
  const lines = [
    `Goal: ${goal.objective}`,
    `Completion criterion: ${goal.completionCriterion}`,
    `Status: ${goal.status}`,
    `Turns used: ${goal.continuationCount}`,
    `Wall clock: ${formatDuration(wallMs)}`,
  ]
  if (goal.budget.turnBudget) {
    lines.push(`Turn budget: ${goal.continuationCount}/${goal.budget.turnBudget}`)
  }
  if (goal.budget.wallClockBudgetMs) {
    lines.push(`Wall clock budget: ${formatDuration(wallMs)}/${formatDuration(goal.budget.wallClockBudgetMs)}`)
  }
  const over = isOverBudget(goal)
  if (over) {
    lines.push(`Budget status: EXCEEDED - ${over}`)
  } else if (goal.budget.turnBudget || goal.budget.wallClockBudgetMs) {
    lines.push(`Budget status: within budget`)
  }
  if (goal.terminalReason) {
    lines.push(`Reason: ${goal.terminalReason}`)
  }
  return lines.join("\n")
}
