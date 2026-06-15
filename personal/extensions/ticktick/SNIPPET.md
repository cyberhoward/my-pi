### TickTick (`ticktick`)

Personal task management via TickTick. Use this for the user's personal tasks, todos, and project planning — **not** for agentic or coding task tracking.

- Actions: `list_projects`, `list_tasks`, `get_task`, `create_task`, `update_task`, `complete_task`, `uncomplete_task`, `delete_task`, `move_task`, `create_project`
- Supports natural language dates (`"tomorrow"`, `"next friday"`, `"in 3 days"`)
- Priority levels: `none`, `low`, `medium`, `high`
- `move_task` recreates the task in the target project, then deletes the original; the task ID changes and comments/history may not be preserved
- If auth fails, tell the user to run `tickrs init` and see `~/.my-pi/personal/extensions/ticktick/setup.md`
