/**
 * TokenRouter provider — OpenAI-compatible gateway.
 * Base URL: https://api.tokenrouter.com/v1 (docs: https://docs.tokenrouter.me/)
 *
 * Auth: Bearer token. Either set TOKENROUTER_API_KEY in the environment or
 * run `/login tokenrouter` once to store the key (auth.json).
 *
 * Model discovery: GET /v1/models returns the models available to the key.
 * The list is fetched at startup when TOKENROUTER_API_KEY is present, and
 * refreshed every time the model selector opens (refreshModels). Without a
 * key, a small curated fallback list keeps the provider usable; the exact
 * per-key catalog is authoritative. Context windows on fetched models are
 * conservative defaults — override per model via models.json if needed.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const BASE_URL = "https://api.tokenrouter.com/v1";
const FETCH_TIMEOUT_MS = 5_000;

interface TokenRouterModel {
	id: string;
	name: string;
	reasoning: boolean;
	input: ("text" | "image")[];
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
	contextWindow: number;
	maxTokens: number;
}

const UNKNOWN_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

/** Fallback list for when no key is available to query /v1/models. */
const FALLBACK_MODELS: TokenRouterModel[] = [
	{
		id: "kimi-k2p7-code",
		name: "Kimi 2.7 Code (256K)",
		reasoning: true,
		input: ["text", "image"],
		cost: UNKNOWN_COST,
		contextWindow: 262144,
		maxTokens: 65536,
	},
	{
		id: "kimi-k2p7-code-fast",
		name: "Kimi 2.7 Code Fast (256K)",
		reasoning: true,
		input: ["text", "image"],
		cost: UNKNOWN_COST,
		contextWindow: 262144,
		maxTokens: 65536,
	},
	{
		id: "kimi-k2p6",
		name: "Kimi K2.6",
		reasoning: false,
		input: ["text"],
		cost: UNKNOWN_COST,
		contextWindow: 131072,
		maxTokens: 8192,
	},
	{
		id: "gpt-4o",
		name: "GPT-4o",
		reasoning: false,
		input: ["text", "image"],
		cost: UNKNOWN_COST,
		contextWindow: 128000,
		maxTokens: 16384,
	},
	{
		id: "gpt-4o-mini",
		name: "GPT-4o mini",
		reasoning: false,
		input: ["text", "image"],
		cost: UNKNOWN_COST,
		contextWindow: 128000,
		maxTokens: 16384,
	},
];

/** Query the gateway's per-key model list (OpenAI /v1/models shape). */
async function fetchModelsFromApi(key: string): Promise<TokenRouterModel[]> {
	try {
		const res = await fetch(`${BASE_URL}/models`, {
			headers: { Authorization: `Bearer ${key}` },
			signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
		});
		if (!res.ok) return [];
		const payload = (await res.json()) as { data?: Array<{ id?: unknown }> };
		const models: TokenRouterModel[] = [];
		for (const entry of payload.data ?? []) {
			if (typeof entry?.id !== "string" || entry.id.length === 0) continue;
			const id = entry.id;
			models.push({
				id,
				name: id,
				reasoning: false,
				input: ["text"],
				cost: UNKNOWN_COST,
				contextWindow: 128000,
				maxTokens: 8192,
			});
		}
		return models;
	} catch {
		return [];
	}
}

function usable(models: TokenRouterModel[], fallback: TokenRouterModel[]): TokenRouterModel[] {
	return models.length > 0 ? models : fallback;
}

export default async function (pi: ExtensionAPI) {
	const envKey = process.env.TOKENROUTER_API_KEY;
	const startupModels = envKey ? await fetchModelsFromApi(envKey) : [];

	pi.registerProvider("tokenrouter", {
		name: "TokenRouter",
		baseUrl: BASE_URL,
		apiKey: "$TOKENROUTER_API_KEY",
		api: "openai-completions",
		models: usable(startupModels, FALLBACK_MODELS),
		refreshModels: async (context) => {
			const key =
				context.credential?.type === "api_key" ? context.credential.key : process.env.TOKENROUTER_API_KEY;
			if (!key) return FALLBACK_MODELS;
			return usable(await fetchModelsFromApi(key), FALLBACK_MODELS);
		},
	});
}
