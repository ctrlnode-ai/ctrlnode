# Product screenshots (CtrlNode.Web)

Captured from `http://localhost:5173` with **cursor-ide-browser** (no Playwright).

| File | Screen |
|------|--------|
| `01-projects.png` | Projects registry |
| `02-dashboard.png` | Project dashboard |
| `03-tasks-board.png` | Kanban board |
| `04-routines.png` | Routines list |
| `06-pipelines-designer.png` | Workflow designer (blank canvas) |
| `05-pipelines-list.png` | Workflows list (definitions) |
| `07-pipelines-new.png` | New workflow templates |
| `08-team.png` | Team / agents |
| `09-memory.png` | Memory explorer |
| `10-events.png` | Events feed |
| `11-bridge-setup.png` | Bridge setup & pairing tokens |
| `12-task-detail.png` | Task detail (done task) |
| `13-routine-set-trigger.png` | Routine/workflow designer — SET TRIGGER + Activate schedule |
| `14-step-node-dependencies.png` | Step panel — Sources / Destinations |

## Mintlify embed paths

After uploading PNGs to the docs repo under `images/product/`, use in MDX:

```md
![Projects list](/images/product/01-projects.png)
![Dashboard](/images/product/02-dashboard.png)
![Tasks Kanban](/images/product/03-tasks-board.png)
![Routines](/images/product/04-routines.png)
![Workflows list](/images/product/05-pipelines-list.png)
![Workflow designer](/images/product/06-pipelines-designer.png)
![New workflow](/images/product/07-pipelines-new.png)
![Team](/images/product/08-team.png)
![Memory](/images/product/09-memory.png)
![Events](/images/product/10-events.png)
![Bridge setup](/images/product/11-bridge-setup.png)
![Task detail](/images/product/12-task-detail.png)
![SET TRIGGER & Activate schedule](/images/product/13-routine-set-trigger.png)
![Step sources & destinations](/images/product/14-step-node-dependencies.png)
```

## GitHub raw URLs (Mintlify MCP branch)

After pushing these files to branch `docs/product-screenshots` on [ctrlnode-ai/ctrlnode](https://github.com/ctrlnode-ai/ctrlnode):

```text
https://raw.githubusercontent.com/ctrlnode-ai/ctrlnode/docs/product-screenshots/docs/product-screenshots/13-routine-set-trigger.png
https://raw.githubusercontent.com/ctrlnode-ai/ctrlnode/docs/product-screenshots/docs/product-screenshots/14-step-node-dependencies.png
```

## Mintlify MCP (when connected)

1. `checkout` → `admin-mcp/getting-started-ctrlnode-679c068`
2. Upload each PNG to `images/product/` (Mintlify dashboard or git on docs repo).
3. `edit_page` on each `getting-started/*` page — insert the figure block after the first `##` section (see `docs/mintlify-embed-patches.md`).
4. `save` with `mode: commit`, message: `docs: embed product screenshots in getting started`.

Branch: `admin-mcp/getting-started-ctrlnode-679c068`

Pages to update: `getting-started/projects`, `dashboard`, `tasks`, `routines`, `workflows`, `team`, `memory`, `events`, `bridge-setup`, optionally `quickstart`.
