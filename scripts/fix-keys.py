import re, glob

# WeakMap keys: SessionManager -> ExtensionContext["sessionManager"] (readonly view is the runtime object)
for f in glob.glob("**/*.ts", recursive=True):
    if "node_modules" in f:
        continue
    src = open(f).read()
    orig = src
    src = re.sub(r"WeakMap<SessionManager,", 'WeakMap<ExtensionContext["sessionManager"],', src)
    src = src.replace("ctx.sessionManager as unknown as SessionManager", "ctx.sessionManager")
    src = src.replace("const sm = ctx.sessionManager as unknown as SessionManager;", "const sm = ctx.sessionManager;")
    if src != orig:
        open(f, "w").write(src)
        print("key type fixed", f)
