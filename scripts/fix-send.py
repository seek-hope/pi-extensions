import re

# ssh: adapter sendFollowUp via pi (captured at factory scope)
p = "ssh/index.ts"
src = open(p).read()
src = src.replace(
    "function instanceFor(ctx: ExtensionContext): SshIntegration {",
    "function instanceFor(ctx: ExtensionContext, send: (text: string) => void): SshIntegration {")
src = src.replace(
    'sendFollowUp: (text) => ctx.sendUserMessage(text, { triggerTurn: true, deliverAs: "followUp" }),',
    "sendFollowUp: (text) => send(text),")
src = src.replace("instanceFor(ctx).", "instanceFor(ctx, send).")
src = src.replace("instanceFor(ctx)", "instanceFor(ctx, send)")
src = src.replace(
    "export default function (pi: ExtensionAPI) {",
    'export default function (pi: ExtensionAPI) {\n\tconst send = (text: string) => pi.sendUserMessage(text, { deliverAs: "followUp" });')
open(p, "w").write(src)
print("ssh done")

# subagent
p = "subagent/index.ts"
src = open(p).read()
src = src.replace(
    "function managerFor(ctx: ExtensionContext): SubagentManager | undefined {",
    "function managerFor(ctx: ExtensionContext, send: (text: string) => void): SubagentManager | undefined {")
src = src.replace(
    'sendFollowUp: (text) => ctx.sendUserMessage(text, { triggerTurn: true, deliverAs: "followUp" }),',
    "sendFollowUp: (text) => send(text),")
src = src.replace("managerFor(ctx)", "managerFor(ctx, send)")
src = src.replace(
    "export default function (pi: ExtensionAPI) {",
    'export default function (pi: ExtensionAPI) {\n\tconst send = (text: string) => pi.sendUserMessage(text, { deliverAs: "followUp" });')
open(p, "w").write(src)
print("subagent done")

# bg-tasks
p = "bg-tasks/index.ts"
src = open(p).read()
src = src.replace(
    "function ensureSubscription(ctx: ExtensionContext, store: BackgroundTaskStore): void {",
    "function ensureSubscription(ctx: ExtensionContext, store: BackgroundTaskStore, send: (text: string) => void): void {")
src = src.replace(
    'ctx.sendUserMessage(parts.join("\\n"), { triggerTurn: true, deliverAs: "followUp" });',
    "send(parts.join(\"\\n\"));")
src = src.replace("ensureSubscription(ctx, store)", "ensureSubscription(ctx, store, send)")
src = src.replace(
    "export default function (pi: ExtensionAPI) {",
    'export default function (pi: ExtensionAPI) {\n\tconst send = (text: string) => pi.sendUserMessage(text, { deliverAs: "followUp" });')
open(p, "w").write(src)
print("bg-tasks done")

# todo
p = "todo/index.ts"
src = open(p).read()
src = src.replace(
    'ctx.sendUserMessage(warning, { deliverAs: "steer" });',
    'pi.sendUserMessage(warning, { deliverAs: "steer" });')
src = src.replace(
    'ctx.sendUserMessage(TODO_COMPACTION_REMINDER, { triggerTurn: true, deliverAs: "followUp" });',
    'pi.sendUserMessage(TODO_COMPACTION_REMINDER, { deliverAs: "followUp" });')
open(p, "w").write(src)
print("todo done")
