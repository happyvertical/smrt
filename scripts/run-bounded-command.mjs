import { spawn } from 'node:child_process';

function usage(message) {
  console.error(`::error::${message}`);
  process.exitCode = 2;
}

// Runs the command once under a hard timeout and resolves with its outcome.
// A timeout terminates the command's whole owned process group (SIGTERM, then
// SIGKILL after the grace period) before resolving.
function runAttempt({ command, stage, timeoutSeconds, graceMilliseconds, label }) {
  return new Promise((resolve) => {
    const child = spawn(command[0], command.slice(1), {
      detached: true,
      stdio: 'inherit',
    });
    let timedOut = false;
    let forceKillTimer;
    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      console.error(
        `::error::ONNX system dependency ${stage} timed out after ${timeoutSeconds} seconds${label}; terminating its process group`,
      );
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch (error) {
        if (error.code !== 'ESRCH') throw error;
      }
      forceKillTimer = setTimeout(() => {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch (error) {
          if (error.code !== 'ESRCH') throw error;
        }
      }, graceMilliseconds);
    }, timeoutSeconds * 1_000);

    child.once('error', (error) => {
      clearTimeout(timeoutTimer);
      clearTimeout(forceKillTimer);
      console.error(`::error::ONNX system dependency ${stage} could not start: ${error.message}`);
      resolve({ exitCode: 1, retryable: false });
    });
    child.once('close', (code, signal) => {
      clearTimeout(timeoutTimer);
      if (timedOut) {
        resolve({ exitCode: 124, retryable: true });
      } else if (code !== 0) {
        clearTimeout(forceKillTimer);
        const result = signal ? `signal ${signal}` : `exit code ${code}`;
        console.error(`::error::ONNX system dependency ${stage} failed with ${result}${label}`);
        resolve({ exitCode: 1, retryable: true });
      } else {
        clearTimeout(forceKillTimer);
        resolve({ exitCode: 0, retryable: false });
      }
    });
  });
}

const arguments_ = process.argv.slice(2);
const commandStart = arguments_.indexOf('--');
if (commandStart === -1 || commandStart === arguments_.length - 1) {
  usage('Expected command after --');
} else {
  const options = arguments_.slice(0, commandStart);
  const command = arguments_.slice(commandStart + 1);
  let stage;
  let timeoutSeconds;
  let graceMilliseconds = 5_000;
  let attempts = 1;
  let backoffSeconds = 0;

  for (let index = 0; index < options.length; index += 2) {
    const option = options[index];
    const value = options[index + 1];
    if (value === undefined) {
      usage(`Missing value for ${option}`);
      break;
    }
    if (option === '--stage') stage = value;
    else if (option === '--timeout-seconds') timeoutSeconds = Number(value);
    else if (option === '--grace-ms') graceMilliseconds = Number(value);
    else if (option === '--attempts') attempts = Number(value);
    else if (option === '--backoff-seconds') backoffSeconds = Number(value);
    else {
      usage(`Unknown option ${option}`);
      break;
    }
  }

  if (process.exitCode === undefined) {
    if (!stage || !Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0 || !Number.isInteger(timeoutSeconds)) {
      usage('Expected --stage and a positive integer --timeout-seconds');
    } else if (!Number.isFinite(graceMilliseconds) || graceMilliseconds < 0) {
      usage('Expected a non-negative --grace-ms');
    } else if (!Number.isInteger(attempts) || attempts < 1) {
      usage('Expected a positive integer --attempts');
    } else if (!Number.isFinite(backoffSeconds) || backoffSeconds < 0) {
      usage('Expected a non-negative --backoff-seconds');
    } else {
      // Every attempt is individually bounded; only after the last one fails
      // does the stage fail closed with its named error and exit status.
      let outcome;
      for (let attempt = 1; attempt <= attempts; attempt += 1) {
        const label = attempts > 1 ? ` (attempt ${attempt}/${attempts})` : '';
        outcome = await runAttempt({ command, stage, timeoutSeconds, graceMilliseconds, label });
        if (outcome.exitCode === 0 || !outcome.retryable || attempt === attempts) break;
        const delaySeconds = backoffSeconds * attempt;
        console.error(`::warning::ONNX system dependency ${stage} will retry in ${delaySeconds} seconds`);
        await new Promise((resolve) => setTimeout(resolve, delaySeconds * 1_000));
      }
      process.exitCode = outcome.exitCode;
    }
  }
}
