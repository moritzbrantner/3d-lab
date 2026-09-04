import type { NextConfig } from "next";

const onGitHubPages = process.env.GITHUB_ACTIONS === "true";
const repositoryName = "3d-lab";

const nextConfig: NextConfig = {
  output: "export",
  trailingSlash: true,
  images: {
    unoptimized: true,
  },
  basePath: onGitHubPages ? `/${repositoryName}` : "",
  assetPrefix: onGitHubPages ? `/${repositoryName}/` : undefined,
};

export default nextConfig;
