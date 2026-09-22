import { spawn, spawnSync } from "node:child_process";

function quoteArg(arg) {
  if (/^[a-zA-Z0-9_./:-]+$/.test(arg)) return arg;
  return `"${String(arg).replace(/"/g, '\\"')}"`;
}

function cmdToString(command, args) {
  return [command, ...args.map(quoteArg)].join(" ");
}

function createLineBuffer(maxLines = 24) {
  const lines = [];
  let pending = "";

  return {
    push(chunk) {
      pending += chunk;
      const split = pending.split(/\r?\n/);
      pending = split.pop() || "";
      for (const line of split) {
        if (!line) continue;
        lines.push(line);
        if (lines.length > maxLines) lines.shift();
      }
    },
    finalize() {
      if (pending) {
        lines.push(pending);
        pending = "";
        if (lines.length > maxLines) lines.shift();
      }
      return [...lines];
    },
  };
}

function forceKillProcessTree(pid) {
  if (!pid || pid <= 0) return;

  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
      stdio: "pipe",
      timeout: 10000,
      windowsHide: true,
    });
    return;
  }

  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return;
  }

  setTimeout(() => {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already exited.
    }
  }, 1000).unref();
}

export async function runCommandStep({
  stepLabel,
  command,
  args,
  cwd,
  timeoutMs,
  env,
}) {
  const commandText = cmdToString(command, args);
  const timeoutSec = Math.round(timeoutMs / 1000);
  console.log(`\n[${stepLabel}] Running (timeout ${timeoutSec}s): ${commandText}`);

  const lineBuffer = createLineBuffer();
  const startedAt = Date.now();

  const child = spawn(command, args, {
    cwd,
    env: env ? { ...process.env, ...env } : process.env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

  child.stdout?.on("data", (buf) => {
    const text = buf.toString();
    process.stdout.write(text);
    lineBuffer.push(text);
  });

  child.stderr?.on("data", (buf) => {
    const text = buf.toString();
    process.stderr.write(text);
    lineBuffer.push(text);
  });

  const timeout = setTimeout(() => {
    forceKillProcessTree(child.pid);
  }, timeoutMs);

  return new Promise((resolve, reject) => {
    child.on("error", (err) => {
      clearTimeout(timeout);
      const elapsedMs = Date.now() - startedAt;
      const lastLines = lineBuffer.finalize();
      reject(
        new Error(
          [
            `[${stepLabel}] Failed to start command after ${(elapsedMs / 1000).toFixed(1)}s`,
            `Command: ${commandText}`,
            `Cause: ${err.message}`,
            lastLines.length ? `Last output:\n${lastLines.join("\n")}` : "Last output: (none)",
          ].join("\n")
        )
      );
    });

    child.on("close", (code, signal) => {
      clearTimeout(timeout);
      const elapsedMs = Date.now() - startedAt;
      const lastLines = lineBuffer.finalize();
      const elapsedSec = (elapsedMs / 1000).toFixed(1);

      if (elapsedMs >= timeoutMs && (signal || code !== 0)) {
        reject(
          new Error(
            [
              `[${stepLabel}] Timed out after ${elapsedSec}s`,
              `Command: ${commandText}`,
              `Timeout: ${(timeoutMs / 1000).toFixed(1)}s`,
              `Process tree for PID ${child.pid} was terminated.`,
              lastLines.length ? `Last useful output:\n${lastLines.join("\n")}` : "Last useful output: (none)",
              `Investigate this step directly with the same command above.`,
            ].join("\n")
          )
        );
        return;
      }

      if (code !== 0) {
        reject(
          new Error(
            [
              `[${stepLabel}] Failed after ${elapsedSec}s with exit code ${code}${signal ? ` (signal ${signal})` : ""}`,
              `Command: ${commandText}`,
              lastLines.length ? `Last useful output:\n${lastLines.join("\n")}` : "Last useful output: (none)",
              `Investigate this step directly with the same command above.`,
            ].join("\n")
          )
        );
        return;
      }

      console.log(`[${stepLabel}] Completed in ${elapsedSec}s`);
      resolve({ code, elapsedMs, pid: child.pid });
    });
  });
}

export function isProcessAlive(pid) {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
