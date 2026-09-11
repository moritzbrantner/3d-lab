use std::collections::BTreeSet;
use std::env;
use std::fs;
use std::path::{Component, Path, PathBuf};

use serde::{Deserialize, Serialize};
use three_d_animation::{Interpolate, Interpolation, Keyframe, KeyframeTrack, Quat};
use three_d_core::Vec3;

const PROTOCOL: &str = "asset-tooling-process-adapter-v1";
const CODEC: &str = "three-d-animation-json-v1";
const ANIMATION_SCHEMA_VERSION: u32 = 1;
const CARGO_LOCK: &str = include_str!("../../../Cargo.lock");
const UNIT_QUATERNION_TOLERANCE: f32 = 1.0e-4;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AdapterOperation {
    Resample,
    Reduce,
}

impl AdapterOperation {
    fn operation(self) -> &'static str {
        match self {
            Self::Resample => "animation.resample",
            Self::Reduce => "animation.reduce",
        }
    }

    fn processor_id(self) -> &'static str {
        match self {
            Self::Resample => "three-d-animation-resample",
            Self::Reduce => "three-d-animation-reduce",
        }
    }

    fn algorithm(self) -> &'static str {
        match self {
            Self::Resample => "three-d-animation-resample-v1",
            Self::Reduce => "three-d-animation-key-reduction-v1",
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Request<T> {
    schema_version: u32,
    operation: String,
    input_path: String,
    parameters: T,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct InterpolationRules {
    translation: String,
    rotation: String,
    scale: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ResampleParameters {
    source_start_seconds: f32,
    source_end_seconds: f32,
    target_times_seconds: Vec<f32>,
    interpolation: InterpolationRules,
    transform_space: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReduceParameters {
    translation_error: f32,
    rotation_error_radians: f32,
    scale_error: f32,
    transform_space: String,
    preserve_endpoints: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AnimationDocument {
    schema_version: u32,
    channels: Vec<ChannelDocument>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
enum ChannelDocument {
    Translation {
        node: usize,
        keyframes: Vec<Vec3KeyframeDocument>,
    },
    Rotation {
        node: usize,
        keyframes: Vec<QuatKeyframeDocument>,
    },
    Scale {
        node: usize,
        keyframes: Vec<Vec3KeyframeDocument>,
    },
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Vec3KeyframeDocument {
    time: f32,
    value: [f32; 3],
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct QuatKeyframeDocument {
    time: f32,
    value: [f32; 4],
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

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ResampleObservations {
    source_keyframe_count: usize,
    result_keyframe_count: usize,
    channel_count: usize,
    duration_seconds: f32,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ReduceObservations {
    source_keyframe_count: usize,
    result_keyframe_count: usize,
    max_translation_error: f32,
    max_rotation_error_radians: f32,
    max_scale_error: f32,
    endpoints_preserved: bool,
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

fn assert_finite(value: f32, location: &str) -> Result<(), String> {
    if !value.is_finite() {
        return Err(format!("{location} must be finite"));
    }
    Ok(())
}

fn validate_times<T>(
    keyframes: &[T],
    time: impl Fn(&T) -> f32,
    location: &str,
) -> Result<(), String> {
    if keyframes.is_empty() {
        return Err(format!("{location} must contain at least one keyframe"));
    }
    for (index, keyframe) in keyframes.iter().enumerate() {
        let current = time(keyframe);
        assert_finite(current, &format!("{location}[{index}].time"))?;
        if current < 0.0 {
            return Err(format!("{location}[{index}].time must be non-negative"));
        }
        if index > 0 && current <= time(&keyframes[index - 1]) {
            return Err(format!("{location} times must be strictly increasing"));
        }
    }
    Ok(())
}

fn validate_vec3_keyframes(
    keyframes: &[Vec3KeyframeDocument],
    location: &str,
) -> Result<(), String> {
    validate_times(keyframes, |keyframe| keyframe.time, location)?;
    for (index, keyframe) in keyframes.iter().enumerate() {
        for (component, value) in keyframe.value.iter().enumerate() {
            assert_finite(*value, &format!("{location}[{index}].value[{component}]"))?;
        }
    }
    Ok(())
}

fn validate_quat_keyframes(
    keyframes: &[QuatKeyframeDocument],
    location: &str,
) -> Result<(), String> {
    validate_times(keyframes, |keyframe| keyframe.time, location)?;
    for (index, keyframe) in keyframes.iter().enumerate() {
        for (component, value) in keyframe.value.iter().enumerate() {
            assert_finite(*value, &format!("{location}[{index}].value[{component}]"))?;
        }
        let [x, y, z, w] = keyframe.value;
        let length = (x * x + y * y + z * z + w * w).sqrt();
        if (length - 1.0).abs() > UNIT_QUATERNION_TOLERANCE {
            return Err(format!(
                "{location}[{index}].value must be a normalized quaternion"
            ));
        }
    }
    Ok(())
}

fn validate_document(document: &AnimationDocument) -> Result<(), String> {
    if document.schema_version != ANIMATION_SCHEMA_VERSION {
        return Err(format!(
            "animation schemaVersion must be {ANIMATION_SCHEMA_VERSION}, got {}",
            document.schema_version
        ));
    }
    if document.channels.is_empty() {
        return Err("animation document must contain at least one channel".into());
    }

    let mut channel_keys = BTreeSet::new();
    for (index, channel) in document.channels.iter().enumerate() {
        let key = match channel {
            ChannelDocument::Translation { node, keyframes } => {
                validate_vec3_keyframes(keyframes, &format!("channels[{index}].keyframes"))?;
                (*node, "translation")
            }
            ChannelDocument::Rotation { node, keyframes } => {
                validate_quat_keyframes(keyframes, &format!("channels[{index}].keyframes"))?;
                (*node, "rotation")
            }
            ChannelDocument::Scale { node, keyframes } => {
                validate_vec3_keyframes(keyframes, &format!("channels[{index}].keyframes"))?;
                (*node, "scale")
            }
        };
        if !channel_keys.insert(key) {
            return Err(format!(
                "animation document contains duplicate {} channel for node {}",
                key.1, key.0
            ));
        }
    }
    Ok(())
}

impl ChannelDocument {
    fn keyframe_count(&self) -> usize {
        match self {
            Self::Translation { keyframes, .. } | Self::Scale { keyframes, .. } => keyframes.len(),
            Self::Rotation { keyframes, .. } => keyframes.len(),
        }
    }

    fn first_time(&self) -> f32 {
        match self {
            Self::Translation { keyframes, .. } | Self::Scale { keyframes, .. } => {
                keyframes[0].time
            }
            Self::Rotation { keyframes, .. } => keyframes[0].time,
        }
    }

    fn last_time(&self) -> f32 {
        match self {
            Self::Translation { keyframes, .. } | Self::Scale { keyframes, .. } => {
                keyframes[keyframes.len() - 1].time
            }
            Self::Rotation { keyframes, .. } => keyframes[keyframes.len() - 1].time,
        }
    }

    fn endpoints_match(&self, other: &Self) -> bool {
        match (self, other) {
            (
                Self::Translation {
                    node: left_node,
                    keyframes: left,
                },
                Self::Translation {
                    node: right_node,
                    keyframes: right,
                },
            )
            | (
                Self::Scale {
                    node: left_node,
                    keyframes: left,
                },
                Self::Scale {
                    node: right_node,
                    keyframes: right,
                },
            ) => {
                left_node == right_node
                    && left.first() == right.first()
                    && left.last() == right.last()
            }
            (
                Self::Rotation {
                    node: left_node,
                    keyframes: left,
                },
                Self::Rotation {
                    node: right_node,
                    keyframes: right,
                },
            ) => {
                left_node == right_node
                    && left.first() == right.first()
                    && left.last() == right.last()
            }
            _ => false,
        }
    }
}

fn document_bounds(document: &AnimationDocument) -> (f32, f32) {
    let start = document
        .channels
        .iter()
        .map(ChannelDocument::first_time)
        .fold(f32::INFINITY, f32::min);
    let end = document
        .channels
        .iter()
        .map(ChannelDocument::last_time)
        .fold(f32::NEG_INFINITY, f32::max);
    (start, end)
}

fn vec3_track(keyframes: &[Vec3KeyframeDocument]) -> Result<KeyframeTrack<Vec3>, String> {
    KeyframeTrack::new(
        keyframes
            .iter()
            .map(|keyframe| Keyframe {
                time: keyframe.time,
                value: Vec3::new(keyframe.value[0], keyframe.value[1], keyframe.value[2]),
            })
            .collect(),
        Interpolation::Linear,
    )
    .map_err(|error| error.to_string())
}

fn quat_track(keyframes: &[QuatKeyframeDocument]) -> Result<KeyframeTrack<Quat>, String> {
    KeyframeTrack::new(
        keyframes
            .iter()
            .map(|keyframe| Keyframe {
                time: keyframe.time,
                value: Quat::new(
                    keyframe.value[0],
                    keyframe.value[1],
                    keyframe.value[2],
                    keyframe.value[3],
                ),
            })
            .collect(),
        Interpolation::Linear,
    )
    .map_err(|error| error.to_string())
}

fn validate_resample_parameters(
    parameters: &ResampleParameters,
    document: &AnimationDocument,
) -> Result<(), String> {
    assert_finite(
        parameters.source_start_seconds,
        "parameters.sourceStartSeconds",
    )?;
    assert_finite(parameters.source_end_seconds, "parameters.sourceEndSeconds")?;
    if parameters.source_start_seconds < 0.0 || parameters.source_end_seconds < 0.0 {
        return Err("source time bounds must be non-negative".into());
    }
    if parameters.source_end_seconds < parameters.source_start_seconds {
        return Err("parameters.sourceEndSeconds must not precede sourceStartSeconds".into());
    }
    if parameters.transform_space != "local" {
        return Err("animation.resample v1 requires transformSpace='local'".into());
    }
    if parameters.interpolation.translation != "linear"
        || parameters.interpolation.rotation != "slerp"
        || parameters.interpolation.scale != "linear"
    {
        return Err(
            "animation.resample v1 requires linear translation/scale and slerp rotation interpolation"
                .into(),
        );
    }
    if parameters.target_times_seconds.is_empty() {
        return Err("parameters.targetTimesSeconds must be non-empty".into());
    }
    for (index, time) in parameters.target_times_seconds.iter().enumerate() {
        assert_finite(*time, &format!("parameters.targetTimesSeconds[{index}]"))?;
        if *time < parameters.source_start_seconds || *time > parameters.source_end_seconds {
            return Err(
                "parameters.targetTimesSeconds must stay inside the source time domain".into(),
            );
        }
        if index > 0 && *time <= parameters.target_times_seconds[index - 1] {
            return Err("parameters.targetTimesSeconds must be strictly increasing".into());
        }
    }

    let (source_start, source_end) = document_bounds(document);
    if source_start.to_bits() != parameters.source_start_seconds.to_bits()
        || source_end.to_bits() != parameters.source_end_seconds.to_bits()
    {
        return Err(format!(
            "declared source time domain [{}, {}] does not match animation document [{source_start}, {source_end}]",
            parameters.source_start_seconds, parameters.source_end_seconds
        ));
    }
    Ok(())
}

fn resample_document(
    document: &AnimationDocument,
    parameters: &ResampleParameters,
) -> Result<(AnimationDocument, ResampleObservations), String> {
    validate_resample_parameters(parameters, document)?;
    let channels = document
        .channels
        .iter()
        .map(|channel| match channel {
            ChannelDocument::Translation { node, keyframes } => {
                let track = vec3_track(keyframes)?;
                Ok(ChannelDocument::Translation {
                    node: *node,
                    keyframes: parameters
                        .target_times_seconds
                        .iter()
                        .map(|time| {
                            let value = track.sample(*time);
                            Vec3KeyframeDocument {
                                time: *time,
                                value: [value.x, value.y, value.z],
                            }
                        })
                        .collect(),
                })
            }
            ChannelDocument::Rotation { node, keyframes } => {
                let track = quat_track(keyframes)?;
                Ok(ChannelDocument::Rotation {
                    node: *node,
                    keyframes: parameters
                        .target_times_seconds
                        .iter()
                        .map(|time| {
                            let value = track.sample(*time);
                            QuatKeyframeDocument {
                                time: *time,
                                value: [value.x, value.y, value.z, value.w],
                            }
                        })
                        .collect(),
                })
            }
            ChannelDocument::Scale { node, keyframes } => {
                let track = vec3_track(keyframes)?;
                Ok(ChannelDocument::Scale {
                    node: *node,
                    keyframes: parameters
                        .target_times_seconds
                        .iter()
                        .map(|time| {
                            let value = track.sample(*time);
                            Vec3KeyframeDocument {
                                time: *time,
                                value: [value.x, value.y, value.z],
                            }
                        })
                        .collect(),
                })
            }
        })
        .collect::<Result<Vec<_>, String>>()?;

    let source_keyframe_count = document
        .channels
        .iter()
        .map(ChannelDocument::keyframe_count)
        .sum();
    let channel_count = channels.len();
    let result_keyframe_count = channel_count * parameters.target_times_seconds.len();
    let duration_seconds = parameters.target_times_seconds
        [parameters.target_times_seconds.len() - 1]
        - parameters.target_times_seconds[0];
    Ok((
        AnimationDocument {
            schema_version: ANIMATION_SCHEMA_VERSION,
            channels,
        },
        ResampleObservations {
            source_keyframe_count,
            result_keyframe_count,
            channel_count,
            duration_seconds,
        },
    ))
}

fn vec3_error(left: Vec3, right: Vec3) -> f32 {
    let dx = left.x - right.x;
    let dy = left.y - right.y;
    let dz = left.z - right.z;
    (dx * dx + dy * dy + dz * dz).sqrt()
}

fn quaternion_error_radians(left: Quat, right: Quat) -> f32 {
    let Some(left) = left.normalized() else {
        return f32::INFINITY;
    };
    let Some(right) = right.normalized() else {
        return f32::INFINITY;
    };
    2.0 * left.dot(right).abs().clamp(0.0, 1.0).acos()
}

fn interpolate_vec3(left: Vec3, right: Vec3, factor: f32) -> Vec3 {
    left.interpolate(right, factor)
}

fn reduce_indices<T: Copy>(
    times: &[f32],
    values: &[T],
    tolerance: f32,
    interpolate: impl Fn(T, T, f32) -> T + Copy,
    error: impl Fn(T, T) -> f32 + Copy,
) -> Vec<usize> {
    debug_assert_eq!(times.len(), values.len());
    if times.len() <= 2 {
        return (0..times.len()).collect();
    }

    let mut keep = vec![false; times.len()];
    keep[0] = true;
    keep[times.len() - 1] = true;
    let mut spans = vec![(0, times.len() - 1)];

    while let Some((start, end)) = spans.pop() {
        if end <= start + 1 {
            continue;
        }
        let span = times[end] - times[start];
        let mut maximum_error = -1.0_f32;
        let mut maximum_index = start + 1;
        for index in start + 1..end {
            let factor = (times[index] - times[start]) / span;
            let predicted = interpolate(values[start], values[end], factor);
            let current_error = error(values[index], predicted);
            if current_error > maximum_error {
                maximum_error = current_error;
                maximum_index = index;
            }
        }
        if maximum_error > tolerance {
            keep[maximum_index] = true;
            spans.push((maximum_index, end));
            spans.push((start, maximum_index));
        }
    }

    keep.into_iter()
        .enumerate()
        .filter(|(_, keep)| *keep)
        .map(|(index, _)| index)
        .collect()
}

fn reduce_vec3_keyframes(
    keyframes: &[Vec3KeyframeDocument],
    tolerance: f32,
) -> Result<(Vec<Vec3KeyframeDocument>, f32), String> {
    let times: Vec<_> = keyframes.iter().map(|keyframe| keyframe.time).collect();
    let values: Vec<_> = keyframes
        .iter()
        .map(|keyframe| Vec3::new(keyframe.value[0], keyframe.value[1], keyframe.value[2]))
        .collect();
    let indices = reduce_indices(
        &times,
        &values,
        tolerance,
        interpolate_vec3,
        vec3_error,
    );
    let reduced: Vec<_> = indices.iter().map(|index| keyframes[*index]).collect();
    let track = vec3_track(&reduced)?;
    let maximum_error = keyframes.iter().fold(0.0_f32, |maximum, keyframe| {
        let actual = Vec3::new(keyframe.value[0], keyframe.value[1], keyframe.value[2]);
        maximum.max(vec3_error(actual, track.sample(keyframe.time)))
    });
    Ok((reduced, maximum_error))
}

fn reduce_quat_keyframes(
    keyframes: &[QuatKeyframeDocument],
    tolerance: f32,
) -> Result<(Vec<QuatKeyframeDocument>, f32), String> {
    let times: Vec<_> = keyframes.iter().map(|keyframe| keyframe.time).collect();
    let values: Vec<_> = keyframes
        .iter()
        .map(|keyframe| {
            Quat::new(
                keyframe.value[0],
                keyframe.value[1],
                keyframe.value[2],
                keyframe.value[3],
            )
        })
        .collect();
    let indices = reduce_indices(
        &times,
        &values,
        tolerance,
        Quat::slerp,
        quaternion_error_radians,
    );
    let reduced: Vec<_> = indices.iter().map(|index| keyframes[*index]).collect();
    let track = quat_track(&reduced)?;
    let maximum_error = keyframes.iter().fold(0.0_f32, |maximum, keyframe| {
        let actual = Quat::new(
            keyframe.value[0],
            keyframe.value[1],
            keyframe.value[2],
            keyframe.value[3],
        );
        maximum.max(quaternion_error_radians(
            actual,
            track.sample(keyframe.time),
        ))
    });
    Ok((reduced, maximum_error))
}

fn validate_reduce_parameters(parameters: &ReduceParameters) -> Result<(), String> {
    for (location, value) in [
        ("parameters.translationError", parameters.translation_error),
        (
            "parameters.rotationErrorRadians",
            parameters.rotation_error_radians,
        ),
        ("parameters.scaleError", parameters.scale_error),
    ] {
        assert_finite(value, location)?;
        if value < 0.0 {
            return Err(format!("{location} must be non-negative"));
        }
    }
    if parameters.transform_space != "local" {
        return Err("animation.reduce v1 requires transformSpace='local'".into());
    }
    Ok(())
}

fn reduce_document(
    document: &AnimationDocument,
    parameters: &ReduceParameters,
) -> Result<(AnimationDocument, ReduceObservations), String> {
    validate_reduce_parameters(parameters)?;
    let source_keyframe_count = document
        .channels
        .iter()
        .map(ChannelDocument::keyframe_count)
        .sum();
    let mut max_translation_error = 0.0_f32;
    let mut max_rotation_error_radians = 0.0_f32;
    let mut max_scale_error = 0.0_f32;

    let channels = document
        .channels
        .iter()
        .map(|channel| match channel {
            ChannelDocument::Translation { node, keyframes } => {
                let (keyframes, error) =
                    reduce_vec3_keyframes(keyframes, parameters.translation_error)?;
                max_translation_error = max_translation_error.max(error);
                Ok(ChannelDocument::Translation {
                    node: *node,
                    keyframes,
                })
            }
            ChannelDocument::Rotation { node, keyframes } => {
                let (keyframes, error) =
                    reduce_quat_keyframes(keyframes, parameters.rotation_error_radians)?;
                max_rotation_error_radians = max_rotation_error_radians.max(error);
                Ok(ChannelDocument::Rotation {
                    node: *node,
                    keyframes,
                })
            }
            ChannelDocument::Scale { node, keyframes } => {
                let (keyframes, error) = reduce_vec3_keyframes(keyframes, parameters.scale_error)?;
                max_scale_error = max_scale_error.max(error);
                Ok(ChannelDocument::Scale {
                    node: *node,
                    keyframes,
                })
            }
        })
        .collect::<Result<Vec<_>, String>>()?;

    let result_keyframe_count = channels.iter().map(ChannelDocument::keyframe_count).sum();
    let endpoints_preserved = document
        .channels
        .iter()
        .zip(&channels)
        .all(|(source, reduced)| source.endpoints_match(reduced));
    if parameters.preserve_endpoints && !endpoints_preserved {
        return Err("endpoint-preserving reduction failed to retain source endpoints".into());
    }

    Ok((
        AnimationDocument {
            schema_version: ANIMATION_SCHEMA_VERSION,
            channels,
        },
        ReduceObservations {
            source_keyframe_count,
            result_keyframe_count,
            max_translation_error,
            max_rotation_error_radians,
            max_scale_error,
            endpoints_preserved,
        },
    ))
}

fn read_animation(input_path: &str) -> Result<AnimationDocument, String> {
    let path = resolve_input_path(input_path)?;
    let document: AnimationDocument = serde_json::from_slice(
        &fs::read(&path)
            .map_err(|error| format!("failed to read input animation '{input_path}': {error}"))?,
    )
    .map_err(|error| format!("invalid input animation JSON: {error}"))?;
    validate_document(&document)?;
    Ok(document)
}

fn write_result<T: Serialize>(path: &Path, value: &T, label: &str) -> Result<(), String> {
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
    operation: AdapterOperation,
    request_path: &Path,
    output_path: &Path,
    observations_path: &Path,
) -> Result<(), String> {
    let request_bytes =
        fs::read(request_path).map_err(|error| format!("failed to read request: {error}"))?;
    match operation {
        AdapterOperation::Resample => {
            let request: Request<ResampleParameters> = serde_json::from_slice(&request_bytes)
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
            let source = read_animation(&request.input_path)?;
            let (output, observations) = resample_document(&source, &request.parameters)?;
            write_result(output_path, &output, "output animation")?;
            write_result(observations_path, &observations, "observations")
        }
        AdapterOperation::Reduce => {
            let request: Request<ReduceParameters> = serde_json::from_slice(&request_bytes)
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
            let source = read_animation(&request.input_path)?;
            let (output, observations) = reduce_document(&source, &request.parameters)?;
            write_result(output_path, &output, "output animation")?;
            write_result(observations_path, &observations, "observations")
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
                Err("usage: animation adapter probe | generate REQUEST OUTPUT OBSERVATIONS".into())
            } else {
                generate(
                    operation,
                    request.as_deref().expect("checked above"),
                    output.as_deref().expect("checked above"),
                    observations.as_deref().expect("checked above"),
                )
            }
        }
        _ => Err("usage: animation adapter probe | generate REQUEST OUTPUT OBSERVATIONS".into()),
    };

    if let Err(error) = result {
        eprintln!("{error}");
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use core::f32::consts::FRAC_PI_2;

    fn translation_channel(values: &[(f32, [f32; 3])]) -> ChannelDocument {
        ChannelDocument::Translation {
            node: 0,
            keyframes: values
                .iter()
                .map(|(time, value)| Vec3KeyframeDocument {
                    time: *time,
                    value: *value,
                })
                .collect(),
        }
    }

    #[test]
    fn resample_materializes_every_channel_at_declared_times() {
        let rotation = Quat::from_axis_angle(Vec3::new(0.0, 1.0, 0.0), FRAC_PI_2).unwrap();
        let source = AnimationDocument {
            schema_version: 1,
            channels: vec![
                translation_channel(&[(0.0, [0.0, 0.0, 0.0]), (1.0, [2.0, 0.0, 0.0])]),
                ChannelDocument::Rotation {
                    node: 0,
                    keyframes: vec![
                        QuatKeyframeDocument {
                            time: 0.0,
                            value: [0.0, 0.0, 0.0, 1.0],
                        },
                        QuatKeyframeDocument {
                            time: 1.0,
                            value: [rotation.x, rotation.y, rotation.z, rotation.w],
                        },
                    ],
                },
            ],
        };
        validate_document(&source).unwrap();
        let parameters = ResampleParameters {
            source_start_seconds: 0.0,
            source_end_seconds: 1.0,
            target_times_seconds: vec![0.0, 0.5, 1.0],
            interpolation: InterpolationRules {
                translation: "linear".into(),
                rotation: "slerp".into(),
                scale: "linear".into(),
            },
            transform_space: "local".into(),
        };
        let (output, observations) = resample_document(&source, &parameters).unwrap();
        assert_eq!(observations.source_keyframe_count, 4);
        assert_eq!(observations.result_keyframe_count, 6);
        assert_eq!(observations.channel_count, 2);
        assert_eq!(observations.duration_seconds, 1.0);
        match &output.channels[0] {
            ChannelDocument::Translation { keyframes, .. } => {
                assert_eq!(keyframes[1].value, [1.0, 0.0, 0.0]);
            }
            _ => panic!("expected translation channel"),
        }
    }

    #[test]
    fn reduction_removes_linear_redundancy_and_preserves_endpoints() {
        let source = AnimationDocument {
            schema_version: 1,
            channels: vec![translation_channel(&[
                (0.0, [0.0, 0.0, 0.0]),
                (0.25, [0.25, 0.0, 0.0]),
                (0.5, [0.5, 0.0, 0.0]),
                (0.75, [0.75, 0.0, 0.0]),
                (1.0, [1.0, 0.0, 0.0]),
            ])],
        };
        validate_document(&source).unwrap();
        let parameters = ReduceParameters {
            translation_error: 0.0,
            rotation_error_radians: 0.0,
            scale_error: 0.0,
            transform_space: "local".into(),
            preserve_endpoints: true,
        };
        let (output, observations) = reduce_document(&source, &parameters).unwrap();
        assert_eq!(observations.source_keyframe_count, 5);
        assert_eq!(observations.result_keyframe_count, 2);
        assert_eq!(observations.max_translation_error, 0.0);
        assert!(observations.endpoints_preserved);
        match &output.channels[0] {
            ChannelDocument::Translation { keyframes, .. } => {
                assert_eq!(keyframes.first().unwrap().time, 0.0);
                assert_eq!(keyframes.last().unwrap().time, 1.0);
            }
            _ => panic!("expected translation channel"),
        }
    }

    #[test]
    fn reduction_retains_a_corner_outside_tolerance() {
        let source = vec![
            Vec3KeyframeDocument {
                time: 0.0,
                value: [0.0, 0.0, 0.0],
            },
            Vec3KeyframeDocument {
                time: 0.5,
                value: [0.5, 1.0, 0.0],
            },
            Vec3KeyframeDocument {
                time: 1.0,
                value: [1.0, 0.0, 0.0],
            },
        ];
        let (reduced, maximum_error) = reduce_vec3_keyframes(&source, 0.25).unwrap();
        assert_eq!(reduced.len(), 3);
        assert_eq!(maximum_error, 0.0);
    }

    #[test]
    fn quaternion_reduction_uses_shortest_arc_angular_error() {
        let middle = Quat::from_axis_angle(Vec3::new(0.0, 1.0, 0.0), FRAC_PI_2 / 2.0).unwrap();
        let end = Quat::from_axis_angle(Vec3::new(0.0, 1.0, 0.0), FRAC_PI_2).unwrap();
        let source = vec![
            QuatKeyframeDocument {
                time: 0.0,
                value: [0.0, 0.0, 0.0, 1.0],
            },
            QuatKeyframeDocument {
                time: 0.5,
                value: [middle.x, middle.y, middle.z, middle.w],
            },
            QuatKeyframeDocument {
                time: 1.0,
                value: [end.x, end.y, end.z, end.w],
            },
        ];
        let (reduced, maximum_error) = reduce_quat_keyframes(&source, 1.0e-5).unwrap();
        assert_eq!(reduced.len(), 2);
        assert!(maximum_error <= 1.0e-5);
    }
}
