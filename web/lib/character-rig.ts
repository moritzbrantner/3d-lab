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

export function sampleCharacterPose(motion: CharacterMotion, phase: number): CharacterPose {
  const normalized = ((phase % 1) + 1) % 1;
  const t = normalized * TAU;

  if (motion === "walk") {
    const stride = Math.sin(t);
    const counterStride = Math.sin(t + Math.PI);
    const kneeLeft = Math.max(0, -stride) * 0.8;
    const kneeRight = Math.max(0, -counterStride) * 0.8;
    return {
      rootX: Math.sin(t * 0.5) * 0.5,
      rootY: Math.abs(Math.sin(t)) * 0.08,
      rootYaw: stride * 0.08,
      spineZ: counterStride * 0.045,
      leftShoulderX: counterStride * 0.72,
      rightShoulderX: stride * 0.72,
      rightShoulderZ: 0,
      leftElbowX: -0.15 - Math.max(0, stride) * 0.28,
      rightElbowX: -0.15 - Math.max(0, counterStride) * 0.28,
      leftHipX: stride * 0.7,
      rightHipX: counterStride * 0.7,
      leftKneeX: kneeLeft,
      rightKneeX: kneeRight,
    };
  }

  if (motion === "wave") {
    const wave = Math.sin(t * 2);
    return {
      rootX: Math.sin(t) * 0.08,
      rootY: Math.sin(t) * 0.025,
      rootYaw: -0.12,
      spineZ: Math.sin(t) * 0.025,
      leftShoulderX: 0,
      rightShoulderX: 0,
      rightShoulderZ: 1.35,
      leftElbowX: -0.1,
      rightElbowX: -0.75 + wave * 0.55,
      leftHipX: 0,
      rightHipX: 0,
      leftKneeX: 0.08,
      rightKneeX: 0.08,
    };
  }

  const breath = Math.sin(t);
  return {
    rootX: 0,
    rootY: breath * 0.025,
    rootYaw: Math.sin(t * 0.5) * 0.035,
    spineZ: breath * 0.018,
    leftShoulderX: 0.08,
    rightShoulderX: -0.08,
    rightShoulderZ: 0,
    leftElbowX: -0.16,
    rightElbowX: -0.16,
    leftHipX: 0,
    rightHipX: 0,
    leftKneeX: 0.04,
    rightKneeX: 0.04,
  };
}
