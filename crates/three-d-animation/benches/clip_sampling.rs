use std::hint::black_box;
use std::time::Instant;

use three_d_animation::{
    AnimationClip, AnimationTrack, ClipBlendWorkspace, ClipSample, Interpolation, Keyframe,
    KeyframeTrack, LoopMode, PoseBuffer, Quat, Transform,
};
use three_d_core::Vec3;

const NODE_COUNT: usize = 64;
const SAMPLES: usize = 500_000;

fn vec3_track(values: [(f32, Vec3); 4]) -> KeyframeTrack<Vec3> {
    KeyframeTrack::new(
        values
            .into_iter()
            .map(|(time, value)| Keyframe { time, value })
            .collect(),
        Interpolation::Linear,
    )
    .unwrap()
}

fn quat_track(values: [(f32, Quat); 4]) -> KeyframeTrack<Quat> {
    KeyframeTrack::new(
        values
            .into_iter()
            .map(|(time, value)| Keyframe { time, value })
            .collect(),
        Interpolation::Linear,
    )
    .unwrap()
}

fn clip(name: &str, scale: f32) -> AnimationClip {
    let mut tracks = Vec::with_capacity(NODE_COUNT * 2);
    for node in 0..NODE_COUNT {
        let phase = node as f32 * 0.01;
        tracks.push(AnimationTrack::Translation {
            node,
            track: vec3_track([
                (0.0, Vec3::new(0.0, phase, 0.0)),
                (0.5, Vec3::new(0.2 * scale, phase + 0.1, 0.0)),
                (1.0, Vec3::new(0.4 * scale, phase, 0.0)),
                (1.5, Vec3::new(0.0, phase, 0.0)),
            ]),
        });
        tracks.push(AnimationTrack::Rotation {
            node,
            track: quat_track([
                (0.0, Quat::IDENTITY),
                (0.5, Quat::from_euler_xyz(0.1 * scale, phase, 0.0)),
                (1.0, Quat::from_euler_xyz(-0.1 * scale, phase * 0.5, 0.05)),
                (1.5, Quat::IDENTITY),
            ]),
        });
    }
    AnimationClip::new(name, tracks)
        .unwrap()
        .with_loop_mode(LoopMode::Repeat)
}

fn main() {
    let left = clip("walk", 1.0);
    let right = clip("run", 1.8);
    let base = vec![Transform::IDENTITY; NODE_COUNT];

    let mut pose = PoseBuffer::from_pose(&base);
    let pose_ptr = pose.as_slice().as_ptr();
    let single_start = Instant::now();
    for sample in 0..SAMPLES {
        let time = sample as f32 * 0.00037;
        left.sample(time, pose.as_mut_slice()).unwrap();
        black_box(pose.as_slice()[sample % NODE_COUNT]);
    }
    let single = single_start.elapsed();
    assert_eq!(pose.as_slice().as_ptr(), pose_ptr);

    let mut output = vec![Transform::IDENTITY; NODE_COUNT];
    let output_ptr = output.as_ptr();
    let mut workspace = ClipBlendWorkspace::new(NODE_COUNT);
    let blend_start = Instant::now();
    for sample in 0..SAMPLES {
        let time = sample as f32 * 0.00037;
        let weight = (sample % 101) as f32 / 100.0;
        workspace
            .sample_crossfade(
                ClipSample { clip: &left, time },
                ClipSample {
                    clip: &right,
                    time: time * 1.07,
                },
                weight,
                &base,
                &mut output,
            )
            .unwrap();
        black_box(output[sample % NODE_COUNT]);
    }
    let blend = blend_start.elapsed();
    assert_eq!(output.as_ptr(), output_ptr);

    println!(
        "{{\"schema\":\"three-d-animation/clip-sampling/v1\",\"nodes\":{NODE_COUNT},\"tracksPerClip\":{},\"samples\":{SAMPLES},\"singleClipNs\":{},\"singleClipNsPerSample\":{:.3},\"crossfadeNs\":{},\"crossfadeNsPerSample\":{:.3},\"poseStorageReused\":true}}",
        left.tracks().len(),
        single.as_nanos(),
        single.as_nanos() as f64 / SAMPLES as f64,
        blend.as_nanos(),
        blend.as_nanos() as f64 / SAMPLES as f64,
    );
}
