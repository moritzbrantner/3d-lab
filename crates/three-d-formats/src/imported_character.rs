//! Imported scene lowering through the existing glTF decoder and animation/rig authorities.
use crate::{FormatError, load_gltf_animation_clips, load_gltf_asset, load_gltf_buffers};
use three_d_animation::{
    AnimationClip, AnimationTrack, Joint, Mat4, Quat, Skeleton, SkinInfluence, Transform,
    TransformNode, world_matrices,
};
use three_d_core::Vec3;
use three_d_rigged_assets::RiggedAsset;

/// Source scene identities remain separate from authored skin palette slots.
#[derive(Debug, Clone)]
pub struct ImportedCharacter {
    /// Canonical encoded resources and material references, validated before GPU acquisition.
    pub asset: three_d_assets::Asset,
    pub nodes: Vec<TransformNode>,
    pub source_nodes: Vec<usize>,
    pub node_names: Vec<String>,
    pub skin_nodes: Vec<usize>,
    pub inverse_binds: Vec<Mat4>,
    /// Every skinned mesh node, in source scene order.
    pub mesh_nodes: Vec<usize>,
    /// Source identity of each entry in `primitive_indices` / `gpu_skin_indices`.
    pub primitives: Vec<ImportedPrimitive>,
    pub primitive_indices: Vec<Vec<u32>>,
    pub gpu_skin_indices: Vec<Vec<[u16; 4]>>,
    pub rig: RiggedAsset,
}
/// One skinned triangle primitive: its scene node, glTF mesh and primitive index.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ImportedPrimitive {
    pub node: usize,
    pub mesh: usize,
    pub primitive: usize,
}
fn invalid(message: impl Into<String>) -> FormatError {
    FormatError::InvalidGltf(message.into())
}
fn remap_track(track: &AnimationTrack, mapping: &[usize]) -> Result<AnimationTrack, FormatError> {
    let remap = |node: usize| {
        mapping
            .get(node)
            .copied()
            .ok_or_else(|| invalid("clip target node out of range"))
    };
    let finite = match track {
        AnimationTrack::Translation { track, .. } | AnimationTrack::Scale { track, .. } => {
            track.frames().iter().all(|f| {
                [f.value.x, f.value.y, f.value.z]
                    .iter()
                    .all(|v| v.is_finite())
            })
        }
        AnimationTrack::Rotation { track, .. } => track.frames().iter().all(|f| {
            [f.value.x, f.value.y, f.value.z, f.value.w]
                .iter()
                .all(|v| v.is_finite())
                && f.value.length().is_finite()
                && f.value.length() > f32::EPSILON
        }),
    };
    if !finite {
        return Err(invalid("clip target transform must be finite"));
    }
    Ok(match track {
        AnimationTrack::Translation { node, track } => AnimationTrack::Translation {
            node: remap(*node)?,
            track: track.clone(),
        },
        AnimationTrack::Rotation { node, track } => AnimationTrack::Rotation {
            node: remap(*node)?,
            track: track.clone(),
        },
        AnimationTrack::Scale { node, track } => AnimationTrack::Scale {
            node: remap(*node)?,
            track: track.clone(),
        },
    })
}
/// One format adapter, no renderer, texture decoding, or animation sampler.
pub fn load_gltf_imported_character(bytes: &[u8]) -> Result<ImportedCharacter, FormatError> {
    let gltf =
        gltf::Gltf::from_slice(bytes).map_err(|e| invalid(format!("glTF node/skin/clip: {e}")))?;
    let buffers = load_gltf_buffers(&gltf)?;
    let source: Vec<_> = gltf.nodes().collect();
    let mut parents = vec![None; source.len()];
    for node in &source {
        for child in node.children() {
            if parents[child.index()].replace(node.index()).is_some() {
                return Err(invalid("scene node has multiple parents"));
            }
        }
    }
    let mut ordered = Vec::new();
    let mut mapping = vec![usize::MAX; source.len()];
    while ordered.len() < source.len() {
        let old = ordered.len();
        for index in 0..source.len() {
            if mapping[index] == usize::MAX
                && parents[index].is_none_or(|p| mapping[p] != usize::MAX)
            {
                mapping[index] = ordered.len();
                ordered.push(index);
            }
        }
        if ordered.len() == old {
            return Err(invalid("scene node hierarchy cycle"));
        }
    }
    // The GPU adapter loads the default scene (or scene zero), not all document nodes.
    // This bounded adapter requires the complete canonical pose hierarchy in that scene.
    let scene = gltf
        .default_scene()
        .or_else(|| gltf.scenes().next())
        .ok_or_else(|| invalid("imported character requires a selected scene hierarchy"))?;
    let mut pending = Vec::new();
    for root in scene.nodes() {
        if parents[root.index()].is_some() {
            return Err(invalid(
                "selected scene root has a parent outside its root hierarchy",
            ));
        }
        pending.push(root.index());
    }
    let mut selected = vec![false; source.len()];
    while let Some(index) = pending.pop() {
        if selected[index] {
            continue;
        }
        selected[index] = true;
        pending.extend(source[index].children().map(|child| child.index()));
    }
    if selected.iter().any(|present| !present) {
        return Err(invalid(
            "selected scene must include the complete imported node/mesh/skin hierarchy; detached nodes are unsupported",
        ));
    }
    let mut nodes = Vec::new();
    let mut names = Vec::new();
    for &index in &ordered {
        let (t, r, s) = source[index].transform().decomposed();
        if t.iter()
            .chain(r.iter())
            .chain(s.iter())
            .any(|v| !v.is_finite())
            || r.iter().map(|v| v * v).sum::<f32>() <= f32::EPSILON
        {
            return Err(invalid(
                "node rest transform must be finite with nonzero rotation",
            ));
        }
        nodes.push(TransformNode {
            parent: parents[index].map(|p| mapping[p]),
            local: Transform {
                translation: Vec3::new(t[0], t[1], t[2]),
                rotation: Quat::new(r[0], r[1], r[2], r[3]),
                scale: Vec3::new(s[0], s[1], s[2]),
            },
        });
        names.push(source[index].name().unwrap_or("").to_owned());
    }
    let world = world_matrices(&nodes).map_err(|e| invalid(e.to_string()))?;
    if world
        .iter()
        .flat_map(|m| &m.elements)
        .any(|v| !v.is_finite())
    {
        return Err(invalid("node world matrix overflow"));
    }
    let meshes: Vec<_> = source
        .iter()
        .filter(|n| n.skin().is_some() && n.mesh().is_some())
        .collect();
    if meshes.is_empty() {
        return Err(invalid("imported character requires a skinned mesh node"));
    }
    // Every skinned mesh node keeps its own authored skin palette and inverse binds (GPU
    // metadata). The canonical rig takes each joint's bind from the first skin naming it.
    let mut skin_nodes = Vec::new();
    let mut inverse_binds = Vec::new();
    let mut bound = std::collections::BTreeSet::new();
    let mut mesh_nodes = Vec::new();
    let mut primitives = Vec::new();
    let mut influences = Vec::new();
    let mut primitive_indices = Vec::new();
    let mut gpu_skin_indices = Vec::new();
    for mesh_node in &meshes {
        let skin = mesh_node.skin().ok_or_else(|| invalid("missing skin"))?;
        let palette: Vec<_> = skin.joints().map(|n| n.index()).collect();
        if palette.is_empty() || palette.len() > u16::MAX as usize {
            return Err(invalid("invalid skin joint count"));
        }
        let mut unique = std::collections::BTreeSet::new();
        if palette.iter().any(|n| !unique.insert(*n)) {
            return Err(invalid("duplicate skin joint"));
        }
        let binds = match skin
            .reader(|b| buffers.get(b.index()).map(Vec::as_slice))
            .read_inverse_bind_matrices()
        {
            Some(values) => values
                .map(|m| Mat4 {
                    elements: m
                        .into_iter()
                        .flatten()
                        .collect::<Vec<_>>()
                        .try_into()
                        .expect("matrix has16 values"),
                })
                .collect::<Vec<_>>(),
            None => vec![Mat4::IDENTITY; palette.len()],
        };
        if binds.len() != palette.len()
            || binds
                .iter()
                .flat_map(|m| &m.elements)
                .any(|v| !v.is_finite())
        {
            return Err(invalid(
                "inverse bind matrix must be finite and match joints",
            ));
        }
        for (&node, &bind) in palette.iter().zip(&binds) {
            if bound.insert(node) {
                skin_nodes.push(node);
                inverse_binds.push(bind);
            }
        }
        let mesh = mesh_node
            .mesh()
            .ok_or_else(|| invalid("missing skin mesh"))?;
        mesh_nodes.push(mesh_node.index());
        for primitive in mesh.primitives() {
            if primitive.mode() != gltf::mesh::Mode::Triangles
                || primitive.morph_targets().next().is_some()
            {
                return Err(invalid("unsupported skin primitive/morph targets"));
            }
            let reader = primitive.reader(|b| buffers.get(b.index()).map(Vec::as_slice));
            let positions = reader
                .read_positions()
                .ok_or_else(|| invalid("skin POSITION missing"))?
                .collect::<Vec<_>>();
            if positions.iter().flatten().any(|v| !v.is_finite()) {
                return Err(invalid("skin position nonfinite"));
            }
            let indices = if let Some(indices) = reader.read_indices() {
                indices.into_u32().collect::<Vec<_>>()
            } else {
                let count = u32::try_from(positions.len())
                    .map_err(|_| invalid("too many skin vertices"))?;
                (0..count).collect()
            };
            if indices.len() % 3 != 0 || indices.iter().any(|i| *i as usize >= positions.len()) {
                return Err(invalid("skin index out of range"));
            }
            primitive_indices.push(indices);
            primitives.push(ImportedPrimitive {
                node: mesh_node.index(),
                mesh: mesh.index(),
                primitive: primitive.index(),
            });
            let joints = reader
                .read_joints(0)
                .ok_or_else(|| invalid("skin joint influences missing"))?
                .into_u16()
                .collect::<Vec<_>>();
            let weights = reader
                .read_weights(0)
                .ok_or_else(|| invalid("skin weights missing"))?
                .into_f32()
                .collect::<Vec<_>>();
            if joints.len() != positions.len() || weights.len() != positions.len() {
                return Err(invalid("skin influence count mismatch"));
            }
            let mut gpu_slots = Vec::new();
            for (slots, weights) in joints.into_iter().zip(weights) {
                // Validate ORIGINAL authored slot domain before canonical hierarchy remapping.
                let authored = SkinInfluence::new(slots, weights)
                    .map_err(|e| invalid(format!("skin weight: {e}")))?;
                authored
                    .validate_joints(palette.len())
                    .map_err(|e| invalid(format!("skin joint: {e}")))?;
                // Stock GPU skinning fetches every slot even when its weight is zero.
                // Active references already passed the authored palette check above;
                // only inert out-of-range references may be normalized to a safe slot.
                gpu_slots.push(slots.map(|slot| {
                    if usize::from(slot) < palette.len() {
                        slot
                    } else {
                        0
                    }
                }));
                let mapped = slots.map(|slot| {
                    palette
                        .get(usize::from(slot))
                        .map_or(0, |node| mapping[*node])
                });
                let canonical = mapped
                    .map(u16::try_from)
                    .into_iter()
                    .collect::<Result<Vec<_>, _>>()
                    .map_err(|_| invalid("scene hierarchy exceeds influence index range"))?;
                influences.push(
                    SkinInfluence::new(canonical.try_into().expect("four slots"), weights)
                        .map_err(|e| invalid(format!("skin influence: {e}")))?,
                );
            }
            gpu_skin_indices.push(gpu_slots);
        }
    }
    let clips = load_gltf_animation_clips(bytes)?
        .iter()
        .map(|clip| {
            let tracks = clip
                .tracks()
                .iter()
                .map(|t| remap_track(t, &mapping))
                .collect::<Result<Vec<_>, _>>()?;
            AnimationClip::new(clip.name(), tracks)
                .map(|c| c.with_loop_mode(clip.loop_mode()))
                .map_err(|e| invalid(format!("clip: {e}")))
        })
        .collect::<Result<Vec<_>, _>>()?;
    let mut names_seen = std::collections::BTreeSet::new();
    if clips.is_empty() || clips.iter().any(|c| !names_seen.insert(c.name())) {
        return Err(invalid("clip names must be present and unique"));
    }
    if clips.iter().any(|clip| clip.duration() <= 0.0) {
        return Err(invalid(
            "zero-duration animation clips are unsupported by the imported playback adapter",
        ));
    }
    // Skeleton entries are structural pose nodes, NOT newly authored skin joints.
    // Non-skin entries have an unused identity bind; original palette metadata stays separate.
    let mut joints = nodes
        .iter()
        .map(|node| Joint {
            parent: node.parent,
            inverse_bind: Mat4::IDENTITY,
        })
        .collect::<Vec<_>>();
    for (&source_node, &inverse_bind) in skin_nodes.iter().zip(&inverse_binds) {
        joints[mapping[source_node]].inverse_bind = inverse_bind;
    }
    let skeleton = Skeleton::new(joints).map_err(|e| invalid(e.to_string()))?;
    let rig = RiggedAsset::new(skeleton, influences, clips, Vec::new())
        .map_err(|e| invalid(format!("rig: {e}")))?;
    let asset = load_gltf_asset(&gltf, &buffers)?;
    Ok(ImportedCharacter {
        asset,
        nodes,
        source_nodes: ordered,
        node_names: names,
        skin_nodes,
        inverse_binds,
        mesh_nodes,
        primitives,
        primitive_indices,
        gpu_skin_indices,
        rig,
    })
}
