import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const root = new URL("../../", import.meta.url);

test("Fox fixture is the actual replayed production import, with license and clip evidence", async () => {
  const proof = JSON.parse(await readFile(new URL("fixtures/imported-character/fox.production-import.json", root), "utf8"));
  const bytes = await readFile(new URL("fixtures/imported-character/fox.glb", root));
  const output = proof.result.outputs.output;
  expect(bytes.byteLength).toBe(output.byteLength);
  expect(createHash("sha256").update(bytes).digest("hex")).toBe(output.sha256);
  expect(output.metadata.operation).toBe("scene.import.gltf");
  expect(output.metadata.operationVersion).toBe("2");
  expect(output.metadata.sourceSha256).toBe(proof.source.sha256);
  expect(proof.identity.inputs.source).toEqual(proof.source);
  expect(proof.source.metadata.license).toBe("CC0-1.0 AND CC-BY-4.0");
  expect(proof.analysis.observations.accepted).toBe(true);
  expect(proof.result.observations.validatorWarnings).toEqual([]);
  expect(proof.result.observations.outputValidatorWarnings).toEqual([]);
  expect(proof.result.observations.clips.map((clip: { name: string }) => clip.name)).toEqual(["Survey", "Walk", "Run"]);
  expect(proof.result.observations.textureCount).toBe(1);
  expect(proof.replayExact).toBe(true);
});

test("game consumers have a public imported-character entrypoint rather than importing private web code", async () => {
  const manifest = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
  expect(manifest.exports["./imported-character"],
    "#87's reusable entrypoint is absent; private web/lib/imported-skin is not a consumer API").toBeDefined();
  // This intentionally binds only the public seam, not an invented parallel
  // skeleton/geometry representation. Instance and live Rust bridge coverage
  // must be independently authored against the settled implementation contract.
});
