//! Renderer-neutral scene snapshots and deterministic normalization for `3d-lab`.
//!
//! `three-d-scene` owns reusable scene hierarchy semantics. File formats, renderers,
//! editor UI state, workflow/provenance infrastructure, and GPU objects stay outside.

use core::fmt;

use three_d_animation::{Quat, Transform};
use three_d_core::{Color3, Mesh, Tangent4, Vec2, Vec3, VertexAttributes};

const UNIT_QUATERNION_TOLERANCE: f32 = 1.0e-4;
const UNMAPPED_INDEX: u32 = u32::MAX;

#[derive(Debug, Clone, PartialEq)]
pub struct SceneMesh {
    id: String,
    mesh: Mesh,
}

impl SceneMesh {
    pub fn new(id: impl Into<String>, mesh: Mesh) -> Self {
        Self {
            id: id.into(),
            mesh,
        }
    }

    pub fn id(&self) -> &str {
        &self.id
    }

    pub const fn mesh(&self) -> &Mesh {
        &self.mesh
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct SceneNode {
    id: String,
    parent: Option<usize>,
    mesh: Option<usize>,
    local: Transform,
}

impl SceneNode {
    pub fn new(
        id: impl Into<String>,
        parent: Option<usize>,
        mesh: Option<usize>,
        local: Transform,
    ) -> Self {
        Self {
            id: id.into(),
            parent,
            mesh,
            local,
        }
    }

    pub fn id(&self) -> &str {
        &self.id
    }

    pub const fn parent(&self) -> Option<usize> {
        self.parent
    }

    pub const fn mesh(&self) -> Option<usize> {
        self.mesh
    }

    pub const fn local(&self) -> Transform {
        self.local
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct SceneSnapshot {
    meshes: Vec<SceneMesh>,
    nodes: Vec<SceneNode>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SceneError {
    EmptyScene,
    EmptyMeshId {
        mesh: usize,
    },
    DuplicateMeshId {
        mesh: usize,
    },
    EmptyNodeId {
        node: usize,
    },
    DuplicateNodeId {
        node: usize,
    },
    ParentMustPrecedeChild {
        node: usize,
        parent: usize,
    },
    MeshIndexOutOfBounds {
        node: usize,
        mesh: usize,
        mesh_count: usize,
    },
    NonFiniteTransform {
        node: usize,
    },
    NonUnitQuaternion {
        node: usize,
    },
}

impl fmt::Display for SceneError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::EmptyScene => formatter.write_str("scene must contain at least one node"),
            Self::EmptyMeshId { mesh } => write!(formatter, "mesh {mesh} has an empty id"),
            Self::DuplicateMeshId { mesh } => {
                write!(formatter, "mesh {mesh} repeats an earlier id")
            }
            Self::EmptyNodeId { node } => write!(formatter, "node {node} has an empty id"),
            Self::DuplicateNodeId { node } => {
                write!(formatter, "node {node} repeats an earlier id")
            }
            Self::ParentMustPrecedeChild { node, parent } => write!(
                formatter,
                "node {node} references parent {parent}; parents must appear before children"
            ),
            Self::MeshIndexOutOfBounds {
                node,
                mesh,
                mesh_count,
            } => write!(
                formatter,
                "node {node} references mesh {mesh}, but the scene has {mesh_count} meshes"
            ),
            Self::NonFiniteTransform { node } => {
                write!(
                    formatter,
                    "node {node} contains a non-finite transform component"
                )
            }
            Self::NonUnitQuaternion { node } => write!(
                formatter,
                "node {node} rotation must be a normalized quaternion"
            ),
        }
    }
}

impl std::error::Error for SceneError {}

impl SceneSnapshot {
    pub fn new(meshes: Vec<SceneMesh>, nodes: Vec<SceneNode>) -> Result<Self, SceneError> {
        if nodes.is_empty() {
            return Err(SceneError::EmptyScene);
        }

        let mut mesh_ids = std::collections::BTreeSet::new();
        for (mesh_index, mesh) in meshes.iter().enumerate() {
            if mesh.id.is_empty() {
                return Err(SceneError::EmptyMeshId { mesh: mesh_index });
            }
            if !mesh_ids.insert(mesh.id.as_str()) {
                return Err(SceneError::DuplicateMeshId { mesh: mesh_index });
            }
        }

        let mut node_ids = std::collections::BTreeSet::new();
        for (node_index, node) in nodes.iter().enumerate() {
            if node.id.is_empty() {
                return Err(SceneError::EmptyNodeId { node: node_index });
            }
            if !node_ids.insert(node.id.as_str()) {
                return Err(SceneError::DuplicateNodeId { node: node_index });
            }
            if let Some(parent) = node.parent
                && parent >= node_index
            {
                return Err(SceneError::ParentMustPrecedeChild {
                    node: node_index,
                    parent,
                });
            }
            if let Some(mesh) = node.mesh
                && mesh >= meshes.len()
            {
                return Err(SceneError::MeshIndexOutOfBounds {
                    node: node_index,
                    mesh,
                    mesh_count: meshes.len(),
                });
            }
            validate_transform(node.local, node_index)?;
        }

        Ok(Self { meshes, nodes })
    }

    pub fn meshes(&self) -> &[SceneMesh] {
        &self.meshes
    }

    pub fn nodes(&self) -> &[SceneNode] {
        &self.nodes
    }

    pub fn normalized(&self) -> Result<Self, SceneError> {
        let mut mesh_order: Vec<_> = (0..self.meshes.len()).collect();
        mesh_order.sort_by(|left, right| self.meshes[*left].id.cmp(&self.meshes[*right].id));
        let mut mesh_remap = vec![0usize; self.meshes.len()];
        let meshes = mesh_order
            .into_iter()
            .enumerate()
            .map(|(new_index, old_index)| {
                mesh_remap[old_index] = new_index;
                SceneMesh::new(
                    self.meshes[old_index].id.clone(),
                    normalize_mesh(&self.meshes[old_index].mesh),
                )
            })
            .collect();

        let mut children = vec![Vec::new(); self.nodes.len()];
        let mut roots = Vec::new();
        for (index, node) in self.nodes.iter().enumerate() {
            match node.parent {
                Some(parent) => children[parent].push(index),
                None => roots.push(index),
            }
        }
        roots.sort_by(|left, right| self.nodes[*left].id.cmp(&self.nodes[*right].id));
        for child_list in &mut children {
            child_list.sort_by(|left, right| self.nodes[*left].id.cmp(&self.nodes[*right].id));
        }

        let mut node_order = Vec::with_capacity(self.nodes.len());
        for root in roots {
            append_subtree(root, &children, &mut node_order);
        }

        let mut node_remap = vec![0usize; self.nodes.len()];
        for (new_index, old_index) in node_order.iter().copied().enumerate() {
            node_remap[old_index] = new_index;
        }

        let nodes = node_order
            .into_iter()
            .map(|old_index| {
                let source = &self.nodes[old_index];
                SceneNode::new(
                    source.id.clone(),
                    source.parent.map(|parent| node_remap[parent]),
                    source.mesh.map(|mesh| mesh_remap[mesh]),
                    canonical_transform(source.local),
                )
            })
            .collect();

        Self::new(meshes, nodes)
    }
}

fn append_subtree(node: usize, children: &[Vec<usize>], order: &mut Vec<usize>) {
    order.push(node);
    for &child in &children[node] {
        append_subtree(child, children, order);
    }
}

fn validate_transform(transform: Transform, node: usize) -> Result<(), SceneError> {
    let components = [
        transform.translation.x,
        transform.translation.y,
        transform.translation.z,
        transform.rotation.x,
        transform.rotation.y,
        transform.rotation.z,
        transform.rotation.w,
        transform.scale.x,
        transform.scale.y,
        transform.scale.z,
    ];
    if components.iter().any(|value| !value.is_finite()) {
        return Err(SceneError::NonFiniteTransform { node });
    }
    if (transform.rotation.length() - 1.0).abs() > UNIT_QUATERNION_TOLERANCE {
        return Err(SceneError::NonUnitQuaternion { node });
    }
    Ok(())
}

fn canonical_scalar(value: f32) -> f32 {
    if value == 0.0 { 0.0 } else { value }
}

fn canonical_vec2(value: Vec2) -> Vec2 {
    Vec2::new(canonical_scalar(value.x), canonical_scalar(value.y))
}

fn canonical_vec3(value: Vec3) -> Vec3 {
    Vec3::new(
        canonical_scalar(value.x),
        canonical_scalar(value.y),
        canonical_scalar(value.z),
    )
}

fn canonical_tangent(value: Tangent4) -> Tangent4 {
    Tangent4::new(
        canonical_scalar(value.x),
        canonical_scalar(value.y),
        canonical_scalar(value.z),
        canonical_scalar(value.w),
    )
}

fn canonical_color(value: Color3) -> Color3 {
    Color3::new(
        canonical_scalar(value.r),
        canonical_scalar(value.g),
        canonical_scalar(value.b),
    )
}

fn canonical_quat(value: Quat) -> Quat {
    let normalized = value.normalized().expect("validated unit quaternion");
    let flip = normalized.w < 0.0
        || (normalized.w == 0.0
            && (normalized.x < 0.0
                || (normalized.x == 0.0
                    && (normalized.y < 0.0 || (normalized.y == 0.0 && normalized.z < 0.0)))));
    let factor = if flip { -1.0 } else { 1.0 };
    Quat::new(
        canonical_scalar(normalized.x * factor),
        canonical_scalar(normalized.y * factor),
        canonical_scalar(normalized.z * factor),
        canonical_scalar(normalized.w * factor),
    )
}

fn canonical_transform(value: Transform) -> Transform {
    Transform {
        translation: canonical_vec3(value.translation),
        rotation: canonical_quat(value.rotation),
        scale: canonical_vec3(value.scale),
    }
}

fn normalize_mesh(mesh: &Mesh) -> Mesh {
    let mut remap = vec![UNMAPPED_INDEX; mesh.vertices().len()];
    let mut vertices = Vec::new();
    let mut indices = Vec::with_capacity(mesh.indices().len());
    let source_attributes = mesh.attributes();
    let mut normals = source_attributes.normals.as_ref().map(|_| Vec::new());
    let mut tangents = source_attributes.tangents.as_ref().map(|_| Vec::new());
    let mut uvs = source_attributes.uvs.as_ref().map(|_| Vec::new());
    let mut colors = source_attributes.colors.as_ref().map(|_| Vec::new());

    for &source_index in mesh.indices() {
        let source_index_usize = source_index as usize;
        let mapped = if remap[source_index_usize] == UNMAPPED_INDEX {
            let mapped = vertices.len() as u32;
            remap[source_index_usize] = mapped;
            vertices.push(canonical_vec3(mesh.vertices()[source_index_usize]));
            if let (Some(output), Some(source)) = (&mut normals, &source_attributes.normals) {
                output.push(canonical_vec3(source[source_index_usize]));
            }
            if let (Some(output), Some(source)) = (&mut tangents, &source_attributes.tangents) {
                output.push(canonical_tangent(source[source_index_usize]));
            }
            if let (Some(output), Some(source)) = (&mut uvs, &source_attributes.uvs) {
                output.push(canonical_vec2(source[source_index_usize]));
            }
            if let (Some(output), Some(source)) = (&mut colors, &source_attributes.colors) {
                output.push(canonical_color(source[source_index_usize]));
            }
            mapped
        } else {
            remap[source_index_usize]
        };
        indices.push(mapped);
    }

    Mesh::with_attributes(
        vertices,
        indices,
        VertexAttributes {
            normals,
            tangents,
            uvs,
            colors,
        },
    )
    .expect("normalization preserves validated mesh structure")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn triangle_with_unused_vertex() -> Mesh {
        Mesh::with_attributes(
            vec![
                Vec3::new(99.0, 99.0, 99.0),
                Vec3::new(-0.0, 0.0, 0.0),
                Vec3::new(1.0, 0.0, 0.0),
                Vec3::new(0.0, 1.0, 0.0),
            ],
            vec![1, 2, 3],
            VertexAttributes {
                normals: Some(vec![Vec3::new(0.0, 0.0, 1.0); 4]),
                ..VertexAttributes::default()
            },
        )
        .unwrap()
    }

    #[test]
    fn normalization_sorts_scene_semantics_and_compacts_meshes() {
        let snapshot = SceneSnapshot::new(
            vec![
                SceneMesh::new("z-mesh", triangle_with_unused_vertex()),
                SceneMesh::new("a-mesh", triangle_with_unused_vertex()),
            ],
            vec![
                SceneNode::new("z-root", None, Some(0), Transform::IDENTITY),
                SceneNode::new("z-child", Some(0), None, Transform::IDENTITY),
                SceneNode::new("a-root", None, Some(1), Transform::IDENTITY),
            ],
        )
        .unwrap();

        let normalized = snapshot.normalized().unwrap();
        assert_eq!(
            normalized
                .meshes()
                .iter()
                .map(SceneMesh::id)
                .collect::<Vec<_>>(),
            vec!["a-mesh", "z-mesh"]
        );
        assert_eq!(
            normalized
                .nodes()
                .iter()
                .map(SceneNode::id)
                .collect::<Vec<_>>(),
            vec!["a-root", "z-root", "z-child"]
        );
        assert_eq!(normalized.nodes()[0].mesh(), Some(0));
        assert_eq!(normalized.nodes()[1].mesh(), Some(1));
        assert_eq!(normalized.nodes()[2].parent(), Some(1));
        for mesh in normalized.meshes() {
            assert_eq!(mesh.mesh().vertices().len(), 3);
            assert_eq!(mesh.mesh().indices(), &[0, 1, 2]);
            assert_eq!(mesh.mesh().vertices()[0].x.to_bits(), 0.0_f32.to_bits());
        }
    }

    #[test]
    fn normalization_canonicalizes_equivalent_quaternion_signs() {
        let snapshot = SceneSnapshot::new(
            vec![],
            vec![SceneNode::new(
                "root",
                None,
                None,
                Transform {
                    rotation: Quat::new(0.0, -1.0, 0.0, 0.0),
                    ..Transform::IDENTITY
                },
            )],
        )
        .unwrap();
        let normalized = snapshot.normalized().unwrap();
        assert_eq!(
            normalized.nodes()[0].local().rotation,
            Quat::new(0.0, 1.0, 0.0, 0.0)
        );
    }

    #[test]
    fn validation_rejects_ambiguous_hierarchy_mesh_references_and_rotation() {
        assert_eq!(
            SceneSnapshot::new(
                vec![],
                vec![SceneNode::new("root", Some(0), None, Transform::IDENTITY)]
            ),
            Err(SceneError::ParentMustPrecedeChild { node: 0, parent: 0 })
        );
        assert_eq!(
            SceneSnapshot::new(
                vec![],
                vec![SceneNode::new("root", None, Some(0), Transform::IDENTITY)]
            ),
            Err(SceneError::MeshIndexOutOfBounds {
                node: 0,
                mesh: 0,
                mesh_count: 0,
            })
        );
        assert_eq!(
            SceneSnapshot::new(
                vec![],
                vec![SceneNode::new(
                    "root",
                    None,
                    None,
                    Transform {
                        rotation: Quat::new(0.0, 0.0, 0.0, 2.0),
                        ..Transform::IDENTITY
                    },
                )]
            ),
            Err(SceneError::NonUnitQuaternion { node: 0 })
        );
    }
}
