use std::hint::black_box;
use std::time::Instant;

use three_d_animation::ik::{
    LookAtLimits, TwoBoneChain, TwoBoneTarget, apply_pose_layer, solve_look_at, solve_two_bone,
};
use three_d_animation::Transform;
use three_d_core::Vec3;

const CHARACTERS: usize = 100;
const FRAMES: usize = 10_000;

fn main() {
    let chain = TwoBoneChain {
        upper_length: 0.72,
        lower_length: 0.68,
    };
    let base = vec![Transform::IDENTITY; 17];
    let mut layer = base.clone();
    let weights = vec![0.75; 17];
    let mut output = base.clone();
    let output_ptr = output.as_ptr();

    let started = Instant::now();
    for frame in 0..FRAMES {
        let phase = frame as f32 * 0.01;
        for character in 0..CHARACTERS {
            let offset = character as f32 * 0.03;
            let hand = solve_two_bone(
                chain,
                TwoBoneTarget {
                    root: Vec3::new(offset, 1.4, 0.0),
                    target: Vec3::new(offset + phase.sin(), 1.1 + phase.cos() * 0.2, 0.25),
                    pole: Vec3::new(offset, 1.4, 1.0),
                },
            )
            .unwrap();
            let look = solve_look_at(
                Vec3::new(offset, 1.8, 0.0),
                Vec3::new(offset + 1.0, 1.9, 2.0),
                LookAtLimits {
                    max_yaw_radians: 1.0,
                    max_pitch_radians: 0.6,
                },
            )
            .unwrap();
            layer[0].translation = hand.end;
            layer[1].translation = Vec3::new(look.yaw_radians, look.pitch_radians, 0.0);
            apply_pose_layer(&base, &layer, &weights, &mut output).unwrap();
            black_box(output[character % output.len()]);
        }
    }
    let elapsed = started.elapsed();
    assert_eq!(output.as_ptr(), output_ptr);
    let solves = CHARACTERS * FRAMES;

    println!(
        "{{\"schema\":\"three-d-animation/ik-layering/v1\",\"characters\":{CHARACTERS},\"frames\":{FRAMES},\"solves\":{solves},\"elapsedNs\":{},\"nsPerCharacterFrame\":{:.3},\"iterationsPerTwoBoneSolve\":0,\"outputStorageReused\":true}}",
        elapsed.as_nanos(),
        elapsed.as_nanos() as f64 / solves as f64,
    );
}
