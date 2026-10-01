use super::*;
use three_d_animation::{AnimationTrack, Interpolation, Keyframe, KeyframeTrack, Quat};
use three_d_core::Vec3;

const TOLERANCE: f32 = 1.0e-6;

/// Steady `rate_hz` frames; a shorter final frame absorbs any remainder.
fn uniform(total: f64, rate_hz: u32) -> Vec<f64> {
    let step = 1.0 / f64::from(rate_hz);
    let whole = (total * f64::from(rate_hz) + 1.0e-9).floor() as usize;
    let mut deltas = vec![step; whole];
    let remainder = total - whole as f64 * step;
    if remainder > 1.0e-9 {
        deltas.push(remainder);
    }
    deltas
}

/// Deterministic jittery deltas (4..50 ms plus one 180 ms hitch) summing to `total`.
fn uneven(total: f64, mut seed: u64) -> Vec<f64> {
    let mut deltas = Vec::new();
    let mut sum = 0.0;
    loop {
        seed = seed
            .wrapping_mul(6_364_136_223_846_793_005)
            .wrapping_add(1_442_695_040_888_963_407);
        let unit = (seed >> 11) as f64 / (1_u64 << 53) as f64;
        let delta = if deltas.len() == 7 {
            0.18
        } else {
            0.004 + 0.046 * unit
        };
        if sum + delta >= total {
            deltas.push(total - sum);
            return deltas;
        }
        sum += delta;
        deltas.push(delta);
    }
}

fn partitions(total: f64) -> Vec<Vec<f64>> {
    vec![
        vec![total],
        uniform(total, 30),
        uniform(total, 60),
        uniform(total, 144),
        uneven(total, 7),
        uneven(total, 1234),
    ]
}

fn clip() -> AnimationClip {
    let translation = KeyframeTrack::new(
        vec![
            Keyframe {
                time: 0.0,
                value: Vec3::new(-1.0, 0.0, 0.0),
            },
            Keyframe {
                time: 0.5,
                value: Vec3::new(0.0, 0.8, 0.0),
            },
            Keyframe {
                time: 1.2,
                value: Vec3::new(1.0, 0.0, 0.3),
            },
        ],
        Interpolation::Linear,
    )
    .unwrap();
    let rotation = KeyframeTrack::new(
        vec![
            Keyframe {
                time: 0.0,
                value: Quat::IDENTITY,
            },
            Keyframe {
                time: 1.2,
                value: Quat::from_axis_angle(Vec3::new(0.0, 0.0, 1.0), 2.5).unwrap(),
            },
        ],
        Interpolation::Linear,
    )
    .unwrap();
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
    .unwrap()
}

fn target_clip() -> AnimationClip {
    let translation = KeyframeTrack::new(
        vec![
            Keyframe {
                time: 0.0,
                value: Vec3::new(0.0, -0.5, 0.0),
            },
            Keyframe {
                time: 0.8,
                value: Vec3::new(0.0, 0.5, -0.5),
            },
        ],
        Interpolation::SmoothStep,
    )
    .unwrap();
    let rotation = KeyframeTrack::new(
        vec![
            Keyframe {
                time: 0.0,
                value: Quat::from_axis_angle(Vec3::new(0.0, 1.0, 0.0), 1.0).unwrap(),
            },
            Keyframe {
                time: 0.8,
                value: Quat::from_axis_angle(Vec3::new(1.0, 0.0, 0.0), -1.4).unwrap(),
            },
        ],
        Interpolation::Linear,
    )
    .unwrap();
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
    .unwrap()
    .with_loop_mode(LoopMode::Repeat)
}

fn assert_transform_close(left: Transform, right: Transform) {
    let pairs = [
        (left.translation.x, right.translation.x),
        (left.translation.y, right.translation.y),
        (left.translation.z, right.translation.z),
        (left.rotation.x, right.rotation.x),
        (left.rotation.y, right.rotation.y),
        (left.rotation.z, right.rotation.z),
        (left.rotation.w, right.rotation.w),
    ];
    for (a, b) in pairs {
        assert!((a - b).abs() <= TOLERANCE, "{left:?} != {right:?}");
    }
}

fn run(mut clock: PlaybackClock, deltas: &[f64]) -> PlaybackClock {
    for delta in deltas {
        clock.advance(*delta).unwrap();
    }
    clock
}

#[test]
fn clamp_forward_holds_the_final_time() {
    let mut clock = PlaybackClock::new(1.0, PlaybackMode::Clamp).unwrap();
    assert_eq!(clock.advance(0.5).unwrap(), 0.5);
    assert!(!clock.is_finished());
    assert_eq!(clock.advance(1.0).unwrap(), 1.0);
    assert!(clock.is_finished());
    assert_eq!(clock.completed_cycles(), 1);
}

#[test]
fn loop_forward_wraps_and_counts_cycles() {
    let mut clock = PlaybackClock::new(1.0, PlaybackMode::Loop).unwrap();
    assert!((clock.advance(2.25).unwrap() - 0.25).abs() <= TOLERANCE);
    assert_eq!(clock.completed_cycles(), 2);
    assert!(!clock.is_finished());
}

#[test]
fn reverse_starts_at_the_end_and_runs_toward_zero() {
    let clamp = PlaybackClock::new(1.0, PlaybackMode::Clamp)
        .unwrap()
        .with_direction(PlaybackDirection::Reverse);
    assert_eq!(clamp.clip_time(), 1.0);
    let clamp = run(clamp, &[0.25]);
    assert!((clamp.clip_time() - 0.75).abs() <= TOLERANCE);
    let clamp = run(clamp, &[5.0]);
    assert_eq!(clamp.clip_time(), 0.0);
    assert!(clamp.is_finished());

    let looped = PlaybackClock::new(1.0, PlaybackMode::Loop)
        .unwrap()
        .with_direction(PlaybackDirection::Reverse);
    let looped = run(looped, &[1.25]);
    assert!((looped.clip_time() - 0.75).abs() <= TOLERANCE);
}

#[test]
fn speed_scales_clip_time_but_not_wall_time() {
    let mut clock = PlaybackClock::new(2.0, PlaybackMode::Clamp)
        .unwrap()
        .with_speed(1.5)
        .unwrap();
    assert!((clock.advance(0.4).unwrap() - 0.6).abs() <= TOLERANCE);
    clock.set_speed(0.0).unwrap();
    assert!((clock.advance(10.0).unwrap() - 0.6).abs() <= TOLERANCE);
    clock.reset();
    assert_eq!(clock.clip_time(), 0.0);
}

#[test]
fn from_clip_adopts_the_clip_loop_mode() {
    assert_eq!(
        PlaybackClock::from_clip(&clip()).unwrap().mode(),
        PlaybackMode::Clamp
    );
    let looped = PlaybackClock::from_clip(&target_clip()).unwrap();
    assert_eq!(looped.mode(), PlaybackMode::Loop);
    assert!((looped.duration_seconds() - 0.8).abs() < 1.0e-6);
}

#[test]
fn every_policy_is_invariant_to_frame_partitioning() {
    let clip = clip();
    for total in [0.37, 1.2, 1.75, 2.4, 3.05] {
        for mode in [PlaybackMode::Clamp, PlaybackMode::Loop] {
            for direction in [PlaybackDirection::Forward, PlaybackDirection::Reverse] {
                let start = PlaybackClock::new(clip.duration(), mode)
                    .unwrap()
                    .with_direction(direction);
                let reference = run(start, &[total]);
                let mut reference_pose = [Transform::IDENTITY];
                reference.sample(&clip, &mut reference_pose).unwrap();
                for deltas in partitions(total) {
                    let clock = run(start, &deltas);
                    assert!(
                        (clock.clip_time() - reference.clip_time()).abs() <= TOLERANCE,
                        "{mode:?} {direction:?} total {total} with {} frames: {} vs {}",
                        deltas.len(),
                        clock.clip_time(),
                        reference.clip_time()
                    );
                    assert_eq!(clock.completed_cycles(), reference.completed_cycles());
                    assert_eq!(clock.is_finished(), reference.is_finished());
                    let mut pose = [Transform::IDENTITY];
                    clock.sample(&clip, &mut pose).unwrap();
                    assert_transform_close(pose[0], reference_pose[0]);
                }
            }
        }
    }
}

#[test]
fn loop_boundaries_do_not_depend_on_summation_noise() {
    // 72 frames of 1/60 s sum to slightly less than 1.2 s in floating point;
    // without boundary snapping the loop would sit just before the wrap.
    let start = PlaybackClock::new(1.2, PlaybackMode::Loop).unwrap();
    let sixty = run(start, &uniform(1.2, 60));
    let one = run(start, &[1.2]);
    assert_eq!(sixty.clip_time(), 0.0);
    assert_eq!(one.clip_time(), 0.0);
    assert_eq!(sixty.completed_cycles(), 1);
}

#[test]
fn fixed_per_frame_stepping_is_not_partition_invariant() {
    // The anti-pattern the web lab demonstrates: ignore the measured delta and
    // advance by 1/60 s every frame. The same 2 s of wall time disagrees.
    let start = PlaybackClock::new(4.0, PlaybackMode::Clamp).unwrap();
    let thirty = run(start, &vec![1.0 / 60.0; uniform(2.0, 30).len()]);
    let sixty = run(start, &vec![1.0 / 60.0; uniform(2.0, 60).len()]);
    assert!((sixty.clip_time() - 2.0).abs() <= TOLERANCE);
    assert!((thirty.clip_time() - 1.0).abs() <= TOLERANCE);
}

#[test]
fn transition_progress_is_wall_time_and_partition_invariant() {
    for duration in [0.3_f32, 0.5, 0.9] {
        for curve in [TransitionCurve::Linear, TransitionCurve::SmoothStep] {
            let start = TransitionClock::new(duration, curve).unwrap();
            for total in [0.1, f64::from(duration), 2.0] {
                let mut reference = start;
                reference.advance(total).unwrap();
                for deltas in partitions(total) {
                    let mut clock = start;
                    let mut previous = 0.0;
                    for delta in &deltas {
                        let weight = clock.advance(*delta).unwrap();
                        assert!(weight >= previous, "weights never decrease");
                        previous = weight;
                    }
                    assert!((clock.progress() - reference.progress()).abs() <= TOLERANCE);
                    assert!((clock.weight() - reference.weight()).abs() <= TOLERANCE);
                    assert_eq!(clock.is_complete(), reference.is_complete());
                }
            }
            let mut exact = start;
            for delta in uniform(f64::from(duration), 60) {
                exact.advance(delta).unwrap();
            }
            assert!(exact.is_complete(), "completes exactly at its duration");
            assert_eq!(exact.weight(), 1.0);
        }
    }
}

#[test]
fn transition_curves_change_weight_but_not_progress() {
    let mut linear = TransitionClock::new(1.0, TransitionCurve::Linear).unwrap();
    let mut smooth = TransitionClock::new(1.0, TransitionCurve::SmoothStep).unwrap();
    linear.advance(0.25).unwrap();
    smooth.advance(0.25).unwrap();
    assert_eq!(linear.progress(), smooth.progress());
    assert!((linear.weight() - 0.25).abs() <= TOLERANCE);
    assert!((smooth.weight() - 0.15625).abs() <= TOLERANCE);
    smooth.advance(0.7).unwrap();
    assert!(!smooth.is_complete());
    smooth.reset();
    assert_eq!(smooth.weight(), 0.0);
}

fn crossfade(target_speed: f64, duration: f32) -> CrossFade {
    let from = PlaybackClock::new(1.2, PlaybackMode::Loop).unwrap();
    let to = PlaybackClock::from_clip(&target_clip())
        .unwrap()
        .with_speed(target_speed)
        .unwrap();
    CrossFade::new(
        from,
        to,
        TransitionClock::new(duration, TransitionCurve::SmoothStep).unwrap(),
    )
}

fn run_crossfade(mut fade: CrossFade, deltas: &[f64]) -> (CrossFade, Transform) {
    let (from_clip, to_clip) = (clip(), target_clip());
    let mut workspace = ClipBlendWorkspace::new(1);
    let mut pose = [Transform::IDENTITY];
    for delta in deltas {
        fade.advance(*delta).unwrap();
        fade.sample(
            &from_clip,
            &to_clip,
            &mut workspace,
            &[Transform::IDENTITY],
            &mut pose,
        )
        .unwrap();
    }
    (fade, pose[0])
}

#[test]
fn crossfades_are_deterministic_and_partition_invariant() {
    for total in [0.2, 0.45, 0.6, 1.3] {
        let start = crossfade(1.5, 0.6);
        let (reference, reference_pose) = run_crossfade(start, &[total]);
        for deltas in partitions(total) {
            let (fade, pose) = run_crossfade(start, &deltas);
            let (again, again_pose) = run_crossfade(start, &deltas);
            assert_eq!(fade, again, "same deltas give bit-identical clocks");
            assert_eq!(pose, again_pose, "same deltas give bit-identical poses");
            let (frame, expected) = (fade.frame(), reference.frame());
            assert!((frame.weight - expected.weight).abs() <= TOLERANCE);
            assert!((frame.from_time - expected.from_time).abs() <= TOLERANCE);
            assert!((frame.to_time - expected.to_time).abs() <= TOLERANCE);
            assert_eq!(frame.complete, expected.complete);
            assert_transform_close(pose, reference_pose);
            assert!((pose.rotation.length() - 1.0).abs() <= TOLERANCE);
        }
    }
}

#[test]
fn transition_wall_time_is_separate_from_clip_clocks() {
    // A 3x target clip and a 0.5x target clip still complete the same 0.6 s fade
    // at the same wall time; only their clip times differ.
    let (fast, _) = run_crossfade(crossfade(3.0, 0.6), &uniform(0.6, 60));
    let (slow, _) = run_crossfade(crossfade(0.5, 0.6), &uniform(0.6, 60));
    assert!(fast.transition().is_complete() && slow.transition().is_complete());
    assert_eq!(fast.frame().weight, slow.frame().weight);
    assert!((fast.to_clock().travelled_seconds() - 1.8).abs() < 1.0e-9);
    assert!((slow.to_clock().travelled_seconds() - 0.3).abs() < 1.0e-9);
    assert!((fast.transition().elapsed_seconds() - 0.6).abs() < 1.0e-9);
    let target = fast.into_target();
    assert_eq!(target.speed(), 3.0);
}

#[test]
fn crossfade_endpoints_match_the_participating_clips() {
    let (from_clip, to_clip) = (clip(), target_clip());
    let fade = crossfade(1.0, 0.5);
    let mut workspace = ClipBlendWorkspace::new(1);
    let mut blended = [Transform::IDENTITY];
    let mut expected = [Transform::IDENTITY];
    fade.sample(
        &from_clip,
        &to_clip,
        &mut workspace,
        &[Transform::IDENTITY],
        &mut blended,
    )
    .unwrap();
    fade.from_clock().sample(&from_clip, &mut expected).unwrap();
    assert_eq!(blended, expected);

    let (done, pose) = run_crossfade(fade, &[0.2, 0.31]);
    assert!(done.transition().is_complete());
    done.to_clock().sample(&to_clip, &mut expected).unwrap();
    assert_transform_close(pose, expected[0]);
}

#[test]
fn invalid_runtime_inputs_fail_closed() {
    assert_eq!(
        PlaybackClock::new(0.0, PlaybackMode::Loop),
        Err(PlaybackError::InvalidDuration)
    );
    assert_eq!(
        TransitionClock::new(f32::NAN, TransitionCurve::Linear),
        Err(PlaybackError::InvalidDuration)
    );
    let mut clock = PlaybackClock::new(1.0, PlaybackMode::Loop).unwrap();
    assert_eq!(clock.advance(f64::NAN), Err(PlaybackError::InvalidDelta));
    assert_eq!(clock.advance(-0.01), Err(PlaybackError::InvalidDelta));
    assert_eq!(clock.set_speed(-1.0), Err(PlaybackError::InvalidSpeed));
    assert_eq!(
        clock.set_speed(f64::INFINITY),
        Err(PlaybackError::InvalidSpeed)
    );
    let mut fade = crossfade(1.0, 0.5);
    let before = fade;
    assert_eq!(fade.advance(f64::NAN), Err(PlaybackError::InvalidDelta));
    assert_eq!(
        fade, before,
        "a rejected delta leaves every clock untouched"
    );
}

#[test]
fn reverse_loop_boundaries_present_the_end_pose() {
    let looped = target_clip();
    let mut end_pose = [Transform::IDENTITY];
    let mut start_pose = [Transform::IDENTITY];
    let clamped = target_clip().with_loop_mode(LoopMode::Clamp);
    clamped.sample(looped.duration(), &mut end_pose).unwrap();
    clamped.sample(0.0, &mut start_pose).unwrap();

    let mut clock = PlaybackClock::from_clip(&looped)
        .unwrap()
        .with_direction(PlaybackDirection::Reverse);
    let mut pose = [Transform::IDENTITY];
    for _ in 0..3 {
        assert_eq!(clock.clip_time(), looped.duration());
        clock.sample(&looped, &mut pose).unwrap();
        assert_transform_close(pose[0], end_pose[0]);
        // A small step later the pose is still next to the end pose, never a
        // jump from the first pose.
        let mut later = clock;
        later.advance(0.001).unwrap();
        let mut later_pose = [Transform::IDENTITY];
        later.sample(&looped, &mut later_pose).unwrap();
        assert!(
            (later_pose[0].translation - end_pose[0].translation).length()
                < (later_pose[0].translation - start_pose[0].translation).length()
        );
        clock.advance(f64::from(looped.duration())).unwrap();
    }

    // The cross-fade samples its clocks the same way: at full weight a
    // reverse-looping target on a cycle boundary shows its end pose.
    let from = PlaybackClock::new(1.2, PlaybackMode::Loop).unwrap();
    let to = PlaybackClock::from_clip(&looped)
        .unwrap()
        .with_direction(PlaybackDirection::Reverse);
    let mut fade = CrossFade::new(
        from,
        to,
        TransitionClock::new(0.4, TransitionCurve::Linear).unwrap(),
    );
    fade.advance(f64::from(looped.duration())).unwrap();
    assert!(fade.transition().is_complete());
    assert_eq!(fade.to_clock().clip_time(), looped.duration());
    let mut workspace = ClipBlendWorkspace::new(1);
    fade.sample(
        &clip(),
        &looped,
        &mut workspace,
        &[Transform::IDENTITY],
        &mut pose,
    )
    .unwrap();
    assert_transform_close(pose[0], end_pose[0]);
}

#[test]
fn arithmetic_overflow_is_rejected_without_poisoning_clocks() {
    let mut clock = PlaybackClock::new(1.0, PlaybackMode::Loop)
        .unwrap()
        .with_speed(f64::MAX)
        .unwrap();
    let before = clock;
    assert_eq!(clock.advance(2.0), Err(PlaybackError::TimeOverflow));
    assert_eq!(clock, before, "a rejected delta leaves the clock untouched");
    assert!(clock.clip_time().is_finite());
    clock.sample(&clip(), &mut [Transform::IDENTITY]).unwrap();

    // The accumulated total can also overflow across frames.
    assert!(clock.advance(1.0).is_ok());
    let before = clock;
    assert_eq!(clock.advance(1.0), Err(PlaybackError::TimeOverflow));
    assert_eq!(clock, before);
    assert!(clock.clip_time().is_finite());

    // A finite total over a tiny duration must not produce infinite cycles.
    let mut tiny = PlaybackClock::new(f32::from_bits(1), PlaybackMode::Loop).unwrap();
    assert_eq!(tiny.advance(1.0e300), Err(PlaybackError::TimeOverflow));
    assert_eq!(tiny.travelled_seconds(), 0.0);

    let mut transition = TransitionClock::new(1.0, TransitionCurve::Linear).unwrap();
    transition.advance(f64::MAX).unwrap();
    assert_eq!(
        transition.advance(f64::MAX),
        Err(PlaybackError::TimeOverflow)
    );
    assert_eq!(transition.elapsed_seconds(), f64::MAX);

    // One overflowing clock rejects the whole cross-fade frame atomically.
    let mut fade = crossfade(f64::MAX, 0.5);
    let before = fade;
    assert_eq!(fade.advance(2.0), Err(PlaybackError::TimeOverflow));
    assert_eq!(fade, before);
}

#[test]
fn effectively_instantaneous_clips_play_their_time_zero_pose() {
    // A positive duration below the animation epsilon is accepted by the
    // clock, but the clip owns its sampling semantics: every path shows the
    // same time-zero pose that `AnimationClip::sample` does.
    let duration = 5.0e-7_f32;
    let track = KeyframeTrack::new(
        vec![
            Keyframe {
                time: 0.0,
                value: Vec3::ZERO,
            },
            Keyframe {
                time: duration,
                value: Vec3::new(1.0, 0.0, 0.0),
            },
        ],
        Interpolation::Linear,
    )
    .unwrap();
    for loop_mode in [LoopMode::Clamp, LoopMode::Repeat] {
        let blink = AnimationClip::new(
            "blink",
            vec![AnimationTrack::Translation {
                node: 0,
                track: track.clone(),
            }],
        )
        .unwrap()
        .with_loop_mode(loop_mode);
        let mut expected = [Transform::IDENTITY];
        blink.sample(0.0, &mut expected).unwrap();
        for direction in [PlaybackDirection::Forward, PlaybackDirection::Reverse] {
            let mut clock = PlaybackClock::from_clip(&blink)
                .unwrap()
                .with_direction(direction);
            for delta in [0.0, 1.0e-7, 0.016, 1.0] {
                clock.advance(delta).unwrap();
                let mut pose = [Transform::IDENTITY];
                clock.sample(&blink, &mut pose).unwrap();
                let mut direct = [Transform::IDENTITY];
                blink.sample(clock.clip_time(), &mut direct).unwrap();
                assert_eq!(pose, expected, "{loop_mode:?} {direction:?}");
                assert_eq!(pose, direct, "{loop_mode:?} {direction:?}");
            }
        }
    }

    // A cross-fade into such a clip agrees with direct sampling as well.
    let blink = AnimationClip::new(
        "blink",
        vec![AnimationTrack::Translation { node: 0, track }],
    )
    .unwrap();
    let mut fade = CrossFade::new(
        PlaybackClock::from_clip(&clip()).unwrap(),
        PlaybackClock::from_clip(&blink).unwrap(),
        TransitionClock::new(0.25, TransitionCurve::Linear).unwrap(),
    );
    fade.advance(0.5).unwrap();
    assert!(fade.transition().is_complete());
    let mut workspace = ClipBlendWorkspace::new(1);
    let mut pose = [Transform::IDENTITY];
    fade.sample(
        &clip(),
        &blink,
        &mut workspace,
        &[Transform::IDENTITY],
        &mut pose,
    )
    .unwrap();
    let mut expected = [Transform::IDENTITY];
    blink.sample(0.0, &mut expected).unwrap();
    assert_transform_close(pose[0], expected[0]);
}
