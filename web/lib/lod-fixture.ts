export type LodFixtureLevel = {
  level: number;
  triangleCount: number;
  relativeError: number;
  indices: number[];
  triangleRatio?: number;
  requestedTriangleCount?: number;
};

export type LodSelectorSample = {
  distance: number;
  previousLevel: number;
  selectedLevel: number;
  projectedErrorPixels: number;
};

export type LodFixture = {
  schemaVersion: 1;
  simplifierId: string;
  meshExtent: number;
  positions: [number, number, number][];
  normals: [number, number, number][];
  source: LodFixtureLevel;
  levels: LodFixtureLevel[];
  selector: {
    targetPixelError: number;
    hysteresisFraction: number;
    viewportHeightPixels: number;
    verticalFovRadians: number;
    samples: LodSelectorSample[];
  };
};

export function lodFixtureUrl(pathname: string) {
  const basePath = pathname === "/3d-lab" || pathname.startsWith("/3d-lab/") ? "/3d-lab" : "";
  return `${basePath}/generated/lod-fixture.json`;
}

export function allLodLevels(fixture: LodFixture) {
  return [fixture.source, ...fixture.levels];
}
