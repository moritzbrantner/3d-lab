use std::env;
use std::fs;
use std::path::{Component, Path, PathBuf};

use serde::{Deserialize, Serialize};
use three_d_animation::{Joint, Mat4, Skeleton, SkinInfluence};

const PROTOCOL: &str = "asset-tooling-process-adapter-v1";
const CODEC: &str = "three-d-skinning-json-v1";
const PROCESSOR_ID: &str = "three-d-skinning-validate";
const OPERATION: &str = "mesh.skinning.validate";
const ALGORITHM: &str = "three-d-animation-skinning-profile-v1";
const DOCUMENT_SCHEMA_VERSION: u32 = 1;
const NORMALIZED_WEIGHT_SUM_TOLERANCE: f32 = 1.0e-5;
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
    bind_pose_identity_tolerance: f32,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SkinningDocument {
    schema_version: u32,
    joints: Vec<JointDocument>,
    influences: Vec<InfluenceDocument>,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct JointDocument {
    parent: Option<usize>,
    inverse_bind: [f32; 16],
    bind_world: [f32; 16],
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct InfluenceDocument {
    joints: [u16; 4],
    weights: [f32; 4],
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProbeDependencies<'a> {
    serde: &'a str,
    serde_json: &'a str,
    three_d_animation: &'a str,
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
struct Observations {
    joint_count: usize,
    root_joint_count: usize,
    vertex_influence_count: usize,
    influence_slots_per_vertex: usize,
    max_active_influences: usize,
    parent_before_child: bool,
    weights_normalized: bool,
    active_joint_indices_in_range: bool,
    inverse_bind_matches_bind_pose: bool,
    max_bind_pose_identity_error: f32,
    matrix_layout: &'static str,
    skin_matrix_rule: &'static str,
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

fn validate_matrix(values: [f32; 16], location: &str) -> Result<Mat4, String> {
    for (index, value) in values.iter().enumerate() {
        if !value.is_finite() {
            return Err(format!("{location}[{index}] must be finite"));
        }
    }
    Ok(Mat4 { elements: values })
}

fn identity_error(matrix: Mat4) -> Result<f32, String> {
    let mut maximum = 0.0_f32;
    for (index, value) in matrix.elements.iter().enumerate() {
        if !value.is_finite() {
            return Err(format!("skin matrix element {index} must be finite"));
        }
        let expected = if matches!(index, 0 | 5 | 10 | 15) {
            1.0
        } else {
            0.0
        };
        let error = (value - expected).abs();
        if !error.is_finite() {
            return Err(format!("skin matrix identity error {index} must be finite"));
        }
        maximum = maximum.max(error);
    }
    Ok(maximum)
}

fn validate_parameters(parameters: Parameters) -> Result<Parameters, String> {
    let tolerance = parameters.bind_pose_identity_tolerance;
    if !tolerance.is_finite() || tolerance < 0.0 {
        return Err(
            "parameters.bindPoseIdentityTolerance must be a finite non-negative f32".into(),
        );
    }
    Ok(parameters)
}

fn validate_and_normalize(
    document: &SkinningDocument,
    parameters: Parameters,
) -> Result<(SkinningDocument, Observations), String> {
    let parameters = validate_parameters(parameters)?;
    if document.schema_version != DOCUMENT_SCHEMA_VERSION {
        return Err(format!(
            "skinning document schemaVersion must be {DOCUMENT_SCHEMA_VERSION}, got {}",
            document.schema_version
        ));
    }
    if document.joints.is_empty() {
        return Err("skinning document must contain at least one joint".into());
    }
    if document.joints.len() > usize::from(u16::MAX) + 1 {
        return Err("skinning document has more joints than u16 skin indices can address".into());
    }
    if document.influences.is_empty() {
        return Err("skinning document must contain at least one vertex influence".into());
    }

    let mut joints = Vec::with_capacity(document.joints.len());
    let mut bind_world = Vec::with_capacity(document.joints.len());
    let mut root_joint_count = 0usize;
    for (index, joint) in document.joints.iter().enumerate() {
        if joint.parent.is_none() {
            root_joint_count += 1;
        }
        joints.push(Joint {
            parent: joint.parent,
            inverse_bind: validate_matrix(
                joint.inverse_bind,
                &format!("joints[{index}].inverseBind"),
            )?,
        });
        bind_world.push(validate_matrix(
            joint.bind_world,
            &format!("joints[{index}].bindWorld"),
        )?);
    }

    let skeleton = Skeleton::new(joints).map_err(|error| format!("invalid skeleton: {error}"))?;
    let skin_matrices = skeleton
        .skin_matrices(&bind_world)
        .map_err(|error| format!("invalid bind pose matrices: {error}"))?;
    let mut max_bind_pose_identity_error = 0.0_f32;
    for (index, matrix) in skin_matrices.iter().copied().enumerate() {
        let error = identity_error(matrix)
            .map_err(|error| format!("invalid bind-pose skin matrix[{index}]: {error}"))?;
        max_bind_pose_identity_error = max_bind_pose_identity_error.max(error);
    }
    if max_bind_pose_identity_error > parameters.bind_pose_identity_tolerance {
        return Err(format!(
            "bind-pose skin matrices deviate from identity by {max_bind_pose_identity_error}, exceeding tolerance {}",
            parameters.bind_pose_identity_tolerance
        ));
    }

    let mut normalized_influences = Vec::with_capacity(document.influences.len());
    let mut max_active_influences = 0usize;
    for (index, influence) in document.influences.iter().enumerate() {
        let input_weight_sum = influence.weights.iter().copied().sum::<f32>();
        if !input_weight_sum.is_finite() || input_weight_sum <= 0.0 {
            return Err(format!(
                "invalid influences[{index}]: weight sum must be finite and positive"
            ));
        }
        let normalized = SkinInfluence::new(influence.joints, influence.weights)
            .map_err(|error| format!("invalid influences[{index}]: {error}"))?
            .validate_joints(skeleton.joints().len())
            .map_err(|error| format!("invalid influences[{index}]: {error}"))?;
        let normalized_weight_sum = normalized.weights.iter().copied().sum::<f32>();
        if !normalized_weight_sum.is_finite()
            || normalized_weight_sum <= 0.0
            || (normalized_weight_sum - 1.0).abs() > NORMALIZED_WEIGHT_SUM_TOLERANCE
            || normalized.weights.iter().any(|weight| !weight.is_finite())
        {
            return Err(format!(
                "invalid influences[{index}]: normalized weights must be finite and sum to one"
            ));
        }
        max_active_influences = max_active_influences.max(
            normalized
                .weights
                .iter()
                .filter(|weight| **weight > 0.0)
                .count(),
        );
        normalized_influences.push(InfluenceDocument {
            joints: normalized.joints,
            weights: normalized.weights,
        });
    }

    Ok((
        SkinningDocument {
            schema_version: DOCUMENT_SCHEMA_VERSION,
            joints: document.joints.clone(),
            influences: normalized_influences,
        },
        Observations {
            joint_count: skeleton.joints().len(),
            root_joint_count,
            vertex_influence_count: document.influences.len(),
            influence_slots_per_vertex: 4,
            max_active_influences,
            parent_before_child: true,
            weights_normalized: true,
            active_joint_indices_in_range: true,
            inverse_bind_matches_bind_pose: true,
            max_bind_pose_identity_error,
            matrix_layout: "column-major-4x4",
            skin_matrix_rule: "joint-world-times-inverse-bind",
        },
    ))
}

fn read_document(input_path: &str) -> Result<SkinningDocument, String> {
    let path = resolve_input_path(input_path)?;
    serde_json::from_slice(&fs::read(&path).map_err(|error| {
        format!("failed to read input skinning document '{input_path}': {error}")
    })?)
    .map_err(|error| format!("invalid input skinning JSON: {error}"))
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
    let (output, observations) = validate_and_normalize(&source, request.parameters)?;
    write_json(output_path, &output, "normalized skinning document")?;
    write_json(observations_path, &observations, "skinning observations")
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
                Err("usage: skinning adapter probe | generate REQUEST OUTPUT OBSERVATIONS".into())
            } else {
                generate(
                    request.as_deref().expect("checked above"),
                    output.as_deref().expect("checked above"),
                    observations.as_deref().expect("checked above"),
                )
            }
        }
        _ => Err("usage: skinning adapter probe | generate REQUEST OUTPUT OBSERVATIONS".into()),
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

    fn translated_y(value: f32) -> [f32; 16] {
        let mut matrix = IDENTITY;
        matrix[13] = value;
        matrix
    }

    fn valid_document() -> SkinningDocument {
        SkinningDocument {
            schema_version: 1,
            joints: vec![
                JointDocument {
                    parent: None,
                    inverse_bind: IDENTITY,
                    bind_world: IDENTITY,
                },
                JointDocument {
                    parent: Some(0),
                    inverse_bind: translated_y(-1.0),
                    bind_world: translated_y(1.0),
                },
            ],
            influences: vec![
                InfluenceDocument {
                    joints: [0, 0, 0, 0],
                    weights: [1.0, 0.0, 0.0, 0.0],
                },
                InfluenceDocument {
                    joints: [0, 1, 0, 0],
                    weights: [1.0, 3.0, 0.0, 0.0],
                },
            ],
        }
    }

    #[test]
    fn normalizes_weights_and_proves_bind_pose_identity() {
        let (normalized, observations) = validate_and_normalize(
            &valid_document(),
            Parameters {
                bind_pose_identity_tolerance: 0.0001,
            },
        )
        .unwrap();
        assert_eq!(normalized.influences[1].weights, [0.25, 0.75, 0.0, 0.0]);
        assert_eq!(observations.joint_count, 2);
        assert_eq!(observations.root_joint_count, 1);
        assert_eq!(observations.vertex_influence_count, 2);
        assert_eq!(observations.max_active_influences, 2);
        assert_eq!(observations.max_bind_pose_identity_error, 0.0);
        assert!(observations.parent_before_child);
        assert!(observations.weights_normalized);
        assert!(observations.active_joint_indices_in_range);
        assert!(observations.inverse_bind_matches_bind_pose);
    }

    #[test]
    fn rejects_forward_parent_reference() {
        let mut document = valid_document();
        document.joints[0].parent = Some(1);
        let error = validate_and_normalize(
            &document,
            Parameters {
                bind_pose_identity_tolerance: 0.0001,
            },
        )
        .unwrap_err();
        assert!(error.contains("parents must appear before children"));
    }

    #[test]
    fn rejects_active_joint_outside_skeleton() {
        let mut document = valid_document();
        document.influences[0] = InfluenceDocument {
            joints: [2, 0, 0, 0],
            weights: [1.0, 0.0, 0.0, 0.0],
        };
        let error = validate_and_normalize(
            &document,
            Parameters {
                bind_pose_identity_tolerance: 0.0001,
            },
        )
        .unwrap_err();
        assert!(error.contains("skeleton has 2 joints"));
    }

    #[test]
    fn rejects_inverse_bind_that_does_not_restore_bind_pose() {
        let mut document = valid_document();
        document.joints[1].inverse_bind = IDENTITY;
        let error = validate_and_normalize(
            &document,
            Parameters {
                bind_pose_identity_tolerance: 0.0001,
            },
        )
        .unwrap_err();
        assert!(error.contains("bind-pose skin matrices deviate from identity"));
    }

    #[test]
    fn rejects_non_finite_skin_matrix_result_from_finite_inputs() {
        let mut document = valid_document();
        let huge = [
            f32::MAX,
            f32::MAX,
            0.0,
            0.0,
            f32::MAX,
            -f32::MAX,
            0.0,
            0.0,
            0.0,
            0.0,
            1.0,
            0.0,
            0.0,
            0.0,
            0.0,
            1.0,
        ];
        document.joints[0].inverse_bind = huge;
        document.joints[0].bind_world = huge;
        let error = validate_and_normalize(
            &document,
            Parameters {
                bind_pose_identity_tolerance: f32::MAX,
            },
        )
        .unwrap_err();
        assert!(error.contains("skin matrix"));
        assert!(error.contains("must be finite"));
    }

    #[test]
    fn rejects_overflowing_input_weight_sum() {
        let mut document = valid_document();
        document.influences[0].weights = [f32::MAX; 4];
        let error = validate_and_normalize(
            &document,
            Parameters {
                bind_pose_identity_tolerance: 0.0001,
            },
        )
        .unwrap_err();
        assert!(error.contains("weight sum must be finite and positive"));
    }
}
