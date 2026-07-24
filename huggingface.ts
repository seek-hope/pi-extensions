/**
 * HuggingFace extension — uses router.huggingface.co/v1 (OpenAI-compatible API).
 * Requires: HF_TOKEN env var
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const BASE_URL = "https://router.huggingface.co/v1";

/** Shared helper: call HuggingFace chat completions API, handle errors, redact tokens. */
async function callHuggingFace(
  body: Record<string, any>,
  signal?: AbortSignal
): Promise<{ content: { type: string; text: string }[]; details: Record<string, any>; isError?: boolean }> {
  const token = process.env.HF_TOKEN;
  if (!token) return { content: [{ type: "text", text: "HF_TOKEN not set." }], details: {}, isError: true };
  try {
    const res = await fetch(`${BASE_URL}/chat/completions`, {
      method: "POST",
      headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok) {
      let errBody = await res.text();
      if (token) errBody = errBody.replaceAll(token, "[REDACTED]");
      throw new Error(`HuggingFace API error (${res.status}): ${errBody.substring(0, 500)}`);
    }
    const rawBody = await res.text();
    let data: any;
    try {
      data = JSON.parse(rawBody);
    } catch {
      let sanitized = rawBody;
      if (token) sanitized = sanitized.replaceAll(token, "[REDACTED]");
      throw new Error(`HuggingFace API returned non-JSON response: ${sanitized.substring(0, 500)}`);
    }
    const text = data.choices?.[0]?.message?.content || JSON.stringify(data);
    return { content: [{ type: "text", text }], details: {} };
  } catch (e: any) {
    const msg = token ? (e.message || String(e)).replaceAll(token, "[REDACTED]") : (e.message || String(e));
    return { content: [{ type: "text", text: msg }], details: {}, isError: true };
  }
}

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
      return callHuggingFace({
        model: params.model,
        messages: [{ role: "user", content: params.prompt }],
        max_tokens: params.maxTokens || 256,
        temperature: params.temperature ?? 0.7,
      }, _signal);
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
      let msgs;
      try { msgs = JSON.parse(params.messages); } catch { msgs = [{ role: "user", content: params.messages }]; }
      return callHuggingFace({
        model: params.model,
        messages: msgs,
        max_tokens: params.maxTokens || 512,
        temperature: params.temperature ?? 0.7,
      }, _signal);
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
      const model = params.model || "facebook/nllb-200-distilled-600M";
      const prompt = params.sourceLang
        ? `Translate from ${params.sourceLang} to ${params.targetLang || "English"}: ${params.text}`
        : `Translate: ${params.text}`;
      return callHuggingFace({
        model,
        messages: [{ role: "user", content: prompt }],
        max_tokens: 512,
        temperature: 0.3,
      }, _signal);
    },
  });
}
