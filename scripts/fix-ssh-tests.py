import re, glob

for f in glob.glob("test/ssh-*.test.ts"):
    src = open(f).read()
    src = re.sub(r'import type \{ CoreIntegrationContext \} from "\.\./src/core/integrations/types\.ts";',
                 'import type { SshIntegrationContext as CoreIntegrationContext } from "../ssh/lib/integration.ts";', src)
    src = re.sub(r'import \{ SettingsManager \} from "\.\./src/core/settings-manager\.ts";',
                 'import { SettingsManager } from "@earendil-works/pi-coding-agent";', src)
    src = re.sub(r'import \{ timeoutToMs \} from "\.\./src/utils/timeout\.ts";',
                 'import { timeoutToMs } from "@earendil-works/pi-coding-agent";', src)
    open(f, "w").write(src)
    print("fixed", f)
