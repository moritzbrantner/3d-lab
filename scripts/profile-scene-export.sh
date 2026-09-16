#!/usr/bin/env bash
set -euo pipefail

root="$(git rev-parse --show-toplevel)"
cd "$root"

profile_dir="$root/target/runtime-profile/scene-export"
scene="$profile_dir/scene.json"
request="$profile_dir/request.json"
output="$profile_dir/output.glb"
observations="$profile_dir/observations.json"
binary="$root/target/release/scene_export_glb"

mkdir -p "$profile_dir"
if [[ ! -f "$scene" || ! -f "$request" ]]; then
  python3 "$root/scripts/generate-scene-export-profile.py" "$scene" "$request"
fi

needs_build=0
if [[ ! -x "$binary" ]]; then
  needs_build=1
elif [[ "$root/Cargo.toml" -nt "$binary" || "$root/Cargo.lock" -nt "$binary" ]]; then
  needs_build=1
elif find "$root/crates" "$root/examples/asset-tooling-scene-adapter" \
  -type f \( -name '*.rs' -o -name 'Cargo.toml' \) -newer "$binary" -print -quit | grep -q .; then
  needs_build=1
fi

if [[ "$needs_build" -eq 1 ]]; then
  cargo build --quiet --release \
    --manifest-path "$root/Cargo.toml" \
    -p asset-tooling-scene-adapter \
    --bin scene_export_glb
fi

exec "$binary" generate "$request" "$output" "$observations"
