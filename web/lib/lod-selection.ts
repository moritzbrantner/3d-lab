export type LodView = {
  meshExtent: number;
  distance: number;
  viewportHeightPixels: number;
  verticalFovRadians: number;
};

export type LodPolicy = {
  targetPixelError: number;
  hysteresisFraction: number;
};

export type LodSelection = {
  level: number;
  projectedErrorPixels: number;
};

function requireFinitePositive(value: number, label: string) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${label} must be finite and positive`);
  }
}

export function projectedErrorPixels(relativeError: number, view: LodView) {
  if (!Number.isFinite(relativeError) || relativeError < 0) {
    throw new Error("relative error must be finite and non-negative");
  }
  requireFinitePositive(view.meshExtent, "mesh extent");
  requireFinitePositive(view.distance, "camera distance");
  requireFinitePositive(view.viewportHeightPixels, "viewport height");
  if (!Number.isFinite(view.verticalFovRadians) || view.verticalFovRadians <= 0 || view.verticalFovRadians >= Math.PI) {
    throw new Error("vertical FOV must be finite and strictly between 0 and PI radians");
  }

  const projectionScale = view.viewportHeightPixels / (2 * Math.tan(view.verticalFovRadians * 0.5));
  return (relativeError * view.meshExtent * projectionScale) / view.distance;
}

export function selectLodLevel(
  relativeErrors: readonly number[],
  currentLevel: number,
  policy: LodPolicy,
  view: LodView,
): LodSelection {
  if (relativeErrors.length === 0) {
    throw new Error("LOD selection requires at least one level");
  }
  if (!Number.isInteger(currentLevel) || currentLevel < 0 || currentLevel >= relativeErrors.length) {
    throw new Error("current LOD level is outside the available levels");
  }
  if (!Number.isFinite(policy.targetPixelError) || policy.targetPixelError <= 0) {
    throw new Error("target pixel error must be finite and positive");
  }
  if (!Number.isFinite(policy.hysteresisFraction) || policy.hysteresisFraction < 0 || policy.hysteresisFraction >= 1) {
    throw new Error("hysteresis fraction must be within 0..1");
  }

  for (let level = 0; level < relativeErrors.length; level += 1) {
    const value = relativeErrors[level];
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`LOD level ${level} has an invalid relative error`);
    }
    if (level > 0 && value < relativeErrors[level - 1]) {
      throw new Error(`LOD level ${level} has less relative error than the preceding level`);
    }
  }

  const projectedErrors = relativeErrors.map((relativeError) => projectedErrorPixels(relativeError, view));
  let idealLevel = 0;
  for (let level = 0; level < projectedErrors.length; level += 1) {
    if (projectedErrors[level] <= policy.targetPixelError) {
      idealLevel = level;
    }
  }

  let selectedLevel = currentLevel;
  if (idealLevel > currentLevel) {
    const coarsenThreshold = policy.targetPixelError * (1 - policy.hysteresisFraction);
    for (let level = currentLevel + 1; level < projectedErrors.length; level += 1) {
      if (projectedErrors[level] <= coarsenThreshold) {
        selectedLevel = level;
      }
    }
  } else if (idealLevel < currentLevel) {
    const refineThreshold = policy.targetPixelError * (1 + policy.hysteresisFraction);
    if (projectedErrors[currentLevel] > refineThreshold) {
      selectedLevel = idealLevel;
    }
  }

  return {
    level: selectedLevel,
    projectedErrorPixels: projectedErrors[selectedLevel],
  };
}
