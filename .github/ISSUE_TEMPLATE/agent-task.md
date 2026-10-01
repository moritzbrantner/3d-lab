---
name: Agent task
about: One PR-sized task for a coding agent (see docs/AGENT_TASKS.md)
title: "<Area>: <what the consumer, learner or system gains>"
labels: ["agent-task", "spec:draft"]
---

Source: <`ROADMAP.md` slice/item, or consumer request such as moritzbrantner/<repo>#<n>> (part of #<parent>, if any). Intended implementer: **<Opus|Sol|Sonnet>**. Start after: <#N or "nothing">. One branch (`agent/<topic>`), one PR; follows the `AGENTS.md` **Execution scope** rules.

## Goal

<Two or three sentences: what a consumer, learner or the system can do afterwards.>

## Decisions already made (do not reopen)

- **Semantics and numbers:** <…>
- **Contracts:** <renderer package exports/types, `docs/contracts/` sections, fixture/envelope fields, version bumps; or "no contract change">
- **Compatibility:** <what happens to pinned consumers, existing fixtures and evidence baselines>
- **Left to the implementer:** <explicitly delegated choices, recorded in the PR>

## Acceptance

- <tests, fixtures and evidence>
- <`cargo run -p three-d-wgpu-example` / manual viewport check / expected runtime-evidence workflow, when relevant>
- CI green and every Codex review finding addressed or answered.

## Expected changes

- <crates/packages/web routes/files/docs>

## Out of scope

- <…>
- Consumer-owned scene composition, gameplay and physics authority.
- Foundation, tooling, dependency and budget work.

## Parallel work

- <open tasks or PRs touching the same files, or "none">
