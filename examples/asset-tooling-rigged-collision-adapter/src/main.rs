use std::env;
use std::fs;
use std::path::{Component, Path, PathBuf};

use serde::{Deserialize, Serialize};
use three_d_animation::{Joint, Mat4, Skeleton, SkinInfluence};
use three_d_core::Vec3;
use three_d_rigged_assets::{
    CollisionFitObservations, CollisionFitOptions, CollisionProxyShape, fit_joint_collision_proxies,
};

const PROTOCOL: &str = "asset-tooling-process-adapter-v1";
const CODEC: &str = "three-d-rigged-collision-json-v1";
const PROCESSOR_ID: &str = "three-d-rigged-collision-fit";
const OPERATION: &str = "mesh.rigged-collision.fit";
const ALGORITHM: &str = "three-d-rigged-assets-joint-proxy-fit-v1";
const DOCUMENT_SCHEMA_VERSION: u32 = 1;
const CARGO_LOCK: &str = include_str!("../../../Cargo.lock");

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Request {
    schema_version: u32,
    operation: String,
    input_path: String,
    parameters: Parameters,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Parameters {
    min_vertices_per_joint: usize,
    min_dominant_weight: f32,
    padding: f32,
    minimum_extent: f32,
    sphere_aspect_ratio: f32,
    capsule_aspect_ratio: f32,
}

impl From<Parameters> for CollisionFitOptions {
    fn from(value: Parameters) -> Self {
        Self {
            min_vertices_per_joint: value.min_vertices_per_joint,
            min_dominant_weight: value.min_dominant_weight,
            padding: value.padding,
            minimum_extent: value.minimum_extent,
            sphere_aspect_ratio: value.sphere_aspect_ratio,
            capsule_aspect_ratio: value.capsule_aspect_ratio,
        }
    }
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RiggedCollisionInput {
    schema_version: u32,
    positions: Vec<[f32; 3]>,
    joints: Vec<JointDocument>,
    influences: Vec<InfluenceDocument>,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct JointDocument {
    parent: Option<usize>,
    inverse_bind: [f32; 16],
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct InfluenceDocument {
    joints: [u16; 4],
    weights: [f32; 4],
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct RiggedCollisionOutput {
    schema_version: u32,
    coordinate_system: &'static str,
    transform_space: &'static str,
    capsule_axis: &'static str,
    proxies: Vec<ProxyDocument>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(
    tag = "shape",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
enum ProxyDocument {
    Box {
        joint: usize,
        center: [f32; 3],
        size: [f32; 3],
    },
    Sphere {
        joint: usize,
        center: [f32; 3],
        radius: f32,
    },
    Capsule {
        joint: usize,
        center: [f32; 3],
        radius: f32,
        segment_length: f32,
    },
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProbeDependencies<'a> {
    serde: &'a str,
    serde_json: &'a str,
    three_d_animation: &'a str,
    three_d_core: &'a str,
    three_d_rigged_assets: &'a str,
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

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct ShapeCounts {
    box_count: usize,
    sphere_count: usize,
    capsule_count: usize,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct Observations {
    joint_count: usize,
    vertex_count: usize,
    assigned_vertices: usize,
    low_confidence_vertices: usize,
    represented_vertices: usize,
    unrepresented_assigned_vertices: usize,
    represented_joint_count: usize,
    proxy_count: usize,
    shape_counts: ShapeCounts,
    capsule_axis: &'static str,
    transform_space: &'static str,
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

fn finite_matrix(values: [f32; 16], location: &str) -> Result<Mat4, String> {
    for (index, value) in values.iter().enumerate() {
        if !value.is_finite() {
            return Err(format!("{location}[{index}] must be finite"));
        }
    }
    Ok(Mat4 { elements: values })
}

fn vec3(value: [f32; 3]) -> Vec3 {
    Vec3::new(value[0], value[1], value[2])
}

fn vec3_array(value: Vec3) -> [f32; 3] {
    [value.x, value.y, value.z]
}

fn proxy_document(joint: usize, center: Vec3, shape: CollisionProxyShape) -> ProxyDocument {
    match shape {
        CollisionProxyShape::Box { size } => ProxyDocument::Box {
            joint,
            center: vec3_array(center),
            size: vec3_array(size),
        },
        CollisionProxyShape::Sphere { radius } => ProxyDocument::Sphere {
            joint,
            center: vec3_array(center),
            radius,
        },
        CollisionProxyShape::Capsule {
            radius,
            segment_length,
        } => ProxyDocument::Capsule {
            joint,
            center: vec3_array(center),
            radius,
            segment_length,
        },
    }
}

fn shape_counts(proxies: &[ProxyDocument]) -> ShapeCounts {
    let mut counts = ShapeCounts {
        box_count: 0,
        sphere_count: 0,
        capsule_count: 0,
    };
    for proxy in proxies {
        match proxy {
            ProxyDocument::Box { .. } => counts.box_count += 1,
            ProxyDocument::Sphere { .. } => counts.sphere_count += 1,
            ProxyDocument::Capsule { .. } => counts.capsule_count += 1,
        }
    }
    counts
}

fn observations(
    joint_count: usize,
    fitting: CollisionFitObservations,
    proxies: &[ProxyDocument],
) -> Observations {
    Observations {
        joint_count,
        vertex_count: fitting.vertex_count,
        assigned_vertices: fitting.assigned_vertices,
        low_confidence_vertices: fitting.low_confidence_vertices,
        represented_vertices: fitting.represented_vertices,
        unrepresented_assigned_vertices: fitting.unrepresented_assigned_vertices,
        represented_joint_count: fitting.represented_joint_count,
        proxy_count: proxies.len(),
        shape_counts: shape_counts(proxies),
        capsule_axis: "local-y",
        transform_space: "joint-bind-local",
    }
}

fn fit(
    document: &RiggedCollisionInput,
    parameters: Parameters,
) -> Result<(RiggedCollisionOutput, Observations), String> {
    if document.schema_version != DOCUMENT_SCHEMA_VERSION {
        return Err(format!(
            "rigged collision document schemaVersion must be {DOCUMENT_SCHEMA_VERSION}, got {}",
            document.schema_version
        ));
    }
    if document.positions.is_empty() {
        return Err("rigged collision document must contain at least one position".into());
    }
    if document.joints.is_empty() {
        return Err("rigged collision document must contain at least one joint".into());
    }
    if document.joints.len() > usize::from(u16::MAX) + 1 {
        return Err(
            "rigged collision document has more joints than u16 skin indices can address".into(),
        );
    }
    if document.positions.len() != document.influences.len() {
        return Err(format!(
            "rigged collision positions/influences length mismatch: {} positions, {} influences",
            document.positions.len(),
            document.influences.len()
        ));
    }

    let joints = document
        .joints
        .iter()
        .enumerate()
        .map(|(index, joint)| {
            Ok(Joint {
                parent: joint.parent,
                inverse_bind: finite_matrix(
                    joint.inverse_bind,
                    &format!("joints[{index}].inverseBind"),
                )?,
            })
        })
        .collect::<Result<Vec<_>, String>>()?;
    let skeleton = Skeleton::new(joints).map_err(|error| format!("invalid skeleton: {error}"))?;

    let positions = document
        .positions
        .iter()
        .copied()
        .map(vec3)
        .collect::<Vec<_>>();
    let influences = document
        .influences
        .iter()
        .copied()
        .map(|influence| SkinInfluence {
            joints: influence.joints,
            weights: influence.weights,
        })
        .collect::<Vec<_>>();

    let fitted = fit_joint_collision_proxies(&positions, &influences, &skeleton, parameters.into())
        .map_err(|error| format!("collision fitting failed: {error}"))?;

    let proxies = fitted
        .proxies()
        .iter()
        .map(|proxy| proxy_document(proxy.joint(), proxy.center(), proxy.shape()))
        .collect::<Vec<_>>();
    let observations = observations(skeleton.joints().len(), fitted.observations(), &proxies);

    Ok((
        RiggedCollisionOutput {
            schema_version: DOCUMENT_SCHEMA_VERSION,
            coordinate_system: "right-handed-y-up",
            transform_space: "joint-bind-local",
            capsule_axis: "local-y",
            proxies,
        },
        observations,
    ))
}

fn read_document(input_path: &str) -> Result<RiggedCollisionInput, String> {
    let path = resolve_input_path(input_path)?;
    serde_json::from_slice(&fs::read(&path).map_err(|error| {
        format!("failed to read input rigged collision document '{input_path}': {error}")
    })?)
    .map_err(|error| format!("invalid input rigged collision JSON: {error}"))
}

fn write_json<T: Serialize>(path: &Path, value: &T, label: &str) -> Result<(), String> {
    let bytes = serde_json::to_vec(value)
        .map_err(|error| format!("failed to serialize {label}: {error}"))?;
    fs::write(path, bytes).map_err(|error| format!("failed to write {label}: {error}"))
}

fn probe() -> Result<(), String> {
    let components = [ProbeComponent {
        id: PROCESSOR_ID,
        version: env!("CARGO_PKG_VERSION"),
        algorithm: ALGORITHM,
        protocol: PROTOCOL,
        codec: CODEC,
        dependencies: ProbeDependencies {
            serde: "1.0.229",
            serde_json: "1.0.151",
            three_d_animation: "0.1.0",
            three_d_core: "0.1.0",
            three_d_rigged_assets: "0.1.0",
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
    if request.schema_version != 1 {
        return Err(format!(
            "request schemaVersion must be 1, got {}",
            request.schema_version
        ));
    }
    if request.operation != OPERATION {
        return Err(format!("unsupported operation '{}'", request.operation));
    }
    let source = read_document(&request.input_path)?;
    let (output, observations) = fit(&source, request.parameters)?;
    write_json(output_path, &output, "rigged collision proxy document")?;
    write_json(
        observations_path,
        &observations,
        "rigged collision fitting observations",
    )
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
                    "usage: rigged collision adapter probe | generate REQUEST OUTPUT OBSERVATIONS"
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
            "usage: rigged collision adapter probe | generate REQUEST OUTPUT OBSERVATIONS".into(),
        ),
    };

    if let Err(error) = result {
        eprintln!("{error}");
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const IDENTITY: [f32; 16] = [
        1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0,
    ];

    fn parameters() -> Parameters {
        Parameters {
            min_vertices_per_joint: 4,
            min_dominant_weight: 0.5,
            padding: 0.01,
            minimum_extent: 0.01,
            sphere_aspect_ratio: 1.25,
            capsule_aspect_ratio: 1.75,
        }
    }

    fn input(offset_x: f32) -> RiggedCollisionInput {
        let mut positions = Vec::new();
        for x in [-0.2, 0.2] {
            for y in [-1.0, 1.0] {
                for z in [-0.2, 0.2] {
                    positions.push([offset_x + x, y, z]);
                }
            }
        }
        RiggedCollisionInput {
            schema_version: 1,
            positions,
            joints: vec![JointDocument {
                parent: None,
                inverse_bind: IDENTITY,
            }],
            influences: vec![
                InfluenceDocument {
                    joints: [0, 0, 0, 0],
                    weights: [1.0, 0.0, 0.0, 0.0],
                };
                8
            ],
        }
    }

    #[test]
    fn fits_capsule_and_reports_structural_observations() {
        let (output, observations) = fit(&input(0.0), parameters()).unwrap();

        assert_eq!(output.proxies.len(), 1);
        assert!(matches!(
            &output.proxies[0],
            ProxyDocument::Capsule { joint: 0, .. }
        ));
        assert_eq!(observations.vertex_count, 8);
        assert_eq!(observations.assigned_vertices, 8);
        assert_eq!(observations.represented_vertices, 8);
        assert_eq!(observations.represented_joint_count, 1);
        assert_eq!(observations.shape_counts.capsule_count, 1);
        assert_eq!(observations.capsule_axis, "local-y");
    }

    #[test]
    fn inverse_bind_moves_bounds_into_joint_local_space() {
        let mut document = input(10.0);
        document.joints[0].inverse_bind[12] = -10.0;

        let (output, _) = fit(&document, parameters()).unwrap();
        let center = match &output.proxies[0] {
            ProxyDocument::Capsule { center, .. } => center,
            _ => panic!("expected capsule"),
        };

        assert!(center[0].abs() < 1.0e-5);
    }

    #[test]
    fn rejects_position_influence_length_mismatch() {
        let mut document = input(0.0);
        document.influences.pop();

        let error = fit(&document, parameters()).unwrap_err();

        assert!(error.contains("positions/influences length mismatch"));
    }

    #[test]
    fn rejects_invalid_public_skin_weights_before_joint_lookup() {
        let mut document = input(0.0);
        document.influences[0] = InfluenceDocument {
            joints: [99, 0, 0, 0],
            weights: [f32::NAN, 1.0, 0.0, 0.0],
        };

        let error = fit(&document, parameters()).unwrap_err();

        assert!(error.contains("skin weight slot 0 is invalid"));
    }

    #[test]
    fn rejects_invalid_fit_parameters() {
        let mut invalid = parameters();
        invalid.capsule_aspect_ratio = 1.0;

        let error = fit(&input(0.0), invalid).unwrap_err();

        assert!(error.contains("capsule_aspect_ratio"));
    }
}
