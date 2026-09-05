import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import * as THREE from "three";
import { cubeMesh } from "./mesh";

type RendererParityFixture = {
  mesh: {
    positions: [number, number, number][];
    indices: number[];
  };
  transform: {
    translation: [number, number, number];
    rotationAxis: [number, number, number];
    rotationRadians: number;
    scale: [number, number, number];
    columnMajorMatrix: number[];
  };
};

const fixtureUrl = new URL("../../fixtures/renderer-parity/cube-and-transform.json", import.meta.url);
const fixture = JSON.parse(readFileSync(fixtureUrl, "utf8")) as RendererParityFixture;

describe("renderer parity fixture", () => {
  test("browser cube data matches the canonical mesh", () => {
    expect(cubeMesh.vertices).toEqual(fixture.mesh.positions);
    expect(cubeMesh.indices).toEqual(fixture.mesh.indices);
  });

  test("Three.js TRS composition matches the canonical column-major matrix", () => {
    const { translation, rotationAxis, rotationRadians, scale, columnMajorMatrix } = fixture.transform;
    const axis = new THREE.Vector3(...rotationAxis).normalize();
    const rotation = new THREE.Matrix4().makeRotationAxis(axis, rotationRadians);
    const matrix = new THREE.Matrix4()
      .makeTranslation(...translation)
      .multiply(rotation)
      .multiply(new THREE.Matrix4().makeScale(...scale));

    expect(matrix.elements).toHaveLength(columnMajorMatrix.length);
    matrix.elements.forEach((actual, index) => {
      expect(actual).toBeCloseTo(columnMajorMatrix[index], 5);
    });
  });
});
