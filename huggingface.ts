/**
 * HuggingFace extension — uses router.huggingface.co/v1 (OpenAI-compatible API).
 * The old api-inference.huggingface.co is deprecated.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const HF_TOKEN = "HF_TOKEN_REDACTED";
const BASE_URL = "https://router.huggingface.co/v1";

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "huggingface_inference",
    label: "HuggingFace Inference",
    description: "Run inference on HuggingFace models via the router API (OpenAI-compatible)",
    parameters: Type.Object({
      model: Type.String({ description: "Model ID, e.g. 'meta-llama/Llama-3.1-8B-Instruct'" }),
      prompt: Type.String({ description: "Input text/prompt" }),
      maxTokens: Type.Optional(Type.Number({ description: "Max new tokens (default 256)" })),
      temperature: Type.Optional(Type.Number({ description: "Temperature (default 0.7)" })),
    }),
    async execute(_id, params, _signal) {
      try {
        const res = await fetch(`${BASE_URL}/chat/completions`, {
          method: "POST",
          headers: { "Authorization": `Bearer ${HF_TOKEN}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            model: params.model,
            messages: [{ role: "user", content: params.prompt }],
            max_tokens: params.maxTokens || 256,
            temperature: params.temperature ?? 0.7,
          }),
          signal: _signal,
        });
        const data: any = await res.json();
        const text = data.choices?.[0]?.message?.content || JSON.stringify(data);
        return { content: [{ type: "text", text }], details: {} };
      } catch (e: any) { return { content: [{ type: "text", text: e.message }], details: {}, isError: true }; }
    },
  });

  pi.registerTool({
    name: "huggingface_chat",
    label: "HuggingFace Chat",
    description: "Chat with HuggingFace conversational models via router API",
    parameters: Type.Object({
      model: Type.String({ description: "Model ID" }),
      messages: Type.String({ description: 'JSON: [{"role":"user","content":"Hello"}]' }),
      maxTokens: Type.Optional(Type.Number({ description: "Max tokens (default 512)" })),
      temperature: Type.Optional(Type.Number({ description: "Temperature (default 0.7)" })),
    }),
    async execute(_id, params, _signal) {
      try {
        let msgs;
        try { msgs = JSON.parse(params.messages); } catch { msgs = [{ role: "user", content: params.messages }]; }
        const res = await fetch(`${BASE_URL}/chat/completions`, {
          method: "POST",
          headers: { "Authorization": `Bearer ${HF_TOKEN}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            model: params.model,
            messages: msgs,
            max_tokens: params.maxTokens || 512,
            temperature: params.temperature ?? 0.7,
          }),
          signal: _signal,
        });
        const data: any = await res.json();
        const text = data.choices?.[0]?.message?.content || JSON.stringify(data);
        return { content: [{ type: "text", text }], details: {} };
      } catch (e: any) { return { content: [{ type: "text", text: e.message }], details: {}, isError: true }; }
    },
  });

  pi.registerTool({
    name: "huggingface_translate",
    label: "HuggingFace Translate",
    description: "Translate text using HuggingFace translation models via router API",
    parameters: Type.Object({
      text: Type.String({ description: "Text to translate" }),
      sourceLang: Type.Optional(Type.String({})),
      targetLang: Type.Optional(Type.String({})),
      model: Type.Optional(Type.String({ description: "Model ID (default: facebook/nllb-200-distilled-600M)" })),
    }),
    async execute(_id, params, _signal) {
      try {
        const model = params.model || "facebook/nllb-200-distilled-600M";
        const prompt = params.sourceLang
          ? `Translate from ${params.sourceLang} to ${params.targetLang || "English"}: ${params.text}`
          : `Translate: ${params.text}`;
        const res = await fetch(`${BASE_URL}/chat/completions`, {
          method: "POST",
          headers: { "Authorization": `Bearer ${HF_TOKEN}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            model,
            messages: [{ role: "user", content: prompt }],
            max_tokens: 512,
            temperature: 0.3,
          }),
          signal: _signal,
        });
        const data: any = await res.json();
        const text = data.choices?.[0]?.message?.content || JSON.stringify(data);
        return { content: [{ type: "text", text }], details: {} };
      } catch (e: any) { return { content: [{ type: "text", text: e.message }], details: {}, isError: true }; }
    },
  });
}
