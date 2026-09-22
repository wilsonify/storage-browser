import { runCommandStep, isProcessAlive } from "./run-command-with-timeout.mjs";

async function main() {
  let timedOut = false;
  let timedOutPid = null;

  try {
    await runCommandStep({
      stepLabel: "timeout-probe",
      command: process.execPath,
      args: ["-e", "console.log('timeout probe child started'); setInterval(() => {}, 1000);"],
      cwd: process.cwd(),
      timeoutMs: 2000,
    });
  } catch (err) {
    timedOut = err.message.includes("Timed out after");
    const pidMatch = err.message.match(/PID (\d+)/);
    if (pidMatch) timedOutPid = Number.parseInt(pidMatch[1], 10);
    console.log(err.message);
  }

  if (!timedOut) {
    throw new Error("Timeout probe failed: command did not time out as expected.");
  }

  if (timedOutPid && isProcessAlive(timedOutPid)) {
    throw new Error(`Timeout probe failed: child process ${timedOutPid} is still alive.`);
  }

  console.log("Timeout probe passed: timed-out child process tree was terminated.");
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
