# Editor picking contract

Viewport picking is a browser interaction concern. Three.js may report transient ray intersections, but the editor only persists model ids and indexed vertex ids.

Vertex handles must respect scene visibility: a vertex hit is selectable only when no mesh surface is hit first, or when the vertex depth is within the small display tolerance of the nearest mesh hit. A handle hidden behind another surface must not win selection merely because point picking is evaluated separately.

This rule does not change mesh, hierarchy, or transform semantics. `three-d-core` and `three-d-animation` remain the semantic authorities; the browser adapter owns hit arbitration only.
