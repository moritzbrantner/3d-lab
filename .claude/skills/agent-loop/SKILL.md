---
name: agent-loop
description: Run one iteration of the 3d-lab multi-agent loop — review open agent PRs, promote drafted issues to ready specs, queue the next roadmap items and consumer requests, implement Opus tasks, dispatch Sonnet tasks and keep a backlog for Sol, which runs separately and occasionally. Use when the user says "start/run the loop" or invokes /agent-loop; wrap in /loop for continuous pacing.
---

# Agent loop

You are the loop driver (Claude Opus). The contract for issues, labels and roles is `docs/AGENT_TASKS.md`; the rules every implementer follows are `AGENTS.md`. Read both at the start of every run, and `ROADMAP.md` plus the relevant `docs/contracts/` before writing a new spec.

**Sol is offline by default.** The user runs Sol's Codex loop occasionally and never needs to run it alongside this one. Never wait for Sol: keep 3d-lab moving with Opus and Sonnet, and treat `agent:sol` issues as a backlog Sol works through whenever it is started. The `agent:*` label partitions issues, so this loop (Opus/Sonnet) and Sol never pick up the same issue; `in-progress` only marks a started task and is not the ownership mechanism. Never touch `in-progress` on an `agent:sol` issue or push to a Sol branch.

One run = the steps below, in order, then a short report. Keep chat output to the report; put spec content into issues and review content into PR comments.

## 0. Baseline

- `git fetch` and work from `origin/main`. Never edit the user's checked-out branch; use a worktree for any change you make yourself.
- Make sure the labels in `docs/AGENT_TASKS.md` exist (`gh label create … || true`).
- Recover stale locks: an `agent:opus` or `agent:sonnet` issue loses `in-progress`, with a one-line comment, so it becomes dispatchable again, only when all of these hold:
  - no open PR references it;
  - the label was added more than 6 hours ago (issue timeline);
  - the issue's branch has no push in the last 6 hours, or does not exist;
  - no background agent from this session is working on it.

  Another session's agent may be invisible, so age and branch activity are the evidence. Never touch `in-progress` on `agent:sol` issues; report a Sol issue that has been `in-progress` for over 48 hours with no PR or branch push.
- Collect state:
  - `gh pr list --state open --limit 200 --json number,title,headRefName,author,labels,isDraft,url`
  - `gh issue list --label agent-task --state open --limit 200 --json number,title,labels,body`
  - `gh issue list --state open --limit 200 --json number,title,labels,body` for request issues that are not yet specs.

## 1. Review open PRs

For each open, non-draft PR that closes an `agent-task` issue:

0. **Blocked:** if the PR carries a `Blocked:` comment from its implementer newer than both its last push and any later comment from the owner (three failed attempts on the same CI failure, Codex finding or review feedback), do not review or re-dispatch it; report it under "For you" as blocked and continue with the next PR. An owner comment after `Blocked:` unblocks it: for an Opus or Sonnet PR, re-dispatch the implementer with that comment as the change list; for a Sol PR, leave it for Sol's next run.
1. **CI:** `gh pr checks <n>`. If pending, skip it this run. If a check was cancelled (for example by the `pages` concurrency group cancelling an older run), it is an infrastructure event, not a failure: rerun it (`gh run rerun <run-id>`) and skip the PR this run; never request code changes for a cancelled check. Before rerunning a cancelled `pages` run, check that no other `pages` run is active: `gh run list --workflow pages.yml --status <s> --limit 1` must be empty for each of `requested`, `waiting`, `pending`, `queued` and `in_progress` (filtering by status covers every run, not just a recent window); if any is not, leave the cancelled run for a later loop run, since a rerun would cancel that newer run (including a `main` deployment). Rerun at most one cancelled `pages` run per loop iteration. If a check failed, treat it as a "changes needed" verdict: comment the failing check and log excerpt, then re-dispatch the owning agent with that list as in the verdict below (for Sol, leave the comment; Sol's next run fixes its own PRs first).
2. **Codex:** read the review comments and threads from `chatgpt-codex-connector` (`gh api repos/{owner}/{repo}/pulls/<n>/comments`, `.../reviews`, and the issue comments). Require a completed connector review covering the current head commit; the review-summary issue comment may record completion even when there are no findings. Skip this PR while that review is absent or running. Every finding must be fixed or answered in the thread. If the head changed after the completed review, comment `@codex review` when no current-head review is running and skip until it completes.
3. **Spec:** compare the diff with the issue's Decisions, Acceptance and Out of scope:
   - contract changes (renderer exports, `docs/contracts/`, fixture/envelope fields, versions) match exactly;
   - nothing out of scope slipped in;
   - acceptance tests, fixtures and evidence exist;
   - the expected runtime-evidence workflow ran, and the native `wgpu` example or manual viewport check was claimed where required.

   Also check the `AGENTS.md` boundaries: Rust crates own the semantics, the renderer only adapts them, lessons create no second semantic model, and consumer scene composition/gameplay stays out.
4. **Verdict:**
   - **Ready:** record the head SHA that CI, Codex and the spec review covered, then `gh pr merge <n> --merge --delete-branch --match-head-commit <sha>`. If the head moved, do not merge; re-review next run. This repository's own reviewed, green agent PRs may be merged by this loop. If auto mode denies the merge, do not work around it; list the PR as "ready for you to merge" in the report.
   - **Changes needed:** one PR comment with a numbered, concrete list. For a PR by Sonnet, dispatch Sonnet again with that list (step 4). For a PR by Opus, re-dispatch the Opus agent with that list (step 4); never fix it inline as well. For Sol, leave the comment; Sol's next run fixes its own PRs first.

When a merged PR resolves a request from a downstream consumer (moritzbrantner/mmorpg, zoo, raid-defense, asset-tooling, …), say so in the report with the merge commit so the consumer can bump its pinned 3d-lab revision. Never merge PRs in other repositories; list them for the user. PRs that close no `agent-task` issue (the user's or Renovate's) are not reviewed or merged here.

## 2. Promote drafts

For each `spec:draft` issue (often drafted in a ChatGPT chat or by a consumer's agent):

- Check it against the current code on `origin/main`: crate and module names, renderer exports, contract versions, budgets, open parallel tasks and PRs.
- Check it against `docs/AGENT_TASKS.md`: sizing, one change per versioned format, the implementer label, every section present.
- If you can complete it by deciding things yourself, edit the body (`gh issue edit <n> --body-file …`), summarise what you changed in a comment, and swap `spec:draft` for `spec:ready` (exactly one `spec:*` label remains).
- If a decision belongs to the owner (scope, public API shape for consumers, anything touching an authority boundary), ask in a comment and swap `spec:draft` for `spec:needs-input` (never both). Every run re-checks `spec:needs-input` issues for answers; once answered, complete the spec and swap `spec:needs-input` for `spec:ready`, so exactly one `spec:*` label remains.

## 3. Refresh and fill the queues

**Refresh the Sol backlog.** For each `agent:sol` + `spec:ready` issue not `in-progress`, re-check it against current `origin/main`: names, versions, exports and "Parallel work". Edit the body when merges have moved them, with a one-line comment.

**Fill the queues.** A startable task is an open `spec:ready` issue whose "Start after" dependencies are merged.
- **Opus and Sonnet:** each keeps exactly one startable task.
- **Sol:** keeps up to three. Give Sol only work that nothing else will depend on soon. Examples: deterministic animation/geometry algorithms with fixtures, performance work with existing evidence, or isolated lesson-independent Rust models. Put critical-path work (whatever a consumer or the next renderer/web task needs) on `agent:opus`.
- Never make an Opus or Sonnet task "Start after" an unstarted Sol task.
- If a Sol task already blocks queued work and has not been started for 24 hours, reassign it to `agent:opus`: swap the label, update the header's "Intended implementer" line in the issue body, and comment why.

For each agent below its target, pick the next unfinished work in this order:

1. **Consumer-blocking requests first.** Open issues in this repository that a downstream consumer is waiting on: issue bodies or links naming moritzbrantner/mmorpg or another sibling repository, or the words "consumer", "first consumer", "mmorpg" or "dogfood". Prefer the one whose consumer issue is oldest or is already blocked on it.
2. **Then the roadmap:** unchecked items in `ROADMAP.md`, in slice order, and the remaining open request issues.

Then:

- Respect dependencies: a renderer/web task waits for its Rust-model or contract task. Queue only work whose own dependencies are already merged; if no such work exists for that agent, queue nothing and say so in the report.
- Avoid conflicts: never queue two tasks that change the same public contract or edit the same crate module, renderer file or web route concurrently, including Sol backlog tasks that may start at any time and open non-agent PRs.
- Write the issue exactly per `docs/AGENT_TASKS.md` "Writing an issue", with labels `agent-task`, `spec:ready` and the `agent:*` label. Verify every name, export and number you cite against the code first. When the source is an existing request issue here, reference it in the header (`Part of #N`) and have the PR close it too when it delivers the whole request.
- Comment one line on the source issue (the request here, or the consumer's issue) linking the new spec.

Write at most three new specs per run.

## 4. Dispatch

- **`agent:sonnet`** (ready, not in progress, and every "Start after" issue closed by a merged PR): add `in-progress`, then launch a background Agent:
  - `model: "sonnet"`, `isolation: "worktree"`;
  - prompt: "Implement issue #N of moritzbrantner/3d-lab. Read AGENTS.md, docs/AGENT_TASKS.md and the issue. Work on the branch the issue names, commit in small steps, run the focused checks plus whatever the issue lists that CI does not run, push, and open the PR with `Closes #N` only when the branch is complete. Report the PR URL and anything you could not verify."

  For a "changes needed" re-dispatch, give the PR number and the numbered list instead. Run at most one Sonnet task at a time.
- **`agent:opus`** (startable, not in progress): add `in-progress` and launch a background Agent so this loop keeps running:
  - `model: "opus"`, `isolation: "worktree"`;
  - the same prompt as for Sonnet.

  Run at most one Opus implementation at a time. For "changes needed" on an Opus PR, re-dispatch with the list.
- **`agent:sol`**: never dispatched from here. Sol runs the Codex `implementer-loop` skill (`.agents/skills/implementer-loop/`) whenever the user starts it. It fixes its own PRs first, then works through the backlog. Do not nag: mention the Sol backlog in the report only when it changed this run.

## 5. Report

End with a compact table: each PR (merged / changes requested / waiting for CI or Codex / ready for the user to merge), each issue (promoted / needs input / newly queued / dispatched), a "Consumers" line naming merged PRs that unblock a downstream repository (with the commit to pin), and a "For you" list naming only the user's actions (merges auto mode refused, questions, and the Sol backlog when it changed).

## Pacing

- A single invocation does one run.
- For continuous operation the user runs `/loop /agent-loop`. Schedule the next wakeup around 1800 s while PRs wait on CI or Codex. While an unstarted Sol task blocks queued work, also schedule a wakeup no later than its 24-hour reassignment deadline (the clamp is 3600 s, so keep waking hourly until then).
- Stop the loop when no Opus or Sonnet work is in flight or startable and no roadmap items or consumer requests remain for them. A non-empty Sol backlog alone is not a reason to keep looping, but a Sol task that blocks queued work is.
- A finished background Sonnet or Opus agent re-invokes you; continue from step 1 for its PR.
