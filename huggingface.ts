/**
 * HuggingFace extension — uses local transformers + huggingface_hub via Python.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { execSync } from "node:child_process";

function py(script: string, timeout = 60_000): string {
  try {
    return execSync(`python3 -c "${script.replace(/"/g, '\\"')}"`, {
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
    description: "Run inference on HuggingFace models via local transformers library",
    parameters: Type.Object({
      model: Type.String({ description: "Model ID, e.g. 'gpt2' or 'meta-llama/Llama-3.1-8B-Instruct'" }),
      prompt: Type.String({ description: "Input text/prompt" }),
      maxTokens: Type.Optional(Type.Number({ description: "Max new tokens (default 256)" })),
      temperature: Type.Optional(Type.Number({ description: "Temperature (default 0.7)" })),
    }),
    async execute(_id, params, _signal) {
      try {
        const maxT = params.maxTokens || 256;
        const temp = params.temperature ?? 0.7;
        const script = `
from huggingface_hub import InferenceClient
client = InferenceClient("${params.model}")
result = client.text_generation("${params.prompt.replace(/"/g, '\\"')}", max_new_tokens=${maxT}, temperature=${temp})
print(result)
`;
        const out = py(script, 120_000);
        return { content: [{ type: "text", text: out }], details: {} };
      } catch (e: any) {
        return { content: [{ type: "text", text: e.message }], details: {}, isError: true };
      }
    },
  });

  pi.registerTool({
    name: "huggingface_chat",
    label: "HuggingFace Chat",
    description: "Chat with HuggingFace conversational models via local SDK",
    parameters: Type.Object({
      model: Type.String({ description: "Model ID" }),
      messages: Type.String({ description: "JSON array: [{\"role\":\"user\",\"content\":\"Hello\"}]" }),
      maxTokens: Type.Optional(Type.Number({ description: "Max new tokens (default 512)" })),
      temperature: Type.Optional(Type.Number({ description: "Temperature (default 0.7)" })),
    }),
    async execute(_id, params, _signal) {
      try {
        const maxT = params.maxTokens || 512;
        const temp = params.temperature ?? 0.7;
        const msgs = params.messages.replace(/"/g, '\\"');
        const script = `
from huggingface_hub import InferenceClient
import json
client = InferenceClient("${params.model}")
msgs = json.loads("""${msgs}""")
result = client.chat_completion(msgs, max_tokens=${maxT}, temperature=${temp})
print(result.choices[0].message.content)
`;
        const out = py(script, 120_000);
        return { content: [{ type: "text", text: out }], details: {} };
      } catch (e: any) {
        return { content: [{ type: "text", text: e.message }], details: {}, isError: true };
      }
    },
  });

  pi.registerTool({
    name: "huggingface_translate",
    label: "HuggingFace Translate",
    description: "Translate text using HuggingFace translation models",
    parameters: Type.Object({
      text: Type.String({ description: "Text to translate" }),
      sourceLang: Type.Optional(Type.String({ description: "Source language (e.g. 'en', 'zh')" })),
      targetLang: Type.Optional(Type.String({ description: "Target language (e.g. 'fr', 'en')" })),
      model: Type.Optional(Type.String({ description: "Model ID (default: facebook/nllb-200-distilled-600M)" })),
    }),
    async execute(_id, params, _signal) {
      try {
        const model = params.model || "facebook/nllb-200-distilled-600M";
        const script = `
from transformers import pipeline
translator = pipeline("translation", model="${model}")
result = translator("${params.text.replace(/"/g, '\\"')}")
print(result[0]["translation_text"])
`;
        const out = py(script, 120_000);
        return { content: [{ type: "text", text: out }], details: {} };
      } catch (e: any) {
        return { content: [{ type: "text", text: e.message }], details: {}, isError: true };
      }
    },
  });
}
