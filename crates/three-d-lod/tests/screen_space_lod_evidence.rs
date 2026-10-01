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
    let policies = document["viewports"]
        .as_array()
        .unwrap()
        .iter()
        .flat_map(|viewport| viewport["policies"].as_array().unwrap());
    for policy in policies {
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

fn first_outbound_switch(viewport: &serde_json::Value, budget: f64, hysteresis: u64) -> u64 {
    let policy = viewport["policies"]
        .as_array()
        .unwrap()
        .iter()
        .find(|policy| {
            policy["maxPixelError"].as_f64() == Some(budget)
                && policy["hysteresisPercent"].as_u64() == Some(hysteresis)
        })
        .unwrap();
    policy["outboundSwitches"][0]["distanceIndex"]
        .as_u64()
        .unwrap()
}

#[test]
fn every_offered_viewport_height_has_its_own_decision_tables() {
    let document = evidence::evidence();
    let viewports = document["viewports"].as_array().unwrap();
    let heights = viewports
        .iter()
        .map(|viewport| viewport["heightPixels"].as_f64().unwrap() as f32)
        .collect::<Vec<_>>();
    assert_eq!(heights, evidence::VIEWPORT_HEIGHTS_PIXELS);

    let tallest = viewports.last().unwrap();
    let tallest_height = tallest["heightPixels"].as_f64().unwrap();
    for viewport in viewports {
        let height = viewport["heightPixels"].as_f64().unwrap();
        // Projected error scales linearly with viewport height at every sample.
        let rows = viewport["projectedErrorPixels"].as_array().unwrap();
        let tallest_rows = tallest["projectedErrorPixels"].as_array().unwrap();
        for (row, tallest_row) in rows.iter().zip(tallest_rows) {
            for (pixels, tallest_pixels) in row
                .as_array()
                .unwrap()
                .iter()
                .zip(tallest_row.as_array().unwrap())
            {
                let expected = tallest_pixels.as_f64().unwrap() * height / tallest_height;
                assert!((pixels.as_f64().unwrap() - expected).abs() <= 1e-4 * expected.max(1.0));
            }
        }
        // A shorter viewport shows less error per unit, so it coarsens nearer to the camera.
        if height < tallest_height {
            assert!(
                first_outbound_switch(viewport, 2.0, 25) < first_outbound_switch(tallest, 2.0, 25),
                "{height} px viewport should coarsen nearer than {tallest_height} px"
            );
        }
    }
}
