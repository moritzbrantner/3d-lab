# Rigged asset ownership contract

## Purpose

three-d-rigged-assets composes the reusable pieces needed by a rigged runtime asset without becoming a file-format loader, an asset-generation workflow, or a physics engine.

The authoritative inputs remain:

- three-d-animation for skeleton hierarchy, inverse bind matrices, skin influences, animation clips, and humanoid semantics;
- three-d-core for bind-pose positions;
- asset-tooling for reproducible generation/processing specs, model identity, receipts, and output provenance;
- the consuming physics engine for collision detection, contact generation, rigid-body state, and gameplay movement authority.

A renderer may visualize these values, but it must not infer a second skeleton, regenerate collision geometry, or reinterpret clip targets.

## Rigged asset composition

A RiggedAsset contains:

- one validated Skeleton;
- zero or more validated SkinInfluence values;
- zero or more AnimationClip values whose node targets fit the skeleton;
- zero or more JointCollisionProxy values.

The composition layer deliberately does not duplicate mesh storage. Mesh/render resources stay in the existing asset and renderer boundaries, while skin influences remain vertex-aligned data supplied by the caller that owns the mesh.

## Collision proxy contract

Collision proxies are joint-local primitive geometry:

- box, with explicit full size;
- sphere, with explicit radius;
- capsule, with explicit radius and straight-segment length.

Capsules use the joint's local Y axis. Centers are expressed in the target joint's bind-local coordinates. All dimensions must be finite and strictly positive.

These proxies are approximation data suitable for downstream physics adapters. They do not make 3d-lab authoritative for contact generation or rigid-body simulation.

## Automatic bind-pose fitting

fit_joint_collision_proxies provides the first deterministic automatic preparation step.

For each bind-pose vertex:

1. validate its four-slot skin influence against the skeleton;
2. select the first maximum-weight joint deterministically;
3. discard the vertex when the dominant weight is below the configured confidence threshold;
4. transform the bind-space position through that joint's inverse-bind matrix into joint-local bind space;
5. accumulate joint-local bounds without rematerializing a second mesh.

For every joint with enough supporting vertices, fitting derives a padded local bounding box and chooses a primitive deterministically:

- near-isotropic bounds become a sphere;
- sufficiently elongated local-Y bounds become a capsule;
- other bounds remain a box.

The fitter returns structural observations (input, assigned, low-confidence, represented, and unrepresented vertex counts) so asset-tooling can record useful evidence without making those observations part of physics authority.

This heuristic is intentionally conservative. Humanoid semantic overrides, learned rigging, convex decomposition, and quality scoring belong in later processing stages and must remain explicit rather than silently changing this base contract.

## Automatic rigging boundary

Automatic skeleton/weight generation is a processing concern, not renderer behavior. A backend such as UniRig should therefore be integrated through asset-tooling:

source mesh -> declared auto-rig operation -> skeleton + weights -> 3d-lab validation -> collision fitting -> animation retargeting -> packaged output + receipts

The generated skeleton becomes accepted runtime data only after it passes the same 3d-lab validation contracts as authored skeletons. Humanoid mapping must normalize through the existing production HumanoidSkeleton profile instead of adding a second name-based humanoid implementation.
