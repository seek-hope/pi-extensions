/**
 * HuggingFace extension for pi — wraps official @huggingface/inference SDK.
 * Official upstream: https://github.com/huggingface/huggingface.js
 * Requires: HF_API_KEY env var or --api-key
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "huggingface_inference",
    label: "HuggingFace Inference",
    description: "Run inference on HuggingFace models via the official @huggingface/inference API",
    parameters: Type.Object({
      model: Type.String({ description: "HuggingFace model ID, e.g. 'gpt2' or 'meta-llama/Llama-3.1-8B-Instruct'" }),
      prompt: Type.String({ description: "Input text/prompt" }),
      maxTokens: Type.Optional(Type.Number({ description: "Max new tokens (default 256)" })),
      temperature: Type.Optional(Type.Number({ description: "Temperature (default 0.7)" })),
    }),
    async execute(_id, params, _signal, _onUpdate, _ctx) {
      try {
        const apiKey = process.env.HF_API_KEY || process.env.HUGGINGFACE_API_KEY;
        if (!apiKey) {
          return { content: [{ type: "text", text: "Error: Set HF_API_KEY or HUGGINGFACE_API_KEY environment variable." }], details: {}, isError: true };
        }
        const body: any = {
          inputs: params.prompt,
          parameters: {
            max_new_tokens: params.maxTokens ?? 256,
            temperature: params.temperature ?? 0.7,
            return_full_text: false,
          },
        };
        const res = await fetch(`https://api-inference.huggingface.co/models/${params.model}`, {
          method: "POST",
          headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: _signal,
        });
        const data = await res.json();
        const text = Array.isArray(data)
          ? data.map((d: any) => d.generated_text || d.summary_text || JSON.stringify(d)).join("\n")
          : JSON.stringify(data, null, 2);
        return { content: [{ type: "text", text }], details: {} };
      } catch (e: any) {
        return { content: [{ type: "text", text: e.message }], details: {}, isError: true };
      }
    },
  });

  pi.registerTool({
    name: "huggingface_chat",
    label: "HuggingFace Chat",
    description: "Chat with HuggingFace conversational/text-generation models",
    parameters: Type.Object({
      model: Type.String({ description: "Model ID, e.g. 'meta-llama/Llama-3.1-8B-Instruct' or 'microsoft/Phi-3-mini-4k-instruct'" }),
      messages: Type.String({ description: "JSON array of messages: [{\"role\":\"user\",\"content\":\"Hello\"}]" }),
      maxTokens: Type.Optional(Type.Number({ description: "Max new tokens (default 512)" })),
      temperature: Type.Optional(Type.Number({ description: "Temperature (default 0.7)" })),
    }),
    async execute(_id, params, _signal, _onUpdate, _ctx) {
      try {
        const apiKey = process.env.HF_API_KEY || process.env.HUGGINGFACE_API_KEY;
        if (!apiKey) {
          return { content: [{ type: "text", text: "Error: Set HF_API_KEY or HUGGINGFACE_API_KEY env var." }], details: {}, isError: true };
        }
        let messages: any[];
        try {
          messages = JSON.parse(params.messages);
        } catch {
          messages = [{ role: "user", content: params.messages }];
        }
        // Use the HuggingFace chat completion endpoint
        const body = {
          model: params.model,
          messages,
          max_tokens: params.maxTokens ?? 512,
          temperature: params.temperature ?? 0.7,
        };
        const res = await fetch("https://api-inference.huggingface.co/models/" + params.model + "/v1/chat/completions", {
          method: "POST",
          headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: _signal,
        });
        if (!res.ok) {
          // Fall back to text generation endpoint
          const prompt = messages.map((m: any) => `${m.role}: ${m.content}`).join("\n") + "\nassistant:";
          const fallbackBody = { inputs: prompt, parameters: { max_new_tokens: params.maxTokens ?? 512, temperature: params.temperature ?? 0.7, return_full_text: false } };
          const fallbackRes = await fetch(`https://api-inference.huggingface.co/models/${params.model}`, {
            method: "POST",
            headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
            body: JSON.stringify(fallbackBody),
            signal: _signal,
          });
          const fallbackData = await fallbackRes.json();
          const text = Array.isArray(fallbackData) ? fallbackData[0]?.generated_text || JSON.stringify(fallbackData) : JSON.stringify(fallbackData);
          return { content: [{ type: "text", text }], details: {} };
        }
        const data = await res.json();
        const text = data.choices?.[0]?.message?.content || JSON.stringify(data);
        return { content: [{ type: "text", text }], details: {} };
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
      sourceLang: Type.Optional(Type.String({ description: "Source language code (e.g. 'en', 'zh')" })),
      targetLang: Type.Optional(Type.String({ description: "Target language code (e.g. 'fr', 'en')" })),
      model: Type.Optional(Type.String({ description: "Translation model ID (default: facebook/nllb-200-distilled-600M)" })),
    }),
    async execute(_id, params, _signal, _onUpdate, _ctx) {
      try {
        const apiKey = process.env.HF_API_KEY || process.env.HUGGINGFACE_API_KEY;
        if (!apiKey) {
          return { content: [{ type: "text", text: "Error: Set HF_API_KEY or HUGGINGFACE_API_KEY env var." }], details: {}, isError: true };
        }
        const model = params.model || "facebook/nllb-200-distilled-600M";
        // NLLB expects source language in the input
        const srcLang = params.sourceLang || "eng_Latn";
        const body = { inputs: params.text, parameters: { src_lang: srcLang, tgt_lang: params.targetLang || "fra_Latn" } };
        const res = await fetch(`https://api-inference.huggingface.co/models/${model}`, {
          method: "POST",
          headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: _signal,
        });
        const data = await res.json();
        const text = Array.isArray(data) ? data[0]?.translation_text || data[0]?.generated_text || JSON.stringify(data) : JSON.stringify(data);
        return { content: [{ type: "text", text }], details: {} };
      } catch (e: any) {
        return { content: [{ type: "text", text: e.message }], details: {}, isError: true };
      }
    },
  });
}
