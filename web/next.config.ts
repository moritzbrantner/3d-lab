import type { NextConfig } from "next";
import path from "node:path";

const onGitHubPages = process.env.GITHUB_ACTIONS === "true";
const repositoryName = "3d-lab";

const nextConfig: NextConfig = {
  output: "export",
  trailingSlash: true,
  // The app and reusable renderer share this repository. Resolve the runtime
  // adapter directly, avoiding Bun file:.. package.json symlink redirects in
  // Turbopack. TypeScript still checks the public package's declaration export.
  turbopack: {
    root: path.join(__dirname, ".."),
    resolveAlias: {
      "@moritzbrantner/three-d-renderer/rigid-skin": "./packages/renderer/rigid-skin.js",
    },
  },
  images: {
    unoptimized: true,
  },
  basePath: onGitHubPages ? `/${repositoryName}` : "",
  assetPrefix: onGitHubPages ? `/${repositoryName}/` : undefined,
};

export default nextConfig;
