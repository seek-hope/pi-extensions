import re

# ask-wait lib: widen stateFor key
p = "ask-wait/lib/ask-wait.ts"
src = open(p).read()
src = src.replace("function stateFor(sm: SessionManager): WaitState {", 'function stateFor(sm: ExtensionContext["sessionManager"]): WaitState {')
src = src.replace("const waitStates = new WeakMap<SessionManager, WaitState>();", 'const waitStates = new WeakMap<ExtensionContext["sessionManager"], WaitState>();')
open(p, "w").write(src)
print("ask-wait lib keys widened")

# bg-tasks: subscribed WeakSet + tool definition typing
p = "bg-tasks/index.ts"
src = open(p).read()
src = src.replace("const subscribed = new WeakSet<SessionManager>();", 'const subscribed = new WeakSet<ExtensionContext["sessionManager"]>();')
src = src.replace('const sm = ctx.sessionManager;', 'const sm = ctx.sessionManager;', 1)
# tool details: annotate via explicit type params on registerTool
src = src.replace('''	pi.registerTool({
		name: "bg_output",''', '''	pi.registerTool<typeof bgOutputSchema, { taskId?: string; status?: string }>({
		name: "bg_output",''')
src = src.replace('''	pi.registerTool({
		name: "bg_kill",''', '''	pi.registerTool<typeof bgKillSchema, { taskId?: string; killed?: boolean }>({
		name: "bg_kill",''')
# hoist schemas as named consts for the annotations
src = src.replace('''		parameters: Type.Object({
			task_id: Type.String({ description: "Task ID (from bg_spawn/bg_status)." }),
			tail_lines: Type.Optional(
				Type.Integer({
					description: "How many lines from the end of the log to return (default 50, max 500).",
					minimum: 1,
					maximum: 500,
				}),
			),
		}),''', '''		parameters: bgOutputSchema,''')
src = src.replace('''		parameters: Type.Object({
			task_id: Type.String({ description: "Task ID to stop (from bg_spawn/bg_status)." }),
		}),''', '''		parameters: bgKillSchema,''')
schema_decls = '''
const bgOutputSchema = Type.Object({
	task_id: Type.String({ description: "Task ID (from bg_spawn/bg_status)." }),
	tail_lines: Type.Optional(
		Type.Integer({
			description: "How many lines from the end of the log to return (default 50, max 500).",
			minimum: 1,
			maximum: 500,
		}),
	),
);

const bgKillSchema = Type.Object({
	task_id: Type.String({ description: "Task ID to stop (from bg_spawn/bg_status)." }),
});
'''
src = src.replace("export default function (pi: ExtensionAPI) {", schema_decls + "\nexport default function (pi: ExtensionAPI) {")
open(p, "w").write(src)
print("bg-tasks fixed")

# context: remaining type fixes
p = "context/index.ts"
src = open(p).read()
src = src.replace('contentText((message as { content?: never }).content ?? [], "")',
                  'contentText((message as unknown as { content?: never }).content ?? [], "")')
src = src.replace('import { type AutoReviewCandidate, parseConflictIds, runAutoReview } from "./lib/auto-review.ts";',
                  'import { type AutoReviewCandidate, parseConflictIds, runAutoReview, type UserOverrideProposal } from "./lib/auto-review.ts";')
src = src.replace('''	proposal: { flagId: string; claim: string; proposed: string },''',
                  '''	proposal: UserOverrideProposal,''')
src = src.replace('''				`The auto-review wants to override your earlier ruling:\\n[${proposal.flagId}] ${proposal.claim}\\n→ ${proposal.proposed}\\n\\nAccept the override?`,''',
                  '''				`The auto-review wants to override your earlier ruling:\\n[${proposal.flagId}] ${proposal.claim}\\n→ ${proposal.decision}${proposal.correction ? `: ${proposal.correction}` : ""}\\n\\nAccept the override?`,''')
src = src.replace("headers: result.auth.headers,", 'headers: result.auth.headers as Record<string, string> | undefined,')
open(p, "w").write(src)
print("context fixed")
