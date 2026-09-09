use std::env;
use std::fs;
use std::path::Path;

use serde_json::json;
use three_d_animation::{
    AnimationClip, AnimationTrack, Interpolation, Keyframe, KeyframeTrack, Quat, Transform,
};
use three_d_core::Vec3;
use three_d_playback::{
    PlaybackClock, PlaybackMode, TransitionClock, TransitionCurve, sample_cross_fade,
};

const CLIP_DURATION: f32 = 1.0;
const TRANSITION_DURATION: f32 = 0.35;
const NAIVE_FRAME_SECONDS: f32 = 1.0 / 60.0;
const FRAME_DELTAS: [f32; 15] = [
    0.016, 0.017, 0.052, 0.009, 0.031, 0.016, 0.082, 0.014, 0.043, 0.016, 0.016, 0.065,
    0.012, 0.028, 0.016,
];

fn source_clip() -> AnimationClip {
    let translation = KeyframeTrack::new(
        vec![
            Keyframe {
                time: 0.0,
                value: Vec3::new(-1.2, 0.0, 0.0),
            },
            Keyframe {
                time: CLIP_DURATION,
                value: Vec3::new(1.2, 0.0, 0.0),
            },
        ],
        Interpolation::Linear,
    )
    .expect("source translation track is valid");
    let rotation = KeyframeTrack::new(
        vec![
            Keyframe {
                time: 0.0,
                value: Quat::IDENTITY,
            },
            Keyframe {
                time: CLIP_DURATION,
                value: Quat::from_axis_angle(Vec3::new(0.0, 1.0, 0.0), core::f32::consts::PI)
                    .expect("rotation axis is valid"),
            },
        ],
        Interpolation::Linear,
    )
    .expect("source rotation track is valid");
    AnimationClip::new(
        "source",
        vec![
            AnimationTrack::Translation {
                node: 0,
                track: translation,
            },
            AnimationTrack::Rotation {
                node: 0,
                track: rotation,
            },
        ],
    )
    .expect("source clip is valid")
}

fn target_clip() -> AnimationClip {
    let translation = KeyframeTrack::new(
        vec![
            Keyframe {
                time: 0.0,
                value: Vec3::new(0.0, -0.8, -0.8),
            },
            Keyframe {
                time: CLIP_DURATION,
                value: Vec3::new(0.0, 0.8, 0.8),
            },
        ],
        Interpolation::SmoothStep,
    )
    .expect("target translation track is valid");
    let rotation = KeyframeTrack::new(
        vec![
            Keyframe {
                time: 0.0,
                value: Quat::IDENTITY,
            },
            Keyframe {
                time: CLIP_DURATION,
                value: Quat::from_axis_angle(Vec3::new(1.0, 0.0, 0.0), core::f32::consts::PI)
                    .expect("rotation axis is valid"),
            },
        ],
        Interpolation::Linear,
    )
    .expect("target rotation track is valid");
    AnimationClip::new(
        "target",
        vec![
            AnimationTrack::Translation {
                node: 0,
                track: translation,
            },
            AnimationTrack::Rotation {
                node: 0,
                track: rotation,
            },
        ],
    )
    .expect("target clip is valid")
}

fn transform_json(transform: Transform) -> serde_json::Value {
    json!({
        "translation": [
            transform.translation.x,
            transform.translation.y,
            transform.translation.z,
        ],
        "rotation": [
            transform.rotation.x,
            transform.rotation.y,
            transform.rotation.z,
            transform.rotation.w,
        ],
        "scale": [transform.scale.x, transform.scale.y, transform.scale.z],
    })
}

fn main() {
    let output = env::args()
        .nth(1)
        .unwrap_or_else(|| "web/public/generated/playback-fixture.json".to_owned());
    let output_path = Path::new(&output);
    if let Some(parent) = output_path.parent() {
        fs::create_dir_all(parent).expect("could not create fixture output directory");
    }

    let source = source_clip();
    let target = target_clip();
    let mut source_clock = PlaybackClock::from_clip(&source, PlaybackMode::Loop)
        .expect("source clock duration is valid");
    let mut target_clock = PlaybackClock::from_clip(&target, PlaybackMode::Loop)
        .expect("target clock duration is valid");
    let mut transition = TransitionClock::new(TRANSITION_DURATION, TransitionCurve::SmoothStep)
        .expect("transition duration is valid");
    let base_pose = [Transform::IDENTITY];
    let mut output_pose = [Transform::IDENTITY];
    let mut wall_time = 0.0_f32;

    let frames = FRAME_DELTAS
        .into_iter()
        .enumerate()
        .map(|(frame_index, delta_seconds)| {
            wall_time += delta_seconds;
            let source_time = source_clock
                .advance(delta_seconds)
                .expect("fixture delta is valid");
            let target_time = target_clock
                .advance(delta_seconds)
                .expect("fixture delta is valid");
            let blend_factor = transition
                .advance(delta_seconds)
                .expect("fixture delta is valid");
            sample_cross_fade(
                &source,
                source_time,
                &target,
                target_time,
                blend_factor,
                &base_pose,
                &mut output_pose,
            )
            .expect("fixture cross-fade is valid");

            json!({
                "frame": frame_index,
                "deltaSeconds": delta_seconds,
                "wallTimeSeconds": wall_time,
                "playbackTimeSeconds": source_time,
                "targetTimeSeconds": target_time,
                "naiveFixedFrameTimeSeconds": (frame_index + 1) as f32 * NAIVE_FRAME_SECONDS,
                "transitionLinearProgress": transition.linear_progress(),
                "blendFactor": blend_factor,
                "transitionComplete": transition.is_complete(),
                "pose": transform_json(output_pose[0]),
            })
        })
        .collect::<Vec<_>>();

    let document = json!({
        "schemaVersion": 1,
        "clipDurationSeconds": CLIP_DURATION,
        "transitionDurationSeconds": TRANSITION_DURATION,
        "transitionCurve": "smoothstep",
        "naiveFrameSeconds": NAIVE_FRAME_SECONDS,
        "frames": frames,
    });

    let encoded = serde_json::to_string_pretty(&document).expect("fixture JSON is serializable");
    fs::write(output_path, format!("{encoded}\n")).expect("could not write fixture JSON");
}
