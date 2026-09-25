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
