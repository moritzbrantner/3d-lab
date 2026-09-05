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
  camera: {
    eye: [number, number, number];
    target: [number, number, number];
    up: [number, number, number];
    fovYRadians: number;
    aspect: number;
    near: number;
    far: number;
    viewMatrix: number[];
    webgpuProjectionMatrix: number[];
  };
};

const fixtureUrl = new URL("../../fixtures/renderer-parity/cube-and-transform.json", import.meta.url);
const fixture = JSON.parse(readFileSync(fixtureUrl, "utf8")) as RendererParityFixture;

function expectMatrixClose(actual: readonly number[], expected: readonly number[]) {
  expect(actual).toHaveLength(expected.length);
  actual.forEach((value, index) => {
    expect(value).toBeCloseTo(expected[index], 5);
  });
}

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

    expectMatrixClose(matrix.elements, columnMajorMatrix);
  });

  test("Three.js view and WebGPU projection conventions match the canonical camera", () => {
    const cameraFixture = fixture.camera;
    const camera = new THREE.PerspectiveCamera(
      THREE.MathUtils.radToDeg(cameraFixture.fovYRadians),
      cameraFixture.aspect,
      cameraFixture.near,
      cameraFixture.far,
    );
    camera.position.set(...cameraFixture.eye);
    camera.up.set(...cameraFixture.up);
    camera.lookAt(new THREE.Vector3(...cameraFixture.target));
    camera.updateMatrixWorld(true);

    const top = cameraFixture.near * Math.tan(cameraFixture.fovYRadians * 0.5);
    const height = 2 * top;
    const width = cameraFixture.aspect * height;
    const left = -0.5 * width;
    const webgpuProjection = new THREE.Matrix4().makePerspective(
      left,
      left + width,
      top,
      top - height,
      cameraFixture.near,
      cameraFixture.far,
      THREE.WebGPUCoordinateSystem,
      false,
    );

    expectMatrixClose(camera.matrixWorldInverse.elements, cameraFixture.viewMatrix);
    expectMatrixClose(webgpuProjection.elements, cameraFixture.webgpuProjectionMatrix);
  });
});
