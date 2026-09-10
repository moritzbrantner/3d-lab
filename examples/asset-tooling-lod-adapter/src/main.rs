use std::env;
use std::fs;
use std::path::{Component, Path, PathBuf};

use serde::{Deserialize, Serialize};
use three_d_core::{Mesh, Vec3};
use three_d_lod::{SIMPLIFIER_ID, SimplificationSettings, simplify_mesh};

const PROTOCOL: &str = "asset-tooling-process-adapter-v1";
const MESH_CODEC: &str = "three-d-mesh-json-v1";
const MESH_SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Request {
    schema_version: u32,
    operation: String,
    input_path: String,
    parameters: SimplifyParameters,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SimplifyParameters {
    source_triangle_count: usize,
    target_triangle_count: usize,
    target_error: f32,
    lock_border: bool,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MeshDocument {
    schema_version: u32,
    vertices: Vec<[f32; 3]>,
    indices: Vec<u32>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProbeDependencies<'a> {
    meshopt: &'a str,
    serde: &'a str,
    serde_json: &'a str,
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
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Observations {
    source_triangle_count: usize,
    source_vertex_count: usize,
    requested_triangle_count: usize,
    result_triangle_count: usize,
    result_index_count: usize,
    relative_error: f32,
    shared_source_vertex_buffer: bool,
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

fn mesh_from_document(document: MeshDocument) -> Result<Mesh, String> {
    if document.schema_version != MESH_SCHEMA_VERSION {
        return Err(format!(
            "mesh schemaVersion must be {MESH_SCHEMA_VERSION}, got {}",
            document.schema_version
        ));
    }
    let vertices = document
        .vertices
        .into_iter()
        .map(|[x, y, z]| Vec3::new(x, y, z))
        .collect();
    Mesh::new(vertices, document.indices).map_err(|error| error.to_string())
}

fn mesh_document(mesh: &Mesh) -> MeshDocument {
    MeshDocument {
        schema_version: MESH_SCHEMA_VERSION,
        vertices: mesh
            .vertices()
            .iter()
            .map(|vertex| [vertex.x, vertex.y, vertex.z])
            .collect(),
        indices: mesh.indices().to_vec(),
    }
}

fn probe() -> Result<(), String> {
    let components = [ProbeComponent {
        id: "three-d-lod",
        version: env!("CARGO_PKG_VERSION"),
        algorithm: SIMPLIFIER_ID,
        protocol: PROTOCOL,
        codec: MESH_CODEC,
        dependencies: ProbeDependencies {
            meshopt: "0.6.2",
            serde: "1.0.229",
            serde_json: "1.0.151",
        },
    }];
    println!(
        "{}",
        serde_json::to_string(&components)
            .map_err(|error| format!("failed to serialize probe: {error}"))?
    );
    Ok(())
}

fn generate(
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
    if request.operation != "mesh.simplify" {
        return Err(format!("unsupported operation '{}'", request.operation));
    }

    let input_path = resolve_input_path(&request.input_path)?;
    let source_document: MeshDocument =
        serde_json::from_slice(&fs::read(&input_path).map_err(|error| {
            format!(
                "failed to read input mesh '{}': {error}",
                request.input_path
            )
        })?)
        .map_err(|error| format!("invalid input mesh JSON: {error}"))?;
    let source = mesh_from_document(source_document)?;
    let source_triangle_count = source.triangle_count();
    if source_triangle_count != request.parameters.source_triangle_count {
        return Err(format!(
            "sourceTriangleCount mismatch: request says {}, mesh contains {source_triangle_count}",
            request.parameters.source_triangle_count
        ));
    }

    let source_vertex_count = source.vertices().len();
    let settings = SimplificationSettings::new(
        request.parameters.target_triangle_count,
        request.parameters.target_error,
    )
    .with_locked_border(request.parameters.lock_border);
    let result = simplify_mesh(&source, settings).map_err(|error| error.to_string())?;

    let output = mesh_document(&result.mesh);
    let output_bytes = serde_json::to_vec(&output)
        .map_err(|error| format!("failed to serialize output mesh: {error}"))?;
    fs::write(output_path, output_bytes)
        .map_err(|error| format!("failed to write output mesh: {error}"))?;

    let observations = Observations {
        source_triangle_count: result.source_triangle_count,
        source_vertex_count,
        requested_triangle_count: result.requested_triangle_count,
        result_triangle_count: result.result_triangle_count,
        result_index_count: result.mesh.indices().len(),
        relative_error: result.relative_error,
        shared_source_vertex_buffer: result.mesh.vertices() == source.vertices(),
    };
    let observations_bytes = serde_json::to_vec(&observations)
        .map_err(|error| format!("failed to serialize observations: {error}"))?;
    fs::write(observations_path, observations_bytes)
        .map_err(|error| format!("failed to write observations: {error}"))?;
    Ok(())
}

fn main() {
    let mut args = env::args_os().skip(1);
    let mode = args.next().and_then(|value| value.into_string().ok());
    let result = match mode.as_deref() {
        Some("probe") if args.next().is_none() => probe(),
        Some("generate") => {
            let request = args.next().map(PathBuf::from);
            let output = args.next().map(PathBuf::from);
            let observations = args.next().map(PathBuf::from);
            if args.next().is_some()
                || request.is_none()
                || output.is_none()
                || observations.is_none()
            {
                Err(
                    "usage: asset-tooling-lod-adapter probe | generate REQUEST OUTPUT OBSERVATIONS"
                        .into(),
                )
            } else {
                generate(
                    request.as_deref().expect("checked above"),
                    output.as_deref().expect("checked above"),
                    observations.as_deref().expect("checked above"),
                )
            }
        }
        _ => Err(
            "usage: asset-tooling-lod-adapter probe | generate REQUEST OUTPUT OBSERVATIONS".into(),
        ),
    };

    if let Err(error) = result {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
