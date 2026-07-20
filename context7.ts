/**
 * Context7 extension for pi — wraps the official context7 API.
 * Official upstream: https://github.com/upstash/context7
 * Uses the Context7 REST API directly.
 * Requires: CONTEXT7_API_KEY env var
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "context7_search",
    label: "Context7 Search",
    description: "Search library/framework/API documentation via Context7. Best for finding up-to-date docs and code examples for npm packages, APIs, and frameworks.",
    parameters: Type.Object({
      query: Type.String({ description: "Search query, e.g. 'how to use React useEffect' or 'express middleware'" }),
      topK: Type.Optional(Type.Number({ description: "Number of results (default: 5, max: 10)" })),
    }),
    async execute(_id, params, _signal, _onUpdate, _ctx) {
      try {
        const apiKey = process.env.CONTEXT7_API_KEY;
        if (!apiKey) {
          return { content: [{ type: "text", text: "Error: Set CONTEXT7_API_KEY environment variable. Get a key at https://context7.com" }], details: {}, isError: true };
        }
        const res = await fetch("https://api.context7.com/v1/search", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            query: params.query,
            topK: params.topK ?? 5,
          }),
          signal: _signal,
        });
        if (!res.ok) {
          const err = await res.text();
          return { content: [{ type: "text", text: `Context7 API error (${res.status}): ${err}` }], details: {}, isError: true };
        }
        const data = await res.json();
        const results = data.results || data;
        const text = typeof results === "string" ? results : JSON.stringify(results, null, 2);
        return { content: [{ type: "text", text }], details: {} };
      } catch (e: any) {
        return { content: [{ type: "text", text: e.message }], details: {}, isError: true };
      }
    },
  });
}
