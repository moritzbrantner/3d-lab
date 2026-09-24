use std::hint::black_box;
use std::time::Instant;

use three_d_animation::retarget::{
    HumanoidBinding, HumanoidBone, HumanoidRig, retarget_pose,
};
use three_d_animation::{Quat, Transform};
use three_d_core::Vec3;

const SAMPLES: usize = 1_000_000;

const BONES: [HumanoidBone; 11] = [
    HumanoidBone::Hips,
    HumanoidBone::Spine,
    HumanoidBone::Head,
    HumanoidBone::LeftUpperArm,
    HumanoidBone::LeftLowerArm,
    HumanoidBone::RightUpperArm,
    HumanoidBone::RightLowerArm,
    HumanoidBone::LeftUpperLeg,
    HumanoidBone::LeftLowerLeg,
    HumanoidBone::RightUpperLeg,
    HumanoidBone::RightLowerLeg,
];

fn rig(height: f32, bind_angle: f32) -> HumanoidRig {
    let bindings: Vec<_> = BONES
        .iter()
        .copied()
        .enumerate()
        .map(|(node, bone)| HumanoidBinding { bone, node })
        .collect();
    let mut rest = vec![Transform::IDENTITY; BONES.len()];
    for (node, transform) in rest.iter_mut().enumerate() {
        transform.translation = Vec3::new(0.0, node as f32 * height * 0.04, 0.0);
    }
    rest[3].rotation = Quat::from_euler_xyz(0.0, 0.0, bind_angle);
    HumanoidRig::new(rest, &bindings, height).unwrap()
}

fn main() {
    let source = rig(1.8, 0.25);
    let target = rig(2.1, -0.35);
    let mut source_pose = source.rest_pose().to_vec();
    let mut output = target.rest_pose().to_vec();
    let pointer = output.as_ptr();

    let started = Instant::now();
    for sample in 0..SAMPLES {
        let phase = sample as f32 * 0.001;
        source_pose[0].translation.x = phase.sin() * 0.25;
        source_pose[3].rotation = Quat::from_euler_xyz(0.0, 0.0, 0.25 + phase.sin() * 0.7);
        retarget_pose(&source, &source_pose, &target, &mut output).unwrap();
        black_box(output[sample % output.len()]);
    }
    let elapsed = started.elapsed();
    assert_eq!(output.as_ptr(), pointer);

    println!(
        "{{\"schema\":\"three-d-animation/retargeting/v1\",\"mappedBones\":{},\"samples\":{SAMPLES},\"elapsedNs\":{},\"nsPerSample\":{:.3},\"outputStorageReused\":true}}",
        BONES.len(),
        elapsed.as_nanos(),
        elapsed.as_nanos() as f64 / SAMPLES as f64,
    );
}
