/**
 * Tests for bash gate (bash-gate.ts).
 */
import { describe, expect, it } from "vitest";
import { checkBashGate, formatGateResponse } from "../fork-bash-gate/lib/bash-gate.ts";

// ============================================================================
// Bash Gate tests
// ============================================================================

describe("bash gate: cat / file reading (intentionally unblocked)", () => {
	it("allows cat with a file argument", () => {
		expect(checkBashGate("cat src/index.ts")).toBeUndefined();
	});

	it("allows cat with flags", () => {
		expect(checkBashGate("cat -n src/index.ts")).toBeUndefined();
	});

	it("allows cat inside a pipeline", () => {
		expect(checkBashGate("cat src/*.ts | grep 'func'")).toBeUndefined();
	});

	it("blocks cat with output redirect (> file)", () => {
		const m = checkBashGate("cat > output.txt");
		expect(m).toBeDefined();
		expect(m!.rule.name).toBe("cat-redirect-write");
	});

	it("allows head file", () => {
		expect(checkBashGate("head -n 20 README.md")).toBeUndefined();
	});

	it("allows tail file", () => {
		expect(checkBashGate("tail -n 5 server.log")).toBeUndefined();
	});

	it("allows echo without redirect", () => {
		const m = checkBashGate("echo hello world");
		expect(m).toBeUndefined();
	});
});

describe("bash gate: sed / file editing", () => {
	it("blocks sed -i (in-place edit)", () => {
		const m = checkBashGate("sed -i 's/old/new/' file.ts");
		expect(m).toBeDefined();
		expect(m!.rule.toolName).toBe("edit");
	});

	it("blocks sed with --in-place", () => {
		const m = checkBashGate("sed --in-place 's/x/y/g' file.txt");
		expect(m).toBeDefined();
		expect(m!.rule.toolName).toBe("edit");
	});

	it("blocks sed without -i when reading a file operand", () => {
		// sed with a FILE operand and no -i prints the transformed file —
		// that is a disguised read (the reported bypass), not a filter.
		const m = checkBashGate("sed 's/old/new/' file.ts");
		expect(m).toBeDefined();
		expect(m!.rule.name).toBe("sed-awk-read");
		expect(m!.rule.toolName).toBe("read");
	});
});

describe("bash gate: ssh / scp", () => {
	it("blocks ssh to remote host", () => {
		const m = checkBashGate("ssh root@example.com 'uptime'");
		expect(m).toBeDefined();
		expect(m!.rule.toolName).toBe("ssh_exec");
	});

	it("allows ssh -T to git hosts (git over SSH)", () => {
		// This is allowed because git-over-SSH is the standard VCS workflow
		const m = checkBashGate("ssh -T git@github.com");
		expect(m).toBeUndefined();
	});

	it("blocks scp", () => {
		const m = checkBashGate("scp file.txt user@host:/data/");
		expect(m).toBeDefined();
		expect(m!.rule.toolName).toBe("scp_to_remote");
	});
});

describe("bash gate: background / tmux / nohup", () => {
	it("blocks tmux new-session", () => {
		const m = checkBashGate("tmux new-session -d -s build 'npm run build'");
		expect(m).toBeDefined();
		expect(m!.rule.toolName).toBe("bg_spawn");
	});

	it("blocks nohup", () => {
		const m = checkBashGate("nohup npm test &");
		expect(m).toBeDefined();
		expect(m!.rule.toolName).toBe("bg_spawn");
	});
});

describe("bash gate: heredoc", () => {
	it("blocks cat with heredoc", () => {
		const m = checkBashGate("cat > file.txt <<'EOF'");
		expect(m).toBeDefined();
		expect(m!.rule.toolName).toBe("write");
	});
});

describe("bash gate: echo redirect", () => {
	it("blocks echo with output redirect", () => {
		const m = checkBashGate("echo 'export KEY=val' >> ~/.bashrc");
		expect(m).toBeDefined();
		expect(m!.rule.toolName).toBe("edit");
		expect(m!.rule.name).toBe("append-redirect");
	});
});

describe("bash gate: sleep", () => {
	it("blocks sleep command", () => {
		const m = checkBashGate("sleep 60");
		expect(m).toBeDefined();
		expect(m!.rule.toolName).toBe("bg_spawn");
	});

	it("blocks while-do-sleep polling loops", () => {
		const m = checkBashGate("while true; do echo checking; sleep 3; done");
		expect(m).toBeDefined();
		expect(m!.rule.name).toBe("while-poll-loop");
		expect(m!.rule.toolName).toBe("bg_spawn");
	});

	it("blocks watch command", () => {
		const m = checkBashGate("watch -n 2 ls /tmp");
		expect(m).toBeDefined();
		expect(m!.rule.name).toBe("watch-command");
		expect(m!.rule.toolName).toBe("bg_spawn");
	});
});

describe("bash gate: uninterrupted commands", () => {
	it("allows npm commands", () => {
		expect(checkBashGate("npm install")).toBeUndefined();
		expect(checkBashGate("npm test")).toBeUndefined();
		expect(checkBashGate("npm run build")).toBeUndefined();
	});

	it("allows git commands (non-SSH)", () => {
		expect(checkBashGate("git status")).toBeUndefined();
		expect(checkBashGate("git diff")).toBeUndefined();
		expect(checkBashGate("git log --oneline")).toBeUndefined();
	});

	it("allows docker / docker-compose", () => {
		expect(checkBashGate("docker ps")).toBeUndefined();
		expect(checkBashGate("docker compose up -d")).toBeUndefined();
	});

	it("allows cargo / go / python commands", () => {
		expect(checkBashGate("cargo build")).toBeUndefined();
		expect(checkBashGate("go test ./...")).toBeUndefined();
		expect(checkBashGate("python -m pytest")).toBeUndefined();
	});

	it("allows curl / wget", () => {
		expect(checkBashGate("curl -s https://api.example.com")).toBeUndefined();
		expect(checkBashGate("wget https://example.com/file.tar.gz")).toBeUndefined();
	});

	it("allows complex multi-line commands", () => {
		expect(checkBashGate("mkdir -p dist && cp -r src/* dist/")).toBeUndefined();
		expect(checkBashGate("if [ -f package.json ]; then npm install; fi")).toBeUndefined();
	});

	it("allows variable assignment", () => {
		expect(checkBashGate("FOO=bar && echo $FOO")).toBeUndefined();
	});
});

// ============================================================================
// formatGateResponse
// ============================================================================

describe("formatGateResponse", () => {
	it("formats a blocked command response with reason", () => {
		const m = checkBashGate("cat > output.txt");
		expect(m).toBeDefined();
		const resp = formatGateResponse(m!);
		expect(resp).toContain("[BLOCKED]");
		expect(resp).toContain("cat > output.txt");
		expect(resp).toContain("write()");
		expect(resp).toContain("bg_spawn()");
	});

	it("truncates long commands", () => {
		const longArg = "a".repeat(150);
		const m = checkBashGate(`sed -i s/x/y/ ${longArg}`);
		expect(m).toBeDefined();
		const resp = formatGateResponse(m!);
		expect(resp).toContain("...");
		// The truncated command is capped at 120 chars; the full message includes
		// the reason and bg_spawn hint. Verify it's reasonably short.
		expect(resp.length).toBeLessThan(longArg.length + 300);
	});
});

describe("bash gate: path-prefixed bypass", () => {
	it("blocks path-prefixed ssh / scp / sleep / watch", () => {
		expect(checkBashGate("/usr/bin/ssh host id")!.rule.name).toBe("ssh-remote");
		expect(checkBashGate("/bin/scp f user@host:/d/")!.rule.name).toBe("scp-transfer");
		expect(checkBashGate("/bin/sleep 5")!.rule.name).toBe("sleep-command");
		expect(checkBashGate("/usr/bin/watch -n 1 ls")!.rule.name).toBe("watch-command");
	});
});

describe("bash gate: wrapper-prefix bypass", () => {
	it("blocks gated commands behind env assignments and keyword wrappers", () => {
		expect(checkBashGate("FOO=1 ssh host id")!.rule.name).toBe("ssh-remote");
		expect(checkBashGate("command ssh host id")!.rule.name).toBe("ssh-remote");
		expect(checkBashGate("builtin ssh host id")!.rule.name).toBe("ssh-remote");
		expect(checkBashGate("setsid ssh host id")!.rule.name).toBe("ssh-remote");
		expect(checkBashGate("sudo command ssh host id")!.rule.name).toBe("ssh-remote");
		expect(checkBashGate("timeout 30 ssh host id")!.rule.name).toBe("ssh-remote");
		expect(checkBashGate("stdbuf -oL ssh host id")!.rule.name).toBe("ssh-remote");
		expect(checkBashGate("xargs ssh host id")!.rule.name).toBe("ssh-remote");
		expect(checkBashGate("A=1 B=2 /usr/bin/ssh host id")!.rule.name).toBe("ssh-remote");
	});

	it("blocks gated commands smuggled through ANSI-C / locale quoting", () => {
		expect(checkBashGate('$"ssh" host id')!.rule.name).toBe("ssh-remote");
		expect(checkBashGate("$'ssh' host id")!.rule.name).toBe("ssh-remote");
		expect(checkBashGate(`$'s\\x73h' host id`)!.rule.name).toBe("ssh-remote");
	});
});

describe("bash gate: quoted content (false-positive fixes)", () => {
	it("allows redirects inside quotes", () => {
		expect(checkBashGate(`echo "don't > break"`)).toBeUndefined();
		expect(checkBashGate("echo '2 > 1'")).toBeUndefined();
	});

	it("allows gated-command mentions inside quotes", () => {
		expect(checkBashGate(`echo "use sed -i to fix"`)).toBeUndefined();
		expect(checkBashGate("grep 'cat <<EOF' src/")).toBeUndefined();
	});

	it("allows sleep mentioned inside quotes", () => {
		expect(checkBashGate(`echo "remember to sleep 5 between retries"`)).toBeUndefined();
	});
});

describe("bash gate: quoting/escaping bypass (false-negative fixes)", () => {
	it("blocks backslash-escaped sed -i", () => {
		const m = checkBashGate("\\sed -i s/x/y/ file");
		expect(m).toBeDefined();
		expect(m!.rule.name).toBe("sed-in-place");
	});

	it("blocks single-quoted sed -i", () => {
		const m = checkBashGate("'sed' -i s/x/y/ file");
		expect(m).toBeDefined();
		expect(m!.rule.name).toBe("sed-in-place");
	});

	it("blocks double-quoted sed -i", () => {
		const m = checkBashGate('"sed" -i s/x/y/ file');
		expect(m).toBeDefined();
		expect(m!.rule.name).toBe("sed-in-place");
	});
});

describe("bash gate: command chaining", () => {
	it("blocks ssh after &&", () => {
		const m = checkBashGate("foo && ssh host cmd");
		expect(m).toBeDefined();
		expect(m!.rule.name).toBe("ssh-remote");
	});

	it("allows cat after ;", () => {
		expect(checkBashGate("foo; cat x")).toBeUndefined();
	});

	it("blocks sleep after ||", () => {
		const m = checkBashGate("foo || sleep 5");
		expect(m).toBeDefined();
		expect(m!.rule.name).toBe("sleep-command");
	});

	it("allows cat as a pipe segment", () => {
		expect(checkBashGate("cat file | grep x")).toBeUndefined();
	});
});

describe("bash gate: redirect vs read ordering", () => {
	it("reports cat a b > c as a write, not a read", () => {
		const m = checkBashGate("cat a b > c");
		expect(m).toBeDefined();
		expect(m!.rule.name).toBe("cat-redirect-write");
		expect(m!.rule.toolName).toBe("write");
	});
});

describe("bash gate: wrapper bypass", () => {
	it("blocks sudo sleep", () => {
		expect(checkBashGate("sudo sleep 5")!.rule.name).toBe("sleep-command");
	});

	it("blocks command sleep", () => {
		expect(checkBashGate("command sleep 5")!.rule.name).toBe("sleep-command");
	});

	it("blocks env VAR=val ssh", () => {
		expect(checkBashGate("env FOO=1 ssh h id")!.rule.name).toBe("ssh-remote");
	});

	it("blocks xargs sleep", () => {
		expect(checkBashGate("xargs sleep 5")!.rule.name).toBe("sleep-command");
	});

	it("blocks nice sleep", () => {
		expect(checkBashGate("nice sleep 5")!.rule.name).toBe("sleep-command");
	});

	it("blocks time sleep", () => {
		expect(checkBashGate("time sleep 5")!.rule.name).toBe("sleep-command");
	});

	it("does not treat wrappers as gated by themselves", () => {
		expect(checkBashGate("time npm test")).toBeUndefined();
		expect(checkBashGate("env FOO=bar make")).toBeUndefined();
	});
});

describe("bash gate: polling loops", () => {
	it("allows while-read line iteration (not polling)", () => {
		expect(checkBashGate("while read l; do echo $l; done < file")).toBeUndefined();
	});

	it("blocks while loops with sleep", () => {
		const m = checkBashGate("while [ ! -f done.flag ]; do sleep 1; done");
		expect(m).toBeDefined();
		expect(m!.rule.name).toBe("while-poll-loop");
	});

	it("blocks until loops with sleep", () => {
		const m = checkBashGate("until [ -f lock ]; do sleep 2; done");
		expect(m).toBeDefined();
		expect(m!.rule.name).toBe("while-poll-loop");
		expect(m!.rule.toolName).toBe("bg_spawn");
	});
});

describe("bash gate: log following", () => {
	it("blocks tail -f with bg_spawn hint", () => {
		const m = checkBashGate("tail -f app.log");
		expect(m).toBeDefined();
		expect(m!.rule.name).toBe("tail-follow");
		expect(m!.rule.toolName).toBe("bg_spawn");
		expect(m!.rule.reason).toContain("bg_spawn");
	});

	it("blocks tail -F", () => {
		expect(checkBashGate("tail -F app.log")!.rule.name).toBe("tail-follow");
	});

	it("blocks less +F", () => {
		expect(checkBashGate("less +F app.log")!.rule.name).toBe("tail-follow");
	});
});

describe("bash gate: harmless redirects", () => {
	it("allows stderr redirects", () => {
		expect(checkBashGate("echo hi >&2")).toBeUndefined();
		expect(checkBashGate("echo hi 2>err")).toBeUndefined();
		expect(checkBashGate("echo hi 2>&1")).toBeUndefined();
	});

	it("allows writes to /dev/null", () => {
		expect(checkBashGate("echo hi > /dev/null")).toBeUndefined();
	});
});

describe("bash gate: input redirect reads (intentionally unblocked)", () => {
	it("allows cat < input.txt", () => {
		expect(checkBashGate("cat < input.txt")).toBeUndefined();
	});

	it("allows head < file", () => {
		expect(checkBashGate("head < file")).toBeUndefined();
	});

	it("allows herestrings", () => {
		expect(checkBashGate('cat <<< "literal text"')).toBeUndefined();
	});
});

describe("bash gate: sed attached-suffix forms", () => {
	it("blocks GNU sed -i.bak", () => {
		const m = checkBashGate("sed -i.bak 's/a/b/' f");
		expect(m).toBeDefined();
		expect(m!.rule.name).toBe("sed-in-place");
	});

	it("blocks macOS sed -i''", () => {
		const m = checkBashGate("sed -i'' 's/a/b/' f");
		expect(m).toBeDefined();
		expect(m!.rule.name).toBe("sed-in-place");
	});
});

describe("bash gate: stdin pipe filters (no file operand)", () => {
	it("allows piping into tail/head/less/cat without a file", () => {
		expect(checkBashGate("npm test 2>&1 | tail -8")).toBeUndefined();
		expect(checkBashGate("npm test | tail")).toBeUndefined();
		expect(checkBashGate("npm test | head -20")).toBeUndefined();
		expect(checkBashGate("npm test | head")).toBeUndefined();
		expect(checkBashGate("npm test | less")).toBeUndefined();
		expect(checkBashGate("npm test | cat")).toBeUndefined();
		expect(checkBashGate("grep -E foo bar | head -n 5")).toBeUndefined();
	});

	it("allows head/tail flag-only stdin forms", () => {
		expect(checkBashGate("yes | head -n 5")).toBeUndefined();
		expect(checkBashGate("yes | head -c 100")).toBeUndefined();
		expect(checkBashGate("yes | tail -n +5")).toBeUndefined();
	});

	it("allows file reads through flags", () => {
		expect(checkBashGate("cat -n file")).toBeUndefined();
		expect(checkBashGate("head -n 5 file")).toBeUndefined();
		expect(checkBashGate("tail -n +5 file")).toBeUndefined();
		expect(checkBashGate("cat file | grep x")).toBeUndefined();
	});

	it("allows process substitution reads", () => {
		expect(checkBashGate("cat <(echo hi)")).toBeUndefined();
		expect(checkBashGate("diff <(ls a) <(ls b)")).toBeUndefined();
	});
});

describe("bash gate: sed/awk/perl as readers", () => {
	it("blocks sed -n with a file operand (the reported bypass)", () => {
		const m = checkBashGate("cd path && sed -n '1,20p' file.ts");
		expect(m).toBeDefined();
		expect(m!.rule.name).toBe("sed-awk-read");
		expect(m!.rule.toolName).toBe("read");
	});

	it("blocks sed script + file without -i", () => {
		expect(checkBashGate("sed 's/a/b/' file")!.rule.name).toBe("sed-awk-read");
		expect(checkBashGate("sed -E 's/a(b)c/d/' file")!.rule.name).toBe("sed-awk-read");
	});

	it("blocks sed script + input redirect", () => {
		expect(checkBashGate("sed -n '1,5p' < file")!.rule.name).toBe("sed-awk-read");
	});

	it("blocks awk/perl script + file", () => {
		expect(checkBashGate("awk '{print}' file")!.rule.name).toBe("sed-awk-read");
		expect(checkBashGate("awk 'NR<10' file")!.rule.name).toBe("sed-awk-read");
		expect(checkBashGate("perl -ne 'print' file")!.rule.name).toBe("sed-awk-read");
	});

	it("allows sed/awk/perl as stdin filters", () => {
		expect(checkBashGate("echo hello | sed 's/a/b/'")).toBeUndefined();
		expect(checkBashGate("npm test | sed -n '/fail/p'")).toBeUndefined();
		expect(checkBashGate("npm test | awk '{print}'")).toBeUndefined();
		expect(checkBashGate("printf 'a\\nb\\n' | awk '{print $1}'")).toBeUndefined();
	});

	it("allows sed reads redirected to another file (data processing)", () => {
		expect(checkBashGate("sed -n '1,5p' file > out.txt")).toBeUndefined();
	});
});

describe("bash gate: pager and cat variants", () => {
	it("blocks more/most with a file operand", () => {
		expect(checkBashGate("more file")!.rule.name).toBe("less-file");
		expect(checkBashGate("most file")!.rule.name).toBe("less-file");
	});

	it("allows tac/bat/batcat with a file operand", () => {
		expect(checkBashGate("tac file")).toBeUndefined();
		expect(checkBashGate("bat file")).toBeUndefined();
		expect(checkBashGate("batcat file")).toBeUndefined();
	});

	it("allows piped pagers without a file operand", () => {
		expect(checkBashGate("npm test | more")).toBeUndefined();
		expect(checkBashGate("npm test | most")).toBeUndefined();
	});
});

describe("bash gate: printf redirect writes", () => {
	it("blocks printf > file and printf >> file", () => {
		expect(checkBashGate("printf 'x\\n' > file")!.rule.category).toBe("write");
		expect(checkBashGate("printf 'x\\n' >> file")!.rule.name).toBe("append-redirect");
	});

	it("does not false-positive on mid-segment printf (compiler output)", () => {
		expect(checkBashGate("gcc -o printf main.c > build.log")).toBeUndefined();
		expect(checkBashGate("gcc -o echo main.c > build.log")).toBeUndefined();
	});
});

describe("bash gate: perl in-place editing", () => {
	it("blocks perl -pi -e", () => {
		const m = checkBashGate("perl -pi -e 's/a/b/' file");
		expect(m).toBeDefined();
		expect(m!.rule.name).toBe("perl-in-place");
		expect(m!.rule.toolName).toBe("edit");
	});
});

describe("bash gate: nested shells", () => {
	it("blocks bash/sh -c at segment start", () => {
		expect(checkBashGate('bash -c "cat file"')!.rule.name).toBe("nested-shell");
		expect(checkBashGate("sh -c 'cat file'")!.rule.name).toBe("nested-shell");
		expect(checkBashGate("zsh -c 'cat file'")!.rule.name).toBe("nested-shell");
		expect(checkBashGate("bash -lc 'cat file'")!.rule.name).toBe("nested-shell");
		expect(checkBashGate("cd x && bash -c 'ls'")!.rule.name).toBe("nested-shell");
	});

	it("blocks bash -s reading a script from stdin", () => {
		expect(checkBashGate("echo 'cat f' | bash -s")!.rule.name).toBe("nested-shell");
	});

	it("allows running script files", () => {
		expect(checkBashGate("bash script.sh")).toBeUndefined();
		expect(checkBashGate("sh ./deploy.sh --force")).toBeUndefined();
		expect(checkBashGate("bash -x script.sh")).toBeUndefined();
	});

	it("allows nested shells in non-initial position (docker exec)", () => {
		expect(checkBashGate("docker exec app bash -c 'ls /data'")).toBeUndefined();
	});
});
