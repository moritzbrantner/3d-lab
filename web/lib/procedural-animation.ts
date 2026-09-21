export type Vec3Value = {
  readonly x: number;
  readonly y: number;
  readonly z: number;
};

export type TwoBoneIkInput = {
  readonly root: Vec3Value;
  readonly target: Vec3Value;
  readonly pole: Vec3Value;
  readonly upperLength: number;
  readonly lowerLength: number;
};

export type TwoBoneIkSolution = {
  readonly root: Vec3Value;
  readonly knee: Vec3Value;
  readonly end: Vec3Value;
  readonly requestedTarget: Vec3Value;
  readonly requestedDistance: number;
  readonly solvedDistance: number;
  readonly reachedTarget: boolean;
};

export type TerrainProfile = "slope" | "stairs" | "uneven";

export type GroundContactSample = {
  readonly position: Vec3Value;
  readonly normal: Vec3Value;
  readonly supportId: string;
};

const EPSILON = 1e-6;

function vector(x: number, y: number, z: number): Vec3Value {
  return { x, y, z };
}

function assertFiniteVector(name: string, value: Vec3Value) {
  if (![value.x, value.y, value.z].every(Number.isFinite)) {
    throw new Error(`${name} must contain only finite coordinates`);
  }
}

function add(left: Vec3Value, right: Vec3Value): Vec3Value {
  return vector(left.x + right.x, left.y + right.y, left.z + right.z);
}

function subtract(left: Vec3Value, right: Vec3Value): Vec3Value {
  return vector(left.x - right.x, left.y - right.y, left.z - right.z);
}

function scale(value: Vec3Value, factor: number): Vec3Value {
  return vector(value.x * factor, value.y * factor, value.z * factor);
}

function dot(left: Vec3Value, right: Vec3Value): number {
  return left.x * right.x + left.y * right.y + left.z * right.z;
}

function cross(left: Vec3Value, right: Vec3Value): Vec3Value {
  return vector(
    left.y * right.z - left.z * right.y,
    left.z * right.x - left.x * right.z,
    left.x * right.y - left.y * right.x,
  );
}

function length(value: Vec3Value): number {
  return Math.hypot(value.x, value.y, value.z);
}

function normalized(value: Vec3Value): Vec3Value | null {
  const magnitude = length(value);
  return magnitude > EPSILON ? scale(value, 1 / magnitude) : null;
}

function deterministicPerpendicular(direction: Vec3Value): Vec3Value {
  const absolute = [Math.abs(direction.x), Math.abs(direction.y), Math.abs(direction.z)];
  const axis =
    absolute[0] <= absolute[1] && absolute[0] <= absolute[2]
      ? vector(1, 0, 0)
      : absolute[1] <= absolute[2]
        ? vector(0, 1, 0)
        : vector(0, 0, 1);
  return normalized(cross(direction, axis)) ?? vector(0, 1, 0);
}

export function solveTwoBoneIk(input: TwoBoneIkInput): TwoBoneIkSolution {
  assertFiniteVector("root", input.root);
  assertFiniteVector("target", input.target);
  assertFiniteVector("pole", input.pole);

  if (
    !Number.isFinite(input.upperLength) ||
    !Number.isFinite(input.lowerLength) ||
    input.upperLength <= EPSILON ||
    input.lowerLength <= EPSILON
  ) {
    throw new Error("two-bone segment lengths must be finite and greater than zero");
  }

  const toTarget = subtract(input.target, input.root);
  const requestedDistance = length(toTarget);
  const poleDirection = normalized(subtract(input.pole, input.root));
  const reachDirection =
    normalized(toTarget) ?? poleDirection ?? vector(1, 0, 0);

  const poleDelta = subtract(input.pole, input.root);
  const projectedPole = subtract(
    poleDelta,
    scale(reachDirection, dot(poleDelta, reachDirection)),
  );
  const bendDirection =
    normalized(projectedPole) ?? deterministicPerpendicular(reachDirection);

  const minimumReach = Math.abs(input.upperLength - input.lowerLength);
  const maximumReach = input.upperLength + input.lowerLength;
  const reachedTarget =
    requestedDistance >= minimumReach - EPSILON &&
    requestedDistance <= maximumReach + EPSILON;

  if (requestedDistance <= EPSILON && minimumReach <= EPSILON) {
    return {
      root: input.root,
      knee: add(input.root, scale(bendDirection, input.upperLength)),
      end: input.root,
      requestedTarget: input.target,
      requestedDistance,
      solvedDistance: 0,
      reachedTarget: true,
    };
  }

  const solvedDistance = Math.min(
    Math.max(requestedDistance, Math.max(minimumReach, EPSILON)),
    maximumReach,
  );
  const end = add(input.root, scale(reachDirection, solvedDistance));
  const along =
    (input.upperLength * input.upperLength -
      input.lowerLength * input.lowerLength +
      solvedDistance * solvedDistance) /
    (2 * solvedDistance);
  const height = Math.sqrt(
    Math.max(input.upperLength * input.upperLength - along * along, 0),
  );
  const knee = add(
    add(input.root, scale(reachDirection, along)),
    scale(bendDirection, height),
  );

  return {
    root: input.root,
    knee,
    end,
    requestedTarget: input.target,
    requestedDistance,
    solvedDistance,
    reachedTarget,
  };
}

export function sampleTeachingTerrain(
  profile: TerrainProfile,
  x: number,
  z: number,
): GroundContactSample {
  if (!Number.isFinite(x) || !Number.isFinite(z)) {
    throw new Error("terrain sample coordinates must be finite");
  }

  if (profile === "slope") {
    const gradient = 0.16;
    const normal = normalized(vector(-gradient, 1, 0)) ?? vector(0, 1, 0);
    return {
      position: vector(x, x * gradient, z),
      normal,
      supportId: "slope",
    };
  }

  if (profile === "stairs") {
    const stepWidth = 0.78;
    const stepHeight = 0.16;
    const level = Math.floor(x / stepWidth);
    return {
      position: vector(x, level * stepHeight, z),
      normal: vector(0, 1, 0),
      supportId: `stair-${level}`,
    };
  }

  const wave = x * 0.92 + z * 0.38;
  const crossWave = z * 1.85 - x * 0.22;
  const height = Math.sin(wave) * 0.26 + Math.cos(crossWave) * 0.09;
  const dx = Math.cos(wave) * 0.26 * 0.92 + Math.sin(crossWave) * 0.09 * 0.22;
  const dz = Math.cos(wave) * 0.26 * 0.38 - Math.sin(crossWave) * 0.09 * 1.85;
  const normal = normalized(vector(-dx, 1, -dz)) ?? vector(0, 1, 0);

  return {
    position: vector(x, height, z),
    normal,
    supportId: "uneven-ground",
  };
}
