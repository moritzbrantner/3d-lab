//! Keeps the committed web-lab evidence tied to the current `three-d-playback`.

#[path = "../examples/playback_timing_evidence.rs"]
mod evidence;

use three_d_animation::Transform;
use three_d_playback::PlaybackClock;

const TOLERANCE: f32 = 1.0e-5;

fn assert_close(left: Transform, right: Transform, context: &str) {
    let flat = |pose: Transform| {
        [
            pose.translation.x,
            pose.translation.y,
            pose.translation.z,
            pose.rotation.x,
            pose.rotation.y,
            pose.rotation.z,
            pose.rotation.w,
        ]
    };
    for (a, b) in flat(left).into_iter().zip(flat(right)) {
        assert!(
            (a - b).abs() <= TOLERANCE,
            "{context}: {left:?} != {right:?}"
        );
    }
}

#[test]
fn committed_playback_evidence_matches_three_d_playback() {
    let committed = std::fs::read_to_string(evidence::fixture_path())
        .expect("fixtures/playback/playback-timing.json is committed");
    if let Some(difference) = evidence::drift(&committed) {
        panic!(
            "playback timing evidence drifted ({difference}); run `cargo run -p three-d-playback --example playback_timing_evidence`"
        );
    }
}

#[test]
fn drift_check_tolerates_libm_rounding_flips_but_not_real_changes() {
    let committed = std::fs::read_to_string(evidence::fixture_path()).unwrap();
    let mut value: serde_json::Value = serde_json::from_str(&committed).unwrap();
    let original = value["crossFades"][3]["pose"][173].as_f64().unwrap();

    // A sixth-decimal flip, as produced by a one-ulp libm difference.
    value["crossFades"][3]["pose"][173] = serde_json::json!(original + 1.0e-6);
    assert_eq!(evidence::drift(&value.to_string()), None);

    // A real change, a structural change, and a string change all drift.
    value["crossFades"][3]["pose"][173] = serde_json::json!(original + 1.0e-4);
    assert!(evidence::drift(&value.to_string()).is_some());
    value["crossFades"][3]["pose"][173] = serde_json::json!(original);
    value["crossFades"][3]["pose"].as_array_mut().unwrap().pop();
    assert!(evidence::drift(&value.to_string()).is_some());
    let mut value: serde_json::Value = serde_json::from_str(&committed).unwrap();
    value["schema"] = serde_json::json!("other");
    assert!(evidence::drift(&value.to_string()).is_some());
}

#[test]
fn every_scenario_partitions_the_same_wall_time() {
    for scenario in evidence::scenarios() {
        let total: f64 = scenario.deltas.iter().sum();
        assert!(
            (total - evidence::WALL_SECONDS).abs() < 1.0e-9,
            "{}",
            scenario.id
        );
        assert!(scenario.deltas.iter().all(|delta| *delta > 0.0));
    }
}

#[test]
fn elapsed_time_playback_agrees_across_partitions_and_fixed_step_does_not() {
    let clip = evidence::sweep_clip();
    let scenarios = evidence::scenarios();
    for (mode, direction) in evidence::POLICIES {
        let start = PlaybackClock::new(clip.duration(), mode)
            .unwrap()
            .with_direction(direction);
        let runs = scenarios
            .iter()
            .map(|scenario| evidence::run_playback(&clip, start, &scenario.deltas))
            .collect::<Vec<_>>();
        let reference = runs[0].poses.last().copied().unwrap();
        for (scenario, run) in scenarios.iter().zip(&runs) {
            let context = format!("{mode:?} {direction:?} {}", scenario.id);
            assert_close(*run.poses.last().unwrap(), reference, &context);
            assert!(
                (run.clip_time.last().unwrap() - runs[0].clip_time.last().unwrap()).abs()
                    <= TOLERANCE
            );
        }
        // Steady 30/60/120 Hz frames share every 30 Hz instant.
        let (thirty, sixty, one_twenty) = (&runs[0], &runs[1], &runs[2]);
        for frame in 0..thirty.poses.len() {
            assert!((thirty.clip_time[frame] - sixty.clip_time[frame * 2]).abs() <= TOLERANCE);
            assert!((thirty.clip_time[frame] - one_twenty.clip_time[frame * 4]).abs() <= TOLERANCE);
            assert_close(
                thirty.poses[frame],
                sixty.poses[frame * 2],
                "30 vs 60 Hz instant",
            );
        }
    }

    let start = PlaybackClock::new(clip.duration(), three_d_playback::PlaybackMode::Clamp).unwrap();
    let fixed_step = |deltas: &[f64]| {
        let naive = vec![evidence::NAIVE_FRAME_SECONDS; deltas.len()];
        *evidence::run_playback(&clip, start, &naive)
            .clip_time
            .last()
            .unwrap()
    };
    assert!((fixed_step(&scenarios[0].deltas) - fixed_step(&scenarios[1].deltas)).abs() > 0.1);
}

#[test]
fn crossfades_reach_full_weight_at_their_wall_duration_on_every_partition() {
    let scenarios = evidence::scenarios();
    for transition_seconds in evidence::TRANSITION_SECONDS {
        for curve in evidence::CURVES {
            let start = evidence::start_crossfade(transition_seconds, curve);
            let runs = scenarios
                .iter()
                .map(|scenario| evidence::run_crossfade(start, &scenario.deltas))
                .collect::<Vec<_>>();
            for (scenario, run) in scenarios.iter().zip(&runs) {
                let mut wall = 0.0;
                for (frame, weight) in run.weight.iter().enumerate() {
                    if frame > 0 {
                        wall += scenario.deltas[frame - 1];
                        assert!(*weight >= run.weight[frame - 1], "weights never decrease");
                    }
                    let complete = wall >= f64::from(transition_seconds) - 1.0e-6;
                    assert_eq!(*weight == 1.0, complete, "{} frame {frame}", scenario.id);
                    let rotation = run.poses[frame].rotation;
                    assert!((rotation.length() - 1.0).abs() <= TOLERANCE);
                }
                assert_close(
                    *run.poses.last().unwrap(),
                    *runs[0].poses.last().unwrap(),
                    scenario.id,
                );
                assert!(
                    (run.to_time.last().unwrap() - runs[0].to_time.last().unwrap()).abs()
                        <= TOLERANCE
                );
            }
        }
    }
}
