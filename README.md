# opencode-autogoal

An [OpenCode](https://opencode.ai) plugin that enables autonomous goal-driven agent mode with budget control, lifecycle management, and independent completion verification.

## Features

- **4 dedicated tools** — `create_goal`, `get_goal`, `update_goal`, `set_goal_budget` instead of a single multiplexed tool
- **4-state lifecycle** — `active` → `paused` / `blocked` / `complete`, plus `cancelled` for discard
- **Budget control** — optional turn cap and wall-clock cap; auto-`blocked` when exceeded
- **Hard safety limit** — 50-turn maximum prevents runaway loops regardless of budget
- **Independent verification** — `goal-verify` sub-agent inspects the codebase from scratch before marking complete
- **Interrupt auto-pause** — Press `Esc` during execution pauses the goal
- **Session persistence** — Goal state stored in `Session.metadata` (SQLite), survives restarts
- **Sub-agent permission isolation** — Sub-agents can only `get` and `complete` the parent's goal
- **`/goal` subcommands** — `/goal pause`, `/goal resume`, `/goal cancel`, `/goal status`

## Setup

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-autogoal"]
}
```

OpenCode automatically installs the plugin on next run.

## Usage

### Start a goal

```
/goal Refactor the authentication module to use JWT tokens
```

The agent creates a goal with your objective and a completion criterion, then works autonomously.

### Tools

| Tool | Description |
|------|-------------|
| `create_goal` | Create a new goal. Requires `objective` + `completion_criterion`. Optional `turn_budget`, `wall_clock_budget_ms`. |
| `get_goal` | Return current goal state (status, turns, wall clock, budget). |
| `update_goal` | Change goal status: `complete`, `paused`, `blocked` (requires reason), `active` (resume), `cancelled`. |
| `set_goal_budget` | Set budget limits on an active goal. |

### Completion verification

When the agent calls `update_goal({status:"complete"})`, it is **blocked** in the main session. The agent must launch the `goal-verify` sub-agent via the Task tool. The sub-agent independently inspects the codebase — reads files, runs tests, checks integrations — and only marks the goal complete if all requirements are satisfied.

### `/goal` subcommands

| Command | Effect |
|---------|--------|
| `/goal` | Start a new goal |
| `/goal pause` | Pause active goal |
| `/goal resume` | Resume paused/blocked goal |
| `/goal cancel` | Discard current goal |
| `/goal status` | Show current goal state |

### Budget example

```
/goal Optimize database queries with a 5-turn budget

The agent will:
1. Create the goal with turn_budget=5
2. Work autonomously for up to 5 continuation turns
3. Auto-block when the budget is exhausted
```

## Architecture

```
User: /goal <objective>
  │
  ▼
┌──────────────────────────────────────────────┐
│  Turn 1                                      │
│  - create_goal({objective, completion_criterion, budget?}) │
│  - Works autonomously (read, edit, bash...)  │
└──────────────┬───────────────────────────────┘
               │  session.status → idle
               ▼
┌──────────────────────────────────────────────┐
│  Event hook                                  │
│  1. Checks goal is active                    │
│  2. Checks budget (turn/wall/max)            │
│  3. Increments continuationCount             │
│  4. client.promptAsync(continuationPrompt)   │
└──────────────┬───────────────────────────────┘
               │
               ▼  (loops until done)
┌──────────────────────────────────────────────┐
│  Agent calls update_goal({status:"complete"}) │
│  → BLOCKED: use goal-verify sub-agent        │
│  → Sub-agent verifies independently          │
│  → If verified: goal marked complete         │
│  → If not: agent keeps working               │
└──────────────────────────────────────────────┘
```

## What's new in v2

## What's new in v2
|-------------|----|----|
| Tools | 1 tool with `op` param | 4 dedicated tools |
| States | active / paused / complete | + `blocked` state |
| Budget | None | Turn + wall-clock budget |
| Safety limit | None | Hard 50-turn cap |
| `/goal pause/resume/cancel` | Handled by model | Built-in subcommand routing |
| Concurrency guard | None | `inFlight` dedup |
| `complete` blocking | Throws Error | Returns guided message |

## License

MIT
