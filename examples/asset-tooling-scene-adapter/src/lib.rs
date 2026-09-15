use std::collections::BTreeMap;
use std::env;
use std::fs;
use std::path::{Component, Path, PathBuf};

use serde::{Deserialize, Serialize};
use three_d_animation::{Quat, Transform};
use three_d_core::{Color3, Mesh, Tangent4, Vec2, Vec3, VertexAttributes};
use three_d_export::export_scene_glb;
use three_d_scene::{SceneMesh, SceneNode, SceneSnapshot};

const PROTOCOL: &str = "asset-tooling-process-adapter-v1";
const SCENE_CODEC: &str = "three-d-scene-json-v1";
const GLB_CODEC: &str = "gltf-binary-v2";
const NORMALIZE_PROCESSOR_ID: &str = "three-d-scene-normalize";
const EXPORT_PROCESSOR_ID: &str = "three-d-scene-export-glb";
const NORMALIZE_OPERATION: &str = "scene.normalize";
const EXPORT_OPERATION: &str = "scene.export.glb";
const NORMALIZE_ALGORITHM: &str = "three-d-scene-normalize-v1";
const EXPORT_ALGORITHM: &str = "three-d-export-glb-v1";
const DOCUMENT_SCHEMA_VERSION: u32 = 1;
const COORDINATE_SYSTEM: &str = "right-handed-y-up";
const OUTPUT_UNIT: &str = "meter";
const CARGO_LOCK: &str = include_str!("../../../Cargo.lock");

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AdapterOperation {
    Normalize,
    ExportGlb,
}

impl AdapterOperation {
    fn operation(self) -> &'static str {
        match self {
            Self::Normalize => NORMALIZE_OPERATION,
            Self::ExportGlb => EXPORT_OPERATION,
        }
    }

    fn processor_id(self) -> &'static str {
        match self {
            Self::Normalize => NORMALIZE_PROCESSOR_ID,
            Self::ExportGlb => EXPORT_PROCESSOR_ID,
        }
    }

    fn algorithm(self) -> &'static str {
        match self {
            Self::Normalize => NORMALIZE_ALGORITHM,
            Self::ExportGlb => EXPORT_ALGORITHM,
        }
    }

    fn codec(self) -> &'static str {
        match self {
            Self::Normalize => SCENE_CODEC,
            Self::ExportGlb => GLB_CODEC,
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Request {
    schema_version: u32,
    operation: String,
    input_path: String,
    parameters: EmptyParameters,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct EmptyParameters {}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SceneDocument {
    schema_version: u32,
    coordinate_system: String,
    unit: String,
    meshes: Vec<MeshDocument>,
    nodes: Vec<NodeDocument>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MeshDocument {
    id: String,
    vertices: Vec<[f32; 3]>,
    indices: Vec<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    normals: Option<Vec<[f32; 3]>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    tangents: Option<Vec<[f32; 4]>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    uvs: Option<Vec<[f32; 2]>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    colors: Option<Vec<[f32; 3]>>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct NodeDocument {
    id: String,
    parent: Option<String>,
    mesh: Option<String>,
    translation: [f32; 3],
    rotation: [f32; 4],
    scale: [f32; 3],
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProbeDependencies<'a> {
    serde: &'a str,
    serde_json: &'a str,
    three_d_scene: &'a str,
    three_d_export: &'a str,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProbeComponent<'a> {
    id: &'a str,
    version: &'a str,
    algorithm: &'a str,
    protocol: &'a str,
    codec: &'a str,
    dependencies: ProbeDependencies<'a>,
    cargo_lock: &'a str,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct NormalizeObservations {
    source_mesh_count: usize,
    result_mesh_count: usize,
    node_count: usize,
    root_node_count: usize,
    source_vertex_count: usize,
    result_vertex_count: usize,
    removed_unused_vertex_count: usize,
    triangle_count: usize,
    source_unit: String,
    output_unit: &'static str,
    coordinate_system: &'static str,
    canonical_order: bool,
    canonical_quaternion_sign: bool,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct ExportObservations {
    mesh_count: usize,
    node_count: usize,
    root_node_count: usize,
    vertex_count: usize,
    triangle_count: usize,
    coordinate_system: &'static str,
    unit: &'static str,
    format: &'static str,
    normalized_before_export: bool,
    byte_length: usize,
}

struct SceneBuild {
    scene: SceneSnapshot,
    source_mesh_count: usize,
    source_vertex_count: usize,
    source_unit: String,
}

fn resolve_input_path(value: &str) -> Result<PathBuf, String> {
    if value.is_empty() {
        return Err("inputPath must be a non-empty portable relative path".into());
    }
    let path = Path::new(value);
    if path.is_absolute()
        || path.components().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
    {
        return Err("inputPath must be a portable relative path without parent traversal".into());
    }
    Ok(env::current_dir()
        .map_err(|error| format!("failed to resolve current directory: {error}"))?
        .join(path))
}

fn unit_scale_to_meters(unit: &str) -> Result<f32, String> {
    match unit {
        "meter" => Ok(1.0),
        "centimeter" => Ok(0.01),
        "millimeter" => Ok(0.001),
        _ => Err("scene unit must be meter, centimeter, or millimeter".into()),
    }
}

fn scaled_vec3(value: [f32; 3], factor: f32) -> Vec3 {
    Vec3::new(value[0] * factor, value[1] * factor, value[2] * factor)
}

fn mesh_from_document(value: &MeshDocument, unit_scale: f32) -> Result<Mesh, String> {
    let vertices = value
        .vertices
        .iter()
        .copied()
        .map(|vertex| scaled_vec3(vertex, unit_scale))
        .collect();
    let normals = value.normals.as_ref().map(|values| {
        values
            .iter()
            .map(|value| Vec3::new(value[0], value[1], value[2]))
            .collect()
    });
    let tangents = value.tangents.as_ref().map(|values| {
        values
            .iter()
            .map(|value| Tangent4::new(value[0], value[1], value[2], value[3]))
            .collect()
    });
    let uvs = value.uvs.as_ref().map(|values| {
        values
            .iter()
            .map(|value| Vec2::new(value[0], value[1]))
            .collect()
    });
    let colors = value.colors.as_ref().map(|values| {
        values
            .iter()
            .map(|value| Color3::new(value[0], value[1], value[2]))
            .collect()
    });
    Mesh::with_attributes(
        vertices,
        value.indices.clone(),
        VertexAttributes {
            normals,
            tangents,
            uvs,
            colors,
        },
    )
    .map_err(|error| format!("invalid mesh '{}': {error}", value.id))
}

fn append_node_subtree(
    node: usize,
    children: &[Vec<usize>],
    order: &mut Vec<usize>,
) {
    order.push(node);
    for &child in &children[node] {
        append_node_subtree(child, children, order);
    }
}

fn build_scene(document: &SceneDocument) -> Result<SceneBuild, String> {
    if document.schema_version != DOCUMENT_SCHEMA_VERSION {
        return Err(format!(
            "scene schemaVersion must be {DOCUMENT_SCHEMA_VERSION}, got {}",
            document.schema_version
        ));
    }
    if document.coordinate_system != COORDINATE_SYSTEM {
        return Err(format!(
            "scene coordinateSystem must be '{COORDINATE_SYSTEM}'"
        ));
    }
    let unit_scale = unit_scale_to_meters(&document.unit)?;

    let mut mesh_index_by_id = BTreeMap::new();
    let mut meshes = Vec::with_capacity(document.meshes.len());
    let mut source_vertex_count = 0usize;
    for (mesh_index, mesh) in document.meshes.iter().enumerate() {
        if mesh.id.is_empty() {
            return Err(format!("meshes[{mesh_index}].id must be non-empty"));
        }
        if mesh_index_by_id.insert(mesh.id.as_str(), mesh_index).is_some() {
            return Err(format!("duplicate mesh id '{}'", mesh.id));
        }
        source_vertex_count = source_vertex_count.saturating_add(mesh.vertices.len());
        meshes.push(SceneMesh::new(
            mesh.id.clone(),
            mesh_from_document(mesh, unit_scale)?,
        ));
    }

    if document.nodes.is_empty() {
        return Err("scene must contain at least one node".into());
    }
    let mut node_index_by_id = BTreeMap::new();
    for (node_index, node) in document.nodes.iter().enumerate() {
        if node.id.is_empty() {
            return Err(format!("nodes[{node_index}].id must be non-empty"));
        }
        if node_index_by_id.insert(node.id.as_str(), node_index).is_some() {
            return Err(format!("duplicate node id '{}'", node.id));
        }
    }

    let mut children = vec![Vec::new(); document.nodes.len()];
    let mut roots = Vec::new();
    for (node_index, node) in document.nodes.iter().enumerate() {
        if let Some(parent) = node.parent.as_deref() {
            let parent_index = *node_index_by_id
                .get(parent)
                .ok_or_else(|| format!("node '{}' references unknown parent '{parent}'", node.id))?;
            children[parent_index].push(node_index);
        } else {
            roots.push(node_index);
        }
        if let Some(mesh) = node.mesh.as_deref()
            && !mesh_index_by_id.contains_key(mesh)
        {
            return Err(format!("node '{}' references unknown mesh '{mesh}'", node.id));
        }
    }
    roots.sort_by(|left, right| document.nodes[*left].id.cmp(&document.nodes[*right].id));
    for child_list in &mut children {
        child_list.sort_by(|left, right| document.nodes[*left].id.cmp(&document.nodes[*right].id));
    }
    let mut order = Vec::with_capacity(document.nodes.len());
    for root in roots {
        append_node_subtree(root, &children, &mut order);
    }
    if order.len() != document.nodes.len() {
        return Err("scene node hierarchy contains a cycle".into());
    }

    let mut normalized_index_by_input = vec![0usize; document.nodes.len()];
    for (normalized_index, input_index) in order.iter().copied().enumerate() {
        normalized_index_by_input[input_index] = normalized_index;
    }
    let nodes = order
        .into_iter()
        .map(|input_index| {
            let node = &document.nodes[input_index];
            let parent = node.parent.as_deref().map(|parent| {
                let input_parent = node_index_by_id[parent];
                normalized_index_by_input[input_parent]
            });
            let mesh = node.mesh.as_deref().map(|mesh| mesh_index_by_id[mesh]);
            SceneNode::new(
                node.id.clone(),
                parent,
                mesh,
                Transform {
                    translation: scaled_vec3(node.translation, unit_scale),
                    rotation: Quat::new(
                        node.rotation[0],
                        node.rotation[1],
                        node.rotation[2],
                        node.rotation[3],
                    ),
                    scale: Vec3::new(node.scale[0], node.scale[1], node.scale[2]),
                },
            )
        })
        .collect();

    let scene = SceneSnapshot::new(meshes, nodes)
        .map_err(|error| format!("invalid scene snapshot: {error}"))?
        .normalized()
        .map_err(|error| format!("scene normalization failed: {error}"))?;
    Ok(SceneBuild {
        scene,
        source_mesh_count: document.meshes.len(),
        source_vertex_count,
        source_unit: document.unit.clone(),
    })
}

fn mesh_to_document(mesh: &SceneMesh) -> MeshDocument {
    let source = mesh.mesh();
    MeshDocument {
        id: mesh.id().to_owned(),
        vertices: source
            .vertices()
            .iter()
            .map(|value| [value.x, value.y, value.z])
            .collect(),
        indices: source.indices().to_vec(),
        normals: source.attributes().normals.as_ref().map(|values| {
            values.iter().map(|value| [value.x, value.y, value.z]).collect()
        }),
        tangents: source.attributes().tangents.as_ref().map(|values| {
            values
                .iter()
                .map(|value| [value.x, value.y, value.z, value.w])
                .collect()
        }),
        uvs: source
            .attributes()
            .uvs
            .as_ref()
            .map(|values| values.iter().map(|value| [value.x, value.y]).collect()),
        colors: source.attributes().colors.as_ref().map(|values| {
            values.iter().map(|value| [value.r, value.g, value.b]).collect()
        }),
    }
}

fn scene_to_document(scene: &SceneSnapshot) -> SceneDocument {
    let meshes = scene.meshes().iter().map(mesh_to_document).collect();
    let nodes = scene
        .nodes()
        .iter()
        .map(|node| {
            let local = node.local();
            NodeDocument {
                id: node.id().to_owned(),
                parent: node.parent().map(|parent| scene.nodes()[parent].id().to_owned()),
                mesh: node.mesh().map(|mesh| scene.meshes()[mesh].id().to_owned()),
                translation: [local.translation.x, local.translation.y, local.translation.z],
                rotation: [
                    local.rotation.x,
                    local.rotation.y,
                    local.rotation.z,
                    local.rotation.w,
                ],
                scale: [local.scale.x, local.scale.y, local.scale.z],
            }
        })
        .collect();
    SceneDocument {
        schema_version: DOCUMENT_SCHEMA_VERSION,
        coordinate_system: COORDINATE_SYSTEM.to_owned(),
        unit: OUTPUT_UNIT.to_owned(),
        meshes,
        nodes,
    }
}

fn scene_counts(scene: &SceneSnapshot) -> (usize, usize, usize, usize) {
    let root_node_count = scene.nodes().iter().filter(|node| node.parent().is_none()).count();
    let vertex_count = scene
        .meshes()
        .iter()
        .map(|mesh| mesh.mesh().vertices().len())
        .sum();
    let triangle_count = scene
        .meshes()
        .iter()
        .map(|mesh| mesh.mesh().triangle_count())
        .sum();
    (scene.meshes().len(), root_node_count, vertex_count, triangle_count)
}

fn normalize_document(document: &SceneDocument) -> Result<(SceneDocument, NormalizeObservations), String> {
    let build = build_scene(document)?;
    let (result_mesh_count, root_node_count, result_vertex_count, triangle_count) =
        scene_counts(&build.scene);
    let observations = NormalizeObservations {
        source_mesh_count: build.source_mesh_count,
        result_mesh_count,
        node_count: build.scene.nodes().len(),
        root_node_count,
        source_vertex_count: build.source_vertex_count,
        result_vertex_count,
        removed_unused_vertex_count: build.source_vertex_count.saturating_sub(result_vertex_count),
        triangle_count,
        source_unit: build.source_unit,
        output_unit: OUTPUT_UNIT,
        coordinate_system: COORDINATE_SYSTEM,
        canonical_order: true,
        canonical_quaternion_sign: true,
    };
    Ok((scene_to_document(&build.scene), observations))
}

fn export_document(document: &SceneDocument) -> Result<(Vec<u8>, ExportObservations), String> {
    let build = build_scene(document)?;
    let (mesh_count, root_node_count, vertex_count, triangle_count) = scene_counts(&build.scene);
    let bytes = export_scene_glb(&build.scene).map_err(|error| format!("GLB export failed: {error}"))?;
    let observations = ExportObservations {
        mesh_count,
        node_count: build.scene.nodes().len(),
        root_node_count,
        vertex_count,
        triangle_count,
        coordinate_system: COORDINATE_SYSTEM,
        unit: OUTPUT_UNIT,
        format: "glb-2.0",
        normalized_before_export: true,
        byte_length: bytes.len(),
    };
    Ok((bytes, observations))
}

fn read_document(input_path: &str) -> Result<SceneDocument, String> {
    let path = resolve_input_path(input_path)?;
    serde_json::from_slice(
        &fs::read(&path)
            .map_err(|error| format!("failed to read input scene '{input_path}': {error}"))?,
    )
    .map_err(|error| format!("invalid input scene JSON: {error}"))
}

fn write_json<T: Serialize>(path: &Path, value: &T, label: &str) -> Result<(), String> {
    let bytes = serde_json::to_vec(value)
        .map_err(|error| format!("failed to serialize {label}: {error}"))?;
    fs::write(path, bytes).map_err(|error| format!("failed to write {label}: {error}"))
}

fn probe(operation: AdapterOperation) -> Result<(), String> {
    let components = [ProbeComponent {
        id: operation.processor_id(),
        version: env!("CARGO_PKG_VERSION"),
        algorithm: operation.algorithm(),
        protocol: PROTOCOL,
        codec: operation.codec(),
        dependencies: ProbeDependencies {
            serde: "1.0.229",
            serde_json: "1.0.151",
            three_d_scene: "0.1.0",
            three_d_export: "0.1.0",
        },
        cargo_lock: CARGO_LOCK,
    }];
    println!(
        "{}",
        serde_json::to_string(&components)
            .map_err(|error| format!("failed to serialize probe: {error}"))?
    );
    Ok(())
}

fn generate(
    operation: AdapterOperation,
    request_path: &Path,
    output_path: &Path,
    observations_path: &Path,
) -> Result<(), String> {
    let request: Request = serde_json::from_slice(
        &fs::read(request_path).map_err(|error| format!("failed to read request: {error}"))?,
    )
    .map_err(|error| format!("invalid request JSON: {error}"))?;
    if request.schema_version != 1 {
        return Err(format!(
            "request schemaVersion must be 1, got {}",
            request.schema_version
        ));
    }
    if request.operation != operation.operation() {
        return Err(format!("unsupported operation '{}'", request.operation));
    }
    let _parameters = request.parameters;
    let source = read_document(&request.input_path)?;
    match operation {
        AdapterOperation::Normalize => {
            let (output, observations) = normalize_document(&source)?;
            write_json(output_path, &output, "normalized scene")?;
            write_json(observations_path, &observations, "normalization observations")
        }
        AdapterOperation::ExportGlb => {
            let (bytes, observations) = export_document(&source)?;
            fs::write(output_path, bytes)
                .map_err(|error| format!("failed to write canonical GLB: {error}"))?;
            write_json(observations_path, &observations, "export observations")
        }
    }
}

pub fn run(operation: AdapterOperation) {
    let mut args = env::args_os().skip(1);
    let mode = args.next().and_then(|value| value.into_string().ok());
    let result = match mode.as_deref() {
        Some("probe") if args.next().is_none() => probe(operation),
        Some("generate") => {
            let request = args.next().map(PathBuf::from);
            let output = args.next().map(PathBuf::from);
            let observations = args.next().map(PathBuf::from);
            if args.next().is_some()
                || request.is_none()
                || output.is_none()
                || observations.is_none()
            {
                Err("usage: scene adapter probe | generate REQUEST OUTPUT OBSERVATIONS".into())
            } else {
                generate(
                    operation,
                    request.as_deref().expect("checked above"),
                    output.as_deref().expect("checked above"),
                    observations.as_deref().expect("checked above"),
                )
            }
        }
        _ => Err("usage: scene adapter probe | generate REQUEST OUTPUT OBSERVATIONS".into()),
    };

    if let Err(error) = result {
        eprintln!("{error}");
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> SceneDocument {
        SceneDocument {
            schema_version: 1,
            coordinate_system: COORDINATE_SYSTEM.into(),
            unit: "centimeter".into(),
            meshes: vec![
                MeshDocument {
                    id: "z-mesh".into(),
                    vertices: vec![
                        [999.0, 999.0, 999.0],
                        [-0.0, 0.0, 0.0],
                        [100.0, 0.0, 0.0],
                        [0.0, 100.0, 0.0],
                    ],
                    indices: vec![1, 2, 3],
                    normals: Some(vec![[0.0, 0.0, 1.0]; 4]),
                    tangents: None,
                    uvs: None,
                    colors: None,
                },
                MeshDocument {
                    id: "a-mesh".into(),
                    vertices: vec![[0.0, 0.0, 0.0], [50.0, 0.0, 0.0], [0.0, 50.0, 0.0]],
                    indices: vec![0, 1, 2],
                    normals: None,
                    tangents: None,
                    uvs: None,
                    colors: None,
                },
            ],
            nodes: vec![
                NodeDocument {
                    id: "z-child".into(),
                    parent: Some("z-root".into()),
                    mesh: None,
                    translation: [0.0, 25.0, 0.0],
                    rotation: [0.0, -1.0, 0.0, 0.0],
                    scale: [1.0, 1.0, 1.0],
                },
                NodeDocument {
                    id: "a-root".into(),
                    parent: None,
                    mesh: Some("a-mesh".into()),
                    translation: [0.0, 0.0, 0.0],
                    rotation: [0.0, 0.0, 0.0, 1.0],
                    scale: [1.0, 1.0, 1.0],
                },
                NodeDocument {
                    id: "z-root".into(),
                    parent: None,
                    mesh: Some("z-mesh".into()),
                    translation: [200.0, 0.0, 0.0],
                    rotation: [0.0, 0.0, 0.0, 1.0],
                    scale: [1.0, 1.0, 1.0],
                },
            ],
        }
    }

    #[test]
    fn normalization_scales_to_meters_sorts_and_compacts() {
        let (normalized, observations) = normalize_document(&fixture()).unwrap();
        assert_eq!(normalized.unit, "meter");
        assert_eq!(
            normalized.meshes.iter().map(|mesh| mesh.id.as_str()).collect::<Vec<_>>(),
            vec!["a-mesh", "z-mesh"]
        );
        assert_eq!(
            normalized.nodes.iter().map(|node| node.id.as_str()).collect::<Vec<_>>(),
            vec!["a-root", "z-root", "z-child"]
        );
        assert_eq!(normalized.nodes[1].translation, [2.0, 0.0, 0.0]);
        assert_eq!(normalized.nodes[2].translation, [0.0, 0.25, 0.0]);
        assert_eq!(normalized.nodes[2].rotation, [0.0, 1.0, 0.0, 0.0]);
        assert_eq!(normalized.meshes[1].vertices.len(), 3);
        assert_eq!(normalized.meshes[1].indices, vec![0, 1, 2]);
        assert_eq!(observations.source_vertex_count, 7);
        assert_eq!(observations.result_vertex_count, 6);
        assert_eq!(observations.removed_unused_vertex_count, 1);
        assert_eq!(observations.source_unit, "centimeter");
        assert_eq!(observations.output_unit, "meter");
    }

    #[test]
    fn export_is_repeatable_and_reports_normalized_meter_scene() {
        let (first, first_observations) = export_document(&fixture()).unwrap();
        let (second, second_observations) = export_document(&fixture()).unwrap();
        assert_eq!(second, first);
        assert_eq!(second_observations, first_observations);
        assert_eq!(&first[0..4], b"glTF");
        assert_eq!(first_observations.mesh_count, 2);
        assert_eq!(first_observations.node_count, 3);
        assert_eq!(first_observations.unit, "meter");
        assert_eq!(first_observations.format, "glb-2.0");
        assert_eq!(first_observations.byte_length, first.len());
    }

    #[test]
    fn scene_input_fails_closed_on_coordinate_unit_hierarchy_and_references() {
        let mut document = fixture();
        document.coordinate_system = "left-handed-y-up".into();
        assert!(build_scene(&document).unwrap_err().contains("coordinateSystem"));

        let mut document = fixture();
        document.unit = "inch".into();
        assert!(build_scene(&document).unwrap_err().contains("scene unit"));

        let mut document = fixture();
        document.nodes[1].parent = Some("z-child".into());
        document.nodes[2].parent = Some("a-root".into());
        assert!(build_scene(&document).unwrap_err().contains("cycle"));

        let mut document = fixture();
        document.nodes[0].mesh = Some("missing".into());
        assert!(build_scene(&document).unwrap_err().contains("unknown mesh"));
    }
}
