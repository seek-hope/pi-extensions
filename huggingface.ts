/**
 * HuggingFace extension — uses local huggingface_hub InferenceClient (Python SDK).
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { execSync } from "node:child_process";

function py(script: string, timeout = 120_000): string {
  try {
    return execSync(`python3 -c '${script}'`, {
      encoding: "utf-8", maxBuffer: 10 * 1024 * 1024, timeout,
    }).trim();
  } catch (e: any) {
    return e.stderr || e.message || "";
  }
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "huggingface_inference",
    label: "HuggingFace Inference",
    description: "Run inference on HuggingFace models via the local Python InferenceClient SDK",
    parameters: Type.Object({
      model: Type.String({ description: "Model ID" }),
      prompt: Type.String({ description: "Input text/prompt" }),
      maxTokens: Type.Optional(Type.Number({ description: "Max new tokens (default 256)" })),
      temperature: Type.Optional(Type.Number({ description: "Temperature (default 0.7)" })),
    }),
    async execute(_id, params, _signal) {
      try {
        const out = py(`
from huggingface_hub import InferenceClient
c = InferenceClient("${params.model}")
r = c.text_generation("${params.prompt.replace(/'/g, "\\'")}", max_new_tokens=${params.maxTokens || 256}, temperature=${params.temperature ?? 0.7})
print(r)
`, 180_000);
        return { content: [{ type: "text", text: out }], details: {} };
      } catch (e: any) { return { content: [{ type: "text", text: e.message }], details: {}, isError: true }; }
    },
  });

  pi.registerTool({
    name: "huggingface_chat",
    label: "HuggingFace Chat",
    description: "Chat with HuggingFace conversational models via local SDK",
    parameters: Type.Object({
      model: Type.String({ description: "Model ID" }),
      messages: Type.String({ description: 'JSON: [{"role":"user","content":"Hello"}]' }),
      maxTokens: Type.Optional(Type.Number({ description: "Max tokens (default 512)" })),
      temperature: Type.Optional(Type.Number({ description: "Temperature (default 0.7)" })),
    }),
    async execute(_id, params, _signal) {
      try {
        const out = py(`
import json
from huggingface_hub import InferenceClient
msgs = json.loads('"""+params.messages.replace(/'/g, "\\'")+"""')
c = InferenceClient("${params.model}")
r = c.chat_completion(msgs, max_tokens=${params.maxTokens || 512}, temperature=${params.temperature ?? 0.7})
print(r.choices[0].message.content)
`, 180_000);
        return { content: [{ type: "text", text: out }], details: {} };
      } catch (e: any) { return { content: [{ type: "text", text: e.message }], details: {}, isError: true }; }
    },
  });

  pi.registerTool({
    name: "huggingface_translate",
    label: "HuggingFace Translate",
    description: "Translate text using HuggingFace translation models",
    parameters: Type.Object({
      text: Type.String({ description: "Text to translate" }),
      sourceLang: Type.Optional(Type.String({})),
      targetLang: Type.Optional(Type.String({})),
      model: Type.Optional(Type.String({ description: "Model ID (default: nllb)" })),
    }),
    async execute(_id, params, _signal) {
      try {
        const out = py(`
from transformers import pipeline
t = pipeline("translation", model="${params.model || "facebook/nllb-200-distilled-600M"}")
r = t("${params.text.replace(/'/g, "\\'")}")
print(r[0]["translation_text"])
`, 180_000);
        return { content: [{ type: "text", text: out }], details: {} };
      } catch (e: any) { return { content: [{ type: "text", text: e.message }], details: {}, isError: true }; }
    },
  });
}
