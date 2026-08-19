import re, glob, os

# Repoint moved tests from pi-ex core paths to the extension libs
RULES = [
    (r'\.\./src/core/compaction/fork\.ts', 'context/lib/pipeline.ts'),
    (r'\.\./src/core/compaction/fork-utils\.ts', 'context/lib/utils.ts'),
    (r'\.\./src/core/compaction/checkpoint\.ts', 'context/lib/checkpoint.ts'),
    (r'\.\./src/core/compaction/contract\.ts', 'context/lib/contract.ts'),
    (r'\.\./src/core/compaction/ledger\.ts', 'context/lib/ledger.ts'),
    (r'\.\./src/core/compaction/auto-review\.ts', 'context/lib/auto-review.ts'),
    (r'\.\./src/core/compaction/content-dedup\.ts', 'context/lib/content-dedup.ts'),
    (r'\.\./src/core/compaction/summary-review\.ts', 'context/lib/summary-review.ts'),
    (r'\.\./src/core/compaction/review\.ts', 'context/lib/review.ts'),
    (r'\.\./src/core/compaction/uncertainty\.ts', 'context/lib/uncertainty.ts'),
    (r'\.\./src/core/compaction/utils\.ts', '@earendil-works/pi-coding-agent'),
    (r'\.\./src/core/compaction/index\.ts', '@earendil-works/pi-coding-agent'),
    (r'\.\./src/core/compaction/compaction\.ts', '@earendil-works/pi-coding-agent'),
    (r'\.\./src/core/file-context\.ts', 'shared/file-context.ts'),
    (r'\.\./src/core/session-manager\.ts', '@earendil-works/pi-coding-agent'),
    (r'\.\./src/core/settings-manager\.ts', '@earendil-works/pi-coding-agent'),
    (r'\.\./src/core/messages\.ts', '@earendil-works/pi-coding-agent'),
    (r'\.\./src/modes/interactive/components/uncertainty-review\.ts', 'SKIP'),
    (r'\.\./src/modes/interactive/components/compaction-review\.ts', 'SKIP'),
]

for f in glob.glob("test/*.test.ts"):
    src = open(f).read()
    orig = src
    for pat, repl in RULES:
        if repl == 'SKIP':
            continue
        src = re.sub(r'from "' + pat + '"', f'from "../{repl}"' if not repl.startswith('@') else f'from "{repl}"', src)
    if src != orig:
        open(f, "w").write(src)
        print("repointed", f)
