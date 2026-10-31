use super::math::{angle_between, position, rotate};
use super::*;
use crate::retarget::quat_conjugate;
use crate::{
    AnimationClip, AnimationTrack, Interpolation, Keyframe, KeyframeTrack, Quat, Transform,
};
use core::f32::consts::{FRAC_PI_2, PI};
use three_d_core::Vec3;

const TOLERANCE: f32 = 1.0e-3;

fn quat_angle(a: Quat, b: Quat) -> f32 {
    let a = a.normalized().unwrap();
    let b = b.normalized().unwrap();
    2.0 * a.dot(b).abs().min(1.0).acos()
}

/// hips(0) → upper leg(1) → lower leg(2) → foot(3); spine(4) → head(5);
/// upper arm(6) → lower arm(7) → hand(8) under the spine.
fn rig() -> IkRig {
    IkRig::new(vec![
        None,
        Some(0),
        Some(1),
        Some(2),
        Some(0),
        Some(4),
        Some(4),
        Some(6),
        Some(7),
    ])
    .unwrap()
}

fn translated(x: f32, y: f32, z: f32) -> Transform {
    Transform {
        translation: Vec3::new(x, y, z),
        ..Transform::IDENTITY
    }
}

/// Leg hangs down from y = 1 with a slight forward knee bend; arm points
/// along +x from the spine.
fn base_pose() -> Vec<Transform> {
    vec![
        translated(0.0, 1.0, 0.0),
        translated(0.1, 0.0, 0.0),
        translated(0.0, -0.5, 0.02),
        translated(0.0, -0.5, -0.02),
        translated(0.0, 0.3, 0.0),
        translated(0.0, 0.3, 0.0),
        translated(0.2, 0.2, 0.0),
        translated(0.3, 0.0, -0.01),
        translated(0.3, 0.0, 0.01),
    ]
}

fn leg(rig: &IkRig) -> TwoBoneChain {
    TwoBoneChain::new(rig, 1, 2, 3).unwrap()
}

fn arm(rig: &IkRig) -> TwoBoneChain {
    TwoBoneChain::new(rig, 6, 7, 8).unwrap()
}

fn assert_close(actual: Vec3, expected: Vec3) {
    assert!(
        (actual - expected).length() < TOLERANCE,
        "{actual:?} != {expected:?}"
    );
}

fn solve(layers: &[IkLayer<'_>]) -> (IkWorkspace, Vec<Transform>, IkSolveStats) {
    let rig = rig();
    let base = base_pose();
    let mut workspace = IkWorkspace::new(rig.node_count());
    let mut output = vec![Transform::IDENTITY; rig.node_count()];
    let stats = workspace.solve(&rig, &base, layers, &mut output).unwrap();
    (workspace, output, stats)
}

fn bone_lengths(workspace: &IkWorkspace, chain: TwoBoneChain) -> (f32, f32) {
    let a = workspace.world_position(chain.root).unwrap();
    let b = workspace.world_position(chain.mid).unwrap();
    let c = workspace.world_position(chain.tip).unwrap();
    ((b - a).length(), (c - b).length())
}

#[test]
fn reachable_foot_target_is_reached_with_bone_lengths_preserved() {
    let rig = rig();
    let target = Vec3::new(0.25, 0.3, 0.2);
    let goal = LimbGoal::new(leg(&rig), target);
    let (workspace, _, stats) = solve(&[IkLayer::new(IkGoal::Limb(goal), 1.0)]);

    assert_close(workspace.world_position(3).unwrap(), target);
    let (upper, lower) = bone_lengths(&workspace, leg(&rig));
    assert!((upper - 0.5004).abs() < TOLERANCE);
    assert!((lower - 0.5004).abs() < TOLERANCE);
    assert_eq!(workspace.outcomes()[0].status, IkStatus::Reached);
    assert!(workspace.outcomes()[0].residual < TOLERANCE);
    assert_eq!(stats.layers_applied, 1);
}

#[test]
fn unreachable_target_extends_toward_target_and_reports_clamped() {
    let rig = rig();
    let target = Vec3::new(0.1, -2.0, 0.0);
    let goal = LimbGoal::new(leg(&rig), target);
    let (workspace, _, stats) = solve(&[IkLayer::new(IkGoal::Limb(goal), 1.0)]);

    let hip = workspace.world_position(1).unwrap();
    let foot = workspace.world_position(3).unwrap();
    let (upper, lower) = bone_lengths(&workspace, leg(&rig));
    assert!(((foot - hip).length() - (upper + lower)).abs() < TOLERANCE);
    let toward = (target - hip).normalized().unwrap();
    assert_close((foot - hip).normalized().unwrap(), toward);
    assert_eq!(workspace.outcomes()[0].status, IkStatus::Clamped);
    assert!((workspace.outcomes()[0].residual - (2.0 + 1.0 - upper - lower)).abs() < 1.0e-2);
    assert_eq!(stats.layers_clamped, 1);
}

#[test]
fn target_inside_minimum_reach_is_clamped() {
    let rig = rig();
    let chain = TwoBoneChain::new(&rig, 6, 7, 8).unwrap();
    // Upper and lower arm are equal, so the only unreachable inner target
    // is the shoulder itself.
    let shoulder = Vec3::new(0.2, 1.5, 0.0);
    let goal = LimbGoal::new(chain, shoulder);
    let (workspace, _, _) = solve(&[IkLayer::new(IkGoal::Limb(goal), 1.0)]);
    assert_eq!(workspace.outcomes()[0].status, IkStatus::Clamped);
}

#[test]
fn max_reach_softens_full_extension() {
    let rig = rig();
    let target = Vec3::new(0.1, -2.0, 0.0);
    let goal = LimbGoal::new(leg(&rig), target).with_max_reach(0.9);
    let (workspace, _, _) = solve(&[IkLayer::new(IkGoal::Limb(goal), 1.0)]);
    let hip = workspace.world_position(1).unwrap();
    let foot = workspace.world_position(3).unwrap();
    let (upper, lower) = bone_lengths(&workspace, leg(&rig));
    assert!(((foot - hip).length() - 0.9 * (upper + lower)).abs() < TOLERANCE);
}

#[test]
fn max_reach_below_unequal_limb_minimum_is_rejected() {
    let rig = rig();
    let mut base = base_pose();
    // Upper leg ~0.5, lower leg 0.25: minimum reach fraction is ~1/3.
    base[3] = translated(0.0, -0.25, 0.0);
    let mut workspace = IkWorkspace::new(rig.node_count());
    let mut output = base.clone();
    let target = Vec3::new(0.1, 0.5, 0.0);

    let goal = LimbGoal::new(leg(&rig), target).with_max_reach(0.2);
    assert_eq!(
        workspace.solve(
            &rig,
            &base,
            &[IkLayer::new(IkGoal::Limb(goal), 1.0)],
            &mut output
        ),
        Err(IkError::ReachBelowMinimum { layer: 0 })
    );

    // A fraction above the minimum still solves within the reach interval.
    let goal = LimbGoal::new(leg(&rig), target).with_max_reach(0.5);
    workspace
        .solve(
            &rig,
            &base,
            &[IkLayer::new(IkGoal::Limb(goal), 1.0)],
            &mut output,
        )
        .unwrap();
    let (upper, lower) = bone_lengths(&workspace, leg(&rig));
    let reach =
        (workspace.world_position(3).unwrap() - workspace.world_position(1).unwrap()).length();
    assert!(reach + TOLERANCE >= (upper - lower).abs());
    assert!(reach <= 0.5 * (upper + lower) + TOLERANCE);
}

#[test]
fn pole_vector_selects_knee_bend_plane() {
    let rig = rig();
    let target = Vec3::new(0.1, 0.4, 0.0);
    for pole_z in [1.0, -1.0] {
        let goal = LimbGoal::new(leg(&rig), target).with_pole(Vec3::new(0.1, 0.7, pole_z));
        let (workspace, _, _) = solve(&[IkLayer::new(IkGoal::Limb(goal), 1.0)]);
        assert_close(workspace.world_position(3).unwrap(), target);
        let knee = workspace.world_position(2).unwrap();
        assert!(knee.z * pole_z > 0.1, "knee {knee:?} pole {pole_z}");
        assert!((knee.x - 0.1).abs() < TOLERANCE, "knee {knee:?}");
    }
}

#[test]
fn straight_rest_limb_bends_toward_pole() {
    let rig = rig();
    let mut base = base_pose();
    base[2] = translated(0.0, -0.5, 0.0);
    base[3] = translated(0.0, -0.5, 0.0);
    let target = Vec3::new(0.1, 0.4, 0.0);
    let goal = LimbGoal::new(leg(&rig), target).with_pole(Vec3::new(0.1, 0.7, 1.0));
    let mut workspace = IkWorkspace::new(rig.node_count());
    let mut output = base.clone();
    workspace
        .solve(
            &rig,
            &base,
            &[IkLayer::new(IkGoal::Limb(goal), 1.0)],
            &mut output,
        )
        .unwrap();
    assert_close(workspace.world_position(3).unwrap(), target);
    assert!(workspace.world_position(2).unwrap().z > 0.1);
}

#[test]
fn foot_aligns_up_axis_to_ground_normal() {
    let rig = rig();
    let normal = Vec3::new(0.3, 1.0, 0.0).normalized().unwrap();
    let contact = Vec3::new(0.1, 0.2, 0.1);
    let goal = LimbGoal::foot(leg(&rig), contact, normal, Vec3::new(0.0, 1.0, 0.0));
    let (workspace, _, _) = solve(&[IkLayer::new(IkGoal::Limb(goal), 1.0)]);
    assert_close(workspace.world_position(3).unwrap(), contact);
    let up = rotate(
        workspace.world_rotation(3).unwrap(),
        Vec3::new(0.0, 1.0, 0.0),
    );
    assert_close(up, normal);
}

#[test]
fn hand_reaches_target_with_exact_grip_orientation() {
    let rig = rig();
    let grip = Quat::from_euler_xyz(0.3, -0.4, 1.1);
    let target = Vec3::new(0.5, 1.9, 0.3);
    let goal = LimbGoal::hand(arm(&rig), target, Some(grip));
    let (workspace, _, _) = solve(&[IkLayer::new(IkGoal::Limb(goal), 1.0)]);
    assert_close(workspace.world_position(8).unwrap(), target);
    let actual = workspace.world_rotation(8).unwrap();
    assert!(actual.dot(grip).abs() > 1.0 - 1.0e-5, "{actual:?}");
}

#[test]
fn look_at_distributes_rotation_and_aims_head() {
    let rig = rig();
    let chain = LookAtChain::new(&rig, &[(4, 0.4), (5, 1.0)], Vec3::new(0.0, 0.0, 1.0)).unwrap();
    let target = Vec3::new(2.0, 1.6, 2.0);
    let goal = LookAtGoal {
        chain,
        target,
        max_angle: FRAC_PI_2,
    };
    let (workspace, output, _) = solve(&[IkLayer::new(IkGoal::LookAt(goal), 1.0)]);
    assert_eq!(workspace.outcomes()[0].status, IkStatus::Reached);
    assert!(workspace.outcomes()[0].residual < TOLERANCE);
    assert_ne!(output[4].rotation, Quat::IDENTITY);
    assert_ne!(output[5].rotation, Quat::IDENTITY);
}

#[test]
fn partially_weighted_look_at_within_max_angle_reports_clamped() {
    let rig = rig();
    let target = Vec3::new(2.0, 1.6, 2.0);
    for weights in [&[(5, 0.0)][..], &[(5, 0.5)][..], &[(4, 0.5), (5, 0.5)][..]] {
        let chain = LookAtChain::new(&rig, weights, Vec3::new(0.0, 0.0, 1.0)).unwrap();
        let goal = LookAtGoal {
            chain,
            target,
            max_angle: FRAC_PI_2,
        };
        let (workspace, _, stats) = solve(&[IkLayer::new(IkGoal::LookAt(goal), 1.0)]);
        let outcome = workspace.outcomes()[0];
        assert_eq!(outcome.status, IkStatus::Clamped, "{weights:?}");
        assert!(outcome.residual > TOLERANCE, "{weights:?}");
        assert_eq!(stats.layers_clamped, 1, "{weights:?}");
    }
}

#[test]
fn look_at_reports_reached_when_final_aim_is_within_limit_after_early_clamp() {
    // The target is 45 degrees above the head's initial forward, beyond the
    // 0.65 rad limit, so the spine step is clamped. Pitching the spine up
    // moves the head back and down relative to the target, which leaves it
    // within the limit from the head's final position; the head then aims
    // fully, so the solve must report Reached rather than a sticky Clamped.
    let rig = rig();
    let chain = LookAtChain::new(&rig, &[(4, 1.0), (5, 1.0)], Vec3::new(0.0, 0.0, 1.0)).unwrap();
    let goal = LookAtGoal {
        chain,
        target: Vec3::new(0.0, 1.75, 0.15),
        max_angle: 0.65,
    };
    let initial_head = Vec3::new(0.0, 1.6, 0.0);
    let initial_angle = angle_between(
        Vec3::new(0.0, 0.0, 1.0),
        (goal.target - initial_head).normalized().unwrap(),
    );
    assert!(initial_angle > goal.max_angle);

    let (workspace, _, stats) = solve(&[IkLayer::new(IkGoal::LookAt(goal), 1.0)]);
    let outcome = workspace.outcomes()[0];
    assert_eq!(outcome.status, IkStatus::Reached);
    assert!(outcome.residual < TOLERANCE, "{}", outcome.residual);
    assert_eq!(stats.layers_clamped, 0);
    let forward = rotate(
        workspace.world_rotation(5).unwrap(),
        Vec3::new(0.0, 0.0, 1.0),
    );
    assert!(angle_between(forward, Vec3::new(0.0, 0.0, 1.0)) <= goal.max_angle + TOLERANCE);
}

#[test]
fn look_at_respects_max_angle() {
    let rig = rig();
    let chain = LookAtChain::new(&rig, &[(5, 1.0)], Vec3::new(0.0, 0.0, 1.0)).unwrap();
    let goal = LookAtGoal {
        chain,
        target: Vec3::new(5.0, 1.6, 0.0),
        max_angle: 0.5,
    };
    let (workspace, _, _) = solve(&[IkLayer::new(IkGoal::LookAt(goal), 1.0)]);
    let forward = rotate(
        workspace.world_rotation(5).unwrap(),
        Vec3::new(0.0, 0.0, 1.0),
    );
    assert!((angle_between(forward, Vec3::new(0.0, 0.0, 1.0)) - 0.5).abs() < TOLERANCE);
    assert_eq!(workspace.outcomes()[0].status, IkStatus::Clamped);
}

#[test]
fn zero_weight_layer_leaves_base_pose_bit_identical() {
    let rig = rig();
    let goal = LimbGoal::new(leg(&rig), Vec3::new(0.3, 0.3, 0.3));
    let (workspace, output, stats) = solve(&[IkLayer::new(IkGoal::Limb(goal), 0.0)]);
    assert_eq!(output, base_pose());
    assert_eq!(workspace.outcomes()[0].status, IkStatus::Skipped);
    assert_eq!(stats.layers_skipped, 1);
    assert_eq!(stats.joints_written, 0);
}

#[test]
fn layer_weight_blends_between_base_and_solved_rotations() {
    let rig = rig();
    let goal = IkGoal::Limb(LimbGoal::new(leg(&rig), Vec3::new(0.3, 0.3, 0.2)));
    let (_, full, _) = solve(&[IkLayer::new(goal, 1.0)]);
    let (_, half, _) = solve(&[IkLayer::new(goal, 0.5)]);
    let base = base_pose();
    for joint in [1, 2] {
        let expected = base[joint].rotation.slerp(full[joint].rotation, 0.5);
        assert!(half[joint].rotation.dot(expected).abs() > 1.0 - 1.0e-6);
    }
    assert_eq!(half[0], base[0]);
    assert_eq!(half[4..], base[4..]);
}

#[test]
fn mask_scales_layer_weight_per_joint() {
    let rig = rig();
    let goal = IkGoal::Limb(LimbGoal::new(leg(&rig), Vec3::new(0.3, 0.3, 0.2)));
    let (_, full, _) = solve(&[IkLayer::new(goal, 1.0)]);
    let mut mask = JointMask::new(rig.node_count(), 1.0).unwrap();
    mask.set(1, 0.0).unwrap();
    mask.set(2, 0.25).unwrap();
    let (_, masked, _) = solve(&[IkLayer::new(goal, 0.8).with_mask(&mask)]);
    let base = base_pose();
    assert_eq!(masked[1].rotation, base[1].rotation);
    let expected = base[2].rotation.slerp(full[2].rotation, 0.2);
    assert!(masked[2].rotation.dot(expected).abs() > 1.0 - 1.0e-6);
}

#[test]
fn layers_solve_in_order_and_later_layers_see_earlier_results() {
    let rig = rig();
    let first = IkGoal::Limb(LimbGoal::new(leg(&rig), Vec3::new(0.3, 0.3, 0.2)));
    let second = IkGoal::Limb(LimbGoal::new(leg(&rig), Vec3::new(-0.1, 0.25, -0.1)));
    let (workspace, ordered, _) = solve(&[IkLayer::new(first, 1.0), IkLayer::new(second, 1.0)]);
    assert_close(
        workspace.world_position(3).unwrap(),
        Vec3::new(-0.1, 0.25, -0.1),
    );
    let (_, repeated, _) = solve(&[IkLayer::new(first, 1.0), IkLayer::new(second, 1.0)]);
    assert_eq!(ordered, repeated);
    let (swapped, _, _) = solve(&[IkLayer::new(second, 1.0), IkLayer::new(first, 1.0)]);
    assert_close(swapped.world_position(3).unwrap(), Vec3::new(0.3, 0.3, 0.2));
}

#[test]
fn solve_never_mutates_sampled_clip_or_base_pose() {
    let rig = rig();
    let track = KeyframeTrack::new(
        vec![
            Keyframe {
                time: 0.0,
                value: Quat::IDENTITY,
            },
            Keyframe {
                time: 1.0,
                value: Quat::from_euler_xyz(0.4, 0.0, 0.0),
            },
        ],
        Interpolation::Linear,
    )
    .unwrap();
    let clip =
        AnimationClip::new("walk", vec![AnimationTrack::Rotation { node: 1, track }]).unwrap();
    let clip_before = clip.clone();
    let mut base = base_pose();
    clip.sample(0.5, &mut base).unwrap();
    let base_before = base.clone();

    let mut workspace = IkWorkspace::new(rig.node_count());
    let mut output = vec![Transform::IDENTITY; rig.node_count()];
    let goal = IkGoal::Limb(LimbGoal::new(leg(&rig), Vec3::new(0.3, 0.3, 0.2)));
    workspace
        .solve(&rig, &base, &[IkLayer::new(goal, 1.0)], &mut output)
        .unwrap();

    assert_eq!(clip, clip_before);
    assert_eq!(base, base_before);
    assert_ne!(output, base);
    let mut resampled = base_pose();
    clip.sample(0.5, &mut resampled).unwrap();
    assert_eq!(resampled, base_before);
}

#[test]
fn work_is_bounded_by_layer_count() {
    let rig = rig();
    let chain = LookAtChain::new(&rig, &[(4, 0.5), (5, 1.0)], Vec3::new(0.0, 0.0, 1.0)).unwrap();
    let layers = [
        IkLayer::new(
            IkGoal::Limb(LimbGoal::foot(
                leg(&rig),
                Vec3::new(0.1, 0.2, 0.1),
                Vec3::new(0.0, 1.0, 0.0),
                Vec3::new(0.0, 1.0, 0.0),
            )),
            0.7,
        ),
        IkLayer::new(
            IkGoal::LookAt(LookAtGoal {
                chain,
                target: Vec3::new(1.0, 1.5, 1.0),
                max_angle: 1.0,
            }),
            0.5,
        ),
        IkLayer::new(
            IkGoal::Limb(LimbGoal::hand(arm(&rig), Vec3::new(0.6, 1.4, 0.2), None)),
            1.0,
        ),
    ];
    let (_, _, stats) = solve(&layers);
    let nodes = rig.node_count();
    assert_eq!(stats.layers_applied, 3);
    assert!(stats.world_nodes_updated <= nodes * (1 + layers.len() * MAX_WORLD_PASSES_PER_LAYER));
    assert!(stats.joints_written <= layers.len() * MAX_LOOK_AT_JOINTS);
}

#[test]
fn rejects_invalid_inputs() {
    let rig = rig();
    assert_eq!(
        IkRig::new(vec![Some(0)]),
        Err(IkError::ParentMustPrecedeChild { node: 0, parent: 0 })
    );
    assert_eq!(
        TwoBoneChain::new(&rig, 1, 5, 3),
        Err(IkError::NotDescendant {
            ancestor: 1,
            joint: 5
        })
    );
    assert_eq!(
        LookAtChain::new(&rig, &[(0, 1.0); 5], Vec3::new(0.0, 0.0, 1.0)),
        Err(IkError::LookAtChainTooLong { len: 5, max: 4 })
    );

    let base = base_pose();
    let mut workspace = IkWorkspace::new(rig.node_count());
    let mut output = base.clone();
    let goal = LimbGoal::new(leg(&rig), Vec3::new(f32::NAN, 0.0, 0.0));
    assert_eq!(
        workspace.solve(
            &rig,
            &base,
            &[IkLayer::new(IkGoal::Limb(goal), 1.0)],
            &mut output
        ),
        Err(IkError::InvalidTarget { layer: 0 })
    );
    let goal = IkGoal::Limb(LimbGoal::new(leg(&rig), Vec3::ZERO));
    assert_eq!(
        workspace.solve(&rig, &base, &[IkLayer::new(goal, 1.5)], &mut output),
        Err(IkError::InvalidLayerWeight { layer: 0 })
    );
    let layers = [IkLayer::new(goal, 1.0); MAX_IK_LAYERS + 1];
    assert_eq!(
        workspace.solve(&rig, &base, &layers, &mut output),
        Err(IkError::TooManyLayers {
            count: MAX_IK_LAYERS + 1,
            max: MAX_IK_LAYERS
        })
    );
    assert_eq!(
        workspace.solve(&rig, &base[..3], &[], &mut output),
        Err(IkError::PoseLengthMismatch {
            expected: rig.node_count(),
            actual: 3
        })
    );
}

#[test]
fn chains_are_revalidated_against_the_solve_rig() {
    let rig = rig();
    let leg = leg(&rig);
    let look = LookAtChain::new(&rig, &[(4, 0.5), (5, 1.0)], Vec3::new(0.0, 0.0, 1.0)).unwrap();
    // Same node count, but the leg joints and head are re-parented to the
    // hips, so neither chain's ancestry holds.
    let other = IkRig::new(vec![
        None,
        Some(0),
        Some(0),
        Some(0),
        Some(0),
        Some(0),
        Some(4),
        Some(6),
        Some(7),
    ])
    .unwrap();
    let base = base_pose();
    let mut workspace = IkWorkspace::new(other.node_count());
    let mut output = base.clone();

    let limb = IkGoal::Limb(LimbGoal::new(leg, Vec3::new(0.25, 0.3, 0.2)));
    assert_eq!(
        workspace.solve(&other, &base, &[IkLayer::new(limb, 1.0)], &mut output),
        Err(IkError::NotDescendant {
            ancestor: 1,
            joint: 2
        })
    );
    let look_at = IkGoal::LookAt(LookAtGoal {
        chain: look,
        target: Vec3::new(1.0, 1.6, 1.0),
        max_angle: PI,
    });
    assert_eq!(
        workspace.solve(&other, &base, &[IkLayer::new(look_at, 1.0)], &mut output),
        Err(IkError::NotDescendant {
            ancestor: 4,
            joint: 5
        })
    );
    // Rejected solves leave the output untouched.
    assert_eq!(output, base);

    // The originating rig still accepts both chains.
    workspace
        .solve(
            &rig,
            &base,
            &[IkLayer::new(limb, 1.0), IkLayer::new(look_at, 1.0)],
            &mut output,
        )
        .unwrap();
}

#[test]
fn cloned_workspaces_keep_outcome_capacity() {
    let fresh = IkWorkspace::new(rig().node_count());
    assert!(fresh.clone().outcomes.capacity() >= MAX_IK_LAYERS);

    let goal = IkGoal::Limb(LimbGoal::new(leg(&rig()), Vec3::new(0.25, 0.3, 0.2)));
    let (used, _, _) = solve(&[IkLayer::new(goal, 1.0)]);
    let clone = used.clone();
    assert!(clone.outcomes.capacity() >= MAX_IK_LAYERS);
    assert_eq!(clone, used);
}

#[test]
fn exact_minimum_reach_fraction_solves_at_minimum_reach() {
    let rig = rig();
    let target = Vec3::new(0.1, 0.5, 0.0);
    let mut boundary_cases = 0;
    for step in 1..200 {
        // Straight leg: upper 0.5, lower varies so the f32 boundary
        // fraction rounds both up and down across the sweep.
        let lower_length = 0.013 * step as f32 + 0.0007;
        if (lower_length - 0.5).abs() < 0.01 {
            continue;
        }
        let mut base = base_pose();
        base[2] = translated(0.0, -0.5, 0.0);
        base[3] = translated(0.0, -lower_length, 0.0);
        let mut workspace = IkWorkspace::new(rig.node_count());
        let mut output = base.clone();
        let probe = IkGoal::Limb(LimbGoal::new(leg(&rig), target));
        workspace
            .solve(&rig, &base, &[IkLayer::new(probe, 0.0)], &mut output)
            .unwrap();
        let (upper, lower) = bone_lengths(&workspace, leg(&rig));
        let fraction = (upper - lower).abs() / (upper + lower);
        if (upper + lower) * fraction < (upper - lower).abs() {
            boundary_cases += 1;
        }

        let goal = LimbGoal::new(leg(&rig), target).with_max_reach(fraction);
        workspace
            .solve(
                &rig,
                &base,
                &[IkLayer::new(IkGoal::Limb(goal), 1.0)],
                &mut output,
            )
            .unwrap_or_else(|error| panic!("lower {lower_length}: {error}"));
        let reach =
            (workspace.world_position(3).unwrap() - workspace.world_position(1).unwrap()).length();
        assert!((reach - (upper - lower).abs()).abs() < TOLERANCE);

        // Clearly below the documented minimum is still rejected.
        let below = LimbGoal::new(leg(&rig), target)
            .with_max_reach(fraction - 10.0 * MIN_REACH_FRACTION_TOLERANCE);
        if below.max_reach > 0.0 {
            assert_eq!(
                workspace.solve(
                    &rig,
                    &base,
                    &[IkLayer::new(IkGoal::Limb(below), 1.0)],
                    &mut output
                ),
                Err(IkError::ReachBelowMinimum { layer: 0 })
            );
        }
    }
    // The sweep must exercise the rounding case the tolerance exists for.
    assert!(boundary_cases > 0);
}

/// Deterministic generator for the look-at limit sweep.
struct Lcg(u64);

impl Lcg {
    fn next(&mut self) -> f32 {
        self.0 = self
            .0
            .wrapping_mul(6_364_136_223_846_793_005)
            .wrapping_add(1_442_695_040_888_963_407);
        (self.0 >> 40) as f32 / (1u64 << 24) as f32
    }

    fn signed(&mut self) -> f32 {
        self.next() * 2.0 - 1.0
    }

    fn unit_quat(&mut self) -> Quat {
        Quat::new(self.signed(), self.signed(), self.signed(), self.signed())
            .normalized()
            .unwrap_or(Quat::IDENTITY)
    }
}

#[test]
fn look_at_never_exceeds_max_angle_for_any_weights_or_masks() {
    // root(0) → a(1) → b(2) → c(3): the three-joint look-at chain. Wide
    // limits (above pi/2) make the permitted cap non-convex along great
    // circles, so neither a weighted step between two in-cap directions
    // nor a per-joint layer/mask blend is automatically inside it.
    let rig = IkRig::new(vec![None, Some(0), Some(1), Some(2)]).unwrap();
    let forward = Vec3::new(0.0, 0.0, 1.0);
    let mut rng = Lcg(0x5eed_1234_abcd_0001);
    let mut workspace = IkWorkspace::new(rig.node_count());
    let mut output = vec![Transform::IDENTITY; rig.node_count()];
    let mut wide_limits = 0;
    let mut unblended_cases = 0;
    let mut scaled_cases = 0;
    for case in 0..4000 {
        let mut base = vec![Transform::IDENTITY; rig.node_count()];
        for transform in base.iter_mut().skip(1) {
            transform.translation = Vec3::new(rng.signed(), rng.signed(), rng.signed());
            transform.rotation = rng.unit_quat();
        }
        let weights = [rng.next(), rng.next(), rng.next()];
        let chain = LookAtChain::new(
            &rig,
            &[(1, weights[0]), (2, weights[1]), (3, weights[2])],
            forward,
        )
        .unwrap();
        let max_angle = rng.next() * PI;
        if max_angle > FRAC_PI_2 {
            wide_limits += 1;
        }
        let goal = LookAtGoal {
            chain,
            target: Vec3::new(rng.signed(), rng.signed(), rng.signed()) * 3.0,
            max_angle,
        };
        let mut mask = JointMask::new(rig.node_count(), 1.0).unwrap();
        for joint in 1..4 {
            // Mix fully masked, fully applied, and partial joints.
            let pick = rng.next();
            let weight = if pick < 0.3 {
                0.0
            } else if pick < 0.6 {
                1.0
            } else {
                rng.next()
            };
            mask.set(joint, weight).unwrap();
        }
        let layer_weight = if rng.next() < 0.5 { 1.0 } else { rng.next() };
        let masked = rng.next() < 0.5;

        workspace
            .solve(
                &rig,
                &base,
                &[IkLayer::new(IkGoal::LookAt(goal), 0.0)],
                &mut output,
            )
            .unwrap();
        let initial = rotate(workspace.world_rotation(3).unwrap(), forward);

        let mut layer = IkLayer::new(IkGoal::LookAt(goal), layer_weight);
        if masked {
            layer = layer.with_mask(&mask);
        }
        let mut full = vec![Transform::IDENTITY; rig.node_count()];
        workspace
            .solve(
                &rig,
                &base,
                &[IkLayer::new(IkGoal::LookAt(goal), 1.0)],
                &mut full,
            )
            .unwrap();
        workspace.solve(&rig, &base, &[layer], &mut output).unwrap();
        let aimed = rotate(workspace.world_rotation(3).unwrap(), forward);
        // The cap is enforced without bypassing weights: every joint stays
        // on its pre-layer → solved SLERP at no more than its effective
        // weight, all scaled by one common factor, and a joint with zero
        // effective weight keeps its base rotation exactly.
        let mut common_scale: Option<f32> = None;
        for joint in 1..4 {
            let factor = layer_weight * if masked { mask.weight(joint) } else { 1.0 };
            if factor <= 0.0 {
                assert_eq!(output[joint].rotation, base[joint].rotation, "case {case}");
                continue;
            }
            let solved_angle = quat_angle(base[joint].rotation, full[joint].rotation);
            // f32 `acos` near one is too coarse to compare tiny arcs.
            if solved_angle * factor < 0.2 {
                continue;
            }
            let traveled = quat_angle(base[joint].rotation, output[joint].rotation);
            let scale = traveled / (solved_angle * factor);
            assert!(
                scale <= 1.0 + 1.0e-2,
                "case {case}: joint {joint} scale {scale}"
            );
            let off_path = quat_angle(
                base[joint]
                    .rotation
                    .slerp(full[joint].rotation, (traveled / solved_angle).min(1.0)),
                output[joint].rotation,
            );
            assert!(
                off_path < 1.0e-2,
                "case {case}: joint {joint} left its SLERP by {off_path}"
            );
            if let Some(common) = common_scale {
                assert!(
                    (common - scale).abs() < 2.0e-2,
                    "case {case}: scales {common} vs {scale}"
                );
            } else {
                common_scale = Some(scale);
            }
        }
        if common_scale.is_some_and(|scale| scale < 0.98) {
            scaled_cases += 1;
        }
        let deviation = angle_between(initial, aimed);
        assert!(
            deviation <= max_angle + TOLERANCE,
            "case {case}: deviation {deviation} > limit {max_angle} \
             (weights {weights:?}, layer {layer_weight}, masked {masked})"
        );
        if layer_weight >= 1.0 && !masked {
            // Nothing is blended here, so the post-blend correction never
            // runs and the solved weighted steps alone must respect the cap.
            unblended_cases += 1;
        }
    }
    assert!(wide_limits > 1000);
    assert!(unblended_cases > 500);
    assert!(scaled_cases > 5, "only {scaled_cases} cap-scaled blends");
}

#[test]
fn fully_folded_equal_length_limb_reaches_its_target() {
    // root(0) → mid(1) → tip(2) with unit bones folded so the tip sits on
    // the root: the current root angle is undefined.
    let rig = IkRig::new(vec![None, Some(0), Some(1)]).unwrap();
    let mut base = vec![Transform::IDENTITY; 3];
    base[1].translation = Vec3::new(1.0, 0.0, 0.0);
    base[2].translation = Vec3::new(-1.0, 0.0, 0.0);
    let chain = TwoBoneChain::new(&rig, 0, 1, 2).unwrap();
    let mut workspace = IkWorkspace::new(3);
    let mut output = vec![Transform::IDENTITY; 3];
    for (target, pole) in [
        (Vec3::new(0.0, 1.0, 0.0), None),
        (Vec3::new(0.6, 0.0, 0.8), None),
        (Vec3::new(0.0, 1.0, 0.0), Some(Vec3::new(0.0, 0.0, 5.0))),
        (Vec3::new(1.5, 0.5, 0.0), None),
    ] {
        let mut goal = LimbGoal::new(chain, target);
        goal.pole = pole;
        workspace
            .solve(
                &rig,
                &base,
                &[IkLayer::new(IkGoal::Limb(goal), 1.0)],
                &mut output,
            )
            .unwrap();
        let outcome = workspace.outcomes()[0];
        assert_eq!(outcome.status, IkStatus::Reached, "target {target:?}");
        assert!(
            outcome.residual < TOLERANCE,
            "target {target:?}: {}",
            outcome.residual
        );
        if pole.is_some() {
            // The mid joint bends fully toward the +z pole: sin(60°) off the axis.
            assert!(position(workspace.world[1]).z > 0.86);
        }
    }
    // Arbitrarily oriented folded limbs.
    let mut rng = Lcg(0xf01d_ed00_1234_5678);
    for case in 0..500 {
        let mut base = vec![Transform::IDENTITY; 3];
        base[0].rotation = rng.unit_quat();
        base[1].rotation = rng.unit_quat();
        base[1].translation = Vec3::new(1.0, 0.0, 0.0);
        base[2].translation = rotate(quat_conjugate(base[1].rotation), Vec3::new(-1.0, 0.0, 0.0));
        let direction = Vec3::new(rng.signed(), rng.signed(), rng.signed())
            .normalized()
            .unwrap_or(Vec3::new(0.0, 1.0, 0.0));
        let target = direction * (0.2 + 1.7 * rng.next());
        workspace
            .solve(
                &rig,
                &base,
                &[IkLayer::new(
                    IkGoal::Limb(LimbGoal::new(chain, target)),
                    1.0,
                )],
                &mut output,
            )
            .unwrap();
        let outcome = workspace.outcomes()[0];
        assert_eq!(outcome.status, IkStatus::Reached, "case {case}");
        assert!(
            outcome.residual < TOLERANCE,
            "case {case}: {}",
            outcome.residual
        );
    }
}

#[test]
fn non_finite_base_pose_is_rejected_before_solving() {
    let rig = rig();
    let goal = IkGoal::Limb(LimbGoal::new(leg(&rig), Vec3::new(0.0, -1.0, 0.0)));
    let mut workspace = IkWorkspace::new(rig.node_count());
    let mut output = vec![Transform::IDENTITY; rig.node_count()];
    for poison in [
        |t: &mut Transform| t.translation.x = f32::NAN,
        |t: &mut Transform| t.scale.y = f32::INFINITY,
        |t: &mut Transform| t.rotation.w = f32::NAN,
    ] {
        let mut base = vec![Transform::IDENTITY; rig.node_count()];
        poison(&mut base[2]);
        assert_eq!(
            workspace.solve(&rig, &base, &[IkLayer::new(goal, 1.0)], &mut output),
            Err(IkError::NonFiniteBasePose { node: 2 })
        );
    }
    // Finite inputs whose composition overflows are rejected for limbs
    // and look-at chains alike.
    let mut base = vec![Transform::IDENTITY; rig.node_count()];
    base[1].translation = Vec3::new(0.0, -1.0, 0.0);
    base[2].translation = Vec3::new(0.0, -f32::MAX, 0.0);
    base[3].translation = Vec3::new(0.0, -f32::MAX, 0.0);
    assert_eq!(
        workspace.solve(&rig, &base, &[IkLayer::new(goal, 1.0)], &mut output),
        Err(IkError::NonFiniteWorldPose { layer: 0 })
    );
    let mut base = vec![Transform::IDENTITY; rig.node_count()];
    base[4].scale = Vec3::new(f32::MAX, f32::MAX, f32::MAX);
    base[5].translation = Vec3::new(0.0, 2.0, 0.0);
    let look = IkGoal::LookAt(LookAtGoal {
        chain: LookAtChain::new(&rig, &[(5, 1.0)], Vec3::new(0.0, 0.0, 1.0)).unwrap(),
        target: Vec3::new(1.0, 1.0, 1.0),
        max_angle: PI,
    });
    assert_eq!(
        workspace.solve(
            &rig,
            &base,
            &[IkLayer::new(goal, 0.0), IkLayer::new(look, 1.0)],
            &mut output
        ),
        Err(IkError::NonFiniteWorldPose { layer: 1 })
    );
}

#[test]
fn zero_length_base_rotation_is_identity_for_ik_deltas() {
    // An unnormalizable base rotation means identity elsewhere in the
    // crate; the solver must still rotate the joint, not keep it zero.
    let rig = rig();
    let mut base = vec![Transform::IDENTITY; rig.node_count()];
    let mut identity_base = base.clone();
    base[5].rotation = Quat::new(0.0, 0.0, 0.0, 0.0);
    identity_base[5].rotation = Quat::IDENTITY;
    let chain = LookAtChain::new(&rig, &[(5, 1.0)], Vec3::new(0.0, 0.0, 1.0)).unwrap();
    let goal = IkGoal::LookAt(LookAtGoal {
        chain,
        target: Vec3::new(2.0, 2.0, 2.0),
        max_angle: PI,
    });
    let mut workspace = IkWorkspace::new(rig.node_count());
    let mut output = vec![Transform::IDENTITY; rig.node_count()];
    workspace
        .solve(&rig, &base, &[IkLayer::new(goal, 1.0)], &mut output)
        .unwrap();
    assert_eq!(workspace.outcomes()[0].status, IkStatus::Reached);
    assert!(workspace.outcomes()[0].residual < TOLERANCE);
    let mut expected = vec![Transform::IDENTITY; rig.node_count()];
    workspace
        .solve(
            &rig,
            &identity_base,
            &[IkLayer::new(goal, 1.0)],
            &mut expected,
        )
        .unwrap();
    assert!(quat_angle(output[5].rotation, expected[5].rotation) < TOLERANCE);
}
