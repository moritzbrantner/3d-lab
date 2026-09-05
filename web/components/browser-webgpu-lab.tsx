/// <reference types="@webgpu/types" />
"use client";

import { useEffect, useRef, useState } from "react";
import { triangleMesh } from "@/lib/mesh";
import { packWebGpuMesh } from "@/lib/webgpu-mesh";
import styles from "./renderer-comparison-lab.module.css";

const SHADER = `
struct VertexInput {
  @location(0) position: vec3<f32>,
};

@vertex
fn vs_main(input: VertexInput) -> @builtin(position) vec4<f32> {
  return vec4<f32>(input.position, 1.0);
}

@fragment
fn fs_main() -> @location(0) vec4<f32> {
  return vec4<f32>(0.2, 0.65, 1.0, 1.0);
}
`;

type WebGpuStatus = "checking" | "rendered" | "unavailable" | "error";

const statusCopy: Record<WebGpuStatus, string> = {
  checking: "Checking for a browser WebGPU adapter…",
  rendered: "The triangle was submitted through the browser WebGPU pipeline.",
  unavailable: "WebGPU is not available here. The comparison remains readable without it.",
  error: "The browser exposed WebGPU, but this minimal pipeline could not be completed.",
};

export function BrowserWebGpuLab() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [status, setStatus] = useState<WebGpuStatus>("checking");

  useEffect(() => {
    let active = true;
    let context: GPUCanvasContext | null = null;
    let device: GPUDevice | null = null;

    const render = async () => {
      const canvas = canvasRef.current;
      if (!canvas) return;

      if (!navigator.gpu) {
        setStatus("unavailable");
        return;
      }

      const adapter = await navigator.gpu.requestAdapter();
      if (!active) return;
      if (!adapter) {
        setStatus("unavailable");
        return;
      }

      const nextDevice = await adapter.requestDevice();
      if (!active) {
        nextDevice.destroy();
        return;
      }
      device = nextDevice;

      context = canvas.getContext("webgpu");
      if (!context) {
        setStatus("unavailable");
        return;
      }

      const pixelRatio = Math.min(window.devicePixelRatio, 2);
      canvas.width = Math.max(1, Math.floor(canvas.clientWidth * pixelRatio));
      canvas.height = Math.max(1, Math.floor(canvas.clientHeight * pixelRatio));

      const format = navigator.gpu.getPreferredCanvasFormat();
      context.configure({ device, format, alphaMode: "opaque" });

      const packed = packWebGpuMesh(triangleMesh);
      const vertexBuffer = device.createBuffer({
        label: "3d-lab browser triangle vertices",
        size: packed.vertices.byteLength,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      });
      device.queue.writeBuffer(vertexBuffer, 0, packed.vertices);

      const indexBuffer = device.createBuffer({
        label: "3d-lab browser triangle indices",
        size: packed.indices.byteLength,
        usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
      });
      device.queue.writeBuffer(indexBuffer, 0, packed.indices);

      const shader = device.createShaderModule({
        label: "3d-lab browser comparison shader",
        code: SHADER,
      });
      const pipeline = device.createRenderPipeline({
        label: "3d-lab browser comparison pipeline",
        layout: "auto",
        vertex: {
          module: shader,
          entryPoint: "vs_main",
          buffers: [
            {
              arrayStride: 12,
              attributes: [{ shaderLocation: 0, offset: 0, format: "float32x3" }],
            },
          ],
        },
        fragment: {
          module: shader,
          entryPoint: "fs_main",
          targets: [{ format }],
        },
        primitive: { topology: "triangle-list" },
      });

      const encoder = device.createCommandEncoder({ label: "3d-lab browser comparison encoder" });
      const pass = encoder.beginRenderPass({
        label: "3d-lab browser comparison pass",
        colorAttachments: [
          {
            view: context.getCurrentTexture().createView(),
            clearValue: { r: 0.047, g: 0.067, b: 0.102, a: 1 },
            loadOp: "clear",
            storeOp: "store",
          },
        ],
      });
      pass.setPipeline(pipeline);
      pass.setVertexBuffer(0, vertexBuffer);
      pass.setIndexBuffer(indexBuffer, "uint32");
      pass.drawIndexed(packed.indices.length);
      pass.end();
      device.queue.submit([encoder.finish()]);

      if (active) setStatus("rendered");
    };

    render().catch(() => {
      if (active) setStatus("error");
    });

    return () => {
      active = false;
      context?.unconfigure();
      device?.destroy();
    };
  }, []);

  return (
    <article className={styles.comparison}>
      <section className={styles.heroGrid} aria-labelledby="browser-webgpu-heading">
        <div className={styles.stage}>
          <div className={styles.viewport}>
            <canvas ref={canvasRef} aria-label="Raw browser WebGPU rendering of the indexed triangle" />
          </div>
          <p className={styles.caption} role="status">{statusCopy[status]}</p>
        </div>
        <div className={styles.explainer}>
          <p className="eyebrow">Raw browser WebGPU</p>
          <h2 id="browser-webgpu-heading">Remove the renderer abstraction for one deliberately tiny draw.</h2>
          <p>
            This exercise uses the existing renderer-independent <code>triangleMesh</code>, but talks directly to
            the browser WebGPU API. It stops after a single indexed triangle so the setup cost stays visible instead
            of growing into a second browser rendering engine.
          </p>
          <pre className={styles.dataReadout}>{`navigator.gpu\n  → adapter → device\n  → canvas context\n  → vertex + index buffers\n  → shader + render pipeline\n  → render pass → drawIndexed`}</pre>
          <p className={styles.boundaryNote}>
            Three.js remains the primary teaching renderer. Raw WebGPU exists here only to expose the machinery that
            higher-level renderer APIs intentionally hide.
          </p>
        </div>
      </section>
    </article>
  );
}
