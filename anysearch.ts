/**
 * AnySearch extension for pi — wraps the official AnySearch API.
 * Official upstream: https://anysearch.ai
 * Requires: ANYSEARCH_API_KEY env var
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "anysearch_web",
    label: "AnySearch Web",
    description: "Search the web using AnySearch API. Best for finance, stocks, and structured data queries.",
    parameters: Type.Object({
      query: Type.String({ description: "Search query" }),
      numResults: Type.Optional(Type.Number({ description: "Number of results (default: 5)" })),
    }),
    async execute(_id, params, _signal, _onUpdate, _ctx) {
      try {
        const apiKey = process.env.ANYSEARCH_API_KEY;
        if (!apiKey) {
          return { content: [{ type: "text", text: "Error: Set ANYSEARCH_API_KEY env var. Get a key at https://anysearch.ai" }], details: {}, isError: true };
        }
        const res = await fetch(`https://api.anysearch.ai/v1/search?q=${encodeURIComponent(params.query)}&num=${params.numResults ?? 5}`, {
          headers: { "Authorization": `Bearer ${apiKey}` },
          signal: _signal,
        });
        if (!res.ok) {
          const err = await res.text();
          return { content: [{ type: "text", text: `AnySearch API error (${res.status}): ${err}` }], details: {}, isError: true };
        }
        const data = await res.json();
        const text = JSON.stringify(data, null, 2);
        return { content: [{ type: "text", text }], details: {} };
      } catch (e: any) {
        return { content: [{ type: "text", text: e.message }], details: {}, isError: true };
      }
    },
  });
}
