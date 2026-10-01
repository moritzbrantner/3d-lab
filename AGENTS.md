# 3D Lab Agent Instructions

3d-lab owns reusable 3D foundations plus interactive learning/authoring surfaces. Product-specific scene composition and gameplay interaction remain with consumers.

## Interactive lab and authoring UX

- Web lessons, authoring/inspection surfaces, and renderer workbenches apply the current shared `ui` conventions from `moritzbrantner/coding-agent-conventions`, especially `PRINCIPLE-009`, `UI-008`, `UI-012`, and `UI-013`.
- Treat the 3D viewport and represented scene objects as the primary work surface. Prefer direct picking and manipulation for scene nodes, vertices, transforms, camera inspection, and similar spatial operations when the lesson or authoring task supports them.
- Keep exact transform/position/rotation/scale values available for precision. Dragging, gizmos, orbiting, and other coarse interactions supplement exact values and must stay synchronized with the same authoritative state.
- Give camera, picking, selection, transform manipulation, and viewport gestures one owner. Do not reconstruct the same scene or interaction state in parallel DOM/CSS overlays or wrapper-level gesture handlers.
- Keep inspectors concise and contextual. They expose exact state and secondary operations; they do not displace the viewport with explanatory or dashboard-style chrome.
- Protect browser-dependent picking, clipping, gizmo placement, viewport alignment, and pointer behavior with focused browser evidence when those properties are part of the contract.

## Authority boundaries

- Rust crates remain renderer-independent owners of their documented geometry, transform, animation, camera, asset, and LOD semantics.
- The browser renderer adapts those semantics to Three.js/GPU resources and must not become an alternate authority for simulation, camera, transforms, placement, or product scene composition.
- Interactive teaching surfaces may visualize and edit authoritative state but must not create a second semantic model merely for presentation.

## Verification

Use the repository-owned Rust, browser renderer, and web validation commands documented in `README.md`, starting with the narrowest affected scope.

## Execution scope

These rules govern how work is sliced and when expensive checks run. They never relax the authority boundaries, the interactive UX rules or Verification above.

- **One task = one branch = one PR.** A task is a tracking issue or an unchecked `ROADMAP.md` item, including an explicitly specified Rust-model or renderer/web half as a separate task per `docs/AGENT_TASKS.md`. Deliver the task's complete declared scope on one branch, including the Rust model, renderer package, web lesson/authoring surface, fixtures, evidence and contract docs it requires, in small commits. Do not split a task into new issues or follow-up PRs on your own; if it cannot land as one PR, stop and propose the split on the issue instead of creating it.
- **Stay inside the task.** Do not start foundation, tooling, CI, dependency-bump, maintenance or budget work unless the task cannot be completed without it. Note unrelated findings as a TODO or one line in the PR description; do not open issues for them.
- **No new ratchets unless the task asks for one.** Do not add performance budgets, baselines, evidence collectors, calibration or gates on your own initiative. Existing ratchets stay; when a task legitimately moves one, update its baseline in the same PR.
- **One contract change per task.** Downstream consumers (mmorpg, zoo, raid-defense, asset-tooling, …) pin exact 3d-lab revisions. Settle changes to the public renderer package API, `docs/contracts/` semantics, fixture/envelope formats and snapshot versions before implementing; a task bumps each versioned format at most once and records breaking changes in the contract doc and the PR.
- **Validate in tiers.** While iterating, run the narrowest commands from `README.md` for the touched scope. GitHub Actions is the full gate: `ci.yml` runs Rust fmt/Clippy/tests, the catalog Avocado check, renderer package tests and the web typecheck/test/build; `pages.yml` builds the site; the path-triggered runtime-evidence workflows (`runtime-evidence.yml`, `renderer-runtime-evidence.yml` with the Chromium character smoke, `editor-runtime-evidence.yml`, `topology-*-runtime-evidence.yml`, `renderer-variance-calibration.yml`) run on PRs that touch their surfaces. Before pushing, run locally only what CI does not cover: `cargo run -p three-d-wgpu-example` when the native `wgpu` example or the mesh/camera data it consumes changes (needs a GPU adapter), and a manual `bun run dev` check of picking, gizmos and viewport behaviour that no browser evidence covers yet. A red CI check blocks merge; fix it rather than re-proving it locally.
- **Codex reviews the PR.** Codex reviews automatically when a PR is opened or marked ready, so open it (or mark a draft ready) only once the branch is complete. Address or explicitly answer every Codex finding before merge; after substantial fixes, comment `@codex review` for another pass.
- **Decide and continue.** When a task leaves a design choice open, pick the simplest option consistent with this file, record it in the PR description (or in `docs/contracts/` when consequential) and keep going.
- **Short PR descriptions.** At most about 15 lines: what changed, contract/format/compatibility changes, one line naming the checks that ran, and anything not verified. Leave detailed evidence to CI and the tests.

Tasks arrive as GitHub issues in the format, labels and pickup rules of `docs/AGENT_TASKS.md`; implement only `spec:ready` issues labeled for you. Claude Opus orchestrates with the `/orchestrate` skill (`.claude/skills/orchestrate/`), preferably under `/goal` (see the skill's Pacing section); ChatGPT Sol uses the Codex `implementer-loop` skill (`.agents/skills/implementer-loop/`).
