// Stand-in for the Rust policy.rs until it exists: the Phase 0 hard-stop text patterns (spikes/sdk/hard-stop.mjs, layer 2)
// answered through the same policy/decide shape. The enforcement suite swaps this for the real broker later.
const GITREF = String.raw`(?:^|[\s;&|(){}` + '`' + String.raw`$=]|\/)git`;
const OPTS = String.raw`(?:\s+(?:-C\s*\S+|-c\s*\S+|--[\w-]+(?:=\S+)?|-[pP]))*`;
const SUBCMD = new RegExp(GITREF + OPTS + String.raw`\s+(commit|push|tag|commit-tree|send-pack|fast-import|cherry-pick|rebase|merge|notes|update-ref)\b`);
const RESET_HARD = new RegExp(GITREF + OPTS + String.raw`\s+reset\b[^;&|]*--hard`);
const ADD_ALL = new RegExp(GITREF + OPTS + String.raw`\s+add\b[^;&|]*?(?:\s-[A-Za-z]*A[A-Za-z]*\b|\s--all\b|\s(?:\.\/?|:\/|:\(top\)\S*|\*)(?=\s|$|[;&|]))`);
const CFG_USER = /\s-c\s*(?:user|author|committer)\./i;
const ALIAS_MK = /\balias\.[\w-]+\s*[= ]\s*['"]?!?\s*(?:git\s+)?(?:commit|push)\b/i;
const OTHERS = [[/\bgh\s+(?:pr\s+(?:merge|create)|release\s+create)/, 'gh pr/release'], [/INTELY_HUMAN_TOKEN|token\.sha256/, 'human-token reference'], [/\bxargs\s+(?:-\S+\s+)*(?:\S*\/)?git\b/, 'xargs git']];
const SPAWN = /\b(child_process|execSync|spawnSync|execFile|subprocess|os\.system|Popen|system\s*\()/;
const WORDS = /\b(commit|push)\b/;

export function hardStopReason(raw) {
  const cmd = String(raw ?? '');
  const norm = cmd.replace(/['"\\]/g, '');
  for (const text of [cmd, norm]) {
    if (SUBCMD.test(text)) return 'git commit/push/tag/history-rewrite';
    if (RESET_HARD.test(text)) return 'git reset --hard';
    if (ADD_ALL.test(text)) return 'git add -A / .';
    if (CFG_USER.test(text)) return 'git -c user.*';
    if (ALIAS_MK.test(text)) return 'git alias to commit/push';
    for (const [re, why] of OTHERS) if (re.test(text)) return why;
  }
  if (SPAWN.test(cmd) && WORDS.test(cmd) && /git/.test(cmd)) return 'scripted git commit/push';
  return null;
}

const PROTECTED = /(?:^|\/)(?:\.git|\.husky|\.claude)(?:\/|$)/;

/** policy/decide body -> reply body. `askWrites` makes writes inside the repo go to the user. */
export function makePolicy({ askWrites = false, log = [] } = {}) {
  return (req) => {
    const i = req.intent;
    let out;
    if (i.class === 'exec') {
      const why = hardStopReason(i.rawCommand);
      out = why ? { decision: 'deny', by: 'hardStop', reason: `${why} is human-only` } : { decision: 'allow', by: 'saved' };
    } else if (i.class === 'write') {
      out = (i.paths ?? []).some((p) => PROTECTED.test(p)) ? { decision: 'deny', by: 'hardStop', reason: 'protected path' } : askWrites ? { decision: 'ask', by: 'roleDeny' } : { decision: 'allow', by: 'saved' };
    } else out = { decision: 'allow', by: 'saved' };
    log.push({ tool: i.tool, class: i.class, cmd: i.rawCommand, paths: i.paths, ...out });
    return out;
  };
}
