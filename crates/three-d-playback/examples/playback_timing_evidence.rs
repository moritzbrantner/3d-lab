//! Generates the committed playback-timing evidence consumed by the web lab.
//!
//! `cargo run -p three-d-playback --example playback_timing_evidence` rewrites
//! `fixtures/playback/playback-timing.json`; `-- --check` fails on drift.
//!
//! The browser only looks frames up in this document. Clip sampling, clock
//! policy, transition progress, and blending all run here. The "fixed per
//! frame" series is the deliberate anti-pattern: the same Rust clocks fed a
//! constant 1/60 s instead of the measured frame delta.

use std::path::PathBuf;

use serde_json::{Value, json};
use three_d_animation::{
    AnimationClip, AnimationTrack, ClipBlendWorkspace, Interpolation, Keyframe, KeyframeTrack,
    LoopMode, Quat, Transform,
};
use three_d_core::Vec3;
use three_d_playback::{
    BOUNDARY_EPSILON_CYCLES, CrossFade, PlaybackClock, PlaybackDirection, PlaybackMode,
    TransitionClock, TransitionCurve,
};

pub const SCHEMA: &str = "3d-lab.playback-timing-evidence.v1";
/// Every scenario covers exactly this much wall-clock time.
pub const WALL_SECONDS: f64 = 2.0;
/// The fixed step the wrong demonstration assumes for every frame.
pub const NAIVE_FRAME_SECONDS: f64 = 1.0 / 60.0;
pub const TRANSITION_SECONDS: [f32; 2] = [0.5, 1.5];
pub const TARGET_SPEED: f64 = 1.5;
/// Values are rounded to this many decimals for the presentation fixture only;
/// the tests check partition invariance against the unrounded clocks.
const DECIMALS: f64 = 1.0e6;
/// How far a regenerated number may sit from the committed one before the
/// fixture counts as drifted. Poses go through `f32` `sin`/`acos`, whose last
/// bit differs between libm implementations (for example glibc 2.39 versus the
/// correctly rounded CORE-MATH functions in glibc 2.41+). A one-ulp difference
/// that lands next to a rounding boundary flips the sixth decimal, so the check
/// allows one rounding step plus slack while every structural field, string,
/// and array length must match exactly.
pub const DRIFT_TOLERANCE: f64 = 2.0e-6;

pub struct Scenario {
    pub id: &'static str,
    pub label: &'static str,
    pub deltas: Vec<f64>,
}

/// Steady `rate_hz` frames covering [`WALL_SECONDS`].
fn steady(rate_hz: u32) -> Vec<f64> {
    let frames = (WALL_SECONDS * f64::from(rate_hz)).round() as usize;
    vec![1.0 / f64::from(rate_hz); frames]
}

/// Deterministic jitter between 6 and 45 ms with two hitches, trimmed so the
/// deltas sum to [`WALL_SECONDS`].
fn uneven() -> Vec<f64> {
    let mut seed = 0x5eed_u64;
    let mut deltas = Vec::new();
    let mut sum = 0.0;
    loop {
        seed = seed
            .wrapping_mul(6_364_136_223_846_793_005)
            .wrapping_add(1_442_695_040_888_963_407);
        let unit = (seed >> 11) as f64 / (1_u64 << 53) as f64;
        let delta = match deltas.len() {
            9 => 0.2,
            40 => 0.12,
            _ => 0.006 + 0.039 * unit,
        };
        if sum + delta >= WALL_SECONDS - 1.0e-9 {
            deltas.push(WALL_SECONDS - sum);
            return deltas;
        }
        sum += delta;
        deltas.push(delta);
    }
}

pub fn scenarios() -> Vec<Scenario> {
    vec![
        Scenario {
            id: "steady-30",
            label: "Steady 30 Hz",
            deltas: steady(30),
        },
        Scenario {
            id: "steady-60",
            label: "Steady 60 Hz",
            deltas: steady(60),
        },
        Scenario {
            id: "steady-120",
            label: "Steady 120 Hz",
            deltas: steady(120),
        },
        Scenario {
            id: "uneven",
            label: "Uneven with hitches",
            deltas: uneven(),
        },
    ]
}

fn keyframe<T>(time: f32, value: T) -> Keyframe<T> {
    Keyframe { time, value }
}

fn z_turn(angle: f32) -> Quat {
    Quat::from_axis_angle(Vec3::new(0.0, 0.0, 1.0), angle).expect("axis is valid")
}

/// The clip every playback policy plays: an arc with a quarter-plus turn.
pub fn sweep_clip() -> AnimationClip {
    let translation = KeyframeTrack::new(
        vec![
            keyframe(0.0, Vec3::new(-1.4, -0.4, 0.0)),
            keyframe(0.75, Vec3::new(0.0, 0.7, 0.0)),
            keyframe(1.5, Vec3::new(1.4, -0.4, 0.0)),
        ],
        Interpolation::Linear,
    )
    .expect("sweep translation is valid");
    let rotation = KeyframeTrack::new(
        vec![keyframe(0.0, Quat::IDENTITY), keyframe(1.5, z_turn(-2.4))],
        Interpolation::Linear,
    )
    .expect("sweep rotation is valid");
    AnimationClip::new(
        "sweep",
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
    .expect("sweep clip is valid")
}

/// The clip a cross-fade blends toward: a looping bob with its own turn.
pub fn bob_clip() -> AnimationClip {
    let translation = KeyframeTrack::new(
        vec![
            keyframe(0.0, Vec3::new(0.0, -0.9, 0.3)),
            keyframe(0.4, Vec3::new(0.3, 0.2, 0.0)),
            keyframe(0.8, Vec3::new(0.0, -0.9, 0.3)),
        ],
        Interpolation::SmoothStep,
    )
    .expect("bob translation is valid");
    let rotation = KeyframeTrack::new(
        vec![
            keyframe(0.0, z_turn(0.6)),
            keyframe(0.4, z_turn(1.5)),
            keyframe(0.8, z_turn(0.6)),
        ],
        Interpolation::Linear,
    )
    .expect("bob rotation is valid");
    AnimationClip::new(
        "bob",
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
    .expect("bob clip is valid")
    .with_loop_mode(LoopMode::Repeat)
}

pub const POLICIES: [(PlaybackMode, PlaybackDirection); 4] = [
    (PlaybackMode::Clamp, PlaybackDirection::Forward),
    (PlaybackMode::Loop, PlaybackDirection::Forward),
    (PlaybackMode::Clamp, PlaybackDirection::Reverse),
    (PlaybackMode::Loop, PlaybackDirection::Reverse),
];
pub const CURVES: [TransitionCurve; 2] = [TransitionCurve::Linear, TransitionCurve::SmoothStep];

pub fn mode_id(mode: PlaybackMode) -> &'static str {
    match mode {
        PlaybackMode::Clamp => "clamp",
        PlaybackMode::Loop => "loop",
    }
}

pub fn direction_id(direction: PlaybackDirection) -> &'static str {
    match direction {
        PlaybackDirection::Forward => "forward",
        PlaybackDirection::Reverse => "reverse",
    }
}

pub fn curve_id(curve: TransitionCurve) -> &'static str {
    match curve {
        TransitionCurve::Linear => "linear",
        TransitionCurve::SmoothStep => "smoothstep",
    }
}

fn round(value: f64) -> f64 {
    let rounded = (value * DECIMALS).round() / DECIMALS;
    if rounded == 0.0 { 0.0 } else { rounded }
}

fn push_pose(target: &mut Vec<f64>, pose: Transform) {
    let Transform {
        translation,
        rotation,
        ..
    } = pose;
    target.extend(
        [
            translation.x,
            translation.y,
            translation.z,
            rotation.x,
            rotation.y,
            rotation.z,
            rotation.w,
        ]
        .map(|value| round(f64::from(value))),
    );
}

fn rounded(values: &[f32]) -> Vec<f64> {
    values
        .iter()
        .map(|value| round(f64::from(*value)))
        .collect()
}

/// Per-frame state of one clock run. Index 0 is the state before any delta.
pub struct PlaybackRun {
    pub clip_time: Vec<f32>,
    pub poses: Vec<Transform>,
}

pub fn run_playback(clip: &AnimationClip, start: PlaybackClock, deltas: &[f64]) -> PlaybackRun {
    let mut clock = start;
    let mut pose = [Transform::IDENTITY];
    let mut run = PlaybackRun {
        clip_time: Vec::with_capacity(deltas.len() + 1),
        poses: Vec::with_capacity(deltas.len() + 1),
    };
    for delta in std::iter::once(None).chain(deltas.iter().map(Some)) {
        if let Some(delta) = delta {
            clock.advance(*delta).expect("evidence deltas are valid");
        }
        clock.sample(clip, &mut pose).expect("clip targets node 0");
        run.clip_time.push(clock.clip_time());
        run.poses.push(pose[0]);
    }
    run
}

pub struct CrossFadeRun {
    pub from_time: Vec<f32>,
    pub to_time: Vec<f32>,
    pub progress: Vec<f32>,
    pub weight: Vec<f32>,
    pub poses: Vec<Transform>,
}

pub fn start_crossfade(transition_seconds: f32, curve: TransitionCurve) -> CrossFade {
    let from = PlaybackClock::new(sweep_clip().duration(), PlaybackMode::Loop)
        .expect("sweep duration is valid");
    let to = PlaybackClock::from_clip(&bob_clip())
        .expect("bob duration is valid")
        .with_speed(TARGET_SPEED)
        .expect("speed is valid");
    let transition = TransitionClock::new(transition_seconds, curve).expect("duration is valid");
    CrossFade::new(from, to, transition)
}

pub fn run_crossfade(start: CrossFade, deltas: &[f64]) -> CrossFadeRun {
    let (sweep, bob) = (sweep_clip(), bob_clip());
    let mut fade = start;
    let mut workspace = ClipBlendWorkspace::new(1);
    let mut pose = [Transform::IDENTITY];
    let capacity = deltas.len() + 1;
    let mut run = CrossFadeRun {
        from_time: Vec::with_capacity(capacity),
        to_time: Vec::with_capacity(capacity),
        progress: Vec::with_capacity(capacity),
        weight: Vec::with_capacity(capacity),
        poses: Vec::with_capacity(capacity),
    };
    for delta in std::iter::once(None).chain(deltas.iter().map(Some)) {
        let frame = match delta {
            Some(delta) => fade.advance(*delta).expect("evidence deltas are valid"),
            None => fade.frame(),
        };
        fade.sample(
            &sweep,
            &bob,
            &mut workspace,
            &[Transform::IDENTITY],
            &mut pose,
        )
        .expect("cross-fade inputs are valid");
        run.from_time.push(frame.from_time);
        run.to_time.push(frame.to_time);
        run.progress.push(frame.progress);
        run.weight.push(frame.weight);
        run.poses.push(pose[0]);
    }
    run
}

fn poses_json(poses: &[Transform]) -> Vec<f64> {
    let mut flat = Vec::with_capacity(poses.len() * 7);
    for pose in poses {
        push_pose(&mut flat, *pose);
    }
    flat
}

fn naive_deltas(deltas: &[f64]) -> Vec<f64> {
    vec![NAIVE_FRAME_SECONDS; deltas.len()]
}

pub fn evidence() -> Value {
    let sweep = sweep_clip();
    let scenarios = scenarios();

    let scenario_json = scenarios
        .iter()
        .map(|scenario| {
            let mut wall = 0.0;
            let wall_time = std::iter::once(0.0)
                .chain(scenario.deltas.iter().map(|delta| {
                    wall += delta;
                    round(wall)
                }))
                .collect::<Vec<_>>();
            json!({
                "id": scenario.id,
                "label": scenario.label,
                "deltaSeconds": scenario.deltas.iter().map(|delta| round(*delta)).collect::<Vec<_>>(),
                "wallSeconds": wall_time,
            })
        })
        .collect::<Vec<_>>();

    let mut playback = Vec::new();
    for scenario in &scenarios {
        for (mode, direction) in POLICIES {
            let start = PlaybackClock::new(sweep.duration(), mode)
                .expect("sweep duration is valid")
                .with_direction(direction);
            let correct = run_playback(&sweep, start, &scenario.deltas);
            let naive = run_playback(&sweep, start, &naive_deltas(&scenario.deltas));
            playback.push(json!({
                "scenario": scenario.id,
                "mode": mode_id(mode),
                "direction": direction_id(direction),
                "clipTime": rounded(&correct.clip_time),
                "pose": poses_json(&correct.poses),
                "fixedStep": {
                    "clipTime": rounded(&naive.clip_time),
                    "pose": poses_json(&naive.poses),
                },
            }));
        }
    }

    let mut cross_fades = Vec::new();
    for scenario in &scenarios {
        for transition_seconds in TRANSITION_SECONDS {
            for curve in CURVES {
                let start = start_crossfade(transition_seconds, curve);
                let correct = run_crossfade(start, &scenario.deltas);
                let naive = run_crossfade(start, &naive_deltas(&scenario.deltas));
                cross_fades.push(json!({
                    "scenario": scenario.id,
                    "transitionSeconds": round(f64::from(transition_seconds)),
                    "curve": curve_id(curve),
                    "fromTime": rounded(&correct.from_time),
                    "toTime": rounded(&correct.to_time),
                    "progress": rounded(&correct.progress),
                    "weight": rounded(&correct.weight),
                    "pose": poses_json(&correct.poses),
                    "fixedStep": {
                        "progress": rounded(&naive.progress),
                        "weight": rounded(&naive.weight),
                        "pose": poses_json(&naive.poses),
                    },
                }));
            }
        }
    }

    let bob = bob_clip();
    json!({
        "schema": SCHEMA,
        "generator": "three-d-playback/examples/playback_timing_evidence.rs",
        "wallSeconds": WALL_SECONDS,
        "fixedStepSeconds": round(NAIVE_FRAME_SECONDS),
        "boundaryEpsilonCycles": BOUNDARY_EPSILON_CYCLES,
        "poseLayout": ["tx", "ty", "tz", "qx", "qy", "qz", "qw"],
        "clips": [
            { "name": sweep.name(), "durationSeconds": round(f64::from(sweep.duration())), "loopMode": "clamp" },
            { "name": bob.name(), "durationSeconds": round(f64::from(bob.duration())), "loopMode": "repeat" },
        ],
        "crossFadeSetup": {
            "from": { "clip": sweep.name(), "mode": "loop", "speed": 1.0 },
            "to": { "clip": bob.name(), "mode": "loop", "speed": TARGET_SPEED },
        },
        "scenarios": scenario_json,
        "playback": playback,
        "crossFades": cross_fades,
    })
}

pub fn evidence_text() -> String {
    let mut text = serde_json::to_string(&evidence()).expect("evidence serializes");
    text.push('\n');
    text
}

fn first_drift(committed: &Value, current: &Value, path: &str) -> Option<String> {
    match (committed, current) {
        (Value::Number(left), Value::Number(right)) => {
            let (left, right) = (left.as_f64()?, right.as_f64()?);
            ((left - right).abs() > DRIFT_TOLERANCE)
                .then(|| format!("{path}: committed {left}, current {right}"))
        }
        (Value::Array(left), Value::Array(right)) => {
            if left.len() != right.len() {
                return Some(format!(
                    "{path}: committed {} entries, current {}",
                    left.len(),
                    right.len()
                ));
            }
            left.iter()
                .zip(right)
                .enumerate()
                .find_map(|(index, (left, right))| {
                    first_drift(left, right, &format!("{path}[{index}]"))
                })
        }
        (Value::Object(left), Value::Object(right)) => {
            if !left.keys().eq(right.keys()) {
                return Some(format!("{path}: keys differ"));
            }
            left.iter()
                .find_map(|(key, value)| first_drift(value, &right[key], &format!("{path}.{key}")))
        }
        _ => (committed != current).then(|| format!("{path}: {committed} != {current}")),
    }
}

/// The first place the committed fixture disagrees with freshly generated
/// evidence beyond [`DRIFT_TOLERANCE`], or `None` when it is current.
pub fn drift(committed_text: &str) -> Option<String> {
    let committed: Value = match serde_json::from_str(committed_text) {
        Ok(value) => value,
        Err(error) => return Some(format!("committed evidence is not JSON: {error}")),
    };
    first_drift(&committed, &evidence(), "$")
}

pub fn fixture_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/playback/playback-timing.json")
}

#[allow(dead_code)]
fn main() {
    let path = fixture_path();
    let text = evidence_text();
    if std::env::args().any(|arg| arg == "--check") {
        let committed = std::fs::read_to_string(&path).expect("committed evidence is readable");
        if let Some(difference) = drift(&committed) {
            panic!(
                "{} drifted from three-d-playback ({difference}); rerun the example without --check",
                path.display()
            );
        }
        return;
    }
    std::fs::create_dir_all(path.parent().expect("fixture has a parent"))
        .expect("fixture directory is writable");
    std::fs::write(&path, text).expect("fixture is writable");
    println!("wrote {}", path.display());
}
