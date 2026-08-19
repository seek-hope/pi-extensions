import { Container, type Focusable, getKeybindings, Text } from "@earendil-works/pi-tui";
import type { BackgroundTask } from "./store.ts";

/**
 * Interactive background-task list widget.
 *
 * Opened via `/tasks` (the keybinding is unbound by default because
 * ctrl+shift+t collides with common terminal shortcuts). Arrow keys move the
 * selection, Enter shows the selected task's latest output (preview panel),
 * Esc closes the preview and returns to the list, a second Esc leaves the
 * manager entirely. The list refreshes itself while the session runs.
 */
export interface BgTasksWidgetOptions {
	/** Current task list (running first, newest first). */
	getTasks: () => BackgroundTask[];
	/** Show the selected task's output preview (last few lines). */
	onView: (id: string) => void;
	/** Dismiss the output preview and return to the list. */
	onBackFromView: () => void;
	/** Kill the selected task; resolves to whether it was killed. */
	onKill: (id: string) => Promise<boolean>;
	/** Release focus back to the editor and close the manager. */
	onExit: () => void;
	/** Available height for the list (rows). */
	height: number;
}

function taskLine(t: BackgroundTask): string {
	const elapsed = ((t.endTime || Date.now()) - t.startTime) / 1000;
	const icon = t.status === "done" ? "✓" : t.status === "running" ? "◐" : "✗";
	const label = t.label ? `: ${t.label}` : "";
	const code = t.exitCode != null ? ` exit=${t.exitCode}` : "";
	return `${icon} ${t.id}${label} (${elapsed.toFixed(0)}s${code})`;
}

export class BgTasksWidget extends Container implements Focusable {
	private readonly opts: BgTasksWidgetOptions;
	private _focused = false;
	private selectedIndex = 0;
	/** Task whose output preview is currently shown (first Esc returns to the list). */
	private viewingTaskId: string | undefined;
	private readonly tasks: BackgroundTask[] = [];
	private readonly titleText: Text;
	private readonly taskTexts: Text[] = [];
	private readonly hintText: Text;
	private refreshTimer: ReturnType<typeof setInterval> | undefined;
	private disposed = false;

	private readonly theme: { fg(color: string, text: string): string };

	constructor(opts: BgTasksWidgetOptions, theme: { fg(color: string, text: string): string }) {
		super();
		this.opts = opts;
		this.theme = theme;
		this.titleText = new Text("", 1, 0);
		this.addChild(this.titleText);
		const rows = Math.max(3, opts.height - 3);
		for (let i = 0; i < rows; i++) {
			const t = new Text("", 1, 0);
			this.taskTexts.push(t);
			this.addChild(t);
		}
		this.hintText = new Text("", 1, 0);
		this.addChild(this.hintText);
		this.refresh();
		this.refreshTimer = setInterval(() => this.refresh(), 1000);
	}

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.refresh();
	}

	/** Re-read the task list and re-render. */
	refresh(): void {
		if (this.disposed) return;
		const tasks = this.opts.getTasks();
		this.tasks.splice(0, this.tasks.length, ...tasks);
		if (this.selectedIndex >= this.tasks.length) {
			this.selectedIndex = Math.max(0, this.tasks.length - 1);
		}
		const running = this.tasks.filter((t) => t.status === "running");
		const total = this.tasks.length;
		const visible = this.taskTexts.length;

		this.titleText.setText(this.theme.fg("accent", `Background tasks (${running.length} running, ${total} total)`));
		// Keep the selection inside the visible window.
		let windowStart = 0;
		if (this.tasks.length > visible) {
			windowStart = Math.max(0, Math.min(this.selectedIndex - Math.floor(visible / 2), this.tasks.length - visible));
		}
		for (let i = 0; i < visible; i++) {
			const task = this.tasks[windowStart + i];
			const row = this.taskTexts[i];
			if (!task) {
				row.setText("");
				continue;
			}
			const selected = this._focused && windowStart + i === this.selectedIndex;
			row.setText(selected ? this.theme.fg("accent", `› ${taskLine(task)}`) : `  ${taskLine(task)}`);
		}

		const selected = this.tasks[this.selectedIndex];
		const id = selected ? selected.id : "-";
		const viewLabel = this.viewingTaskId ? `viewing ${this.viewingTaskId}` : `Enter view ${id}`;
		this.hintText.setText(
			this.theme.fg(
				"muted",
				`↑↓ select  |  ${viewLabel}  |  k kill ${id}  |  Esc ${this.viewingTaskId ? "back" : "close"}`,
			),
		);
	}

	handleInput(keyData: string): void {
		const kb = getKeybindings();
		if (kb.matches(keyData, "tui.select.up") || kb.matches(keyData, "tui.editor.cursorUp")) {
			if (this.tasks.length > 0) {
				this.selectedIndex = (this.selectedIndex - 1 + this.tasks.length) % this.tasks.length;
				this.leavePreview();
				this.refresh();
			}
			return;
		}
		if (kb.matches(keyData, "tui.select.down") || kb.matches(keyData, "tui.editor.cursorDown")) {
			if (this.tasks.length > 0) {
				this.selectedIndex = (this.selectedIndex + 1) % this.tasks.length;
				this.leavePreview();
				this.refresh();
			}
			return;
		}
		if (kb.matches(keyData, "tui.select.confirm") || keyData === "\n") {
			const selected = this.tasks[this.selectedIndex];
			if (selected) {
				this.viewingTaskId = selected.id;
				this.opts.onView(selected.id);
				this.refresh();
			}
			return;
		}
		if (kb.matches(keyData, "tui.select.cancel") || keyData === "\x1b") {
			if (this.viewingTaskId) {
				// First Esc: leave the preview, stay in the manager.
				this.leavePreview();
				this.refresh();
				return;
			}
			this.opts.onExit();
			return;
		}
		if (keyData === "k") {
			const selected = this.tasks[this.selectedIndex];
			if (selected) {
				void this.opts.onKill(selected.id).then(() => this.refresh());
			}
			return;
		}
	}

	/** Dismiss the output preview (if any) without closing the manager. */
	private leavePreview(): void {
		if (this.viewingTaskId) {
			this.viewingTaskId = undefined;
			this.opts.onBackFromView();
		}
	}

	dispose(): void {
		this.disposed = true;
		if (this.refreshTimer) {
			clearInterval(this.refreshTimer);
			this.refreshTimer = undefined;
		}
	}
}
