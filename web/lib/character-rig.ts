export type CharacterMotion = "idle" | "walk" | "wave";

export type CharacterPose = {
  rootX: number;
  rootY: number;
  rootYaw: number;
  spineZ: number;
  leftShoulderX: number;
  rightShoulderX: number;
  rightShoulderZ: number;
  leftElbowX: number;
  rightElbowX: number;
  leftHipX: number;
  rightHipX: number;
  leftKneeX: number;
  rightKneeX: number;
};

const TAU = Math.PI * 2;
export const CHARACTER_CYCLE_SECONDS = 1 / 0.42;
export const CHARACTER_PREVIEW_FPS = 60;

export function createCharacterPose(): CharacterPose {
  return {
    rootX: 0, rootY: 0, rootYaw: 0, spineZ: 0,
    leftShoulderX: 0, rightShoulderX: 0, rightShoulderZ: 0,
    leftElbowX: 0, rightElbowX: 0, leftHipX: 0, rightHipX: 0,
    leftKneeX: 0, rightKneeX: 0,
  };
}

/** Reusable output; every channel is overwritten, including when clips change. */
export function sampleCharacterPoseInto(
  motion: CharacterMotion,
  phase: number,
  pose: CharacterPose,
): CharacterPose {
  if (!Number.isFinite(phase)) throw new RangeError("character phase must be finite");
  const normalized = ((phase % 1) + 1) % 1;
  const t = normalized * TAU;
  const sine = Math.sin(t);

  if (motion === "walk") {
    const stride = sine;
    const counterStride = -stride;
    // Full-cycle signals have matching values AND velocities at the seam.
    pose.rootX = sine * 0.5;
    pose.rootY = sine * sine * 0.08;
    pose.rootYaw = stride * 0.08;
    pose.spineZ = counterStride * 0.045;
    pose.leftShoulderX = counterStride * 0.72;
    pose.rightShoulderX = stride * 0.72;
    pose.rightShoulderZ = 0;
    pose.leftElbowX = -0.15 - Math.max(0, stride) * 0.28;
    pose.rightElbowX = -0.15 - Math.max(0, counterStride) * 0.28;
    pose.leftHipX = stride * 0.7;
    pose.rightHipX = counterStride * 0.7;
    pose.leftKneeX = Math.max(0, -stride) * 0.8;
    pose.rightKneeX = Math.max(0, -counterStride) * 0.8;
  } else if (motion === "wave") {
    pose.rootX = sine * 0.08;
    pose.rootY = sine * 0.025;
    pose.rootYaw = -0.12;
    pose.spineZ = sine * 0.025;
    pose.leftShoulderX = 0;
    pose.rightShoulderX = 0;
    pose.rightShoulderZ = 1.35;
    pose.leftElbowX = -0.1;
    pose.rightElbowX = -0.75 + Math.sin(t * 2) * 0.55;
    pose.leftHipX = 0;
    pose.rightHipX = 0;
    pose.leftKneeX = 0.08;
    pose.rightKneeX = 0.08;
  } else {
    pose.rootX = 0;
    pose.rootY = sine * 0.025;
    pose.rootYaw = sine * 0.035;
    pose.spineZ = sine * 0.018;
    pose.leftShoulderX = 0.08;
    pose.rightShoulderX = -0.08;
    pose.rightShoulderZ = 0;
    pose.leftElbowX = -0.16;
    pose.rightElbowX = -0.16;
    pose.leftHipX = 0;
    pose.rightHipX = 0;
    pose.leftKneeX = 0.04;
    pose.rightKneeX = 0.04;
  }
  return pose;
}

/** Convenience snapshot API; the preview uses sampleCharacterPoseInto instead. */
export function sampleCharacterPose(motion: CharacterMotion, phase: number): CharacterPose {
  return sampleCharacterPoseInto(motion, phase, createCharacterPose());
}

export function stepCharacterPhase(phase: number, frames: number): number {
  if (!Number.isFinite(phase) || !Number.isInteger(frames)) {
    throw new RangeError("frame stepping requires a finite phase and integer frame count");
  }
  return Math.min(1, Math.max(0, phase + frames / (CHARACTER_PREVIEW_FPS * CHARACTER_CYCLE_SECONDS)));
}
