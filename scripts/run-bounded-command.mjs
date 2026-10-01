import { spawn } from 'node:child_process';

function usage(message) {
  console.error(`::error::${message}`);
  process.exitCode = 2;
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
    } else {
      const child = spawn(command[0], command.slice(1), {
        detached: true,
        stdio: 'inherit',
      });
      let timedOut = false;
      let forceKillTimer;
      const timeoutTimer = setTimeout(() => {
        timedOut = true;
        console.error(
          `::error::ONNX system dependency ${stage} timed out after ${timeoutSeconds} seconds; terminating its process group`,
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
        process.exitCode = 1;
      });
      child.once('close', (code, signal) => {
        clearTimeout(timeoutTimer);
        clearTimeout(forceKillTimer);
        if (timedOut) {
          process.exitCode = 124;
        } else if (code !== 0) {
          const result = signal ? `signal ${signal}` : `exit code ${code}`;
          console.error(`::error::ONNX system dependency ${stage} failed with ${result}`);
          process.exitCode = 1;
        }
      });
    }
  }
}
