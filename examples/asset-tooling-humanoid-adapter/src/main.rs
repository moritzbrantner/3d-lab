use std::env;
use std::fs;
use std::path::{Component, Path, PathBuf};

use serde::{Deserialize, Serialize};
use three_d_animation::humanoid::{HumanoidSkeleton, HumanoidSocket, HumanoidSocketBinding};
use three_d_animation::retarget::{HumanoidBinding, HumanoidBone, HumanoidRig};
use three_d_animation::{Joint, Mat4, Quat, Skeleton, Transform};
use three_d_core::Vec3;

const PROTOCOL: &str = "asset-tooling-process-adapter-v1";
const CODEC: &str = "three-d-humanoid-json-v1";
const PROCESSOR_ID: &str = "three-d-humanoid-validate";
const OPERATION: &str = "rig.humanoid.validate";
const ALGORITHM: &str = "three-d-animation-humanoid-production-v1";
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
#[serde(deny_unknown_fields)]
struct Parameters {}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct HumanoidDocument {
    schema_version: u32,
    reference_height: f32,
    joints: Vec<JointDocument>,
    rest_pose: Vec<TransformDocument>,
    bindings: Vec<BindingDocument>,
    sockets: Vec<SocketDocument>,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct JointDocument {
    parent: Option<usize>,
    inverse_bind: [f32; 16],
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TransformDocument {
    translation: [f32; 3],
    rotation: [f32; 4],
    scale: [f32; 3],
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BindingDocument {
    bone: String,
    node: usize,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SocketDocument {
    socket: String,
    bone: String,
    local: TransformDocument,
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
    mapped_bone_count: usize,
    helper_joint_count: usize,
    socket_count: usize,
    root_node: usize,
    hips_node: usize,
    optional_toe_count: usize,
    reference_height: f32,
    semantic_hierarchy_valid: bool,
    root_hips_separated: bool,
    standard_sockets_present: bool,
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

fn vec3(values: [f32; 3], location: &str) -> Result<Vec3, String> {
    if values.iter().any(|value| !value.is_finite()) {
        return Err(format!("{location} must contain finite values"));
    }
    Ok(Vec3::new(values[0], values[1], values[2]))
}

fn transform(value: TransformDocument, location: &str) -> Result<Transform, String> {
    if value
        .rotation
        .iter()
        .any(|component| !component.is_finite())
    {
        return Err(format!("{location}.rotation must contain finite values"));
    }
    Ok(Transform {
        translation: vec3(value.translation, &format!("{location}.translation"))?,
        rotation: Quat::new(
            value.rotation[0],
            value.rotation[1],
            value.rotation[2],
            value.rotation[3],
        ),
        scale: vec3(value.scale, &format!("{location}.scale"))?,
    })
}

fn parse_bone(value: &str, location: &str) -> Result<HumanoidBone, String> {
    HumanoidBone::from_id(value)
        .ok_or_else(|| format!("{location} contains unknown humanoid bone id '{value}'"))
}

fn parse_socket(value: &str, location: &str) -> Result<HumanoidSocket, String> {
    HumanoidSocket::from_id(value)
        .ok_or_else(|| format!("{location} contains unknown humanoid socket id '{value}'"))
}

fn validate_and_normalize(
    document: &HumanoidDocument,
) -> Result<(HumanoidDocument, Observations), String> {
    if document.schema_version != DOCUMENT_SCHEMA_VERSION {
        return Err(format!(
            "humanoid document schemaVersion must be {DOCUMENT_SCHEMA_VERSION}, got {}",
            document.schema_version
        ));
    }
    if !document.reference_height.is_finite() || document.reference_height <= 0.0 {
        return Err("humanoid referenceHeight must be finite and positive".into());
    }
    if document.joints.is_empty() {
        return Err("humanoid document must contain at least one joint".into());
    }
    if document.joints.len() != document.rest_pose.len() {
        return Err(format!(
            "humanoid joints/restPose length mismatch: {} joints, {} transforms",
            document.joints.len(),
            document.rest_pose.len()
        ));
    }

    let mut joints = Vec::with_capacity(document.joints.len());
    for (index, joint) in document.joints.iter().enumerate() {
        joints.push(Joint {
            parent: joint.parent,
            inverse_bind: finite_matrix(
                joint.inverse_bind,
                &format!("joints[{index}].inverseBind"),
            )?,
        });
    }
    let skeleton = Skeleton::new(joints).map_err(|error| format!("invalid skeleton: {error}"))?;

    let mut rest_pose = Vec::with_capacity(document.rest_pose.len());
    for (index, value) in document.rest_pose.iter().copied().enumerate() {
        rest_pose.push(transform(value, &format!("restPose[{index}]"))?);
    }

    let mut bindings = Vec::with_capacity(document.bindings.len());
    for (index, binding) in document.bindings.iter().enumerate() {
        bindings.push(HumanoidBinding {
            bone: parse_bone(&binding.bone, &format!("bindings[{index}].bone"))?,
            node: binding.node,
        });
    }
    let rig = HumanoidRig::new(rest_pose, &bindings, document.reference_height)
        .map_err(|error| format!("invalid humanoid rig: {error}"))?;

    let mut sockets = Vec::with_capacity(document.sockets.len());
    for (index, socket) in document.sockets.iter().enumerate() {
        sockets.push(HumanoidSocketBinding {
            socket: parse_socket(&socket.socket, &format!("sockets[{index}].socket"))?,
            bone: parse_bone(&socket.bone, &format!("sockets[{index}].bone"))?,
            local: transform(socket.local, &format!("sockets[{index}].local"))?,
        });
    }

    let humanoid = HumanoidSkeleton::production_v1(skeleton, rig, &sockets)
        .map_err(|error| format!("invalid production humanoid: {error}"))?;

    let root_node = humanoid
        .rig()
        .node(HumanoidBone::Root)
        .ok_or_else(|| "validated production humanoid is missing Root".to_string())?;
    let hips_node = humanoid
        .rig()
        .node(HumanoidBone::Hips)
        .ok_or_else(|| "validated production humanoid is missing Hips".to_string())?;
    let optional_toe_count = [HumanoidBone::LeftToes, HumanoidBone::RightToes]
        .into_iter()
        .filter(|bone| humanoid.rig().node(*bone).is_some())
        .count();

    Ok((
        document.clone(),
        Observations {
            joint_count: humanoid.skeleton().joints().len(),
            mapped_bone_count: document.bindings.len(),
            helper_joint_count: humanoid
                .skeleton()
                .joints()
                .len()
                .saturating_sub(document.bindings.len()),
            socket_count: document.sockets.len(),
            root_node,
            hips_node,
            optional_toe_count,
            reference_height: humanoid.rig().reference_height(),
            semantic_hierarchy_valid: true,
            root_hips_separated: root_node != hips_node,
            standard_sockets_present: HumanoidSocket::REQUIRED
                .into_iter()
                .all(|socket| humanoid.socket(socket).is_some()),
        },
    ))
}

fn read_document(input_path: &str) -> Result<HumanoidDocument, String> {
    let path = resolve_input_path(input_path)?;
    serde_json::from_slice(&fs::read(&path).map_err(|error| {
        format!("failed to read input humanoid document '{input_path}': {error}")
    })?)
    .map_err(|error| format!("invalid input humanoid JSON: {error}"))
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
    let _parameters = request.parameters;
    let source = read_document(&request.input_path)?;
    let (output, observations) = validate_and_normalize(&source)?;
    write_json(output_path, &output, "validated humanoid document")?;
    write_json(
        observations_path,
        &observations,
        "humanoid validation observations",
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
                Err("usage: humanoid adapter probe | generate REQUEST OUTPUT OBSERVATIONS".into())
            } else {
                generate(
                    request.as_deref().expect("checked above"),
                    output.as_deref().expect("checked above"),
                    observations.as_deref().expect("checked above"),
                )
            }
        }
        _ => Err("usage: humanoid adapter probe | generate REQUEST OUTPUT OBSERVATIONS".into()),
    };

    if let Err(error) = result {
        eprintln!("{error}");
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const IDENTITY_MATRIX: [f32; 16] = [
        1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0,
    ];
    const IDENTITY_TRANSFORM: TransformDocument = TransformDocument {
        translation: [0.0, 0.0, 0.0],
        rotation: [0.0, 0.0, 0.0, 1.0],
        scale: [1.0, 1.0, 1.0],
    };
    const BONE_IDS: [&str; 20] = [
        "root",
        "hips",
        "spine",
        "chest",
        "neck",
        "head",
        "left-shoulder",
        "left-upper-arm",
        "left-lower-arm",
        "left-hand",
        "right-shoulder",
        "right-upper-arm",
        "right-lower-arm",
        "right-hand",
        "left-upper-leg",
        "left-lower-leg",
        "left-foot",
        "right-upper-leg",
        "right-lower-leg",
        "right-foot",
    ];
    const PARENTS: [Option<usize>; 20] = [
        None,
        Some(0),
        Some(1),
        Some(2),
        Some(3),
        Some(4),
        Some(3),
        Some(6),
        Some(7),
        Some(8),
        Some(3),
        Some(10),
        Some(11),
        Some(12),
        Some(1),
        Some(14),
        Some(15),
        Some(1),
        Some(17),
        Some(18),
    ];

    fn socket(socket: HumanoidSocket) -> SocketDocument {
        SocketDocument {
            socket: socket.id().to_string(),
            bone: socket.expected_bone().id().to_string(),
            local: IDENTITY_TRANSFORM,
        }
    }

    fn valid_document() -> HumanoidDocument {
        HumanoidDocument {
            schema_version: 1,
            reference_height: 1.8,
            joints: PARENTS
                .into_iter()
                .map(|parent| JointDocument {
                    parent,
                    inverse_bind: IDENTITY_MATRIX,
                })
                .collect(),
            rest_pose: vec![IDENTITY_TRANSFORM; BONE_IDS.len()],
            bindings: BONE_IDS
                .into_iter()
                .enumerate()
                .map(|(node, bone)| BindingDocument {
                    bone: bone.to_string(),
                    node,
                })
                .collect(),
            sockets: HumanoidSocket::REQUIRED.into_iter().map(socket).collect(),
        }
    }

    #[test]
    fn validates_canonical_production_humanoid() {
        let document = valid_document();
        let (normalized, observations) = validate_and_normalize(&document).unwrap();

        assert_eq!(normalized, document);
        assert_eq!(observations.joint_count, 20);
        assert_eq!(observations.mapped_bone_count, 20);
        assert_eq!(observations.helper_joint_count, 0);
        assert_eq!(observations.socket_count, 7);
        assert_eq!(observations.root_node, 0);
        assert_eq!(observations.hips_node, 1);
        assert_eq!(observations.optional_toe_count, 0);
        assert_eq!(observations.reference_height, 1.8);
        assert!(observations.semantic_hierarchy_valid);
        assert!(observations.root_hips_separated);
        assert!(observations.standard_sockets_present);
    }

    #[test]
    fn rejects_cross_branch_semantic_hierarchy() {
        let mut document = valid_document();
        document.joints[10].parent = Some(9);

        let error = validate_and_normalize(&document).unwrap_err();

        assert!(error.contains("RightShoulder"));
        assert!(error.contains("Chest"));
    }

    #[test]
    fn rejects_missing_standard_socket() {
        let mut document = valid_document();
        document.sockets.retain(|socket| socket.socket != "back");

        let error = validate_and_normalize(&document).unwrap_err();

        assert!(error.contains("missing required socket Back"));
    }

    #[test]
    fn rejects_unknown_semantic_ids_before_profile_validation() {
        let mut document = valid_document();
        document.bindings[0].bone = "pelvis-root".to_string();

        let error = validate_and_normalize(&document).unwrap_err();

        assert!(error.contains("unknown humanoid bone id 'pelvis-root'"));
    }
}
