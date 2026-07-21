/**
 * PaddleOCR extension — official PaddleOCR cloud API.
 * Uses PaddleOCR-VL-1.6 model via api-v2 REST endpoint.
 * Requires: PADDLEOCR_API_TOKEN env var
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { readFileSync, existsSync } from "node:fs";

const JOB_URL = "https://paddleocr.aistudio-app.com/api/v2/ocr/jobs";
const MODEL = "PaddleOCR-VL-1.6";

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "paddle_ocr",
    label: "PaddleOCR",
    description:
      "Extract text from images using PaddleOCR (official PaddleOCR v5 + ONNX Runtime). " +
      "Supports .png, .jpg, .jpeg, .webp, .bmp files.",
    parameters: Type.Object({
      imagePath: Type.String({ description: "Path to the image file to OCR" }),
      language: Type.Optional(Type.String({ description: "Language code: ch, en, en_ch (default: en)" })),
    }),
    async execute(_id, params, _signal) {
      const token = process.env.PADDLEOCR_API_TOKEN;
      if (!token) {
        return { content: [{ type: "text", text: "PADDLEOCR_API_TOKEN not set." }], details: {}, isError: true };
      }
      try {
        const filePath = params.imagePath;
        const isUrl = filePath.startsWith("http");
        if (!isUrl && (!filePath || !existsSync(filePath))) {
          return { content: [{ type: "text", text: `File not found: ${filePath}` }], details: {}, isError: true };
        }

        let jobResp: any;
        if (isUrl) {
          jobResp = await fetch(JOB_URL, {
            method: "POST",
            headers: { "Authorization": `bearer ${token}`, "Content-Type": "application/json" },
            body: JSON.stringify({ fileUrl: filePath, model: MODEL, optionalPayload: {} }),
            signal: _signal,
          });
        } else {
          const fileData = readFileSync(filePath);
          const form = new FormData();
          form.append("file", new Blob([fileData]), filePath.split("/").pop() || "image.png");
          form.append("model", MODEL);
          form.append("optionalPayload", JSON.stringify({}));
          jobResp = await fetch(JOB_URL, {
            method: "POST",
            headers: { "Authorization": `bearer ${token}` },
            body: form,
            signal: _signal,
          });
        }

        if (jobResp.status !== 200) {
          const err = await jobResp.text();
          return { content: [{ type: "text", text: `OCR submit failed (${jobResp.status}): ${err}` }], details: {}, isError: true };
        }

        const jobData: any = await jobResp.json();
        const jobId = jobData.data.jobId;

        let state = "", resultUrl = "";
        for (let i = 0; i < 60; i++) {
          await new Promise((r) => setTimeout(r, 3000));
          const pollResp = await fetch(`${JOB_URL}/${jobId}`, { headers: { "Authorization": `bearer ${token}` }, signal: _signal });
          if (pollResp.status !== 200) continue;
          const pollData: any = await pollResp.json();
          state = pollData.data.state;
          if (state === "done") { resultUrl = pollData.data.resultUrl?.jsonUrl || ""; break; }
          if (state === "failed") {
            return { content: [{ type: "text", text: `OCR failed: ${pollData.data.errorMsg}` }], details: {}, isError: true };
          }
        }

        if (state !== "done" || !resultUrl) {
          return { content: [{ type: "text", text: "OCR timed out after 3 minutes." }], details: {}, isError: true };
        }

        const resultResp = await fetch(resultUrl, { signal: _signal });
        const text = await resultResp.text();
        const lines = text.trim().split("\n").filter(Boolean);
        const output: string[] = [];
        for (const line of lines) {
          try {
            const parsed = JSON.parse(line);
            for (const layout of parsed.result?.layoutParsingResults || []) {
              const md = layout.markdown?.text || "";
              if (md) output.push(md);
            }
          } catch { /* skip */ }
        }

        return { content: [{ type: "text", text: output.join("\n\n") || "(no text extracted)" }], details: { jobId, pages: lines.length } };
      } catch (e: any) {
        return { content: [{ type: "text", text: `PaddleOCR error: ${e.message}` }], details: {}, isError: true };
      }
    },
  });
}
