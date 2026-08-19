import re, glob, sys

# 1) drop now-unneeded SessionManager casts on getForkHost / WeakMap keys stay as-is
# 2) ctx.sendUserMessage(...) -> a sendUserMessage param threaded from pi
for f in ["context/index.ts", "bg-tasks/index.ts", "todo/index.ts", "ssh/index.ts", "subagent/index.ts", "ask-wait/index.ts", "ask-wait/lib/ask-wait.ts"]:
    src = open(f).read()
    src = src.replace("getForkHost(ctx.sessionManager as unknown as SessionManager)", "getForkHost(ctx.sessionManager)")
    open(f, "w").write(src)
    print("cast cleaned", f)
