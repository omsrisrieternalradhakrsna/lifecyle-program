import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  ERROR_COMMANDS,
  SAFE_COMMANDS,
  buildTypingPlan,
  createLogger,
  deriveTtydUrls,
  encodeHandshake,
  encodeInputFrame,
  loadTargets,
  parseArguments,
  runTraffic,
  selectCommand,
} from "../src/traffic_runner.mjs";

const decoder = new TextDecoder();

class FakeWebSocket extends EventTarget {
  constructor({ failOpen = false } = {}) {
    super();
    this.binaryType = "blob";
    this.readyState = 0;
    this.sent = [];
    queueMicrotask(() => {
      if (failOpen) {
        this.readyState = 3;
        this.dispatchEvent(new Event("error"));
        this.dispatchClose(1006);
      } else {
        this.readyState = 1;
        this.dispatchEvent(new Event("open"));
        this.emitOutput("0bash-5.3# ");
      }
    });
  }

  send(data) {
    assert.equal(this.readyState, 1);
    this.sent.push(new Uint8Array(data));
    if (this.sent.length > 1) {
      this.emitOutput("0");
    }
  }

  close(code = 1000) {
    if (this.readyState === 3) {
      return;
    }
    this.readyState = 3;
    this.dispatchClose(code);
  }

  dispatchClose(code) {
    const event = new Event("close");
    Object.defineProperty(event, "code", { value: code });
    this.dispatchEvent(event);
  }

  emitOutput(text) {
    const event = new Event("message");
    Object.defineProperty(event, "data", {
      value: new TextEncoder().encode(text).buffer,
    });
    this.dispatchEvent(event);
  }
}

function fakeClock() {
  let value = 0;
  return {
    now: () => value,
    sleep: async (milliseconds, signal) => {
      if (signal?.aborted) {
        const error = new Error("aborted");
        error.name = "AbortError";
        throw error;
      }
      value += milliseconds;
    },
  };
}

function quietLogger() {
  return createLogger({ level: "error", emit: () => {}, now: () => 0 });
}

test("derives ttyd token and websocket URLs, including a base path", () => {
  assert.deepEqual(
    deriveTtydUrls("https://terminal.example.test/base/?renderer=dom"),
    {
      tokenUrl: "https://terminal.example.test/base/token",
      websocketUrl:
        "wss://terminal.example.test/base/ws?renderer=dom",
    },
  );
  assert.deepEqual(deriveTtydUrls("https://terminal.example.test"), {
    tokenUrl: "https://terminal.example.test/token",
    websocketUrl: "wss://terminal.example.test/ws",
  });
});

test("loads and validates target configuration", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "traffic-targets-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const validPath = path.join(directory, "valid.json");
  await writeFile(
    validPath,
    JSON.stringify([
      { name: "one", url: "https://one.example.test" },
      { name: "two", url: "https://two.example.test/path" },
    ]),
  );

  assert.deepEqual(await loadTargets(validPath), [
    { name: "one", url: "https://one.example.test/" },
    { name: "two", url: "https://two.example.test/path" },
  ]);

  const invalidPath = path.join(directory, "invalid.json");
  await writeFile(
    invalidPath,
    JSON.stringify([
      { name: "duplicate", url: "https://one.example.test" },
      { name: "duplicate", url: "https://two.example.test" },
    ]),
  );
  await assert.rejects(loadTargets(invalidPath), /target names must be unique/);

  const credentialPath = path.join(directory, "credentials.json");
  await writeFile(
    credentialPath,
    JSON.stringify([
      {
        name: "unsafe",
        url: "https://user:secret@terminal.example.test",
      },
    ]),
  );
  await assert.rejects(loadTargets(credentialPath), /without credentials/);
});

test("command selection avoids the recent history", () => {
  const history = [];
  const selected = [];
  for (let index = 0; index < 8; index += 1) {
    selected.push(
      selectCommand(history, () => 0.5, { errorProbability: 0 }).id,
    );
  }

  for (let index = 0; index < selected.length; index += 1) {
    const recent = selected.slice(Math.max(0, index - 5), index);
    assert.equal(recent.includes(selected[index]), false);
  }
});

test("the command catalog is fixed and contains no shell write operators", () => {
  const commands = [...SAFE_COMMANDS, ...ERROR_COMMANDS];
  assert.ok(commands.length >= 15);
  for (const entry of commands) {
    assert.match(entry.id, /^[a-z0-9-]+$/);
    assert.doesNotMatch(entry.command, /[;&|><`$(){}\n\r]/);
  }
  assert.ok(commands.some((entry) => entry.command === "date"));
  assert.ok(commands.some((entry) => entry.command.startsWith("cat ")));
  assert.ok(commands.some((entry) => entry.command.startsWith("cd ")));
});

test("typing plans use human delays and correct a typo with DEL", () => {
  const plan = buildTypingPlan("date", () => 0, { typoProbability: 1 });
  assert.equal(plan.at(-1).key, "\r");
  assert.equal(plan.filter((stroke) => stroke.correction).length, 1);
  assert.ok(plan.some((stroke) => stroke.key === "\u007f"));
  for (const stroke of plan.slice(0, -1)) {
    assert.ok(stroke.delayMs >= 200 && stroke.delayMs <= 800);
  }
  assert.ok(plan.at(-1).delayMs >= 250 && plan.at(-1).delayMs <= 700);
});

test("ttyd frames match the browser protocol", () => {
  const input = encodeInputFrame("x");
  assert.deepEqual([...input], [48, 120]);
  assert.deepEqual(JSON.parse(decoder.decode(encodeHandshake("token"))), {
    AuthToken: "token",
    columns: 80,
    rows: 24,
  });
});

test("runner opens all workers independently and sends framed commands", async () => {
  const clock = fakeClock();
  const sockets = [];
  const fetched = [];
  const targets = [
    { name: "one", url: "https://one.example.test/" },
    { name: "two", url: "https://two.example.test/" },
    { name: "three", url: "https://three.example.test/" },
  ];

  const summaries = await runTraffic(targets, {
    // The deterministic clock is shared by all three concurrent workers, so
    // allow enough aggregate virtual time for every stagger and command.
    durationSeconds: 100,
    logger: quietLogger(),
    rng: () => 0.5,
    now: clock.now,
    sleeper: clock.sleep,
    fetchImpl: async (url) => {
      fetched.push(url);
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ token: "" }),
      };
    },
    webSocketFactory: () => {
      const socket = new FakeWebSocket();
      sockets.push(socket);
      return socket;
    },
  });

  assert.equal(summaries.length, 3);
  assert.ok(summaries.every((summary) => summary.successful_connections === 1));
  assert.ok(summaries.every((summary) => summary.commands_sent >= 1));
  assert.equal(fetched.length, 3);
  assert.equal(sockets.length, 3);
  for (const socket of sockets) {
    assert.ok(socket.sent.length > 1);
    assert.deepEqual(JSON.parse(decoder.decode(socket.sent[0])), {
      AuthToken: "",
      columns: 80,
      rows: 24,
    });
    assert.ok(socket.sent.slice(1).every((frame) => frame[0] === 48));
  }
});

test("a failed websocket retries without stopping another target", async () => {
  const clock = fakeClock();
  let failingTargetAttempts = 0;
  const targets = [
    { name: "flaky", url: "https://flaky.example.test/" },
    { name: "steady", url: "https://steady.example.test/" },
  ];

  const summaries = await runTraffic(targets, {
    durationSeconds: 28,
    logger: quietLogger(),
    rng: () => 0.5,
    now: clock.now,
    sleeper: clock.sleep,
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ token: "" }),
    }),
    webSocketFactory: (url) => {
      if (url.includes("flaky") && failingTargetAttempts++ === 0) {
        return new FakeWebSocket({ failOpen: true });
      }
      return new FakeWebSocket();
    },
  });

  const flaky = summaries.find((summary) => summary.target === "flaky");
  const steady = summaries.find((summary) => summary.target === "steady");
  assert.equal(flaky.reconnects, 1);
  assert.equal(flaky.successful_connections, 1);
  assert.equal(steady.successful_connections, 1);
});

test("CLI arguments expose bounded and indefinite runtimes", () => {
  assert.deepEqual(
    parseArguments([
      "--config",
      "targets.json",
      "--duration-seconds",
      "0",
      "--log-level",
      "info",
      "--dry-run",
    ]),
    {
      config: "targets.json",
      durationSeconds: 0,
      logLevel: "info",
      dryRun: true,
      help: false,
    },
  );
  assert.throws(
    () => parseArguments(["--duration-seconds", "-1"]),
    /zero or a positive number/,
  );
  assert.throws(() => parseArguments(["--unknown"]), /unknown argument/);
});
