use core::fmt;

use serde_json::{Map, Value, json};
use three_d_scene::{SceneError, SceneSnapshot};

const GLB_MAGIC: &[u8; 4] = b"glTF";
const GLB_VERSION: u32 = 2;
const JSON_CHUNK_TYPE: u32 = 0x4e4f534a;
const BIN_CHUNK_TYPE: u32 = 0x004e4942;
const ARRAY_BUFFER_TARGET: u32 = 34962;
const ELEMENT_ARRAY_BUFFER_TARGET: u32 = 34963;
const COMPONENT_F32: u32 = 5126;
const COMPONENT_U32: u32 = 5125;
const TRIANGLES_MODE: u32 = 4;

#[derive(Debug)]
pub enum SceneExportError {
    Scene(SceneError),
    EmptyMesh { mesh: usize },
    Json(serde_json::Error),
    OutputTooLarge,
}

impl fmt::Display for SceneExportError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Scene(error) => write!(formatter, "scene normalization failed: {error}"),
            Self::EmptyMesh { mesh } => write!(
                formatter,
                "scene mesh {mesh} must contain indexed triangle geometry before GLB export"
            ),
            Self::Json(error) => write!(formatter, "failed to serialize canonical glTF JSON: {error}"),
            Self::OutputTooLarge => formatter.write_str("canonical GLB exceeds the 32-bit GLB size domain"),
        }
    }
}

impl std::error::Error for SceneExportError {}

impl From<SceneError> for SceneExportError {
    fn from(error: SceneError) -> Self {
        Self::Scene(error)
    }
}

impl From<serde_json::Error> for SceneExportError {
    fn from(error: serde_json::Error) -> Self {
        Self::Json(error)
    }
}

fn u32_size(value: usize) -> Result<u32, SceneExportError> {
    u32::try_from(value).map_err(|_| SceneExportError::OutputTooLarge)
}

fn align_four(bytes: &mut Vec<u8>, padding: u8) {
    while !bytes.len().is_multiple_of(4) {
        bytes.push(padding);
    }
}

fn append_f32(bytes: &mut Vec<u8>, value: f32) {
    bytes.extend_from_slice(&value.to_le_bytes());
}

fn append_u32(bytes: &mut Vec<u8>, value: u32) {
    bytes.extend_from_slice(&value.to_le_bytes());
}

fn add_buffer_view(
    binary: &mut Vec<u8>,
    buffer_views: &mut Vec<Value>,
    target: u32,
    write: impl FnOnce(&mut Vec<u8>),
) -> Result<usize, SceneExportError> {
    align_four(binary, 0);
    let offset = binary.len();
    write(binary);
    let length = binary.len() - offset;
    let index = buffer_views.len();
    buffer_views.push(json!({
        "buffer": 0,
        "byteLength": u32_size(length)?,
        "byteOffset": u32_size(offset)?,
        "target": target,
    }));
    Ok(index)
}

fn add_f32_accessor(
    binary: &mut Vec<u8>,
    buffer_views: &mut Vec<Value>,
    accessors: &mut Vec<Value>,
    width: usize,
    values: impl Iterator<Item = Vec<f32>>,
    count: usize,
    semantic: Option<(&str, Vec<f32>, Vec<f32>)>,
) -> Result<usize, SceneExportError> {
    let collected: Vec<Vec<f32>> = values.collect();
    debug_assert_eq!(collected.len(), count);
    debug_assert!(collected.iter().all(|value| value.len() == width));
    let view = add_buffer_view(binary, buffer_views, ARRAY_BUFFER_TARGET, |bytes| {
        for value in &collected {
            for component in value {
                append_f32(bytes, *component);
            }
        }
    })?;
    let mut accessor = Map::new();
    accessor.insert("bufferView".into(), json!(view));
    accessor.insert("byteOffset".into(), json!(0));
    accessor.insert("componentType".into(), json!(COMPONENT_F32));
    accessor.insert("count".into(), json!(count));
    accessor.insert(
        "type".into(),
        json!(match width {
            2 => "VEC2",
            3 => "VEC3",
            4 => "VEC4",
            _ => unreachable!("bounded vector width"),
        }),
    );
    if let Some((_name, minimum, maximum)) = semantic {
        accessor.insert("min".into(), json!(minimum));
        accessor.insert("max".into(), json!(maximum));
    }
    let index = accessors.len();
    accessors.push(Value::Object(accessor));
    Ok(index)
}

fn position_bounds(vertices: &[three_d_core::Vec3]) -> (Vec<f32>, Vec<f32>) {
    let mut minimum = [f32::INFINITY; 3];
    let mut maximum = [f32::NEG_INFINITY; 3];
    for vertex in vertices {
        let values = [vertex.x, vertex.y, vertex.z];
        for axis in 0..3 {
            minimum[axis] = minimum[axis].min(values[axis]);
            maximum[axis] = maximum[axis].max(values[axis]);
        }
    }
    (minimum.to_vec(), maximum.to_vec())
}

pub fn export_scene_glb(scene: &SceneSnapshot) -> Result<Vec<u8>, SceneExportError> {
    let scene = scene.normalized()?;
    let mut binary = Vec::new();
    let mut buffer_views = Vec::new();
    let mut accessors = Vec::new();
    let mut gltf_meshes = Vec::new();

    for (mesh_index, scene_mesh) in scene.meshes().iter().enumerate() {
        let mesh = scene_mesh.mesh();
        if mesh.vertices().is_empty() || mesh.indices().is_empty() {
            return Err(SceneExportError::EmptyMesh { mesh: mesh_index });
        }
        let (minimum, maximum) = position_bounds(mesh.vertices());
        let position_accessor = add_f32_accessor(
            &mut binary,
            &mut buffer_views,
            &mut accessors,
            3,
            mesh.vertices().iter().map(|value| vec![value.x, value.y, value.z]),
            mesh.vertices().len(),
            Some(("POSITION", minimum, maximum)),
        )?;

        let mut attributes = Map::new();
        attributes.insert("POSITION".into(), json!(position_accessor));
        if let Some(normals) = &mesh.attributes().normals {
            let accessor = add_f32_accessor(
                &mut binary,
                &mut buffer_views,
                &mut accessors,
                3,
                normals.iter().map(|value| vec![value.x, value.y, value.z]),
                normals.len(),
                None,
            )?;
            attributes.insert("NORMAL".into(), json!(accessor));
        }
        if let Some(tangents) = &mesh.attributes().tangents {
            let accessor = add_f32_accessor(
                &mut binary,
                &mut buffer_views,
                &mut accessors,
                4,
                tangents
                    .iter()
                    .map(|value| vec![value.x, value.y, value.z, value.w]),
                tangents.len(),
                None,
            )?;
            attributes.insert("TANGENT".into(), json!(accessor));
        }
        if let Some(uvs) = &mesh.attributes().uvs {
            let accessor = add_f32_accessor(
                &mut binary,
                &mut buffer_views,
                &mut accessors,
                2,
                uvs.iter().map(|value| vec![value.x, value.y]),
                uvs.len(),
                None,
            )?;
            attributes.insert("TEXCOORD_0".into(), json!(accessor));
        }
        if let Some(colors) = &mesh.attributes().colors {
            let accessor = add_f32_accessor(
                &mut binary,
                &mut buffer_views,
                &mut accessors,
                3,
                colors.iter().map(|value| vec![value.r, value.g, value.b]),
                colors.len(),
                None,
            )?;
            attributes.insert("COLOR_0".into(), json!(accessor));
        }

        let index_view = add_buffer_view(
            &mut binary,
            &mut buffer_views,
            ELEMENT_ARRAY_BUFFER_TARGET,
            |bytes| {
                for &index in mesh.indices() {
                    append_u32(bytes, index);
                }
            },
        )?;
        let index_accessor = accessors.len();
        accessors.push(json!({
            "bufferView": index_view,
            "byteOffset": 0,
            "componentType": COMPONENT_U32,
            "count": mesh.indices().len(),
            "type": "SCALAR",
        }));

        gltf_meshes.push(json!({
            "name": scene_mesh.id(),
            "primitives": [{
                "attributes": Value::Object(attributes),
                "indices": index_accessor,
                "mode": TRIANGLES_MODE,
            }],
        }));
    }

    let mut children = vec![Vec::new(); scene.nodes().len()];
    let mut roots = Vec::new();
    for (node_index, node) in scene.nodes().iter().enumerate() {
        match node.parent() {
            Some(parent) => children[parent].push(node_index),
            None => roots.push(node_index),
        }
    }

    let gltf_nodes = scene
        .nodes()
        .iter()
        .enumerate()
        .map(|(node_index, node)| {
            let local = node.local();
            let mut value = Map::new();
            value.insert("name".into(), json!(node.id()));
            value.insert(
                "translation".into(),
                json!([local.translation.x, local.translation.y, local.translation.z]),
            );
            value.insert(
                "rotation".into(),
                json!([
                    local.rotation.x,
                    local.rotation.y,
                    local.rotation.z,
                    local.rotation.w
                ]),
            );
            value.insert("scale".into(), json!([local.scale.x, local.scale.y, local.scale.z]));
            if let Some(mesh) = node.mesh() {
                value.insert("mesh".into(), json!(mesh));
            }
            if !children[node_index].is_empty() {
                value.insert("children".into(), json!(children[node_index]));
            }
            Value::Object(value)
        })
        .collect::<Vec<_>>();

    let binary_length = binary.len();
    let document = json!({
        "accessors": accessors,
        "asset": {
            "generator": "three-d-formats canonical scene exporter v1",
            "version": "2.0",
        },
        "bufferViews": buffer_views,
        "buffers": [{ "byteLength": binary_length }],
        "meshes": gltf_meshes,
        "nodes": gltf_nodes,
        "scene": 0,
        "scenes": [{ "name": "scene", "nodes": roots }],
    });
    let mut json_bytes = serde_json::to_vec(&document)?;
    align_four(&mut json_bytes, b' ');
    align_four(&mut binary, 0);

    let total_length = 12usize
        .checked_add(8)
        .and_then(|value| value.checked_add(json_bytes.len()))
        .and_then(|value| value.checked_add(8))
        .and_then(|value| value.checked_add(binary.len()))
        .ok_or(SceneExportError::OutputTooLarge)?;

    let mut glb = Vec::with_capacity(total_length);
    glb.extend_from_slice(GLB_MAGIC);
    glb.extend_from_slice(&GLB_VERSION.to_le_bytes());
    glb.extend_from_slice(&u32_size(total_length)?.to_le_bytes());
    glb.extend_from_slice(&u32_size(json_bytes.len())?.to_le_bytes());
    glb.extend_from_slice(&JSON_CHUNK_TYPE.to_le_bytes());
    glb.extend_from_slice(&json_bytes);
    glb.extend_from_slice(&u32_size(binary.len())?.to_le_bytes());
    glb.extend_from_slice(&BIN_CHUNK_TYPE.to_le_bytes());
    glb.extend_from_slice(&binary);
    Ok(glb)
}

#[cfg(test)]
mod tests {
    use super::*;
    use three_d_animation::{Quat, Transform};
    use three_d_core::{Mesh, Vec3, VertexAttributes};
    use three_d_scene::{SceneMesh, SceneNode, SceneSnapshot};

    fn scene_fixture() -> SceneSnapshot {
        let mesh = Mesh::with_attributes(
            vec![
                Vec3::new(9.0, 9.0, 9.0),
                Vec3::new(0.0, 0.0, 0.0),
                Vec3::new(1.0, 0.0, 0.0),
                Vec3::new(0.0, 1.0, 0.0),
            ],
            vec![1, 2, 3],
            VertexAttributes {
                normals: Some(vec![Vec3::new(0.0, 0.0, 1.0); 4]),
                ..VertexAttributes::default()
            },
        )
        .unwrap();
        SceneSnapshot::new(
            vec![SceneMesh::new("triangle", mesh)],
            vec![SceneNode::new(
                "root",
                None,
                Some(0),
                Transform {
                    translation: Vec3::new(2.0, 3.0, 4.0),
                    rotation: Quat::IDENTITY,
                    scale: Vec3::new(1.0, 2.0, 1.0),
                },
            )],
        )
        .unwrap()
    }

    #[test]
    fn canonical_glb_is_repeatable_and_loadable() {
        let first = export_scene_glb(&scene_fixture()).unwrap();
        let second = export_scene_glb(&scene_fixture()).unwrap();
        assert_eq!(second, first);

        let gltf = gltf::Gltf::from_slice(&first).unwrap();
        assert_eq!(gltf.meshes().count(), 1);
        let node = gltf.nodes().next().unwrap();
        let (translation, rotation, scale) = node.transform().decomposed();
        assert_eq!(translation, [2.0, 3.0, 4.0]);
        assert_eq!(rotation, [0.0, 0.0, 0.0, 1.0]);
        assert_eq!(scale, [1.0, 2.0, 1.0]);
        assert_eq!(node.name(), Some("root"));
    }

    #[test]
    fn canonical_glb_round_trips_normalized_geometry_through_loader() {
        let bytes = export_scene_glb(&scene_fixture()).unwrap();
        let asset = crate::load_gltf(&bytes).unwrap();
        let mesh = asset.meshes()[0].primitives()[0].mesh();
        assert_eq!(mesh.vertices().len(), 3);
        assert_eq!(mesh.indices(), &[0, 1, 2]);
        assert_eq!(mesh.attributes().normals.as_ref().unwrap().len(), 3);
    }

    #[test]
    fn export_rejects_an_empty_geometry_mesh() {
        let snapshot = SceneSnapshot::new(
            vec![SceneMesh::new("empty", Mesh::new(vec![], vec![]).unwrap())],
            vec![SceneNode::new("root", None, Some(0), Transform::IDENTITY)],
        )
        .unwrap();
        assert!(matches!(
            export_scene_glb(&snapshot),
            Err(SceneExportError::EmptyMesh { mesh: 0 })
        ));
    }
}
