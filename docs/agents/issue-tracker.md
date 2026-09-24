# 工单跟踪：GitHub

本仓库的工单、规格说明和路线图存放于 GitHub Issues，使用 `gh` CLI 操作。工单标题、正文、规格说明、地图内容和讨论统一使用中文。为兼容技能协议，固定章节名、字段名、标签、命令及标识符保留原文；triage 技能要求的固定 AI 声明也保留原文。

## 操作约定

- **创建工单**：`gh issue create --title "..." --body "..."`。多行正文使用 heredoc。
- **查看工单**：`gh issue view <number> --comments`；需要时用 `jq` 筛选评论，并一并检查标签。
- **列出工单**：`gh issue list --state open --json number,title,body,labels,comments`，按需用 `--label`、`--state` 筛选。
- **评论**：`gh issue comment <number> --body "..."`。
- **添加 / 移除标签**：`gh issue edit <number> --add-label "..."` / `--remove-label "..."`。
- **关闭**：`gh issue close <number> --comment "..."`。
- `gh` 在本仓库 clone 中运行时应使用 `origin` 对应的仓库 `oOSomnus/oho`；若任务明确指定其他仓库，显式指定目标，不要仅因存在 `upstream` 远程而切换目标。

## 将 PR 作为需求入口

**PRs as a request surface: no.** _(若本仓库将外部 PR 视为功能请求，可改为 `yes`；`/triage` 会读取此标记。)_

当前不将 PR 纳入 triage。若以后改为 `yes`，PR 与工单使用相同的标签和状态，并通过 `gh pr` 操作：

- **查看 PR**：`gh pr view <number> --comments` 和 `gh pr diff <number>`。
- **列出外部 PR**：`gh pr list --state open --json number,title,body,labels,author,authorAssociation,comments`；仅保留 `CONTRIBUTOR`、`FIRST_TIME_CONTRIBUTOR` 或 `NONE`，排除 `OWNER`、`MEMBER`、`COLLABORATOR`。
- **评论 / 标签 / 关闭**：使用 `gh pr comment`、`gh pr edit --add-label` / `--remove-label`、`gh pr close`。

GitHub 的 issue 与 PR 共用编号；裸编号（如 `#42`）可能对应任一类型。先运行 `gh pr view 42`，失败后再运行 `gh issue view 42`。

## 发布与读取

- 技能要求“发布到工单跟踪器”时，创建 GitHub Issue。
- 技能要求“读取相关工单”时，运行 `gh issue view <number> --comments`。

## Wayfinding 操作

Wayfinder 的地图和子工单也存放于 GitHub Issues。地图标题、工单标题及正文均用中文；地图和工单的固定章节名按 Wayfinder 格式保留原文。

- **地图**：创建带 `wayfinder:map` 标签的 issue，正文包含 Destination、Notes、Decisions so far、Not yet specified、Out of scope 等固定章节。
- **子工单**：创建地图的 GitHub sub-issue（使用 `gh api` 的 sub-issues endpoint）。若仓库未启用 sub-issues，则在地图中用 task list 链接子工单，并在子工单正文顶部写 `Part of #<map>`。类型标签使用 `wayfinder:<type>`（`research`、`prototype`、`grilling`、`task`）。认领后分配给负责推进地图的开发者。
- **阻塞关系**：优先使用 GitHub 原生 issue dependencies。添加依赖时，通过 `gh api` 请求 `<child>/dependencies/blocked_by`，并传入阻塞工单的数据库 `id`（不是 `#number` 或 `node_id`）。若功能不可用，则在子工单顶部使用 `Blocked by: #<n>, #<n>`。
- **Frontier 查询**：查询地图下未关闭的子工单，排除存在未关闭阻塞项或已有 assignee 的工单；按地图中的顺序取第一个可处理项。
- **认领**：`gh issue edit <n> --add-assignee @me`；认领是本次工作中的首次写操作。
- **解决**：先用 `gh issue comment <n> --body "<answer>"` 记录中文答案，再关闭工单，最后将简短中文结论及链接追加到地图的 Decisions so far。
