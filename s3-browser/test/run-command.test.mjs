import test from "node:test";
import assert from "node:assert/strict";

import { isProcessAlive, runCommandStep } from "../scripts/run-command-with-timeout.mjs";

const NODE = process.execPath;

test("a successful command resolves with its code and pid", async () => {
  const result = await runCommandStep({
    stepLabel: "success",
    command: NODE,
    args: ["-e", "console.log('hello from child')"],
    timeoutMs: 15000,
  });

  assert.equal(result.code, 0);
  assert.equal(result.elapsedMs >= 0, true);
  assert.equal(typeof result.pid, "number");
  assert.equal(isProcessAlive(result.pid), false, "the child is gone once the step resolves");
});

test("a non-zero exit rejects with the command and a clear reason", async () => {
  await assert.rejects(
    () => runCommandStep({
      stepLabel: "failing",
      command: NODE,
      args: ["-e", "process.exit(3)"],
      timeoutMs: 15000,
    }),
    (error) => {
      assert.match(error.message, /^\[failing\] Failed after [\d.]+s with exit code 3/m);
      assert.match(error.message, /Investigate this step directly/);
      assert.match(error.message, /Last useful output: \(none\)/);
      return true;
    },
  );
});

test("recent output is included and older lines are dropped", async () => {
  await assert.rejects(
    () => runCommandStep({
      stepLabel: "noisy",
      command: NODE,
      args: ["-e", "for (let i = 1; i <= 40; i += 1) console.log('line-' + i); process.exit(1)"],
      timeoutMs: 15000,
    }),
    (error) => {
      assert.match(error.message, /line-40/, "the newest output is kept");
      assert.equal(/line-1\b/.test(error.message), false, "only the last 24 lines are retained");
      assert.match(error.message, /line-17/, "the window covers the last 24 lines");
      return true;
    },
  );
});

test("a hanging command is killed and reported as a timeout", async () => {
  await assert.rejects(
    () => runCommandStep({
      stepLabel: "hanging",
      command: NODE,
      args: ["-e", "setTimeout(() => {}, 3000)"],
      timeoutMs: 400,
    }),
    (error) => {
      assert.match(error.message, /\[hanging\] Timed out after [\d.]+s/);
      assert.match(error.message, /Process tree for PID \d+ was terminated/);
      assert.match(error.message, /Timeout: 0\.4s/);
      return true;
    },
  );
});

test("stderr output and an unterminated final line are captured", async () => {
  await assert.rejects(
    () => runCommandStep({
      stepLabel: "stderr",
      command: NODE,
      args: ["-e", "process.stderr.write('error-without-newline'); process.exit(2)"],
      timeoutMs: 15000,
    }),
    (error) => {
      assert.match(error.message, /error-without-newline/, "stderr is part of the diagnostic tail");
      assert.match(error.message, /exit code 2/);
      return true;
    },
  );
});

test("a command that cannot start rejects with the cause", async () => {
  await assert.rejects(
    () => runCommandStep({
      stepLabel: "missing-binary",
      command: "s3-browser-definitely-not-a-real-binary",
      args: [],
      timeoutMs: 5000,
    }),
    (error) => {
      assert.match(error.message, /Failed to start command/);
      assert.match(error.message, /Cause: /);
      return true;
    },
  );
});

test("extra environment variables reach the child", async () => {
  await assert.rejects(
    () => runCommandStep({
      stepLabel: "env",
      command: NODE,
      args: ["-e", "process.exit(process.env.S3_BROWSER_TEST_FLAG === 'on' ? 7 : 0)"],
      timeoutMs: 15000,
      env: { S3_BROWSER_TEST_FLAG: "on" },
    }),
    /exit code 7/,
  );
});

test("isProcessAlive rejects invalid pids", () => {
  assert.equal(isProcessAlive(0), false);
  assert.equal(isProcessAlive(-1), false);
  assert.equal(isProcessAlive(undefined), false);
  assert.equal(isProcessAlive(process.pid), true);
});
