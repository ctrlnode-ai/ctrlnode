/**
 * Shared utility for checking whether a CLI binary is installed and reachable.
 * Used by providers to implement IProvider.isAvailable().
 */
import { execFile } from 'child_process';

/**
 * Returns true if `binaryName` is reachable in PATH.
 * Runs `binaryName --version` with a 3-second timeout.
 * ENOENT (not installed) → false. Any other outcome (including non-zero exit) → true.
 */
export function checkBinaryExists(binaryName: string): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = execFile(binaryName, ['--version'], { timeout: 3000 }, (err) => {
      if (!err || (err as NodeJS.ErrnoException).code !== 'ENOENT') {
        resolve(true);
      } else {
        resolve(false);
      }
    });
    proc.on('error', (err) => {
      resolve((err as NodeJS.ErrnoException).code !== 'ENOENT');
    });
  });
}

/**
 * Returns true if `hermes acp` is installed (hermes-agent[acp] extra).
 * ENOENT → false. Non-zero exit from --check → false (ACP deps missing).
 */
export function checkHermesAcpAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    execFile('hermes', ['acp', '--check'], { timeout: 8000 }, (err) => {
      if (err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
        resolve(false);
        return;
      }
      resolve(!err);
    });
  });
}
