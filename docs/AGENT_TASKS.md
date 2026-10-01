# Agent tasks

How work reaches the coding agents. A task is one GitHub issue that one agent turns into one PR (see `AGENTS.md`, Execution scope). Anyone may draft an issue, including a person, a chat assistant or an agent in a consumer repository. An issue becomes implementable only once it is `spec:ready`.

## Roles

| Agent | Does |
| --- | --- |
| Claude Opus | Runs the loop (`/agent-loop`). Turns drafts into ready specs, writes new specs from open consumer requests and `ROADMAP.md`, reviews PRs against their spec and merges them. Implements critical-path and cross-cutting work itself (`agent:opus`): public renderer API, contract changes and anything a downstream consumer is blocked on. |
| ChatGPT Sol | Implements narrow, technically deep `agent:sol` tasks via the Codex `implementer-loop` skill. The spec should settle architecture, authority, formats and scope so Sol can spend depth on correctness rather than redesigning adjacent systems. Runs occasionally, separately from `/agent-loop`, through a backlog of up to three tasks that nothing else waits on. |
| Claude Sonnet | Implements `agent:sonnet` tasks: web lessons and authoring UI, docs, mechanical follow-ups. |
| GitHub Actions | The full deterministic gate on every PR (`ci.yml`, `pages.yml`, plus the path-triggered runtime-evidence workflows). |
| Codex review | Reviews each PR automatically when it is opened or marked ready; `@codex review` re-triggers it. |

## Labels

- `agent-task`: every task issue.
- `spec:draft`: written but not yet checked against the code. Do not implement.
- `spec:ready`: checked and implementable.
- `spec:needs-input`: blocked on a question for the owner, asked in a comment.
- `agent:opus`, `agent:sol`, `agent:sonnet`: the intended implementer.
- `in-progress`: an implementer has started; the PR will reference the issue.

## Picking up a task (implementers)

When asked to "pick up work", take the oldest open issue labeled `spec:ready` plus your `agent:*` label that has no `in-progress` label and whose "Start after" dependencies are merged. Add `in-progress`, branch `agent/<topic>` (or the branch the issue names) and follow the issue and `AGENTS.md`. Open the PR only when the branch is complete, with `Closes #N`. Never implement `spec:draft` or `spec:needs-input` issues. If the spec turns out to be wrong or impossible, comment on the issue, replace `spec:ready` with `spec:needs-input`, remove `in-progress` and stop; do not silently re-scope it.

## Implementer loop

An implementer run (Codex: the `implementer-loop` skill in `.agents/skills/`; Sonnet: dispatched by `/agent-loop`) takes exactly one action, in this priority order, then reports and exits.

1. **Fix your own open PR.** A PR of yours (its issue carries your `agent:*` label) needs work when:
   - a CI check failed;
   - a Codex review finding is neither fixed nor answered;
   - the loop driver posted a "changes needed" comment newer than your last push.

   Fix it on the same branch, push, and reply to each finding. After substantial fixes, comment `@codex review`. After three failed attempts on the same failure, comment what blocks you on the PR and stop touching it.
2. **Otherwise, wait if your PR is still in review.** If a PR of yours is open and only waiting on CI, Codex or the loop driver's merge, do nothing. One task in flight per implementer.
3. **Otherwise, start the next task** per "Picking up a task". Work in a fresh worktree from `origin/main`. Commit in small steps. Run the focused checks plus what the issue lists that CI does not run. Push, then open the PR with `Closes #N`. Wait for CI and the first Codex review, and handle them as in step 1 within the same run.
4. **Otherwise, exit.** Do not invent work: no new issues, no tooling, foundation or cleanup tasks.

An implementer never merges, never edits issue bodies, never writes specs and never changes a `spec:*` label except to replace `spec:ready` with `spec:needs-input` when the spec is wrong. That last case always comes with a comment explaining why and removal of `in-progress`.

## Writing an issue

**Title:** `<Area>: <what the consumer, learner or system gains>`, for example `Renderer: expose imported skinned GLB and clip playback to reusable game renderers`.

**Sizing:**
- One PR. Big enough to deliver a whole roadmap item or consumer request (or its Rust-model half or its renderer/web half), small enough that one agent finishes it in one session.
- Split only along the model/presentation seam: the renderer or web task starts after the renderer-independent Rust (or renderer-package contract) task merges.
- At most one change per versioned format (renderer package API, `docs/contracts/` schema, fixture or adapter envelope, scene snapshot version) per task.
- Pick the implementer by the table above: ambiguous, cross-cutting, public-API or consumer-blocking work → `agent:opus`; narrow but technically deep work with settled decisions, strong deterministic acceptance and no downstream waiters → `agent:sol`; lessons/authoring UI/docs and mechanical follow-ups → `agent:sonnet`.
- For `agent:sol`, keep breadth narrow even when implementation depth is high: pin the important decisions, name explicit out-of-scope boundaries, and do not rely on the implementer to decompose or redesign neighboring systems.

**Body:** use these sections in this order (the "Agent task" issue template has them):

1. **Header line:** source (roadmap slice/item or consumer request, e.g. `moritzbrantner/mmorpg#39`), implementer, branch name, `Start after #N` if it depends on another task.
2. **Goal:** two or three sentences on the observable result.
3. **Decisions already made (do not reopen):**
   - semantics and numbers (tables welcome);
   - exact contract changes: public renderer exports and types, `docs/contracts/` sections, fixture/envelope fields, version bumps;
   - compatibility behaviour for existing consumers (who pins what), fixtures and evidence baselines;
   - deliberate simplifications.

   Anything left open says so explicitly ("implementer decides X; record it in the PR").
4. **Acceptance:** concrete tests, fixtures and evidence. Name the checks CI does not run (`cargo run -p three-d-wgpu-example`, a manual viewport check) and which runtime-evidence workflow is expected to run. Always end with "CI green and every Codex finding addressed".
5. **Expected changes:** crates, packages, web routes, files and docs likely touched.
6. **Out of scope:** what a thorough implementer might otherwise add, especially consumer-owned scene composition, gameplay and physics authority. Always includes foundation, tooling, dependency and budget work.
7. **Parallel work:** open tasks and PRs touching the same files, and how to stay out of their way.

**Quality bar for `spec:ready`:**
- Consistent with `AGENTS.md` (Rust crates own semantics, the renderer adapts them, no second semantic model in lessons).
- No unresolved design question that would change a public contract or an authority boundary.
- Acceptance checks can be verified from the PR.
- Matches the current code: crate and module names, renderer exports, contract versions and budgets are checked on `main`.

## Drafting with a chat assistant

To hash out an issue in a chat (e.g. ChatGPT) and have it filed, paste this into the chat:

> You are helping me specify a task for the `moritzbrantner/3d-lab` repository. Before proposing anything, read `AGENTS.md`, `docs/AGENT_TASKS.md`, `ROADMAP.md` and the contracts in `docs/contracts/` relevant to the topic. Discuss the task with me first: challenge scope that is too large for one PR, ask about decisions that would change a public contract or an authority boundary, and propose concrete numbers. When I say "file it", create a GitHub issue in `moritzbrantner/3d-lab` with the title and body sections exactly as in `docs/AGENT_TASKS.md` "Writing an issue", and the labels `agent-task`, `spec:draft` and the `agent:*` label we agreed on. Never label it `spec:ready`; Claude checks drafts against the code first. If you cannot create issues, output the title and the body as a Markdown code block instead.

If the chat cannot create issues, open a new issue with the "Agent task" template and paste the body. The next `/agent-loop` run checks the draft against the code, completes or corrects it, and flips it to `spec:ready` (or asks its questions under `spec:needs-input`).
