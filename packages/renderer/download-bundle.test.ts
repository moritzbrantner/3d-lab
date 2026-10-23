import { expect, test } from "bun:test";
import { downloadEntry, bindSharedAnimations } from "./download-bundle.js";

const fail = (message: string): never => {
  throw new Error(message);
};
const entry = {
  key: "ranger",
  variant: "default",
  files: ["ranger.default.gltf", "ranger.default.bin"],
  textures: [],
  clips: "ranger.clips.glb",
};
test("existing asset-downloads-v1 selects exactly one entry and rejects undeclared paths", () => {
  expect(
    downloadEntry({ schema: "asset-downloads-v1", entries: [entry] }, "ranger", "default", fail),
  ).toBe(entry);
  expect(() =>
    downloadEntry({ schema: "wrong", entries: [entry] }, "ranger", "default", fail),
  ).toThrow(/asset-downloads-v1/);
  expect(() =>
    downloadEntry({ schema: "asset-downloads-v1", entries: [entry] }, "ranger", "knight", fail),
  ).toThrow(/no ranger\/knight/);
  expect(() =>
    downloadEntry(
      { schema: "asset-downloads-v1", entries: [{ ...entry, files: ["../escape.gltf"] }] },
      "ranger",
      "default",
      fail,
    ),
  ).toThrow(/filename/);
});
const accessor = { componentType: 5126, type: "SCALAR", count: 2 };
function documents() {
  return {
    target: { nodes: [{ name: "hand" }, { name: "hip" }], accessors: [accessor], animations: [] },
    clips: {
      nodes: [{ name: "hip" }, { name: "hand" }],
      accessors: [accessor, accessor],
      animations: [
        {
          name: "Walk",
          samplers: [{ input: 0, output: 1 }],
          channels: [{ sampler: 0, target: { node: 0, path: "translation" } }],
        },
      ],
    },
  };
}
test("shared clips bind authored names, not entry-local node indices", () => {
  const { target, clips } = documents();
  bindSharedAnimations(target, clips, fail);
  expect(target.animations).toEqual([
    {
      name: "Walk",
      samplers: [{ input: 1, output: 2 }],
      channels: [{ sampler: 0, target: { node: 1, path: "translation" } }],
    },
  ]);
  expect(clips.animations[0].channels[0].target.node).toBe(0);
});
test("shared clips reject missing/ambiguous joints and duplicate clips before mutation", () => {
  for (const nodes of [[{ name: "hand" }], [{ name: "hip" }, { name: "hip" }]]) {
    const { target, clips } = documents();
    target.nodes = nodes;
    expect(() => bindSharedAnimations(target, clips, fail)).toThrow(/unique joint hip/);
    expect(target.animations).toEqual([]);
  }
  const { target, clips } = documents();
  target.animations = clips.animations as never[];
  expect(() => bindSharedAnimations(target, clips, fail)).toThrow(/duplicate clip/);
});

// A real rolling-release meshopt + quantization entry, small enough for the
// ordinary offline gate. source.json records its producer/source and byte hashes.
import { readFile } from "node:fs/promises";
import { adaptImportedItemBundle } from "./imported-character.js";
// The package is browser-native; Bun lacks only this FileLoader progress event.
if (typeof globalThis.ProgressEvent === "undefined") {
  globalThis.ProgressEvent = class extends Event {
    constructor(type: string, init: Record<string, unknown>) {
      super(type);
      Object.assign(this, init);
    }
  } as typeof ProgressEvent;
}
const fixture = new URL("../../fixtures/compressed-ranger/", import.meta.url);
const manifest = JSON.parse(await readFile(new URL("index.json", fixture), "utf8"));
const source = {
  manifest,
  key: "equipment.sword.arming",
  readResource: async (path: string) => new Uint8Array(await readFile(new URL(path, fixture))),
};
test("real meshopt/quantized sword loads, retains grip and releases shared resources once", async () => {
  const progress: { loadedBytes: number; totalBytes: number }[] = [];
  const item = await adaptImportedItemBundle(source, { onProgress: (p) => progress.push(p) });
  expect(item.frames.grip).toHaveLength(16);
  const a = item.createInstance(),
    b = item.createInstance();
  const meshes: any[] = [];
  a.root.traverse((node: any) => {
    if (node.isMesh) {
      meshes.push(node);
    }
  });
  const other: any[] = [];
  b.root.traverse((node: any) => {
    if (node.isMesh) {
      other.push(node);
    }
  });
  expect(meshes.length).toBeGreaterThan(0);
  const resources = new Set<any>();
  meshes.forEach((mesh, i) => {
    expect(mesh.geometry).toBe(other[i].geometry);
    expect(mesh.material).toBe(other[i].material);
    expect([...mesh.geometry.attributes.position.array].every(Number.isFinite)).toBe(true);
    resources.add(mesh.geometry);
    resources.add(mesh.material);
  });
  let disposed = 0;
  for (const resource of resources) {
    resource.addEventListener("dispose", () => {
      disposed++;
    });
  }
  item.dispose();
  item.dispose();
  expect(disposed).toBe(resources.size);
  expect(() => item.createInstance()).toThrow(/disposed/);
  expect(progress.at(-1)?.loadedBytes).toBe(progress.at(-1)?.totalBytes);
});
test("compressed downloads reject missing and undeclared geometry", async () => {
  await expect(
    adaptImportedItemBundle({
      ...source,
      readResource: async (path: string) => {
        if (path.endsWith(".bin")) {
          throw Error("missing geometry");
        }
        return source.readResource(path);
      },
    }),
  ).rejects.toThrow(/missing geometry/);
  await expect(
    adaptImportedItemBundle({
      ...source,
      manifest: {
        ...manifest,
        entries: [{ ...manifest.entries[0], files: ["equipment.sword.arming.default.gltf"] }],
      },
    }),
  ).rejects.toThrow(/not a declared/);
});
