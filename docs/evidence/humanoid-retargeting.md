# Humanoid retargeting evidence

Issue: #64

`three_d_animation::retarget` maps explicit humanoid semantics to already-known
numeric pose nodes. It never assumes that source and target node indices match.

Each rig owns an authoritative local rest pose and a positive reference height.
Retargeting computes source motion relative to the source rest transform, applies
the rotation delta on top of the target rest rotation, and scales translation
deltas by `target_height / source_height`. Scale animation is transferred as a
component-wise ratio relative to the source rest scale.

Required humanoid roles fail at rig construction when absent. Chest, neck, hands,
and feet are optional; if the target has an optional semantic that the source does
not, its target rest transform is preserved.

Correctness tests use deliberately different arm bind rotations and body heights,
verify root-motion scaling, required-bone failures, optional-bone preservation,
and stable caller-owned output storage.

Run the native diagnostic benchmark with:

`cargo bench -p three-d-animation --bench retargeting`

It performs one million retargets and prints raw JSON timing. Timing is not a CI
gate; output-buffer identity is the deterministic allocation ratchet.
