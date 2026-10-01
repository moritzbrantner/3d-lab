//! Keeps the committed web-lab evidence tied to the current `three-d-lod`.

#[path = "../examples/screen_space_lod_evidence.rs"]
mod evidence;

#[test]
fn committed_screen_space_evidence_matches_three_d_lod() {
    let committed = std::fs::read_to_string(evidence::fixture_path())
        .expect("fixtures/lod/screen-space-lod.json is committed");
    assert!(
        committed == evidence::evidence_text(),
        "screen-space LOD evidence drifted; run `cargo run -p three-d-lod --example screen_space_lod_evidence`"
    );
}

#[test]
fn evidence_levels_get_coarser_and_errors_never_shrink() {
    let document = evidence::evidence();
    let levels = document["levels"].as_array().unwrap();
    assert_eq!(levels.len(), 4);
    for pair in levels.windows(2) {
        assert!(pair[1]["triangleCount"].as_u64() < pair[0]["triangleCount"].as_u64());
        assert!(pair[1]["geometricError"].as_f64() >= pair[0]["geometricError"].as_f64());
    }
}

#[test]
fn hysteresis_separates_outbound_and_inbound_switch_distances() {
    let document = evidence::evidence();
    for policy in document["policies"].as_array().unwrap() {
        let outbound = policy["outboundSwitches"].as_array().unwrap();
        let inbound = policy["inboundSwitches"].as_array().unwrap();
        assert!(!outbound.is_empty());
        let hysteresis = policy["hysteresisPercent"].as_u64().unwrap();
        for switch in outbound {
            let (from, to) = (switch["from"].as_u64(), switch["to"].as_u64());
            let back = inbound.iter().find(|candidate| {
                candidate["from"].as_u64() == to && candidate["to"].as_u64() == from
            });
            if let Some(back) = back {
                let out_at = switch["distanceIndex"].as_u64().unwrap();
                let in_at = back["distanceIndex"].as_u64().unwrap();
                if hysteresis > 0 {
                    assert!(in_at < out_at, "{policy:?}");
                } else {
                    assert!(in_at <= out_at, "{policy:?}");
                }
            }
        }
    }
}
