/**
 * AnySearch extension for pi — wraps the official AnySearch API.
 * Official upstream: https://github.com/anysearch-ai
 * API: https://api.anysearch.com
 * Requires: ANYSEARCH_API_KEY env var (optional, works anonymously with lower limits)
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const API_BASE = "https://api.anysearch.com";

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "anysearch_web",
    label: "AnySearch Web",
    description:
      "Search the web using AnySearch API. Best for finance, stocks, and structured data queries. " +
      "Works anonymously with lower rate limits if no API key is set.",
    parameters: Type.Object({
      query: Type.String({ description: "Search query" }),
      numResults: Type.Optional(Type.Number({ description: "Number of results (default: 5)" })),
    }),
    async execute(_id, params, _signal, _onUpdate, _ctx) {
      try {
        const apiKey = process.env.ANYSEARCH_API_KEY || "";

        const url = `${API_BASE}/v1/search?q=${encodeURIComponent(params.query)}&num=${params.numResults ?? 5}`;

        const headers: Record<string, string> = {
          "Content-Type": "application/json",
        };
        if (apiKey) {
          headers["Authorization"] = `Bearer ${apiKey}`;
        }

        const res = await fetch(url, { headers, signal: _signal });

        if (!res.ok) {
          const err = await res.text();
          return {
            content: [{
              type: "text",
              text: `AnySearch API error (${res.status}): ${err}\n\n` +
                `API: ${API_BASE}\n` +
                `Key: ${apiKey ? apiKey.substring(0, 12) + "..." : "(anonymous)"}`,
            }],
            details: {},
            isError: true,
          };
        }

        const data = await res.json();
        const text = JSON.stringify(data, null, 2);
        return { content: [{ type: "text", text }], details: {} };
      } catch (e: any) {
        return {
          content: [{
            type: "text",
            text: `AnySearch network error: ${e.message}\n\n` +
              `API: ${API_BASE}\n` +
              `This may be caused by a network proxy blocking the connection. ` +
              `Check that ${API_BASE} is reachable from your environment.`,
          }],
          details: {},
          isError: true,
        };
      }
    },
  });
}
