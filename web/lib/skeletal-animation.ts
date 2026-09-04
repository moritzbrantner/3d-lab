import { Matrix4, Vector3 } from "three";

export const TEACHING_CLIP_DURATION = 2;

export type TeachingPose = {
  shoulder: number;
  elbow: number;
  wrist: number;
};

export type Weight4 = readonly [number, number, number, number];
export type Joint4 = readonly [number, number, number, number];

export type SkinInfluence = {
  joints: Joint4;
  weights: Weight4;
};

export type SkinningReadout = {
  bindPoint: readonly [number, number, number];
  rootContribution: readonly [number, number, number];
  middleContribution: readonly [number, number, number];
  blendedPoint: readonly [number, number, number];
  weights: readonly [number, number];
  jointOrigins: readonly (readonly [number, number, number])[];
};

function toTuple(vector: Vector3): readonly [number, number, number] {
  return [vector.x, vector.y, vector.z];
}

export function normalizeSkinWeights(weights: Weight4): Weight4 {
  const values = [...weights];
  values.forEach((weight, slot) => {
    if (!Number.isFinite(weight) || weight < 0) {
      throw new Error(`skin weight ${slot} must be finite and non-negative`);
    }
  });

  const total = values.reduce((sum, weight) => sum + weight, 0);
  if (total <= Number.EPSILON) {
    throw new Error("skin weights must have a positive total");
  }

  return values.map((weight) => weight / total) as unknown as Weight4;
}

export function skinMatrix(jointWorld: Matrix4, inverseBind: Matrix4): Matrix4 {
  return jointWorld.clone().multiply(inverseBind);
}

export function linearBlendSkinPoint(
  bindPoint: Vector3,
  skinMatrices: readonly Matrix4[],
  influence: SkinInfluence,
): Vector3 {
  const weights = normalizeSkinWeights(influence.weights);
  const result = new Vector3();

  for (let slot = 0; slot < 4; slot += 1) {
    const weight = weights[slot];
    if (weight <= 0) continue;

    const joint = influence.joints[slot];
    const matrix = skinMatrices[joint];
    if (!matrix) {
      throw new Error(`skin influence references missing joint ${joint}`);
    }

    result.add(bindPoint.clone().applyMatrix4(matrix).multiplyScalar(weight));
  }

  return result;
}

function smoothStep(value: number): number {
  const t = Math.min(Math.max(value, 0), 1);
  return t * t * (3 - 2 * t);
}

function sampleTrack(time: number, values: readonly [number, number, number]): number {
  const clamped = Math.min(Math.max(time, 0), TEACHING_CLIP_DURATION);
  if (clamped <= 1) {
    const t = smoothStep(clamped);
    return values[0] + (values[1] - values[0]) * t;
  }
  const t = smoothStep(clamped - 1);
  return values[1] + (values[2] - values[1]) * t;
}

export function sampleTeachingPose(time: number): TeachingPose {
  return {
    shoulder: sampleTrack(time, [-18, 26, -18]),
    elbow: sampleTrack(time, [18, 68, 18]),
    wrist: sampleTrack(time, [8, -36, 8]),
  };
}

function rotationZ(degrees: number): Matrix4 {
  return new Matrix4().makeRotationZ((degrees * Math.PI) / 180);
}

function translation(y: number): Matrix4 {
  return new Matrix4().makeTranslation(0, y, 0);
}

export function buildTeachingSkinningReadout(
  pose: TeachingPose,
  middleWeight: number,
): SkinningReadout {
  const weight = Math.min(Math.max(middleWeight, 0), 1);

  const rootBind = translation(-1.5);
  const middleBind = rootBind.clone().multiply(translation(1.5));
  const tipBind = middleBind.clone().multiply(translation(1.5));

  const rootWorld = translation(-1.5).multiply(rotationZ(pose.shoulder));
  const middleWorld = rootWorld
    .clone()
    .multiply(translation(1.5))
    .multiply(rotationZ(pose.elbow));
  const tipWorld = middleWorld
    .clone()
    .multiply(translation(1.5))
    .multiply(rotationZ(pose.wrist));

  const skinMatrices = [
    skinMatrix(rootWorld, rootBind.clone().invert()),
    skinMatrix(middleWorld, middleBind.clone().invert()),
    skinMatrix(tipWorld, tipBind.clone().invert()),
  ];

  const bindPoint = new Vector3(0.32, 0.15, 0);
  const rootContribution = bindPoint.clone().applyMatrix4(skinMatrices[0]);
  const middleContribution = bindPoint.clone().applyMatrix4(skinMatrices[1]);
  const blendedPoint = linearBlendSkinPoint(bindPoint, skinMatrices, {
    joints: [0, 1, 0, 0],
    weights: [1 - weight, weight, 0, 0],
  });

  return {
    bindPoint: toTuple(bindPoint),
    rootContribution: toTuple(rootContribution),
    middleContribution: toTuple(middleContribution),
    blendedPoint: toTuple(blendedPoint),
    weights: [1 - weight, weight],
    jointOrigins: [rootWorld, middleWorld, tipWorld].map((matrix) =>
      toTuple(new Vector3().applyMatrix4(matrix)),
    ),
  };
}

export const MODEL_ASSEMBLY = [
  { id: "mesh", label: "mesh primitive", detail: "POSITION / NORMAL / indices" },
  { id: "weights", label: "skin attributes", detail: "JOINTS_0 + WEIGHTS_0" },
  { id: "node", label: "mesh node", detail: "node.mesh + node.skin" },
  { id: "skin", label: "skin", detail: "joints[] + inverseBindMatrices" },
  { id: "joints", label: "joint nodes", detail: "ordinary nodes in a hierarchy" },
  { id: "clip", label: "animation", detail: "sampler → channel → joint TRS" },
] as const;

export type ModelAssemblyId = (typeof MODEL_ASSEMBLY)[number]["id"];
