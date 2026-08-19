/**
 * shared todo state bus: the TodoStore is per-session (keyed by
 * SessionManager) and shared across fork extensions (todo widget, subagent
 * progress items) via the module-level WeakMap — jiti resolves all importers
 * to this single module instance.
 */
import type { ExtensionContext, SessionManager } from "@earendil-works/pi-coding-agent";
import { TodoStore } from "../todo/lib/store.ts";

export interface TodoState {
	store: TodoStore;
	detailWidgetActive: boolean;
	detailPage: number;
	userTurnCount: number;
	lastActivityTurn: number;
	lastStaleWarnTurn: number;
	/** True while the pre-compaction refresh turn is running. */
	refreshActive: boolean;
	/** Set when compaction was cancelled for a refresh; re-trigger on agent_end. */
	retriggerCompaction: boolean;
	/** The store revision we last refreshed at (one refresh per state). */
	lastRefreshedAtTurn: number;
	/** Rendering hook installed by todo. */
	onStoreChange?: (ctx: ExtensionContext, s: TodoState) => void;
}

const states = new WeakMap<ExtensionContext["sessionManager"], TodoState>();

export function stateFor(ctx: ExtensionContext): TodoState {
	const sm = ctx.sessionManager;
	const existing = states.get(sm);
	if (existing) return existing;
	const s: TodoState = {
		store: undefined as unknown as TodoStore,
		detailWidgetActive: false,
		detailPage: 1,
		userTurnCount: 0,
		lastActivityTurn: 0,
		lastStaleWarnTurn: -1,
		refreshActive: false,
		retriggerCompaction: false,
		lastRefreshedAtTurn: -1,
		onStoreChange: undefined,
	};
	s.store = new TodoStore(sm as SessionManager, {
		onChange: () => {
			s.lastActivityTurn = s.userTurnCount;
			s.onStoreChange?.(ctx, s);
		},
		notify: (message, level) => {
			if (ctx.hasUI) ctx.ui.notify(message, level);
		},
	});
	states.set(sm, s);
	return s;
}

