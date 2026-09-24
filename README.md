# OMP 工作站

这是一个基于 [oh-my-pi（OMP）](https://github.com/can1357/oh-my-pi) 的个人工作站仓库，README 只记录本仓库相关的自定义配置与开发命令。

OMP 上游项目的功能介绍、安装、常规用法和其他项目文档，请参阅[上游 README](https://github.com/can1357/oh-my-pi/blob/main/README.md)。

## Automode 审批

将 `tools.approvalMode` 设为 `automode` 后，`read` 和 `write` tier 会自动批准；只有由该模式产生的 `exec` 审批请求会交给 `judge` 角色复核。工具或用户配置要求人工确认的提示仍需人工处理，任何显式拒绝仍然有效。

```yaml
tools:
  approvalMode: automode
modelRoles:
  judge: typesafe/jev-latest
retry:
  fallbackChains:
    judge:
      - typesafe/jev-preview
      - "@tiny"
      - "@smol"
```

Judge 收到的是有限的审批上下文，而不是完整会话记录或原始工具对象：

- 最近的用户请求，最多 4,000 个字符。
- 最多 8 条最近的非空用户/助手消息，总计最多 6,000 个字符；合成或归属于 agent 的用户消息会被排除。
- 工作目录，最多 4,000 个字符。
- 工具名、审批 tier，以及最多 2,000 个字符的格式化操作说明；工具调用 ID 不在 Judge 状态中。

文本会经过清理，并在可用时混淆已识别的秘密值。Judge 必须把这些字段视为不可信证据；只有当最新请求结合近期对话明确授权了这项具体操作及其风险时，才应允许。复核不可用时，支持交互审批的通道会转为人工确认；没有可用审批界面的路径会拒绝放行。

## Makefile 命令

根目录 Makefile 提供三个快捷目标，默认使用 `BUN=bun`：

| 目标 | 实际执行 |
| --- | --- |
| `make build` | `$(BUN) run build` |
| `make test` | `$(BUN) run test` |
| `make quick-install` | `$(BUN) setup` |

可以用 `BUN` 覆盖 Bun 命令，例如：

```sh
make build BUN=/path/to/bun
```
