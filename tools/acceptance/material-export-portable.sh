#!/usr/bin/env bash
set -euo pipefail
# Export only through real Rust; consumer receives no source GLB/resource workspace.
project_root=$(cd "$(dirname "$0")/../.." && pwd)
proof_root=${1:?provide a fresh external evidence directory}
blender_bin=${2:?provide verified Blender5.0.1 binary}
if [[ -e "$proof_root" ]]; then
  echo 'Evidence path must be new; retained evidence is not overwritten' >&2
  exit 1
fi
mkdir -p "$proof_root/portable"
proof_root=$(cd "$proof_root" && pwd)
cd "$project_root"
THREE_D_EXPORT_ACCEPTANCE_OUTPUT="$proof_root/portable" cargo test -p three-d-export --test material_scene_contract -- --test-threads=1
for kind in authored caller-bound; do
  "$blender_bin" --background --factory-startup --python "$project_root/tools/acceptance/material-export-blender.py" -- \
    --glb "$proof_root/portable/$kind.glb" --checker "$project_root/crates/three-d-export/tests/fixtures/checker.png" --report "$proof_root/$kind-report.json"
  python3 - "$proof_root/$kind-report.json" <<'PYREPORT'
import json
import sys
report = json.load(open(sys.argv[1]))
assert report.get('passed') is True, report
PYREPORT
done
