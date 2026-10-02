# Projects: from an approved idea to a Cowork project

The research desks fill idea banks. This layer lets Yuke pick an idea and get back a project folder that Claude Cowork can run as parallel sessions.

```
idea bank row → Approve (Yuke) → project record on the board → builder routine (Opus 5.5)
→ pull request in the projects repository → Merge (Yuke) → Cowork project, one session per workstream
→ result recorded on the board → the manager marks the bank row tested or dropped
```

Two human steps create a project: approve the idea, merge the pull request. A third closes it: record the result.

## Pieces

| Piece | Where | What it does |
|---|---|---|
| Approve link | every row of an idea bank page (`/docs/ideas-*`) | Opens `/projects/new`, the confirm page: the idea, optional notes for the builder, the board token. |
| Project record | `projects` table in the Board Durable Object (`src/board.ts`) | A copy of the approved row (bank rows have no id and the manager rewrites the bank), Yuke's notes, the status, the pull-request and run links, a history. |
| Project page | `/projects/<id>`, and the Projects tab on the board | Where the project stands and the one thing to do next. `ready` and `failed` projects also show under "Needs attention". |
| Builder | a Claude Code cloud routine on the private repository `yukewF2023/projects`, prompt `builder/PROMPT.md` there | Reads the idea, the memos behind it and the goal's brief; writes `<slug>/` to the contract in `builder/SPEC.md`; opens a pull request; reports to the board. |
| Bank link | `manager/PROMPT.md`, idea-bank section | The manager pins a row that has a project and sets its Status from the project. |

## Statuses

`approved` → `building` → `ready` (pull request open) → `active` (merged, running in Cowork) → `done` or `dropped`. `failed` means the build stopped; the project page offers "Build again".

Who moves it: approving creates `approved`; the builder sets `building`, `ready` and `failed` (and `active` for merged folders, on its next run); Yuke sets `active` ("I merged it"), `done` and `dropped` on the project page.

## API

- Public: `GET /api/projects[?status=]`, `GET /api/projects/<id>`, and `projects` in `/api/status`.
- Manager token: `GET|POST /manager/projects`, `GET|PATCH /manager/projects/<id>` with `{status, slug, pr_url, session_url, result, note, actor}`.
- Web forms (`POST /projects`, board token as a form field like `/goals`): `action=approve|rebuild|merged|result`.
- CLI: `scripts/board.sh projects [status]`, `project <id>`, `project-set <id> '<json>'`.
- `GET /api/tasks?key=<task key>` finds a task by its key; the builder uses it to read the memos named in a row's "Seen" cell.

Approving copies the row by position when the bank is still at the version the page showed, otherwise by its exact idea text; if neither matches, the page says the bank changed and nothing is approved. An idea with an open project cannot be approved twice.

## Setup (one time)

1. **Repository.** `yukewF2023/projects`, private. It holds `builder/` and one folder per project. Install the Claude GitHub App on it.
2. **Routine.** A Claude Code routine "Project builder": model `claude-opus-5-5`; tools Bash, Read, Write, Edit, Glob, Grep; repository `yukewF2023/projects`; the manager's environment (`WORKER_URL`, `ORCHESTRATOR_TOKEN`; network access to the Worker host and GitHub); no schedule. Kickoff prompt: check the env vars exist, then read `builder/PROMPT.md` and follow it.
3. **Trigger.** On the routine's page: Edit → Add another trigger → API → Generate token. Then, in this repository:
   `npx wrangler secret put BUILDER_FIRE_URL` (the `…/routines/<id>/fire` URL shown) and `npx wrangler secret put BUILDER_FIRE_TOKEN`. Never put them in `.dev.vars`: `npm run secrets:push` only carries the two board tokens.

Until step 3 is done, approving still records the project; its page says the trigger is not configured and nothing starts by itself. Run the builder by hand from a clone of the projects repository:

```bash
claude -p "Read builder/PROMPT.md and follow it." --model claude-opus-5-5
```

with `ORCHESTRATOR_TOKEN` in the environment (reads use the public API; `project-set` needs the token).

State on 2026-10-02: the board code and the builder files are written and tested locally; the repository, the routine and the trigger are not created yet.

## After the merge

1. Pull the projects repository.
2. Follow `<slug>/cowork/SETUP.md`: create the Cowork project, attach the folder, paste `cowork/project-instructions.md`, upload the skill zip, run `cowork/sessions/00-setup.md`.
3. Open one session per file in `cowork/sessions/`; they run at the same time, each on its own workstream.
4. When the project reaches the decision rule in its `RESULT.md`, record the one line on `/projects/<id>`.

Creating the Cowork project is manual; nothing here drives the desktop app.

## Limits and choices

- **One repository, pull requests only.** The builder can write to one repository and never to its `main`. Idea text comes from research agents that read the web, so the builder holds no token that could create or delete repositories.
- **Notes are public**, like everything on the board. The projects repository is private.
- **The result is typed by hand.** A Cowork session cannot write to the board.
- **Bank rows are matched by text.** The manager keeps an approved row's text unchanged and writes `(P<id>)` in its Status cell; the bank page uses either to show the project instead of "Approve →".
- Not verified yet: that a cloud routine can open a pull request on its repository (the builder falls back to a compare link), and whether routines expose a reasoning-effort setting.
