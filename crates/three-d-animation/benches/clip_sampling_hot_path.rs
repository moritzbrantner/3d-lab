//! Reference vs compiled vs quantized clip sampling for one character and a
//! crowd. Prints raw JSON evidence only; there is deliberately no timing gate.

use std::hint::black_box;
use std::time::{Duration, Instant};

use three_d_animation::sampling::{CompiledClip, QuantizationBudget, QuantizedClip};
use three_d_animation::{
    AnimationClip, AnimationTrack, Interpolation, Keyframe, KeyframeTrack, LoopMode, Quat,
    Transform,
};
use three_d_core::Vec3;

const NODE_COUNT: usize = 64;
/// Keys per track: 30 fps over a 2 s loop.
const KEYS_PER_TRACK: usize = 61;
const KEY_RATE: f32 = 30.0;
const SINGLE_SAMPLES: usize = 100_000;
const CROWD_SIZE: usize = 256;
const CROWD_FRAMES: usize = 400;
const FRAME_DT: f32 = 1.0 / 60.0;
const BUDGET: QuantizationBudget = QuantizationBudget::new(1.0e-3, 1.0e-3, 1.0e-3);

fn clip(name: &str, scale: f32) -> AnimationClip {
    let times = (0..KEYS_PER_TRACK).map(|key| key as f32 / KEY_RATE);
    let mut tracks = Vec::with_capacity(NODE_COUNT * 2 + 1);
    for node in 0..NODE_COUNT {
        let phase = node as f32 * 0.37;
        tracks.push(AnimationTrack::Translation {
            node,
            track: KeyframeTrack::new(
                times
                    .clone()
                    .map(|time| Keyframe {
                        time,
                        value: Vec3::new(
                            0.2 * scale * (time * 3.1 + phase).sin(),
                            0.05 * (time * 6.2 + phase).cos(),
                            0.0,
                        ),
                    })
                    .collect(),
                Interpolation::Linear,
            )
            .unwrap(),
        });
        tracks.push(AnimationTrack::Rotation {
            node,
            track: KeyframeTrack::new(
                times
                    .clone()
                    .map(|time| Keyframe {
                        time,
                        value: Quat::from_euler_xyz(
                            0.4 * scale * (time * 3.1 + phase).sin(),
                            0.2 * (time * 1.7 + phase).cos(),
                            0.1 * (time * 2.3).sin(),
                        ),
                    })
                    .collect(),
                Interpolation::Linear,
            )
            .unwrap(),
        });
    }
    tracks.push(AnimationTrack::Scale {
        node: 0,
        track: KeyframeTrack::new(
            times
                .map(|time| Keyframe {
                    time,
                    value: Vec3::new(1.0, 1.0 + 0.02 * (time * 6.2).sin(), 1.0),
                })
                .collect(),
            Interpolation::Linear,
        )
        .unwrap(),
    });
    AnimationClip::new(name, tracks)
        .unwrap()
        .with_loop_mode(LoopMode::Repeat)
}

fn per_sample(duration: Duration, samples: usize) -> f64 {
    duration.as_nanos() as f64 / samples as f64
}

fn main() {
    let walk = clip("walk", 1.0);
    let run = clip("run", 1.8);
    let clips = [&walk, &run];
    let compiled = clips.map(|clip| CompiledClip::compile(clip, NODE_COUNT).unwrap());
    let quantized = clips.map(|clip| QuantizedClip::compress(clip, NODE_COUNT, BUDGET).unwrap());

    // One character, monotonic playback.
    let time_at = |sample: usize| sample as f32 * FRAME_DT * 0.7;
    let mut pose = vec![Transform::IDENTITY; NODE_COUNT];
    let pose_ptr = pose.as_ptr();

    let start = Instant::now();
    for sample in 0..SINGLE_SAMPLES {
        walk.sample(time_at(sample), &mut pose).unwrap();
        black_box(pose[sample % NODE_COUNT]);
    }
    let single_reference = start.elapsed();

    let start = Instant::now();
    for sample in 0..SINGLE_SAMPLES {
        compiled[0].sample(time_at(sample), &mut pose).unwrap();
        black_box(pose[sample % NODE_COUNT]);
    }
    let single_compiled = start.elapsed();

    let mut cursor = compiled[0].cursor();
    let start = Instant::now();
    for sample in 0..SINGLE_SAMPLES {
        compiled[0]
            .sample_with_cursor(time_at(sample), &mut cursor, &mut pose)
            .unwrap();
        black_box(pose[sample % NODE_COUNT]);
    }
    let single_cursor = start.elapsed();

    let mut cursor = quantized[0].cursor();
    let start = Instant::now();
    for sample in 0..SINGLE_SAMPLES {
        quantized[0]
            .sample_with_cursor(time_at(sample), &mut cursor, &mut pose)
            .unwrap();
        black_box(pose[sample % NODE_COUNT]);
    }
    let single_quantized = start.elapsed();
    assert_eq!(pose.as_ptr(), pose_ptr);

    // Crowd: every character has its own pose and cursor, clips are shared,
    // phases and playback rates are staggered.
    let phase = |character: usize| character as f32 * 0.173;
    let rate = |character: usize| 0.8 + (character % 7) as f32 * 0.07;
    let crowd_time = |frame: usize, character: usize| {
        phase(character) + frame as f32 * FRAME_DT * rate(character)
    };
    let mut poses = vec![vec![Transform::IDENTITY; NODE_COUNT]; CROWD_SIZE];
    let pose_ptrs: Vec<_> = poses.iter().map(|pose| pose.as_ptr()).collect();
    let crowd_samples = CROWD_SIZE * CROWD_FRAMES;

    let start = Instant::now();
    for frame in 0..CROWD_FRAMES {
        for (character, pose) in poses.iter_mut().enumerate() {
            clips[character % 2]
                .sample(crowd_time(frame, character), pose)
                .unwrap();
        }
        black_box(&poses[frame % CROWD_SIZE][frame % NODE_COUNT]);
    }
    let crowd_reference = start.elapsed();

    let mut cursors: Vec<_> = (0..CROWD_SIZE)
        .map(|character| compiled[character % 2].cursor())
        .collect();
    let start = Instant::now();
    for frame in 0..CROWD_FRAMES {
        for (character, (pose, cursor)) in poses.iter_mut().zip(&mut cursors).enumerate() {
            compiled[character % 2]
                .sample_with_cursor(crowd_time(frame, character), cursor, pose)
                .unwrap();
        }
        black_box(&poses[frame % CROWD_SIZE][frame % NODE_COUNT]);
    }
    let crowd_cursor = start.elapsed();

    let mut cursors: Vec<_> = (0..CROWD_SIZE)
        .map(|character| quantized[character % 2].cursor())
        .collect();
    let start = Instant::now();
    for frame in 0..CROWD_FRAMES {
        for (character, (pose, cursor)) in poses.iter_mut().zip(&mut cursors).enumerate() {
            quantized[character % 2]
                .sample_with_cursor(crowd_time(frame, character), cursor, pose)
                .unwrap();
        }
        black_box(&poses[frame % CROWD_SIZE][frame % NODE_COUNT]);
    }
    let crowd_quantized = start.elapsed();
    assert!(
        poses
            .iter()
            .zip(&pose_ptrs)
            .all(|(pose, ptr)| pose.as_ptr() == *ptr)
    );

    let measured = quantized[0].measured_error();
    println!(
        "{{\"schema\":\"three-d-animation/clip-sampling-hot-path/v1\",\"nodes\":{NODE_COUNT},\"tracksPerClip\":{},\"keysPerTrack\":{KEYS_PER_TRACK},\
\"single\":{{\"samples\":{SINGLE_SAMPLES},\"referenceNs\":{},\"referenceNsPerSample\":{:.3},\"compiledNs\":{},\"compiledNsPerSample\":{:.3},\"compiledCursorNs\":{},\"compiledCursorNsPerSample\":{:.3},\"quantizedCursorNs\":{},\"quantizedCursorNsPerSample\":{:.3}}},\
\"crowd\":{{\"characters\":{CROWD_SIZE},\"frames\":{CROWD_FRAMES},\"samples\":{crowd_samples},\"referenceNs\":{},\"referenceNsPerCharacterFrame\":{:.3},\"compiledCursorNs\":{},\"compiledCursorNsPerCharacterFrame\":{:.3},\"quantizedCursorNs\":{},\"quantizedCursorNsPerCharacterFrame\":{:.3}}},\
\"storage\":{{\"compiledKeyBytes\":{},\"quantizedKeyBytes\":{}}},\
\"quantization\":{{\"budgetTranslation\":{},\"budgetRotationRadians\":{},\"budgetScale\":{},\"measuredTranslation\":{:e},\"measuredRotationRadians\":{:e},\"measuredScale\":{:e}}},\
\"poseStorageReused\":true}}",
        walk.tracks().len(),
        single_reference.as_nanos(),
        per_sample(single_reference, SINGLE_SAMPLES),
        single_compiled.as_nanos(),
        per_sample(single_compiled, SINGLE_SAMPLES),
        single_cursor.as_nanos(),
        per_sample(single_cursor, SINGLE_SAMPLES),
        single_quantized.as_nanos(),
        per_sample(single_quantized, SINGLE_SAMPLES),
        crowd_reference.as_nanos(),
        per_sample(crowd_reference, crowd_samples),
        crowd_cursor.as_nanos(),
        per_sample(crowd_cursor, crowd_samples),
        crowd_quantized.as_nanos(),
        per_sample(crowd_quantized, crowd_samples),
        compiled[0].key_storage_bytes(),
        quantized[0].key_storage_bytes(),
        BUDGET.translation,
        BUDGET.rotation_radians,
        BUDGET.scale,
        measured.translation,
        measured.rotation_radians,
        measured.scale,
    );
}
