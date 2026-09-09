export type PlaybackPose = {
  translation: [number, number, number];
  rotation: [number, number, number, number];
  scale: [number, number, number];
};

export type PlaybackFrame = {
  frame: number;
  deltaSeconds: number;
  wallTimeSeconds: number;
  playbackTimeSeconds: number;
  targetTimeSeconds: number;
  naiveFixedFrameTimeSeconds: number;
  transitionLinearProgress: number;
  blendFactor: number;
  transitionComplete: boolean;
  pose: PlaybackPose;
};

export type PlaybackFixture = {
  schemaVersion: 1;
  clipDurationSeconds: number;
  transitionDurationSeconds: number;
  transitionCurve: "smoothstep";
  naiveFrameSeconds: number;
  frames: PlaybackFrame[];
};

export function playbackFixtureUrl(pathname: string) {
  const basePath = pathname === "/3d-lab" || pathname.startsWith("/3d-lab/") ? "/3d-lab" : "";
  return `${basePath}/generated/playback-fixture.json`;
}
