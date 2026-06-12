# opencode-autogoal

基于 [OpenCode](https://opencode.ai) 的自主目标驱动插件，支持预算控制、生命周期管理和独立完成验证。

An [OpenCode](https://opencode.ai) plugin for autonomous goal-driven agent mode with budget control, lifecycle management, and independent verification.

---

## 特性 / Features

- **4 个独立工具** / 4 dedicated tools — `create_goal`、`get_goal`、`update_goal`、`set_goal_budget`
- **4 态生命周期** / 4-state lifecycle — `active` → `paused` / `blocked` / `complete`，外加 `cancelled`
- **预算控制** / Budget control — 可选 turn + 挂钟时间上限，超限自动 `blocked`
- **安全上限** / Safety limit — 50 轮硬限制，防止无限循环
- **独立验证** / Independent verification — `goal-verify` 子 agent 从零检查代码库后才标记完成
- **中断自动暂停** / Interrupt auto-pause — 按 `Esc` 自动暂停 goal
- **持久化** / Persistence — 状态存在 `Session.metadata` (SQLite)，重启不丢失
- **子 agent 权限隔离** / Permission isolation — 子 agent 只能 `get` 和 `complete` 父 session 的 goal
- **`/goal` 子命令** / Subcommands — `/goal pause`、`/goal resume`、`/goal cancel`、`/goal status`

## 安装 / Setup

本地安装（推荐）/ Install from local path:

```json
{
  "plugin": ["/path/to/opencode-goal-plugin"]
}
```

或从 GitHub 安装 / or from GitHub:

```
opencode plugin https://github.com/fuhongtao1010-oss/opencode-autogoal
```

## 使用 / Usage

### 启动 goal / Start a goal

```
/goal 将认证模块重构为 JWT 方案
/goal Refactor the authentication module to use JWT tokens
```

agent 创建 goal 后自主工作，完成后调用 goal-verify 子 agent 独立验证。

### 工具 / Tools

| 工具 / Tool | 说明 / Description |
|-------------|-------------------|
| `create_goal` | 创建新 goal。需 `objective` + `completion_criterion`。可选 `turn_budget`、`wall_clock_budget_ms`。 |
| `get_goal` | 查看当前 goal 状态（状态、轮次、耗时、预算）。 |
| `update_goal` | 变更状态：`complete` / `paused` / `blocked`(需reason) / `active`(恢复) / `cancelled` |
| `set_goal_budget` | 设置活跃 goal 的预算上限。 |

### 完成验证 / Completion verification

主 session 调 `update_goal({status:"complete"})` 时被**阻止**，必须通过 Task 工具启动 `goal-verify` 子 agent。子 agent 独立检查代码库实际状态，全部满足才标记完成。

### `/goal` 子命令 / Subcommands

| 命令 | 效果 |
|------|------|
| `/goal` | 启动新 goal |
| `/goal pause` | 暂停活跃 goal |
| `/goal resume` | 恢复已暂停/阻塞的 goal |
| `/goal cancel` | 丢弃当前 goal |
| `/goal status` | 查看当前 goal 状态 |

### 预算示例 / Budget example

```
/goal 优化数据库查询，限制 5 轮
/goal Optimize database queries with a 5-turn budget

1. 创建带 turn_budget=5 的 goal
2. 自主工作最多 5 个续跑轮次
3. 预算耗尽后自动 blocked
```

## 架构 / Architecture

```
User: /goal <objective>
  │
  ▼
┌──────────────────────────────────────────────┐
│  Turn 1                                      │
│  - create_goal({...})                        │
│  - Works autonomously                        │
└──────────────┬───────────────────────────────┘
               │  session.status → idle
               ▼
┌──────────────────────────────────────────────┐
│  Event hook                                  │
│  1. Checks goal is active                    │
│  2. Checks budget (turn/wall/max)            │
│  3. Increments continuationCount             │
│  4. promptAsync(continuationPrompt)          │
└──────────────┬───────────────────────────────┘
               │  (loops until done)
               ▼
┌──────────────────────────────────────────────┐
│  update_goal({status:"complete"})            │
│  → BLOCKED: use goal-verify sub-agent        │
│  → Sub-agent verifies independently          │
│  → If verified: complete                     │
└──────────────────────────────────────────────┘
```

## v2 改进 / What's new in v2

| 改进项 | v1 | v2 |
|--------|----|----|
| 工具 / Tools | 1 个 + `op` 参数 | 4 个独立工具 |
| 状态 / States | active / paused / complete | + `blocked` 状态 |
| 预算 / Budget | 无 | Turn + 挂钟时间预算 |
| 安全上限 / Safety | 无 | 50 轮硬限制 |
| `/goal` 子命令 | 模型自行处理 | 内置子命令路由 |
| 并发防护 / Guard | 无 | `inFlight` 去重 |
| complete 阻塞 | 抛 Error | 返回引导信息 |

## 许可证 / License

MIT
