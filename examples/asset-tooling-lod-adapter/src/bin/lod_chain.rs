use std::env;
use std::fs;
use std::path::{Component, Path, PathBuf};

use serde::{Deserialize, Serialize};
use three_d_core::{Mesh, Vec3};
use three_d_lod::{SIMPLIFIER_ID, SimplificationSettings, simplify_mesh};

const PROTOCOL: &str = "asset-tooling-process-adapter-v1";
const CODEC: &str = "three-d-lod-chain-json-v1";
const MESH_SCHEMA_VERSION: u32 = 1;
const OUTPUT_SCHEMA_VERSION: u32 = 1;
const CARGO_LOCK: &str = include_str!("../../../../Cargo.lock");

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Request {
    schema_version: u32,
    operation: String,
    input_path: String,
    parameters: LodChainParameters,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LodChainParameters {
    source_triangle_count: usize,
    source_based: bool,
    budget_rounding: String,
    levels: Vec<LodLevelParameters>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LodLevelParameters {
    triangle_ratio: f64,
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
struct LodChainDocument {
    schema_version: u32,
    source_vertices: Vec<[f32; 3]>,
    levels: Vec<LodChainLevelDocument>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct LodChainLevelDocument {
    level: usize,
    triangle_ratio: f64,
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
    cargo_lock: &'a str,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Observations {
    source_triangle_count: usize,
    source_vertex_count: usize,
    source_based: bool,
    shared_source_vertex_buffer: bool,
    levels: Vec<LevelObservations>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct LevelObservations {
    level: usize,
    triangle_ratio: f64,
    requested_triangle_count: usize,
    result_triangle_count: usize,
    result_index_count: usize,
    relative_error: f32,
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

fn validate_request(request: &Request) -> Result<(), String> {
    if request.schema_version != 1 {
        return Err(format!(
            "request schemaVersion must be 1, got {}",
            request.schema_version
        ));
    }
    if request.operation != "mesh.lod_chain" {
        return Err(format!("unsupported operation '{}'", request.operation));
    }
    if !request.parameters.source_based {
        return Err("mesh.lod_chain requires sourceBased=true".into());
    }
    if request.parameters.budget_rounding != "nearest-ties-away-from-zero" {
        return Err("mesh.lod_chain requires budgetRounding='nearest-ties-away-from-zero'".into());
    }
    if request.parameters.levels.is_empty() {
        return Err("mesh.lod_chain requires at least one level".into());
    }
    let mut previous_ratio = 1.0;
    for (index, level) in request.parameters.levels.iter().enumerate() {
        if !level.triangle_ratio.is_finite() || !(0.0..1.0).contains(&level.triangle_ratio) {
            return Err(format!(
                "LOD level {} must use a finite triangleRatio strictly between 0 and 1",
                index + 1
            ));
        }
        if level.triangle_ratio >= previous_ratio {
            return Err(format!(
                "LOD level {} triangleRatio must be strictly smaller than the previous level",
                index + 1
            ));
        }
        previous_ratio = level.triangle_ratio;
    }
    Ok(())
}

fn process(
    request: &Request,
    source_document: MeshDocument,
) -> Result<(LodChainDocument, Observations), String> {
    validate_request(request)?;
    let source = mesh_from_document(source_document)?;
    let source_triangle_count = source.triangle_count();
    if source_triangle_count != request.parameters.source_triangle_count {
        return Err(format!(
            "sourceTriangleCount mismatch: request says {}, mesh contains {source_triangle_count}",
            request.parameters.source_triangle_count
        ));
    }

    let mut output_levels = Vec::with_capacity(request.parameters.levels.len());
    let mut observation_levels = Vec::with_capacity(request.parameters.levels.len());
    let mut shared_source_vertex_buffer = true;
    let mut previous_target = source_triangle_count;
    for (index, requested) in request.parameters.levels.iter().enumerate() {
        let level = index + 1;
        if requested.target_triangle_count == 0
            || requested.target_triangle_count >= previous_target
        {
            return Err(format!(
                "LOD level {level} targetTriangleCount must be positive and strictly smaller than the previous level"
            ));
        }
        let result = simplify_mesh(
            &source,
            SimplificationSettings::new(requested.target_triangle_count, requested.target_error)
                .with_locked_border(requested.lock_border),
        )
        .map_err(|error| error.to_string())?;
        if result.requested_triangle_count != requested.target_triangle_count {
            return Err(format!(
                "LOD level {level} targetTriangleCount mismatch: request materialized {}, authoritative processor applied {}",
                requested.target_triangle_count, result.requested_triangle_count
            ));
        }
        let shares_vertices = result.mesh.vertices() == source.vertices();
        shared_source_vertex_buffer &= shares_vertices;
        let indices = result.mesh.indices().to_vec();
        observation_levels.push(LevelObservations {
            level,
            triangle_ratio: requested.triangle_ratio,
            requested_triangle_count: result.requested_triangle_count,
            result_triangle_count: result.result_triangle_count,
            result_index_count: indices.len(),
            relative_error: result.relative_error,
        });
        output_levels.push(LodChainLevelDocument {
            level,
            triangle_ratio: requested.triangle_ratio,
            indices,
        });
        previous_target = requested.target_triangle_count;
    }

    let output = LodChainDocument {
        schema_version: OUTPUT_SCHEMA_VERSION,
        source_vertices: source
            .vertices()
            .iter()
            .map(|vertex| [vertex.x, vertex.y, vertex.z])
            .collect(),
        levels: output_levels,
    };
    let observations = Observations {
        source_triangle_count,
        source_vertex_count: source.vertices().len(),
        source_based: true,
        shared_source_vertex_buffer,
        levels: observation_levels,
    };
    Ok((output, observations))
}

fn probe() -> Result<(), String> {
    let components = [ProbeComponent {
        id: "three-d-lod-chain",
        version: env!("CARGO_PKG_VERSION"),
        algorithm: SIMPLIFIER_ID,
        protocol: PROTOCOL,
        codec: CODEC,
        dependencies: ProbeDependencies {
            meshopt: "0.6.2",
            serde: "1.0.229",
            serde_json: "1.0.151",
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
    request_path: &Path,
    output_path: &Path,
    observations_path: &Path,
) -> Result<(), String> {
    let request: Request = serde_json::from_slice(
        &fs::read(request_path).map_err(|error| format!("failed to read request: {error}"))?,
    )
    .map_err(|error| format!("invalid request JSON: {error}"))?;
    let input_path = resolve_input_path(&request.input_path)?;
    let source_document: MeshDocument =
        serde_json::from_slice(&fs::read(&input_path).map_err(|error| {
            format!(
                "failed to read input mesh '{}': {error}",
                request.input_path
            )
        })?)
        .map_err(|error| format!("invalid input mesh JSON: {error}"))?;
    let (output, observations) = process(&request, source_document)?;

    fs::write(
        output_path,
        serde_json::to_vec(&output)
            .map_err(|error| format!("failed to serialize LOD chain output: {error}"))?,
    )
    .map_err(|error| format!("failed to write LOD chain output: {error}"))?;
    fs::write(
        observations_path,
        serde_json::to_vec(&observations)
            .map_err(|error| format!("failed to serialize observations: {error}"))?,
    )
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
                Err("usage: lod_chain probe | generate REQUEST OUTPUT OBSERVATIONS".into())
            } else {
                generate(
                    request.as_deref().expect("checked above"),
                    output.as_deref().expect("checked above"),
                    observations.as_deref().expect("checked above"),
                )
            }
        }
        _ => Err("usage: lod_chain probe | generate REQUEST OUTPUT OBSERVATIONS".into()),
    };

    if let Err(error) = result {
        eprintln!("{error}");
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn grid_mesh(segments: usize) -> MeshDocument {
        let mut vertices = Vec::new();
        let mut indices = Vec::new();
        for y in 0..=segments {
            for x in 0..=segments {
                vertices.push([x as f32 / segments as f32, y as f32 / segments as f32, 0.0]);
            }
        }
        let stride = segments + 1;
        for y in 0..segments {
            for x in 0..segments {
                let top_left = y * stride + x;
                let top_right = top_left + 1;
                let bottom_left = top_left + stride;
                let bottom_right = bottom_left + 1;
                indices.extend([
                    top_left as u32,
                    top_right as u32,
                    bottom_left as u32,
                    top_right as u32,
                    bottom_right as u32,
                    bottom_left as u32,
                ]);
            }
        }
        MeshDocument {
            schema_version: 1,
            vertices,
            indices,
        }
    }

    fn triangle_soup(triangle_count: usize) -> MeshDocument {
        let mut vertices = Vec::with_capacity(triangle_count * 3);
        let mut indices = Vec::with_capacity(triangle_count * 3);
        for triangle in 0..triangle_count {
            let base = vertices.len() as u32;
            let x = triangle as f32 * 2.0;
            vertices.extend([[x, 0.0, 0.0], [x + 1.0, 0.0, 0.0], [x, 1.0, 0.0]]);
            indices.extend([base, base + 1, base + 2]);
        }
        MeshDocument {
            schema_version: 1,
            vertices,
            indices,
        }
    }

    fn request(source_triangle_count: usize) -> Request {
        Request {
            schema_version: 1,
            operation: "mesh.lod_chain".into(),
            input_path: "fixture.json".into(),
            parameters: LodChainParameters {
                source_triangle_count,
                source_based: true,
                budget_rounding: "nearest-ties-away-from-zero".into(),
                levels: vec![
                    LodLevelParameters {
                        triangle_ratio: 0.75,
                        target_triangle_count: (source_triangle_count as f64 * 0.75).round()
                            as usize,
                        target_error: 1.0,
                        lock_border: false,
                    },
                    LodLevelParameters {
                        triangle_ratio: 0.5,
                        target_triangle_count: (source_triangle_count as f64 * 0.5).round()
                            as usize,
                        target_error: 1.0,
                        lock_border: false,
                    },
                    LodLevelParameters {
                        triangle_ratio: 0.25,
                        target_triangle_count: (source_triangle_count as f64 * 0.25).round()
                            as usize,
                        target_error: 1.0,
                        lock_border: false,
                    },
                ],
            },
        }
    }

    #[test]
    fn lod_chain_uses_authoritative_source_based_derivation() {
        let mesh = grid_mesh(8);
        let source_triangle_count = mesh.indices.len() / 3;
        let (output, observations) = process(&request(source_triangle_count), mesh).unwrap();

        assert_eq!(output.schema_version, 1);
        assert_eq!(output.levels.len(), 3);
        assert_eq!(observations.levels.len(), 3);
        assert!(observations.source_based);
        assert!(observations.shared_source_vertex_buffer);
        assert!(
            observations
                .levels
                .windows(2)
                .all(|pair| pair[0].requested_triangle_count > pair[1].requested_triangle_count)
        );
        assert!(
            observations
                .levels
                .iter()
                .all(|level| level.result_index_count == level.result_triangle_count * 3)
        );
    }

    #[test]
    fn lod_chain_executes_materialized_budget_without_narrowing_ratio_precision() {
        let mesh = triangle_soup(45);
        let request = Request {
            schema_version: 1,
            operation: "mesh.lod_chain".into(),
            input_path: "fixture.json".into(),
            parameters: LodChainParameters {
                source_triangle_count: 45,
                source_based: true,
                budget_rounding: "nearest-ties-away-from-zero".into(),
                levels: vec![LodLevelParameters {
                    triangle_ratio: 0.7,
                    target_triangle_count: 31,
                    target_error: 1.0,
                    lock_border: false,
                }],
            },
        };
        let (output, observations) = process(&request, mesh).unwrap();

        assert_eq!(output.levels[0].triangle_ratio, 0.7);
        assert_eq!(observations.levels[0].triangle_ratio, 0.7);
        assert_eq!(observations.levels[0].requested_triangle_count, 31);
    }
}
