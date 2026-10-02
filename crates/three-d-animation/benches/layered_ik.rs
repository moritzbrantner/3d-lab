use std::hint::black_box;
use std::time::Instant;

use three_d_animation::ik::{
    IkGoal, IkLayer, IkRig, IkWorkspace, LimbGoal, LookAtChain, LookAtGoal, TwoBoneChain,
};
use three_d_animation::{Quat, Transform};
use three_d_core::Vec3;

const CHARACTERS: usize = 64;
const FRAMES: usize = 2_000;

/// root, hips, two legs, spine, chest, neck, head, two arms.
const PARENTS: [Option<usize>; 17] = [
    None,
    Some(0),
    Some(1),
    Some(2),
    Some(3),
    Some(1),
    Some(5),
    Some(6),
    Some(1),
    Some(8),
    Some(9),
    Some(10),
    Some(11),
    Some(10),
    Some(13),
    Some(14),
    Some(15),
];

fn translated(x: f32, y: f32, z: f32) -> Transform {
    Transform {
        translation: Vec3::new(x, y, z),
        ..Transform::IDENTITY
    }
}

fn base_pose() -> Vec<Transform> {
    vec![
        Transform::IDENTITY,
        translated(0.0, 1.0, 0.0),
        translated(0.1, 0.0, 0.0),
        translated(0.0, -0.45, 0.02),
        translated(0.0, -0.45, -0.02),
        translated(-0.1, 0.0, 0.0),
        translated(0.0, -0.45, 0.02),
        translated(0.0, -0.45, -0.02),
        translated(0.0, 0.2, 0.0),
        translated(0.0, 0.2, 0.0),
        translated(0.0, 0.2, 0.0),
        translated(0.0, 0.1, 0.0),
        translated(0.0, 0.1, 0.0),
        translated(0.2, 0.0, 0.0),
        translated(0.15, 0.0, 0.0),
        translated(0.28, 0.0, -0.01),
        translated(0.28, 0.0, 0.01),
    ]
}

fn main() {
    let rig = IkRig::new(PARENTS.to_vec()).unwrap();
    let left_leg = TwoBoneChain::new(&rig, 2, 3, 4).unwrap();
    let right_leg = TwoBoneChain::new(&rig, 5, 6, 7).unwrap();
    let arm = TwoBoneChain::new(&rig, 14, 15, 16).unwrap();
    let look = LookAtChain::new(
        &rig,
        &[(9, 0.3), (11, 0.5), (12, 1.0)],
        Vec3::new(0.0, 0.0, 1.0),
    )
    .unwrap();

    let mut bases: Vec<_> = (0..CHARACTERS).map(|_| base_pose()).collect();
    let mut outputs = vec![vec![Transform::IDENTITY; PARENTS.len()]; CHARACTERS];
    let mut workspaces: Vec<_> = (0..CHARACTERS)
        .map(|_| IkWorkspace::new(PARENTS.len()))
        .collect();
    let mut solves = 0usize;
    let mut world_nodes_updated = 0usize;
    let mut clamped_layers = 0usize;

    let started = Instant::now();
    for frame in 0..FRAMES {
        let phase = frame as f32 * 0.01;
        for character in 0..CHARACTERS {
            let offset = character as f32 * 0.37;
            bases[character][3].rotation =
                Quat::from_euler_xyz((phase + offset).sin() * 0.3, 0.0, 0.0);
            let ground = (phase + offset).sin() * 0.05;
            let layers = [
                IkLayer::new(
                    IkGoal::Limb(
                        LimbGoal::foot(
                            left_leg,
                            Vec3::new(0.1, 0.2 + ground, 0.05),
                            Vec3::new(0.05, 1.0, 0.0),
                            Vec3::new(0.0, 1.0, 0.0),
                        )
                        .with_pole(Vec3::new(0.1, 0.6, 1.0)),
                    ),
                    1.0,
                ),
                IkLayer::new(
                    IkGoal::Limb(
                        LimbGoal::foot(
                            right_leg,
                            Vec3::new(-0.1, 0.2 - ground, -0.05),
                            Vec3::new(-0.05, 1.0, 0.0),
                            Vec3::new(0.0, 1.0, 0.0),
                        )
                        .with_pole(Vec3::new(-0.1, 0.6, 1.0)),
                    ),
                    1.0,
                ),
                IkLayer::new(
                    IkGoal::LookAt(LookAtGoal {
                        chain: look,
                        target: Vec3::new((phase + offset).cos() * 2.0, 1.6, 2.0),
                        max_angle: 1.2,
                    }),
                    0.8,
                ),
                IkLayer::new(
                    IkGoal::Limb(LimbGoal::hand(
                        arm,
                        Vec3::new(0.45, 1.25 + ground, 0.3),
                        Some(Quat::from_euler_xyz(0.0, 0.0, -0.4)),
                    )),
                    0.6,
                ),
            ];
            let stats = workspaces[character]
                .solve(&rig, &bases[character], &layers, &mut outputs[character])
                .unwrap();
            solves += 1;
            world_nodes_updated += stats.world_nodes_updated;
            clamped_layers += stats.layers_clamped;
            black_box(&outputs[character]);
        }
    }
    let elapsed = started.elapsed();

    println!(
        "{{\"schema\":\"three-d-animation/layered-ik/v1\",\"characters\":{CHARACTERS},\"frames\":{FRAMES},\"nodesPerCharacter\":{},\"layersPerCharacter\":4,\"solves\":{solves},\"worldNodesUpdated\":{world_nodes_updated},\"clampedLayers\":{clamped_layers},\"elapsedNs\":{},\"nsPerCharacterSolve\":{:.3},\"nsPerFrameAllCharacters\":{:.3}}}",
        PARENTS.len(),
        elapsed.as_nanos(),
        elapsed.as_nanos() as f64 / solves as f64,
        elapsed.as_nanos() as f64 / FRAMES as f64,
    );
}
