# opencode-autogoal

基于 [OpenCode](https://opencode.ai) 的自主目标驱动插件，支持预算控制、生命周期管理和独立完成验证。

## 特性

- **4 个独立工具** — `create_goal`、`get_goal`、`update_goal`、`set_goal_budget`
- **4 态生命周期** — `active` → `paused` / `blocked` / `complete`，外加 `cancelled`
- **预算控制** — 可选 turn 上限 + 挂钟时间上限，超限自动 `blocked`
- **安全上限** — 50 轮硬限制，防止无限循环
- **独立验证** — `goal-verify` 子 agent 独立检查代码库后才标记完成
- **中断自动暂停** — 按 `Esc` 自动暂停 goal
- **持久化** — 状态存在 `Session.metadata` (SQLite)，重启不丢失
- **子 agent 权限隔离** — 子 agent 只能 `get` 和 `complete` 父 session 的 goal
- **`/goal` 子命令** — `/goal pause`、`/goal resume`、`/goal cancel`、`/goal status`

## 安装

本地安装（推荐）：

```json
{
  "plugin": ["/path/to/opencode-goal-plugin"]
}
```

或从 GitHub 安装：

```
opencode plugin https://github.com/fuhongtao1010-oss/opencode-autogoal
```

## 使用

### 启动 goal

```
/goal 将认证模块重构为 JWT 方案
```

agent 会根据目标创建 goal，设置完成标准，然后自主工作。

### 工具

| 工具 | 说明 |
|------|------|
| `create_goal` | 创建新 goal。必须提供 `objective` + `completion_criterion`。可选 `turn_budget`、`wall_clock_budget_ms`。 |
| `get_goal` | 查看当前 goal 状态（状态、轮次、耗时、预算）。 |
| `update_goal` | 变更 goal 状态：`complete`、`paused`、`blocked`（需提供 reason）、`active`（恢复）、`cancelled`。 |
| `set_goal_budget` | 为活跃 goal 设置预算上限。 |

### 完成验证

主 session 调用 `update_goal({status:"complete"})` 时会被**阻止**。agent 必须通过 Task 工具启动 `goal-verify` 子 agent。子 agent 会独立检查代码库实际状态，所有要求满足后才标记完成。

### `/goal` 子命令

| 命令 | 效果 |
|------|------|
| `/goal` | 启动新 goal |
| `/goal pause` | 暂停活跃 goal |
| `/goal resume` | 恢复已暂停/阻塞的 goal |
| `/goal cancel` | 丢弃当前 goal |
| `/goal status` | 查看当前 goal 状态 |

### 预算示例

```
/goal 优化数据库查询，限制 5 轮
```

agent 会：
1. 创建带 `turn_budget=5` 的 goal
2. 自主工作最多 5 个续跑轮次
3. 预算耗尽后自动 blocked

## v2 改进

| 改进项 | v1 | v2 |
|--------|----|----|
| 工具 | 1 个工具 + `op` 参数 | 4 个独立工具 |
| 状态 | active / paused / complete | 新增 `blocked` 状态 |
| 预算 | 无 | turn + 挂钟时间预算 |
| 安全上限 | 无 | 50 轮硬限制 |
| `/goal pause/resume/cancel` | 模型自行处理 | 内置子命令路由 |
| 并发防护 | 无 | `inFlight` 去重 |
| complete 阻塞 | 抛 Error | 返回引导信息 |

## 许可证

MIT
