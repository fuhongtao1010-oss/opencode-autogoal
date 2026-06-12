// Goal 状态：active=活跃, paused=用户暂停, blocked=系统阻塞(预算耗尽/错误), complete=完成
export type GoalStatus = "active" | "paused" | "blocked" | "complete"

export interface GoalBudget {
  turnBudget?: number        // 最大自主续跑轮次
  wallClockBudgetMs?: number // 最大挂钟时间(毫秒)
}

export interface GoalData {
  id: string
  objective: string
  completionCriterion: string  // 完成标准 — 必须是可验证的具体条件
  status: GoalStatus
  continuationCount: number    // 已续跑次数
  wallClockStartedAt: number   // 当前轮开始时间戳(用于计算增量)
  wallClockAccumulatedMs: number // 已累积挂钟时间(不含当前轮)
  budget: GoalBudget
  createdAt: number
  updatedAt: number
  terminalReason?: string      // blocked 时的原因
  verificationCommand?: string // 可选 shell 命令，定期执行来检查目标是否达成
}

// 硬安全上限：最多续跑 50 轮，防止无限循环
export const MAX_CONTINUATIONS = 50

export function createGoal(
  objective: string,
  completionCriterion: string,
  budget?: GoalBudget,
  verificationCommand?: string,
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
    verificationCommand: verificationCommand?.trim() || undefined,
  }
}

// 状态机：检查能否从当前状态迁移到目标状态
export function canTransition(goal: GoalData, newStatus: GoalStatus): boolean {
  if (goal.status === "complete") return false // complete 是终态
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

// 获取当前总挂钟时间(含当前轮正在运行的时间)
export function getWallClockMs(goal: GoalData): number {
  if (goal.status === "active") {
    return goal.wallClockAccumulatedMs + (Date.now() - goal.wallClockStartedAt)
  }
  return goal.wallClockAccumulatedMs
}

// 检查是否超预算，返回原因字符串或 null
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

// 格式化 goal 信息供模型读取
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
  if (goal.verificationCommand) {
    lines.push(`Verification: ${goal.verificationCommand}`)
  }
  if (goal.terminalReason) {
    lines.push(`Reason: ${goal.terminalReason}`)
  }
  return lines.join("\n")
}
