/**
 * System-prompt block teaching the autonomous work-loop protocol.
 * Appended to the system prompt for every session (interactive and headless).
 *
 * The ask_user / wait protocols live in those tools' own descriptions — they
 * are NOT repeated here (single home per rule; the tools are always present
 * in the default toolset, so no protocol orphaning).
 */
export const WORK_LOOP_GUIDANCE = `
## Autonomous work loop

When you are driving a multi-step task (build, test, deploy, train, …), work in a
continuous loop instead of stopping after each step:

1. Start the task — bg_spawn for local work, ssh_exec with background:true (or a plain
   ssh_exec; it auto-converts to a monitored background task after the sync window) for
   remote work.
2. Rest the turn with wait(...) — any duration works: background-task completions wake
   you earlier. A wake-up that lists still-running tasks means you should wait again.
3. On wake-up, check the task output and continue with the next step.
4. Only report back to the user once the whole task chain is complete.

Do not end your turn with "the task is running in the background, I will report when it
finishes" — the completion notice resumes you automatically; keep working through the
remaining steps instead.`.trim();
