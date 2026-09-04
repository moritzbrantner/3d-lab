# Skeletal animation deep dive

The browser deep dive uses one three-joint strip on purpose. The goal is to keep the geometry trivial enough that every transform in the animation pipeline can be inspected.

## 1. A skeleton is a transform hierarchy

A joint is a transform node. For a child joint:

`joint_world = parent_world × joint_local`

This is the same scene-graph rule used for ordinary parent/child objects. The important effect is inheritance: changing the shoulder moves the elbow and wrist even when the elbow and wrist local transforms do not change.

A production rig may have many more joints, but the evaluation rule is the same. Engines normally evaluate the hierarchy in parent-before-child order so each world transform can be computed once from an already-known parent world transform.

## 2. The bind pose is the reference configuration

The mesh is authored in a reference pose, usually called the bind pose or rest pose. A joint's inverse bind matrix records the inverse of that joint's world transform in this reference configuration.

For joint `j`:

`skin_matrix[j] = animated_joint_world[j] × inverse_bind[j]`

In the untouched bind pose, `animated_joint_world[j]` equals the original bind-world transform, so the two matrices cancel. A bind-space vertex therefore remains in its authored position.

The inverse bind matrix is not "the animation". It is the persistent bridge between mesh bind space and an animated joint's current space.

## 3. Linear blend skinning is the common deformation algorithm

A skinned vertex stores joint indices and corresponding weights. In glTF these are carried by `JOINTS_n` and `WEIGHTS_n` attributes. The common real-time algorithm is **linear blend skinning (LBS)**.

For a bind-space position `p`:

`p' = Σ w_i × skin_matrix[joint_i] × p`

The weights should form a normalized blend. A vertex near the elbow can therefore be influenced partly by the upper-arm joint and partly by the forearm joint.

The deep-dive demo exposes one vertex's two transformed candidate positions and the weighted result. Moving the weight from 0 to 1 should make it clear that the final point is not attached to a single bone; it is a blend of bone-transformed copies of the original bind-space point.

### Why LBS sometimes looks wrong

LBS is fast and simple, but linear matrix blending can lose volume around strong twists and bends. The familiar "candy-wrapper" artifact is one consequence. Dual-quaternion skinning is a common alternative when better rotational deformation is worth extra complexity, but it is not required to understand the standard skeleton/weight pipeline and is deliberately outside this first deep dive.

## 4. Animation clips produce poses, not final vertices

A skeletal animation frame can be understood as a pipeline:

1. Choose a clip time.
2. Sample translation, rotation, and scale tracks for targeted nodes.
3. Compose those sampled values into local joint transforms.
4. Evaluate the parent hierarchy to obtain joint world matrices.
5. Multiply by inverse bind matrices to build the skinning palette.
6. For each skinned vertex, use its joint indices and weights to blend the relevant skin matrices.
7. Continue with the ordinary rendering pipeline: model/view/projection transforms, clipping, rasterization, shading, and so on.

This separation matters architecturally. Clip sampling belongs to animation. Hierarchy evaluation belongs to scene/pose math. Skinning consumes the resulting matrices. Rendering consumes the deformed vertex stream.

## 5. How a glTF animated model is assembled

A glTF asset connects several independently useful pieces:

- a **mesh primitive** owns positions, normals, indices, and other vertex data;
- skinning attributes such as **`JOINTS_0`** and **`WEIGHTS_0`** live with the primitive's vertex attributes;
- a **node** instantiates a mesh and may reference a skin;
- a **skin** lists the joint nodes and may reference an accessor of inverse bind matrices;
- the **joint hierarchy** is the normal glTF node hierarchy;
- an **animation** contains samplers and channels that target node translation, rotation, scale, or morph weights.

A loader resolves those references into runtime objects. In the Three.js teaching surface the approximate runtime mapping is:

- mesh primitive → `BufferGeometry` + material;
- mesh node + skin → `SkinnedMesh`;
- joint nodes → `Bone` objects;
- skin → `Skeleton` + bone inverses;
- animation → `AnimationClip` / keyframe tracks;
- clip playback → `AnimationMixer` updating the target node transforms.

The file format does not replace the animation algorithm. It serializes enough data for the runtime to reconstruct the same hierarchy, bind, sampling, and skinning relationships.

## References

- Khronos glTF 2.0 specification, skinning section: https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html
- Three.js `SkinnedMesh`: https://threejs.org/docs/pages/SkinnedMesh.html
- Three.js `Skeleton`: https://threejs.org/docs/pages/Skeleton.html
