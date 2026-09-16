# Topology editing storage boundary

Topology editing no longer treats a fully materialized `IndexedMesh` as the mandatory working representation.

## Working representation

While topology is being edited, the editor keeps:

- the original vertex/UV/color arrays as shared chunks;
- newly created vertices and authored attributes as small append-only chunks;
- triangles in bounded chunks of at most 128 triangles; and
- derived normals/tangents separately so topology edits can invalidate them without copying authored data.

Split, inset, extrude, undo, and redo replace only the touched triangle chunk(s). They do not copy the complete vertex array, UV/color arrays, or index array merely to preserve an immutable-array API shape.

The existing `IndexedMesh` remains the compatibility format for code that genuinely needs contiguous arrays. A lazy compatibility view materializes it on first access and caches that materialization for the current topology revision.

## Copy budget

For one topology operation:

- source vertex-reference copies: **0**;
- source UV/color-reference copies: **0**;
- edge split: at most two 128-triangle chunks may contribute unchanged copied index values;
- inset/extrude: at most one 128-triangle chunk may contribute unchanged copied index values; and
- the bounded replacement triangles and appended vertices are the only newly authored topology data.

Contiguous materialization is counted separately. It is expected at real renderer/export/validation boundaries, not inside every edit operation.

## Why this is intentionally less uniform

A uniform `IndexedMesh -> IndexedMesh` transformation is simple to read but makes a local edit O(mesh size) because every operation has to rebuild unrelated arrays. That uniformity is not an architectural requirement. The editor is allowed to use a representation that matches its mutation pattern and convert only when a downstream consumer requires the flat form.

This principle should be applied elsewhere in `3d-lab`: do not copy or recompute whole authoritative structures merely to preserve a visually clean API boundary. Prefer narrow operations and explicit materialization boundaries, then measure the remaining unavoidable conversions.

## Next performance targets

Persistent topology storage removes the dominant repeated copy identified by the topology workload. The next candidates are:

1. repeated full adjacency-index rebuilds for edge operations; and
2. renderer-side replacement of entire vertex/index buffers after a bounded topology edit.

Those should be optimized only with deterministic work evidence showing they are now material contributors.
