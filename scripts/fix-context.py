import re

p = "context/index.ts"
src = open(p).read()

# message_end scan: contentText(undefined content) — route via unknown
src = src.replace('''				s.uncertainty.scanAssistantText(
					contentText((message as { content?: never }).content, ""),
					ctx.sessionManager.getLeafId() ?? undefined,
				);''', '''				s.uncertainty.scanAssistantText(
					contentText((message as unknown as { content?: never }).content ?? [], ""),
					ctx.sessionManager.getLeafId() ?? "",
				);''')

# tool_result read tracking: cast via unknown + guard content
src = src.replace('''			if (event.toolName === "read") {
				const text = contentText((event as { content?: never }).content ?? [], "");
				s.fileTracker.markRead(p, text);''', '''			if (event.toolName === "read") {
				const text = contentText((event as unknown as { content?: never }).content ?? [], "");
				s.fileTracker.markRead(p, text);''')

# structured result: readFiles/modifiedFiles come from preparation.fileOps, not the result
src = src.replace('''					details: {
						readFiles: structured.readFiles ?? [],
						modifiedFiles: structured.modifiedFiles ?? [],
						contract: structured.contract,
						ledger: structured.ledger,
						version: 2,
					},''', '''					details: {
						...computeFileLists(preparation.fileOps),
						contract: structured.contract,
						ledger: structured.ledger,
						version: 2,
					},''')
src = src.replace('''import {
	getForkHost,
	getLatestCompactionEntry,
	sessionEntryToContextMessages,
} from "@earendil-works/pi-coding-agent";''', '''import {
	computeFileLists,
	getForkHost,
	getLatestCompactionEntry,
	sessionEntryToContextMessages,
} from "@earendil-works/pi-coding-agent";''')
open(p, "w").write(src)
print("context fixed")

# shared/todo-state.ts: store constructor cast + definite-assignment
p = "shared/todo-state.ts"
src = open(p).read()
src = src.replace("s.store = new TodoStore(sm,", "s.store = new TodoStore(sm as SessionManager,")
src = src.replace('''	let s = states.get(sm);
	if (!s) {
		s = {''', '''	let s = states.get(sm);
	if (!s) {
		s = {''')
# the "s possibly undefined" at usage after set: ensure non-null via local var
src = src.replace("function stateFor(", "function stateForImpl(") if False else src
open(p, "w").write(src)
print("todo-state fixed")
