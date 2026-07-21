/**
 * PaddleOCR extension for pi — wraps the official paddleocr npm package.
 * Official upstream: https://github.com/PaddlePaddle/PaddleOCR
 * npm: paddleocr v1.2.0 (by x3zvawq) — cross-platform OCR based on PaddleOCR v5 + ONNX Runtime
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { execSync } from "node:child_process";

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "paddle_ocr",
    label: "PaddleOCR",
    description: "Extract text from images using PaddleOCR (official PaddleOCR v5 + ONNX Runtime). Supports .png, .jpg, .jpeg, .webp, .bmp files.",
    parameters: Type.Object({
      imagePath: Type.String({ description: "Path to the image file to OCR" }),
      language: Type.Optional(Type.String({ description: "Language code: ch, en, en_ch (default: en)" })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      try {
        const imgPath = params.imagePath;
        if (!imgPath) return { content: [{ type: "text", text: "imagePath required" }], details: {}, isError: true };
        const out = execSync(
          `NODE_PATH=${process.env.HOME}/.npm/lib/node_modules node ${process.env.HOME}/.local/bin/paddle-ocr "${imgPath}"`,
          { cwd: ctx.cwd, encoding: "utf-8", maxBuffer: 10 * 1024 * 1024, timeout: 120_000 }
        );
        return { content: [{ type: "text", text: out }], details: {} };
      } catch (e: any) {
        return { content: [{ type: "text", text: `PaddleOCR: ${e.stderr || e.message}` }], details: {}, isError: true };
      }
    },
  });
}
