/** Error with the process exit code the CLI should use (2 = usage/refusal, 1 = content or check failure). */
export class DemoError extends Error {
  constructor(message, exitCode = 2) {
    super(message);
    this.name = "DemoError";
    this.exitCode = exitCode;
  }
}
