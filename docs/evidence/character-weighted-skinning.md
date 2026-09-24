# Weighted character skinning

Base: `190519de0cbf495321f1d72a842def98c2f97f09` (main after PR #59).

## Boundary

The teaching character now authors explicit per-vertex influences where deformation
semantics belong: the hips/spine, spine/chest, neck/head, elbow and knee seams.
The reusable renderer does not infer a humanoid, pick joints or generate weights.
`batchWeightedSkin` validates caller-authored influences, packs them and keeps the
same material-identity batching contract as `batchRigidSkin`.

Each blended teaching vertex uses at most two positive influences. Weights are
smoothstepped over the distal 42% of the authored segment. Bind-pose geometry stays
unchanged, while child-joint motion now deforms the adjacent segment instead of
creating a rigid hinge seam.

## Performance ratchets

The richer character remains **31 authored source parts -> one indexed SkinnedMesh
with three material groups**. Smooth weighting therefore does not add material
submissions or per-frame mesh rebuilds.

The 13-joint palette now uses four uint8 skin-index lanes instead of four uint16
lanes: **4 bytes per vertex instead of 8 bytes per vertex for skin indices (50%
smaller)**. Palettes above 256 joints retain uint16 indices, with a regression test
covering joint 256 so compaction cannot silently overflow.

This is a deterministic buffer-size improvement, not a claim of 2x frame rate.
Float32 skin weights and the existing bone palette remain unchanged.

## Correctness and verification

Renderer tests cover normalized explicit weights, malformed/negative weights,
invalid joints, bind-pose preservation, an exact 50/50 parent-child deformation,
source immutability, compact-index selection and the >256-joint fallback.

Character tests require a non-zero set of blended vertices, at most two positive
influences per teaching vertex, normalized weights, Uint8 skin indices, the same
three material groups, stable topology/palette buffers, floor contact, shoulder
coverage and exactly-once resource disposal.

The existing Chromium character acceptance lane additionally requires the weighted
skin contract and compact-index metadata before exercising exact timeline editing,
playback, bind-pose and x-ray screenshots.
