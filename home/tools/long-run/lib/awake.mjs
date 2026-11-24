// Purpose: keep the machine from idle sleep while a run's driver lives (M5).
// Exports: AWAKE_BEAT_SECONDS, awakeCommand, startAwake.
// Invariants: the keeper ends by itself when the driver pid is gone (caffeinate -w, a PowerShell loop on the pid, `tail --pid`), so
//   a killed driver never leaves the machine awake for good; the pid is an integer checked before it reaches a command; macOS stops
//   idle sleep only (a closed lid on battery still sleeps); the Windows keeper is not verified (spec U5).
import { spawn, spawnSync } from 'node:child_process';

/** The Windows keeper renews its request this often. */
export const AWAKE_BEAT_SECONDS = 30;
const ES_CONTINUOUS = 0x80000000;
const ES_SYSTEM_REQUIRED = 0x00000001;

const windowsScript = (pid) => [
  "Add-Type -Name Power -Namespace LongRun -MemberDefinition '[DllImport(\"kernel32.dll\")] public static extern uint SetThreadExecutionState(uint esFlags);'",
  `while (Get-Process -Id ${pid} -ErrorAction SilentlyContinue) { [LongRun.Power]::SetThreadExecutionState(${ES_CONTINUOUS + ES_SYSTEM_REQUIRED}) > $null; Start-Sleep -Seconds ${AWAKE_BEAT_SECONDS} }`,
].join('; ');

/**
 * The keeper command for `pid`.
 * @param {string} platform process.platform.
 * @param {number} pid the driver's pid.
 * @param {{hasSystemdInhibit?: boolean}} facts whether `systemd-inhibit` exists (Linux).
 * @returns {{command: string, args: string[]} | null} null when the platform has none.
 * @throws {Error} for a pid that is not a positive integer.
 */
export function awakeCommand(platform, pid, { hasSystemdInhibit = false } = {}) {
  if (!Number.isInteger(pid) || pid <= 0) throw new Error(`not a pid: ${pid}`);
  if (platform === 'darwin') return { command: 'caffeinate', args: ['-i', '-w', String(pid)] };
  if (platform === 'win32') return { command: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', windowsScript(pid)] };
  if (platform === 'linux' && hasSystemdInhibit) {
    return { command: 'systemd-inhibit', args: ['--what=idle:sleep', '--who=long-run', '--why=a long run is working', 'tail', `--pid=${pid}`, '-f', '/dev/null'] };
  }
  return null;
}

/**
 * Starts the keeper for this process (detached, no output).
 * @param {{platform?: string, pid?: number, spawnFn?: Function, probe?: Function}} deps stand-ins for tests.
 * @returns {string} what was started, or why nothing was.
 */
export function startAwake({ platform = process.platform, pid = process.pid, spawnFn = spawn, probe = spawnSync } = {}) {
  const hasSystemdInhibit = platform === 'linux' && probe('systemd-inhibit', ['--version'], { stdio: 'ignore' }).status === 0;
  const command = awakeCommand(platform, pid, { hasSystemdInhibit });
  if (command === null) return 'keep-awake: none on this system';
  const child = spawnFn(command.command, command.args, { detached: true, stdio: 'ignore', windowsHide: true });
  child.on('error', () => {}); // a missing keeper only means the machine may sleep; the run itself goes on
  child.unref();
  return `keep-awake: ${command.command}`;
}
