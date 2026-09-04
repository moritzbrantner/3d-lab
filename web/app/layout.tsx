import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "3D Lab",
  description: "Interactive lessons for vertices, triangles, meshes, transforms, cameras, lighting, and animation.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
