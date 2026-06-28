import { randomInt } from "node:crypto";
import { readFile } from "node:fs/promises";
import process from "node:process";
import { pathToFileURL } from "node:url";
import WebSocket from "ws";

const DEFAULT_CONFIG = "config/targets.json";
const DEFAULT_DURATION_SECONDS = 240;
const DEFAULT_LOG_LEVEL = "debug";
const TOKEN_TIMEOUT_MS = 10_000;
const INPUT_PREFIX = "0".charCodeAt(0);
const TERMINAL_COLUMNS = 80;
const TERMINAL_ROWS = 24;
const HISTORY_SIZE = 5;

const LOG_LEVELS = Object.freeze({
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
});

const TYPO_NEIGHBORS = Object.freeze({
  a: "sqw",
  b: "vghn",
  c: "xdfv",
  d: "serfcx",
  e: "wsdr",
  f: "drtgvc",
  g: "ftyhbv",
  h: "gyujnb",
  i: "ujko",
  j: "huikmn",
  k: "jiolm",
  l: "kop",
  m: "njk",
  n: "bhjm",
  o: "iklp",
  p: "ol",
  q: "wa",
  r: "edft",
  s: "awedxz",
  t: "rfgy",
  u: "yhji",
  v: "cfgb",
  w: "qase",
  x: "zsdc",
  y: "tghu",
  z: "asx",
});

export const SAFE_COMMANDS = Object.freeze([
  { id: "pwd", category: "navigation", command: "pwd" },
  { id: "whoami", category: "identity", command: "whoami" },
  { id: "date", category: "time", command: "date" },
  { id: "ls", category: "listing", command: "ls" },
  { id: "ls-a", category: "listing", command: "ls -a" },
  { id: "ls-root", category: "listing", command: "ls /" },
  { id: "ls-tmp", category: "listing", command: "ls /tmp" },
  { id: "cd-root", category: "navigation", command: "cd /" },
  { id: "cd-tmp", category: "navigation", command: "cd /tmp" },
  { id: "cd-home", category: "navigation", command: "cd ~" },
  { id: "cd-back", category: "navigation", command: "cd -" },
  { id: "echo-status", category: "output", command: "echo \"checking terminal\"" },
  { id: "echo-active", category: "output", command: "echo \"session active\"" },
  { id: "echo-ok", category: "output", command: "echo \"still here\"" },
  { id: "ps", category: "processes", command: "ps" },
  {
    id: "ps-columns",
    category: "processes",
    command: "ps -o pid,ppid,stat,comm",
  },
  {
    id: "cat-os-release",
    category: "small-file",
    command: "cat /etc/os-release",
  },
  {
    id: "cat-uptime",
    category: "small-file",
    command: "cat /proc/uptime",
  },
]);

export const ERROR_COMMANDS = Object.freeze([
  {
    id: "error-ls-option",
    category: "harmless-error",
    command: "ls --not-a-real-option",
  },
  {
    id: "error-cat-path",
    category: "harmless-error",
    command: "cat /definitely-not-a-real-file",
  },
  {
    id: "error-cd-path",
    category: "harmless-error",
    command: "cd /definitely-not-a-real-directory",
  },
]);

class RunnerError extends Error {
  constructor(code, detail = code) {
    super(detail);
    this.name = "RunnerError";
    this.code = code;
  }
}

function productionRandom() {
  return randomInt(0, 0x1_0000_0000) / 0x1_0000_0000;
}

function boundedRandom(rng) {
  const value = Number(rng());
  if (!Number.isFinite(value)) {
    throw new RunnerError("invalid_random_source");
  }
  return Math.min(Math.max(value, 0), 0.9999999999999999);
}

export function randomInteger(rng, minimum, maximum) {
  return (
    minimum +
    Math.floor(boundedRandom(rng) * (Math.floor(maximum) - minimum + 1))
  );
}

function sanitizeDetail(value) {
  return String(value)
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .slice(0, 200);
}

export function createLogger({
  level = DEFAULT_LOG_LEVEL,
  emit = (line) => console.log(line),
  now = () => Date.now(),
} = {}) {
  if (!(level in LOG_LEVELS)) {
    throw new RunnerError("invalid_log_level", `unsupported log level: ${level}`);
  }

  return {
    log(entryLevel, event, fields = {}) {
      if (LOG_LEVELS[entryLevel] < LOG_LEVELS[level]) {
        return;
      }
      emit(
        JSON.stringify({
          timestamp: new Date(now()).toISOString(),
          level: entryLevel,
          event,
          ...fields,
        }),
      );
    },
  };
}

function validateTarget(raw, index) {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new RunnerError(
      "configuration",
      `target ${index} must be an object`,
    );
  }

  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  const value = typeof raw.url === "string" ? raw.url.trim() : "";
  if (!name) {
    throw new RunnerError(
      "configuration",
      `target ${index} must have a non-empty string name`,
    );
  }
  if (!value) {
    throw new RunnerError(
      "configuration",
      `target ${index} must have a non-empty string URL`,
    );
  }

  let url;
  try {
    url = new URL(value);
  } catch {
    throw new RunnerError(
      "configuration",
      `target ${index} URL must be an absolute HTTPS URL`,
    );
  }
  if (
    url.protocol !== "https:" ||
    !url.hostname ||
    url.username ||
    url.password
  ) {
    throw new RunnerError(
      "configuration",
      `target ${index} URL must be an absolute HTTPS URL without credentials`,
    );
  }
  if (url.hash) {
    throw new RunnerError(
      "configuration",
      `target ${index} URL must not contain a fragment`,
    );
  }

  return Object.freeze({ name, url: url.href });
}

export async function loadTargets(path = DEFAULT_CONFIG) {
  let raw;
  try {
    raw = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new RunnerError(
        "configuration",
        `target configuration not found: ${path}`,
      );
    }
    if (error instanceof SyntaxError) {
      throw new RunnerError(
        "configuration",
        `target configuration is not valid JSON: ${path}`,
      );
    }
    throw error;
  }

  if (!Array.isArray(raw) || raw.length === 0) {
    throw new RunnerError(
      "configuration",
      "target configuration must be a non-empty JSON array",
    );
  }

  const targets = raw.map((item, index) => validateTarget(item, index + 1));
  const names = new Set();
  const urls = new Set();
  for (const target of targets) {
    if (names.has(target.name)) {
      throw new RunnerError("configuration", "target names must be unique");
    }
    if (urls.has(target.url)) {
      throw new RunnerError("configuration", "target URLs must be unique");
    }
    names.add(target.name);
    urls.add(target.url);
  }
  return targets;
}

export function deriveTtydUrls(targetUrl) {
  const endpoint = new URL(targetUrl);
  const basePath = endpoint.pathname.replace(/\/+$/, "");

  const tokenUrl = new URL(endpoint.href);
  tokenUrl.pathname = `${basePath}/token`;
  tokenUrl.search = "";
  tokenUrl.hash = "";

  const websocketUrl = new URL(endpoint.href);
  websocketUrl.protocol = "wss:";
  websocketUrl.pathname = `${basePath}/ws`;
  websocketUrl.hash = "";

  return Object.freeze({
    tokenUrl: tokenUrl.href,
    websocketUrl: websocketUrl.href,
  });
}

function chooseFrom(values, rng) {
  return values[randomInteger(rng, 0, values.length - 1)];
}

export function selectCommand(
  history,
  rng = productionRandom,
  { errorProbability = 0.06 } = {},
) {
  const useError = boundedRandom(rng) < errorProbability;
  const preferred = useError ? ERROR_COMMANDS : SAFE_COMMANDS;
  let eligible = preferred.filter((entry) => !history.includes(entry.id));
  if (eligible.length === 0) {
    eligible = preferred;
  }

  const selected = chooseFrom(eligible, rng);
  history.push(selected.id);
  if (history.length > HISTORY_SIZE) {
    history.splice(0, history.length - HISTORY_SIZE);
  }
  return selected;
}

function neighboringTypo(character, rng) {
  const lower = character.toLowerCase();
  const neighbors = TYPO_NEIGHBORS[lower];
  if (!neighbors) {
    return null;
  }
  const replacement = chooseFrom([...neighbors], rng);
  return character === lower ? replacement : replacement.toUpperCase();
}

export function buildTypingPlan(
  command,
  rng = productionRandom,
  { typoProbability = 0.18 } = {},
) {
  const candidates = [...command]
    .map((character, index) => ({ character, index }))
    .filter(({ character }) => TYPO_NEIGHBORS[character.toLowerCase()]);
  const makeTypo =
    candidates.length > 0 && boundedRandom(rng) < typoProbability;
  const typoIndex = makeTypo ? chooseFrom(candidates, rng).index : -1;
  const strokes = [];

  for (const [index, character] of [...command].entries()) {
    if (index === typoIndex) {
      strokes.push({
        key: neighboringTypo(character, rng),
        delayMs: randomInteger(rng, 200, 800),
        correction: false,
      });
      strokes.push({
        key: "\u007f",
        delayMs: randomInteger(rng, 200, 800),
        correction: true,
      });
    }
    strokes.push({
      key: character,
      delayMs: randomInteger(rng, 200, 800),
      correction: false,
    });
  }

  strokes.push({
    key: "\r",
    delayMs: randomInteger(rng, 250, 700),
    correction: false,
  });
  return strokes;
}

export function encodeInputFrame(input) {
  const encoded = new TextEncoder().encode(input);
  const frame = new Uint8Array(encoded.length + 1);
  frame[0] = INPUT_PREFIX;
  frame.set(encoded, 1);
  return frame;
}

export function encodeHandshake(token) {
  return new TextEncoder().encode(
    JSON.stringify({
      AuthToken: token,
      columns: TERMINAL_COLUMNS,
      rows: TERMINAL_ROWS,
    }),
  );
}

function abortError() {
  const error = new Error("operation aborted");
  error.name = "AbortError";
  return error;
}

export function sleep(milliseconds, signal) {
  if (signal?.aborted) {
    return Promise.reject(abortError());
  }
  return new Promise((resolve, reject) => {
    const cleanup = () => signal?.removeEventListener("abort", onAbort);
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, Math.max(0, milliseconds));
    const onAbort = () => {
      clearTimeout(timer);
      cleanup();
      reject(abortError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function fetchAuthToken(target, {
  fetchImpl,
  signal,
  timeoutMs = TOKEN_TIMEOUT_MS,
}) {
  const { tokenUrl } = deriveTtydUrls(target.url);
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const requestSignal = signal
    ? AbortSignal.any([signal, timeoutSignal])
    : timeoutSignal;

  let response;
  try {
    response = await fetchImpl(tokenUrl, {
      method: "GET",
      headers: {
        Accept: "application/json",
        "User-Agent": "lifecycle-terminal-traffic/1.0",
      },
      redirect: "follow",
      signal: requestSignal,
    });
  } catch (error) {
    if (signal?.aborted) {
      throw abortError();
    }
    throw new RunnerError(
      error?.name === "TimeoutError" ? "token_timeout" : "token_network",
    );
  }

  if (!response.ok) {
    throw new RunnerError("token_http", `token endpoint returned ${response.status}`);
  }

  let text;
  try {
    if (response.body?.getReader) {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let totalBytes = 0;
      let decoded = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        totalBytes += value.byteLength;
        if (totalBytes > 4_096) {
          await reader.cancel();
          throw new RunnerError("token_payload_too_large");
        }
        decoded += decoder.decode(value, { stream: true });
      }
      text = decoded + decoder.decode();
    } else {
      text = await response.text();
    }
  } catch (error) {
    if (error instanceof RunnerError) {
      throw error;
    }
    throw new RunnerError("token_invalid_payload");
  }
  if (Buffer.byteLength(text) > 4_096) {
    throw new RunnerError("token_payload_too_large");
  }

  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new RunnerError("token_invalid_payload");
  }
  if (
    body === null ||
    typeof body !== "object" ||
    typeof body.token !== "string"
  ) {
    throw new RunnerError("token_invalid_payload");
  }
  return body.token;
}

function dataSize(data) {
  if (typeof data === "string") {
    return Buffer.byteLength(data);
  }
  if (data instanceof ArrayBuffer) {
    return data.byteLength;
  }
  if (ArrayBuffer.isView(data)) {
    return data.byteLength;
  }
  if (typeof Blob !== "undefined" && data instanceof Blob) {
    return data.size;
  }
  return 0;
}

async function openTtydConnection(target, {
  fetchImpl,
  webSocketFactory,
  signal,
  now,
  logger,
}) {
  const token = await fetchAuthToken(target, { fetchImpl, signal });
  if (signal.aborted) {
    throw abortError();
  }

  const { websocketUrl } = deriveTtydUrls(target.url);
  let socket;
  try {
    socket = webSocketFactory(websocketUrl, ["tty"], {
      origin: new URL(target.url).origin,
    });
    socket.binaryType = "arraybuffer";
  } catch {
    throw new RunnerError("websocket_create");
  }

  let opened = false;
  let closed = false;
  let closeCode = null;
  let outputBytes = 0;
  let lastOutputAt = now();
  let resolveClosed;
  const closedPromise = new Promise((resolve) => {
    resolveClosed = resolve;
  });

  const markClosed = (code = null) => {
    if (!closed) {
      closed = true;
      closeCode = code;
      resolveClosed();
    }
  };

  const openPromise = new Promise((resolve, reject) => {
    const onOpen = () => {
      opened = true;
      resolve();
    };
    const onError = () => {
      markClosed();
      if (!opened) {
        reject(new RunnerError("websocket_open"));
      }
    };
    const onClose = (event) => {
      markClosed(event?.code ?? null);
      if (!opened) {
        reject(new RunnerError("websocket_closed_before_open"));
      }
    };
    socket.addEventListener("open", onOpen, { once: true });
    socket.addEventListener("error", onError);
    socket.addEventListener("close", onClose);
    socket.addEventListener("message", (event) => {
      outputBytes += dataSize(event.data);
      lastOutputAt = now();
    });
  });

  const close = (reason = "complete") => {
    try {
      if (socket.readyState === 0 || socket.readyState === 1) {
        socket.close(1000, reason);
      }
    } catch {
      // Closing is best-effort during teardown.
    }
    markClosed(1000);
  };

  const onAbort = () => close("shutdown");
  signal.addEventListener("abort", onAbort, { once: true });

  try {
    await openPromise;
    if (signal.aborted) {
      throw abortError();
    }
    socket.send(encodeHandshake(token));
  } catch (error) {
    close("open-failed");
    signal.removeEventListener("abort", onAbort);
    throw error;
  }

  logger.log("debug", "terminal_handshake", {
    target: target.name,
    token_present: token.length > 0,
    columns: TERMINAL_COLUMNS,
    rows: TERMINAL_ROWS,
  });

  return {
    socket,
    closedPromise,
    close,
    isClosed: () => closed,
    closeCode: () => closeCode,
    outputBytes: () => outputBytes,
    lastOutputAt: () => lastOutputAt,
    dispose: () => signal.removeEventListener("abort", onAbort),
  };
}

async function waitWhileConnected(
  milliseconds,
  connection,
  { sleeper, signal, now, deadline },
) {
  if (connection.isClosed()) {
    throw new RunnerError("websocket_closed");
  }
  const remaining = deadline - now();
  if (remaining <= 0 || signal.aborted) {
    return false;
  }

  const outcome = await Promise.race([
    sleeper(Math.min(milliseconds, remaining), signal).then(() => "timer"),
    connection.closedPromise.then(() => "closed"),
  ]);
  if (outcome === "closed") {
    throw new RunnerError(
      "websocket_closed",
      `websocket closed with code ${connection.closeCode() ?? "unknown"}`,
    );
  }
  return now() < deadline && !signal.aborted;
}

function reconnectDelay(attempt, rng) {
  const base = Math.min(1_000 * 2 ** Math.min(attempt - 1, 5), 30_000);
  return Math.round(base * (0.5 + boundedRandom(rng)));
}

function activityPause(rng) {
  if (boundedRandom(rng) < 0.1) {
    return { kind: "long", milliseconds: randomInteger(rng, 30_000, 90_000) };
  }
  return { kind: "normal", milliseconds: randomInteger(rng, 4_000, 20_000) };
}

async function waitForOutputQuiet(connection, dependencies) {
  const startedAt = dependencies.now();
  while (dependencies.now() - startedAt < 5_000) {
    const active = await waitWhileConnected(200, connection, dependencies);
    if (!active) {
      return false;
    }
    if (
      dependencies.now() - connection.lastOutputAt() >= 700 &&
      dependencies.now() - startedAt >= 700
    ) {
      return true;
    }
  }
  return true;
}

export class TargetWorker {
  constructor(target, options) {
    this.target = target;
    this.rng = options.rng ?? productionRandom;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.webSocketFactory =
      options.webSocketFactory ??
      ((url, protocols, websocketOptions) =>
        new WebSocket(url, protocols, websocketOptions));
    this.sleeper = options.sleeper ?? sleep;
    this.now = options.now ?? (() => Date.now());
    this.signal = options.signal;
    this.deadline = options.deadline;
    this.logger = options.logger;
    this.history = [];
    this.summary = {
      target: target.name,
      successful_connections: 0,
      commands_sent: 0,
      corrections: 0,
      reconnects: 0,
      failures: 0,
      input_bytes: 0,
      output_bytes: 0,
    };
  }

  async runActivity(connection) {
    const dependencies = {
      sleeper: this.sleeper,
      signal: this.signal,
      now: this.now,
      deadline: this.deadline,
    };

    if (
      !(await waitWhileConnected(
        randomInteger(this.rng, 500, 1_500),
        connection,
        dependencies,
      ))
    ) {
      return;
    }

    while (!this.signal.aborted && this.now() < this.deadline) {
      const selected = selectCommand(this.history, this.rng);
      const typingPlan = buildTypingPlan(selected.command, this.rng);
      this.logger.log("debug", "command_start", {
        target: this.target.name,
        command_id: selected.id,
        category: selected.category,
        command: selected.command,
      });

      let complete = true;
      for (const stroke of typingPlan) {
        if (
          !(await waitWhileConnected(
            stroke.delayMs,
            connection,
            dependencies,
          ))
        ) {
          complete = false;
          break;
        }
        const frame = encodeInputFrame(stroke.key);
        if (connection.isClosed() || connection.socket.readyState !== 1) {
          throw new RunnerError("websocket_closed");
        }
        connection.socket.send(frame);
        this.summary.input_bytes += frame.byteLength;
        if (stroke.correction) {
          this.summary.corrections += 1;
        }
      }
      if (!complete) {
        return;
      }

      this.summary.commands_sent += 1;
      this.logger.log("info", "command_complete", {
        target: this.target.name,
        command_id: selected.id,
        category: selected.category,
        commands_sent: this.summary.commands_sent,
      });

      if (!(await waitForOutputQuiet(connection, dependencies))) {
        return;
      }
      const pause = activityPause(this.rng);
      this.logger.log("debug", "activity_pause", {
        target: this.target.name,
        pause_kind: pause.kind,
        duration_ms: pause.milliseconds,
      });
      if (
        !(await waitWhileConnected(
          pause.milliseconds,
          connection,
          dependencies,
        ))
      ) {
        return;
      }
    }
  }

  async run() {
    const staggerMs = randomInteger(this.rng, 0, 20_000);
    this.logger.log("debug", "worker_stagger", {
      target: this.target.name,
      duration_ms: staggerMs,
    });
    try {
      await this.sleeper(
        Math.min(staggerMs, Math.max(0, this.deadline - this.now())),
        this.signal,
      );
    } catch (error) {
      if (error?.name !== "AbortError") {
        throw error;
      }
    }

    let reconnectAttempt = 0;
    while (!this.signal.aborted && this.now() < this.deadline) {
      let connection;
      try {
        this.logger.log("info", "connection_start", {
          target: this.target.name,
          attempt: reconnectAttempt + 1,
        });
        connection = await openTtydConnection(this.target, {
          fetchImpl: this.fetchImpl,
          webSocketFactory: this.webSocketFactory,
          signal: this.signal,
          now: this.now,
          logger: this.logger,
        });
        this.summary.successful_connections += 1;
        reconnectAttempt = 0;
        this.logger.log("info", "connection_open", {
          target: this.target.name,
          successful_connections: this.summary.successful_connections,
        });

        await this.runActivity(connection);
        this.summary.output_bytes += connection.outputBytes();
        connection.close("complete");
        connection.dispose();
      } catch (error) {
        if (connection) {
          this.summary.output_bytes += connection.outputBytes();
          connection.close("retry");
          connection.dispose();
        }
        if (
          this.signal.aborted ||
          this.now() >= this.deadline ||
          error?.name === "AbortError"
        ) {
          break;
        }

        this.summary.failures += 1;
        reconnectAttempt += 1;
        this.summary.reconnects += 1;
        const delayMs = reconnectDelay(reconnectAttempt, this.rng);
        this.logger.log("warn", "connection_retry", {
          target: this.target.name,
          error: sanitizeDetail(error?.code ?? error?.name ?? "connection"),
          attempt: reconnectAttempt,
          delay_ms: delayMs,
        });
        try {
          await this.sleeper(
            Math.min(delayMs, Math.max(0, this.deadline - this.now())),
            this.signal,
          );
        } catch (sleepError) {
          if (sleepError?.name !== "AbortError") {
            throw sleepError;
          }
        }
      }
    }

    this.logger.log("info", "worker_summary", this.summary);
    return Object.freeze({ ...this.summary });
  }
}

export async function runTraffic(targets, {
  durationSeconds = DEFAULT_DURATION_SECONDS,
  logger = createLogger(),
  rng = productionRandom,
  fetchImpl = globalThis.fetch,
  webSocketFactory = (url, protocols, websocketOptions) =>
    new WebSocket(url, protocols, websocketOptions),
  sleeper = sleep,
  now = () => Date.now(),
  signal,
  installSignalHandlers = false,
} = {}) {
  if (!Number.isFinite(durationSeconds) || durationSeconds < 0) {
    throw new RunnerError(
      "arguments",
      "duration seconds must be zero or a positive number",
    );
  }

  const controller = new AbortController();
  const combinedSignal = signal
    ? AbortSignal.any([signal, controller.signal])
    : controller.signal;
  const deadline =
    durationSeconds === 0 ? Number.POSITIVE_INFINITY : now() + durationSeconds * 1_000;

  const stop = (signalName) => {
    logger.log("info", "shutdown_requested", { signal: signalName });
    controller.abort();
  };
  const onSigint = () => stop("SIGINT");
  const onSigterm = () => stop("SIGTERM");
  if (installSignalHandlers) {
    process.once("SIGINT", onSigint);
    process.once("SIGTERM", onSigterm);
  }

  logger.log("info", "traffic_start", {
    targets: targets.length,
    duration_seconds: durationSeconds,
  });

  try {
    const workers = targets.map(
      (target) =>
        new TargetWorker(target, {
          rng,
          fetchImpl,
          webSocketFactory,
          sleeper,
          now,
          signal: combinedSignal,
          deadline,
          logger,
        }),
    );
    return await Promise.all(workers.map((worker) => worker.run()));
  } finally {
    controller.abort();
    if (installSignalHandlers) {
      process.removeListener("SIGINT", onSigint);
      process.removeListener("SIGTERM", onSigterm);
    }
  }
}

function usage() {
  return `Usage: node src/traffic_runner.mjs [options]

Options:
  --config PATH               Target JSON file (default: ${DEFAULT_CONFIG})
  --duration-seconds NUMBER   Runtime; 0 means until stopped (default: ${DEFAULT_DURATION_SECONDS})
  --log-level LEVEL           debug, info, warn, or error (default: ${DEFAULT_LOG_LEVEL})
  --dry-run                   Validate config and print sample safe activity
  --help                      Show this help`;
}

export function parseArguments(argv) {
  const options = {
    config: DEFAULT_CONFIG,
    durationSeconds: DEFAULT_DURATION_SECONDS,
    logLevel: process.env.LOG_LEVEL ?? DEFAULT_LOG_LEVEL,
    dryRun: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help") {
      options.help = true;
    } else if (argument === "--dry-run") {
      options.dryRun = true;
    } else if (
      argument === "--config" ||
      argument === "--duration-seconds" ||
      argument === "--log-level"
    ) {
      const value = argv[index + 1];
      if (value === undefined) {
        throw new RunnerError("arguments", `${argument} requires a value`);
      }
      index += 1;
      if (argument === "--config") {
        options.config = value;
      } else if (argument === "--duration-seconds") {
        const parsed = Number(value);
        if (!Number.isFinite(parsed) || parsed < 0) {
          throw new RunnerError(
            "arguments",
            "--duration-seconds must be zero or a positive number",
          );
        }
        options.durationSeconds = parsed;
      } else {
        if (!(value in LOG_LEVELS)) {
          throw new RunnerError(
            "arguments",
            "--log-level must be debug, info, warn, or error",
          );
        }
        options.logLevel = value;
      }
    } else {
      throw new RunnerError("arguments", `unknown argument: ${argument}`);
    }
  }
  return options;
}

function dryRun(targets, logger, rng = productionRandom) {
  for (const target of targets) {
    const history = [];
    for (let index = 0; index < 8; index += 1) {
      const selected = selectCommand(history, rng);
      const plan = buildTypingPlan(selected.command, rng);
      logger.log("info", "dry_run_command", {
        target: target.name,
        command_id: selected.id,
        category: selected.category,
        command: selected.command,
        keystrokes: plan.length,
        corrections: plan.filter((stroke) => stroke.correction).length,
      });
    }
  }
}

export async function main(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseArguments(argv);
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "fatal",
        error: error?.code ?? "arguments",
        detail: sanitizeDetail(error?.message ?? error),
      }),
    );
    return 2;
  }

  if (options.help) {
    console.log(usage());
    return 0;
  }

  let logger;
  try {
    logger = createLogger({ level: options.logLevel });
    const targets = await loadTargets(options.config);
    if (options.dryRun) {
      dryRun(targets, logger);
      return 0;
    }

    const summaries = await runTraffic(targets, {
      durationSeconds: options.durationSeconds,
      logger,
      installSignalHandlers: true,
    });
    const unavailable = summaries.filter(
      (summary) => summary.successful_connections === 0,
    );
    logger.log("info", "traffic_summary", {
      checked: summaries.length,
      connected: summaries.length - unavailable.length,
      unavailable: unavailable.length,
      commands_sent: summaries.reduce(
        (total, summary) => total + summary.commands_sent,
        0,
      ),
    });
    return unavailable.length === 0 ? 0 : 1;
  } catch (error) {
    const record = {
      event: "fatal",
      error: sanitizeDetail(error?.code ?? error?.name ?? "runtime"),
      detail: sanitizeDetail(error?.message ?? error),
    };
    if (logger) {
      logger.log("error", record.event, {
        error: record.error,
        detail: record.detail,
      });
    } else {
      console.error(JSON.stringify(record));
    }
    return error?.code === "configuration" || error?.code === "arguments" ? 2 : 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exitCode = await main();
}
