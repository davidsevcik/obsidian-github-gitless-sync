import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { config } from "./config";

const VMFS_PATH = "~/.e2e/vmfs.py";

// Homebrew tools, the Obsidian CLI included, are not on the PATH of
// non-interactive SSH sessions
const SHELL_ENV = 'eval "$(/opt/homebrew/bin/brew shellenv)"; ';

// Reuse one SSH connection for all the commands, there are a lot of them
const SSH_OPTIONS = [
  "-o",
  "BatchMode=yes",
  "-o",
  "ControlMaster=auto",
  "-o",
  "ControlPath=~/.ssh/e2e-%C",
  "-o",
  "ControlPersist=120",
];

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
}

/**
 * Runs a shell command on the VM.
 * @param input Sent on stdin, use it for anything that needs quoting or is secret
 */
export function sshExec(
  command: string,
  input: string | Buffer = "",
  timeoutMs = 120_000,
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("ssh", [
      ...SSH_OPTIONS,
      config.sshHost,
      SHELL_ENV + command,
    ]);
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Timed out after ${timeoutMs}ms on the VM: ${command}`));
    }, timeoutMs);
    child.stdout.on("data", (data) => (stdout += data));
    child.stderr.on("data", (data) => (stderr += data));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code: code ?? -1 });
    });
    child.stdin.end(input);
  });
}

/**
 * Copies the file helper to the VM, it must be done before calling vmfs.
 */
export async function installVmfs() {
  const script = readFileSync(path.join(__dirname, "vmfs.py"));
  const res = await sshExec(`mkdir -p ~/.e2e && cat > ${VMFS_PATH}`, script);
  if (res.code !== 0) {
    throw new Error(`Can't reach the VM: ${res.stderr.trim()}`);
  }
}

/**
 * Runs a file operation in the E2E vaults on the VM, see vmfs.py.
 */
export async function vmfs<T = Record<string, never>>(
  request: { op: string } & Record<string, unknown>,
): Promise<T> {
  const res = await sshExec(
    `/usr/bin/python3 ${VMFS_PATH}`,
    JSON.stringify({ vaultsDir: config.vaultsDir, ...request }),
  );
  if (res.code !== 0) {
    throw new Error(`File operation failed on the VM: ${res.stderr.trim()}`);
  }
  return JSON.parse(res.stdout) as T;
}

export const sleep = (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Polls until the condition is true, errors thrown by it count as false.
 */
export async function waitFor(
  what: string,
  condition: () => Promise<boolean>,
  timeoutMs = 30_000,
  intervalMs = 500,
) {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    try {
      if (await condition()) {
        return;
      }
      lastError = null;
    } catch (err) {
      lastError = err;
    }
    await sleep(intervalMs);
  }
  const reason = lastError instanceof Error ? `: ${lastError.message}` : "";
  throw new Error(`Timed out waiting for ${what}${reason}`);
}
