# Projects, and the app in front of the board

Two things live here: how an approved idea becomes a Cowork project, and how a person reaches the board at all.

## Who can see the board

Nobody, through this Worker. It has no pages, and every route needs a token. People use the **`agent-board` DeepSpace app** (https://agent-board.app.space, repository `../agent-board`):

```
browser → agent-board.app.space (DeepSpace sign-in, owner check, holds APP_TOKEN as a secret)
        → this Worker: GET /api/* and /app/*  → Durable Object
VM workers, manager routine, builder routine → this Worker with their own tokens
```

- Anyone with a Google or GitHub account can sign in to a DeepSpace app, so the app's server checks on every call that the caller is the app's owner. Everyone else sees "This board is private" and gets no data. There is no viewer role yet.
- The app stores nothing of the board's. It shows what `/api/*` returns and passes the owner's clicks to `/app/*`, adding the signed-in email as `who` so the activity log names the person.
- Tokens: `ORCHESTRATOR_TOKEN` (manager, builder, the CLI: `/manager/*` and `GET /api/*`), `WORKER_TOKEN` (`/worker/*`), `APP_TOKEN` (the app: `/app/*` and `GET /api/*`). The app's token cannot reach `/manager/*` or `/worker/*`. `npm run setup:env` generates all three into `.dev.vars`; `npm run secrets:push` sends them to the Worker; the app gets its copy with `npx deepspace secrets set BOARD_APP_TOKEN=…` in the app's folder.

`/app/*` (JSON, `APP_TOKEN`):

| Route | Does |
|---|---|
| `GET /app/config` | whether the builder trigger, the wake trigger and the GitHub token are configured |
| `POST /app/projects` `{doc, version, row, idea, notes, who}` | approve an idea: records the project and fires the builder. `409 changed` when the bank moved on and the idea text is gone; `409 duplicate {id}` when the idea already has an open project |
| `POST /app/projects/:id` `{action, outcome, result, who}` | `rebuild`, `merged`, or `result` (outcome `done` or `dropped`, with one line) |
| `POST /app/feedback` `{doc, version, row, idea, kind, note, who}` | feedback on one idea-bank row (kind `generic`, `not_for_us`, `known`, `sharpen` or `more`; the row is found and copied as in an approval, `409 changed` when it is gone) or a note to the manager (kind `note`, no `idea`). Listed at `GET /api/feedback`; the manager closes each item with one line (`scripts/board.sh feedback`, `feedback-done`) |
| `GET /app/goals`, `PUT /app/goals` `{content, sha, message, who}` | read and commit GOALS.md through the GitHub contents API |
| `POST /app/wake` `{reason, who}` | fire the manager routine, with the same guards as `scripts/board.sh wake` |

## From an approved idea to a Cowork project

```
idea bank row → Approve (owner, in the app) → project record on the board → builder routine (Opus 5.5)
→ pull request in the projects repository → Merge (owner) → Cowork project, one session per workstream
→ result recorded in the app → the manager marks the bank row tested or dropped
```

Two human steps create a project: approve the idea, merge the pull request. A third closes it: record the result.

| Piece | Where | What it does |
|---|---|---|
| Approve link, confirm page, project page, Projects tab | the app (`src/pages/(app)/docs/[id].tsx`, `projects/new.tsx`, `projects/[id].tsx`, `home.tsx`) | The owner's side of the flow. Ready and failed projects also show under "Needs attention". |
| Project record | `projects` table in the Board Durable Object (`src/board.ts`) | A copy of the approved row (bank rows have no id and the manager rewrites the bank), the owner's notes, the status, the pull-request and run links, a history. |
| Idea rows | `src/ideas.ts`; returned as `idea_rows` by `GET /api/docs/:id` | One parser for both sides: the board copies a row on approval, the app puts "Approve →" on it. |
| Builder | a Claude Code cloud routine on the private repository `yukewF2023/projects`, prompt `builder/PROMPT.md` there | Reads the idea, the memos behind it and the goal's brief; writes `<slug>/` to the contract in `builder/SPEC.md`; opens a pull request; reports to the board. |
| Bank link | `manager/PROMPT.md`, "Projects" | The manager pins a row that has a project and sets its Status from the project. |

**Statuses.** `approved` → `building` → `ready` (pull request open) → `active` (merged, running in Cowork) → `done` or `dropped`. `failed` means the build stopped; the project page offers "Build again". Approving creates `approved`; the builder sets `building`, `ready` and `failed` (and `active` for merged folders, on its next run); the owner sets `active` ("I merged it"), `done` and `dropped`.

**Approving copies the row** by position when the bank is still at the version the page showed, otherwise by its exact idea text; if neither matches, nothing is approved and the app says the bank changed.

**Other routes.** Manager token: `GET|POST /manager/projects`, `GET|PATCH /manager/projects/<id>` with `{status, slug, pr_url, session_url, result, note, actor}`. Reads: `GET /api/projects[?status=]`, `/api/projects/<id>`, and `projects` in `/api/status`. `GET /api/tasks?key=<task key>` finds a task by key (the builder reads memos with it). CLI: `scripts/board.sh projects [status]`, `project <id>`, `project-set <id> '<json>'`.

## Setup (one time)

1. **Projects repository.** `yukewF2023/projects`, private (created 2026-10-02). It holds `builder/` and one folder per project. The Claude GitHub App is installed on it.
2. **Builder routine.** Done on 2026-10-02: `trig_01UAaXvfeZbp2kYPj9uDyrFx` "Project builder" (https://claude.ai/code/routines/trig_01UAaXvfeZbp2kYPj9uDyrFx): model `claude-opus-5-5`; tools Bash, Read, Write, Edit, Glob, Grep; repository `yukewF2023/projects`; the manager's environment `env_01HUXQno31z13QhWv3CBREm6` (`WORKER_URL`, `ORCHESTRATOR_TOKEN`); no schedule, fired only by the board. Kickoff prompt: check the env vars exist, then read `builder/PROMPT.md` and follow it. Created from a Claude Code session with the `RemoteTrigger` tool, action `create`.
3. **Builder trigger.** On the routine's page: Edit → Add another trigger → API → Generate token. Then, in this repository: `npx wrangler secret put BUILDER_FIRE_URL` (the `…/routines/<id>/fire` URL shown) and `npx wrangler secret put BUILDER_FIRE_TOKEN`. These two are not in `.dev.vars`; `npm run setup:env` would drop them.
4. **App.** In `../agent-board`: `npx deepspace secrets set BOARD_URL=<this Worker's address> BOARD_APP_TOKEN=<APP_TOKEN>`, then `npx deepspace deploy`. The DeepSpace account that registered the app is its owner.

Until step 3 is done, approving still records the project; its page says the trigger is not configured and nothing starts by itself. Run the builder by hand from a clone of the projects repository, with `ORCHESTRATOR_TOKEN` in the environment:

```bash
claude -p "Read builder/PROMPT.md and follow it." --model claude-opus-5-5
```

## After the merge

1. Pull the projects repository.
2. Follow `<slug>/cowork/SETUP.md`: create the Cowork project, attach the folder, paste `cowork/project-instructions.md`, upload the skill zip, run `cowork/sessions/00-setup.md`.
3. Open one session per file in `cowork/sessions/`; they run at the same time, each on its own workstream.
4. When the project reaches the decision rule in its `RESULT.md`, record the one line on the project's page in the app.

Creating the Cowork project is manual; nothing here drives the desktop app.

## Local development

```bash
npm run dev                                   # this Worker on http://localhost:8787 (JSON only)
cd ../agent-board && npx deepspace dev start  # the app on http://localhost:5173, using BOARD_URL_LOCAL
scripts/smoke.sh                              # the Worker's API, on a fresh .wrangler/state
```

The app's tests are described in its README. One of them renders the owner's screens against this local Worker.

## Limits and choices

- **One repository, pull requests only.** The builder can write to one repository and never to its `main`. Idea text comes from research agents that read the web, so the builder holds no token that could create or delete repositories.
- **The result is typed by hand.** A Cowork session cannot write to the board.
- **Bank rows are matched by text.** The manager keeps an approved row's text unchanged and writes `(P<id>)` in its Status cell; the app uses either to show the project instead of "Approve →".
- **The app's JavaScript bundle is public**, like any web app's; it contains no board data and no token.
- Not verified yet: that a cloud routine can open a pull request on its repository (the builder falls back to a compare link), and whether routines expose a reasoning-effort setting.
