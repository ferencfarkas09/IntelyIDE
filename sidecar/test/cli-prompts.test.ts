import { describe, expect, it } from 'vitest';
import { cliPromptMessage, heredocFalsePositive, judgeCliPrompt, stripQuotedHeredocBodies } from '../src/adapters/claude-sdk/cli-prompts.js';

const BRACE = 'Contains brace with quote character (expansion obfuscation)';
const RANGE = 'Contains zsh <N-M> numeric-range glob';
const SUBST = 'Contains command_substitution';

describe('stripQuotedHeredocBodies', () => {
  it('cuts the body of a quoted heredoc that only writes a file, keeping the command around it', () => {
    const cmd = "mkdir -p /tmp/u && cat > src/a.js <<'EOF'\nconst a = {\"x\": [1, 2]};\nEOF";
    expect(stripQuotedHeredocBodies(cmd)).toBe('mkdir -p /tmp/u && cat > src/a.js');
    expect(stripQuotedHeredocBodies("cat > a.txt <<'EOF'\nx\nEOF\nnode a.js")).toBe('cat > a.txt\nnode a.js');
    expect(stripQuotedHeredocBodies("cd /w/repo && cat >> notes.md <<'END'\n{\"a\"}\nEND")).toBe('cd /w/repo && cat >> notes.md');
  });
  it('accepts the double-quoted and the backslash form, the redirect after the operator, tee, and <<- with tab-indented terminator', () => {
    expect(stripQuotedHeredocBodies('cat > a <<"EOF"\n{"k"}\nEOF')).toBe('cat > a');
    expect(stripQuotedHeredocBodies('cat > a <<\\EOF\n{"k"}\nEOF')).toBe('cat > a');
    expect(stripQuotedHeredocBodies("cat <<'EOF' > a\n{\"k\"}\nEOF")).toBe('cat > a');
    expect(stripQuotedHeredocBodies("tee out.json <<'EOF' > /dev/null\n{\"k\"}\nEOF")).toBe('tee out.json > /dev/null');
    expect(stripQuotedHeredocBodies("cat > a <<-'EOF'\n\t{\"k\"}\n\tEOF")).toBe('cat > a');
  });
  it('refuses to judge what is not a plain file write', () => {
    const body = '\n{"k": 1}\nEOF';
    for (const head of [
      "cat > a <<EOF", // unquoted delimiter: the shell expands the body
      "bash <<'EOF'", "sh <<'EOF'", "python3 - <<'EOF'", "node <<'EOF'", "cat <<'EOF' | sh", "cat <<'EOF' | tee a", // the body is run, or piped on
      "cat > a <<'EOF' && rm -rf x", "cat > $f <<'EOF'", "cat > 'a b' <<'EOF'", "eval \"$(cat <<'EOF'", "cat > a <<<'x'",
    ]) expect(stripQuotedHeredocBodies(head + body), head).toBeNull();
    expect(stripQuotedHeredocBodies("cat > a <<'EOF'\n{\"k\": 1}")).toBeNull(); // no terminator: the CLI would take the rest as the body
    expect(stripQuotedHeredocBodies('echo {"a","b"}')).toBeNull(); // no heredoc at all
    expect(stripQuotedHeredocBodies("echo \"<<'EOF'\"\nrm -rf x\nEOF")).toBeNull(); // the operator sits inside a quoted string
    expect(stripQuotedHeredocBodies("cat > a <<'EOF'\nx\nEOF\ncat > b <<EOF\ny\nEOF")).toBeNull(); // one unjudgeable heredoc spoils the command
  });
});

describe('heredocFalsePositive', () => {
  const write = (body: string) => `mkdir -p /tmp/u && cat > src/x.js <<'EOF'\n${body}\nEOF`;
  it('is true when the heuristic fired on the content of the heredoc only', () => {
    expect(heredocFalsePositive(BRACE, write('const a = {"x": 1};'))).toBe(true);
    expect(heredocFalsePositive(RANGE, write('range <1-5> and <10-20>'))).toBe(true);
    expect(heredocFalsePositive(SUBST, write('echo $(date) `uname` ${HOME}'))).toBe(true);
    expect(heredocFalsePositive('Contains command substitution', write('echo $(date)'))).toBe(true);
  });
  it('is false when the feature is also in the command itself, for another reason, or without a heredoc', () => {
    expect(heredocFalsePositive(BRACE, undefined)).toBe(false);
    expect(heredocFalsePositive(BRACE, 'echo {"a","b"} > x')).toBe(false);
    expect(heredocFalsePositive(BRACE, `${write('x')}\necho {"a","b"}`)).toBe(false);
    expect(heredocFalsePositive(SUBST, `${write('x')}\necho $(id)`)).toBe(false);
    expect(heredocFalsePositive(RANGE, `${write('x')}\nls <1-3>`)).toBe(false);
    expect(heredocFalsePositive('Dangerous command', write('x'))).toBe(false);
    expect(heredocFalsePositive("Claude requested permissions to edit /w/.bashrc which is a sensitive file.", write('x'))).toBe(false);
    expect(heredocFalsePositive(BRACE, "bash <<'EOF'\n{\"a\"}\nEOF")).toBe(false);
  });
});

describe('judgeCliPrompt with a heredoc command', () => {
  const cmd = "mkdir -p /tmp/u && cat > src/x.js <<'EOF'\nconst a = {\"x\": 1};\nEOF";
  it('answers the three text heuristics for a heredoc write in Automatic and Bypass, and still refuses them for a plain command', () => {
    for (const mode of ['automatic', 'bypass'] as const) {
      for (const reason of [BRACE, RANGE.replace('numeric', 'numeric'), SUBST]) {
        const heredocWrite = reason === BRACE ? cmd : cmd.replace('const a = {"x": 1};', reason === RANGE ? 'x <1-5>' : '$(date)');
        expect(judgeCliPrompt({ mode, reason, command: heredocWrite }), `${mode}: ${reason}`).toBeNull();
      }
    }
    expect(judgeCliPrompt({ mode: 'automatic', reason: BRACE, command: 'echo {"a","b"} > f' })).toEqual({ reason: BRACE });
    expect(judgeCliPrompt({ mode: 'automatic', reason: BRACE })).toEqual({ reason: BRACE });
  });
});

describe('cliPromptMessage', () => {
  it('names the reason and tells the model what works instead for the text heuristics', () => {
    const m = cliPromptMessage(BRACE, 'automatic');
    expect(m).toContain(BRACE);
    expect(m).toContain('Write or Edit tool');
    expect(m).toContain('switch to Ask');
    expect(cliPromptMessage('Path is outside allowed working directories', 'automatic')).not.toContain('Write or Edit tool');
  });
});
