#!/usr/bin/env python3
"""Generate the deterministic scene used by the scene-export runtime canary."""

import json
from pathlib import Path
import sys

MESH_COUNT = 96
REFERENCED_VERTICES_PER_MESH = 192
SOURCE_VERTICES_PER_MESH = REFERENCED_VERTICES_PER_MESH + 1


def vertex(vertex_index: int) -> list[float]:
    return [
        (vertex_index % 16) * 0.125,
        ((vertex_index // 16) % 4) * 0.125,
        (vertex_index // 64) * 0.125,
    ]


def main() -> int:
    if len(sys.argv) != 3:
        raise SystemExit("usage: generate-scene-export-profile.py SCENE REQUEST")

    scene_path = Path(sys.argv[1])
    request_path = Path(sys.argv[2])
    scene_path.parent.mkdir(parents=True, exist_ok=True)
    request_path.parent.mkdir(parents=True, exist_ok=True)

    meshes = []
    nodes = []
    for mesh_index in reversed(range(MESH_COUNT)):
        mesh_id = f"mesh-{mesh_index:03d}"
        vertices = [vertex(index) for index in range(REFERENCED_VERTICES_PER_MESH)]
        vertices.append([999.0, 999.0, 999.0])
        meshes.append(
            {
                "id": mesh_id,
                "vertices": vertices,
                "indices": list(range(REFERENCED_VERTICES_PER_MESH)),
                "normals": [[0.0, 1.0, 0.0] for _ in range(SOURCE_VERTICES_PER_MESH)],
                "uvs": [
                    [
                        (index % 16) / 15.0,
                        (index // 16) / 11.0,
                    ]
                    for index in range(SOURCE_VERTICES_PER_MESH)
                ],
            }
        )
        nodes.append(
            {
                "id": f"node-{mesh_index:03d}",
                "parent": None,
                "mesh": mesh_id,
                "translation": [float(mesh_index % 12), 0.0, float(mesh_index // 12)],
                "rotation": [0.0, 0.0, 0.0, 1.0],
                "scale": [1.0, 1.0, 1.0],
            }
        )

    scene = {
        "schemaVersion": 1,
        "coordinateSystem": "right-handed-y-up",
        "unit": "meter",
        "meshes": meshes,
        "nodes": nodes,
    }
    scene_path.write_text(
        json.dumps(scene, separators=(",", ":"), allow_nan=False),
        encoding="utf-8",
    )

    request = {
        "schemaVersion": 1,
        "operation": "scene.export.glb",
        "inputPath": scene_path.as_posix(),
        "parameters": {},
    }
    request_path.write_text(
        json.dumps(request, separators=(",", ":"), allow_nan=False),
        encoding="utf-8",
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
