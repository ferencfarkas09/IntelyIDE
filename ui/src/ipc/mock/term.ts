import type { TermData, TermExit, TermIpc } from "../term";

const CSI = "\x1b[";
const prompt = (where: string) => `${CSI}32m${where}${CSI}0m ${CSI}90m$${CSI}0m `;

/** Output of `colors`: the 16 ANSI colours, to check the theme mapping by eye. */
function colors(): string {
  const row = (base: number) => Array.from({ length: 8 }, (_, i) => `${CSI}${base + i}m ${String(i).padStart(2)} ${CSI}0m`).join("");
  return `${row(40)}\r\n${row(100)}\r\n`;
}

interface Shell {
  where: string;
  line: string;
}

/**
 * A tiny fake shell for the browser and for tests: it echoes typed input, edits the line (backspace, ^C) and knows a few
 * commands. There is no pty and no process behind it.
 */
export function createMockTerm(): TermIpc {
  const shells = new Map<string, Shell>();
  const data = new Set<(e: TermData) => void>();
  const exit = new Set<(e: TermExit) => void>();
  let seq = 0;
  const emit = (termId: string, text: string) => data.forEach((cb) => cb({ termId, data: text }));
  const quit = (termId: string, code: number) => {
    if (shells.delete(termId)) exit.forEach((cb) => cb({ termId, code }));
  };

  function run(termId: string, shell: Shell, command: string): void {
    const [name, ...args] = command.trim().split(/\s+/);
    switch (name) {
      case "":
        break;
      case "help":
        emit(termId, "mock shell (no pty in the browser): help, echo, pwd, seq N, colors, errors, clear, exit [code]\r\n");
        break;
      case "echo":
        emit(termId, `${args.join(" ")}\r\n`);
        break;
      case "pwd":
        emit(termId, `${shell.where}\r\n`);
        break;
      case "seq":
        for (let i = 1; i <= Math.min(Number(args[0]) || 10, 5000); i++) emit(termId, `${i}\r\n`);
        break;
      case "colors":
        emit(termId, colors());
        break;
      case "errors":
        emit(
          termId,
          `src/index.ts:12:5 - ${CSI}31merror${CSI}0m TS2322: Type 'string' is not assignable to type 'number'.\r\n` +
            `    at total (src/api/routes/index.js:6:3)\r\npackage.json:3 warning: unused field 'x'\r\n`,
        );
        break;
      case "clear":
        emit(termId, `${CSI}2J${CSI}3J${CSI}H`);
        break;
      case "exit":
        return quit(termId, Number(args[0]) || 0);
      default:
        emit(termId, `mock: command not found: ${name}\r\n`);
    }
    emit(termId, prompt(shell.where));
  }

  function type(termId: string, shell: Shell, text: string): void {
    for (let i = 0; i < text.length && shells.has(termId); i++) {
      const ch = text[i];
      if (ch === "\x1b") {
        // Escape sequences (arrows, function keys) are swallowed up to their final byte.
        const m = /^\x1b(?:\[[0-9;]*[A-Za-z~]|O[A-Za-z]|.)/.exec(text.slice(i));
        i += (m?.[0].length ?? 1) - 1;
      } else if (ch === "\r") {
        const command = shell.line;
        shell.line = "";
        emit(termId, "\r\n");
        run(termId, shell, command);
      } else if (ch === "\x7f") {
        if (shell.line) {
          shell.line = shell.line.slice(0, -1);
          emit(termId, "\b \b");
        }
      } else if (ch === "\x03") {
        shell.line = "";
        emit(termId, `^C\r\n${prompt(shell.where)}`);
      } else if (ch >= " ") {
        shell.line += ch;
        emit(termId, ch);
      }
    }
  }

  return {
    async open({ repoId, cwd }) {
      const termId = `mock-term-${++seq}`;
      const shell = { where: cwd ?? repoId ?? "~", line: "" };
      shells.set(termId, shell);
      queueMicrotask(() => emit(termId, `${CSI}90mmock shell: type help${CSI}0m\r\n${prompt(shell.where)}`));
      return { termId };
    },
    async write(termId, text) {
      const shell = shells.get(termId);
      if (shell) type(termId, shell, text);
    },
    async resize() {},
    async close(termId) {
      quit(termId, 0);
    },
    onData(cb) {
      data.add(cb);
      return () => data.delete(cb);
    },
    onExit(cb) {
      exit.add(cb);
      return () => exit.delete(cb);
    },
  };
}
