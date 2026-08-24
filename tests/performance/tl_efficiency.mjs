#!/usr/bin/env node

import { createHash } from "node:crypto";
import { createConnection } from "node:net";
import { createServer } from "node:http";
import { execFileSync, spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import process from "node:process";

const SCRIPT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const DEFAULT_TURA_ROOT = resolve(SCRIPT_ROOT);
const DEFAULT_MODEL = process.env.TURA_BENCH_MODEL || "combo-high";
const MARKER = "BENCH_CHAIN_OK";
const SNAPSHOT_START = "<WORKSPACE_SNAPSHOT>";
const SNAPSHOT_END = "</WORKSPACE_SNAPSHOT>";
const SAFE_CATEGORY_NAMES = [".git", "node_modules", "__pycache__", ".pytest_cache", ".cache"];
const OBSERVED_CATEGORY_NAMES = [...SAFE_CATEGORY_NAMES, "target", "dist", "build"];
const BENCHMARK_CACHE_IRRELEVANT_HEADERS = new Set(["accept-language", "sec-fetch-mode", "user-agent"]);
const UNSAFE_COMMAND_PATTERN = /(Remove-Item|Set-Content|Add-Content|Out-File|Move-Item|Copy-Item|New-Item|(?:^|[\s;&|])(?:rm|del|rmdir|chmod|chown)(?:\s|$)|git\s+(commit|checkout|reset|clean|restore|switch)|npm\s+(install|publish)|pnpm\s+(install|publish)|Invoke-(WebRequest|RestMethod)|\b(curl|wget|iwr|irm)\b|Start-Process|(?:^|[\s;&|])(?:>|>>)(?:\s|$))/iu;
const TURA_PROMPT = [
  "Call command_run exactly once. Put exactly ten independent read-only command objects in its commands array, one operation per object, using step 1 for all.",
  "Do not make another command_run call. Do not modify files, use network, or inspect secrets.",
  "Operations: print current directory; print git branch; list root entries; print package.json size; print Cargo.toml size if present; count TypeScript files under components/adapters/codex; print Node version; print Git version; print Rust compiler version; print current OS.",
  "After the one command_run call succeeds, return exactly BENCH_CHAIN_OK.",
].join(" ");
const CODEX_PROMPT = [
  "Use the shell tool exactly ten times. Make exactly one independent read-only command per shell call.",
  "Do not call command_run. Do not make more or fewer than ten shell calls. Do not modify files, use network, or inspect secrets.",
  "Operations, in order: print current directory; print git branch; list root entries; print package.json size; print Cargo.toml size if present; count TypeScript files under components/adapters/codex; print Node version; print Git version; print Rust compiler version; print current OS.",
  "After all ten shell calls succeed, return exactly BENCH_CHAIN_OK.",
].join(" ");

function parseArgs(argv) {
  const values = { arms: ["T", "TL"], repetitions: 10, outputDir: null, workspaceCase: "unchanged", selfTest: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--self-test") values.selfTest = true;
    else if (arg === "--arms") values.arms = argv[++index].split(",").map((value) => value.trim()).filter(Boolean);
    else if (arg === "--repetitions") values.repetitions = Number(argv[++index]);
    else if (arg === "--output-dir") values.outputDir = resolve(argv[++index]);
    else if (arg === "--workspace-case") values.workspaceCase = argv[++index];
    else if (arg === "--tura-root") values.turaRoot = resolve(argv[++index]);
    else if (arg === "--lightrsi-root") values.lightrsiRoot = resolve(argv[++index]);
    else if (arg === "--tura-bin") values.turaBin = resolve(argv[++index]);
    else if (arg === "--provider-url") values.providerUrl = argv[++index];
    else if (arg === "--model") values.model = argv[++index];
    else throw new Error(`unknown argument: ${arg}`);
  }
  values.turaRoot = values.turaRoot || process.env.TURA_BENCH_TURA_ROOT || DEFAULT_TURA_ROOT;
  values.lightrsiRoot = values.lightrsiRoot || process.env.TURA_BENCH_LIGHTRSI_ROOT;
  values.turaBin = values.turaBin || process.env.TURA_BENCH_TURA_BIN || join(values.turaRoot, "target", "debug", process.platform === "win32" ? "tura_exec.exe" : "tura_exec");
  values.codexBin = values.codexBin || process.env.TURA_BENCH_CODEX_BIN || "codex";
  values.agentId = process.env.TURA_BENCH_AGENT_ID || "balanced";
  values.providerUrl = values.providerUrl || process.env.LIGHTRSI_BASE_URL;
  values.model = values.model || DEFAULT_MODEL;
  if (!values.selfTest && !values.lightrsiRoot) throw new Error("--lightrsi-root or TURA_BENCH_LIGHTRSI_ROOT is required");
  if (!values.selfTest && !values.providerUrl) throw new Error("--provider-url or LIGHTRSI_BASE_URL is required");
  if (!Number.isInteger(values.repetitions) || values.repetitions < 1) throw new Error("--repetitions must be a positive integer");
  if (values.arms.length === 0) throw new Error("--arms must include L, T, or TL");
  if (!values.arms.every((arm) => arm === "L" || arm === "T" || arm === "TL")) throw new Error("--arms accepts only L, T, and TL");
  if (!["unchanged", "tracked-source", "generated-git", "different-path"].includes(values.workspaceCase)) throw new Error("--workspace-case accepts unchanged, tracked-source, generated-git, or different-path");
  return values;
}

function hashText(value) {
  return createHash("sha256").update(value).digest("hex");
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function firstDivergence(left, right) {
  const leftText = String(left);
  const rightText = String(right);
  const leftBytes = Buffer.from(leftText, "utf8");
  const rightBytes = Buffer.from(rightText, "utf8");
  const limit = Math.min(leftBytes.length, rightBytes.length);
  let byteOffset = 0;
  while (byteOffset < limit && leftBytes[byteOffset] === rightBytes[byteOffset]) byteOffset += 1;
  const leftChars = [...leftText];
  const rightChars = [...rightText];
  const charLimit = Math.min(leftChars.length, rightChars.length);
  let characterOffset = 0;
  while (characterOffset < charLimit && leftChars[characterOffset] === rightChars[characterOffset]) characterOffset += 1;
  return {
    common_prefix_bytes: byteOffset,
    first_divergence_byte: byteOffset < Math.max(leftBytes.length, rightBytes.length) ? byteOffset : null,
    first_divergence_character: characterOffset < Math.max(leftChars.length, rightChars.length) ? characterOffset : null,
  };
}

function payloadMetadataFromBody(body) {
  const text = Buffer.isBuffer(body) ? body.toString("utf8") : String(body);
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = undefined; }
  const objectPayload = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  return {
    payload_is_json: parsed !== undefined,
    payload_model: typeof objectPayload?.model === "string" ? objectPayload.model : null,
    prompt_cache_key_present: Boolean(objectPayload && Object.hasOwn(objectPayload, "prompt_cache_key")),
    payload_top_level_keys: objectPayload ? Object.keys(objectPayload).sort() : [],
  };
}

function firstDifferentTopLevelField(left, right) {
  let leftPayload;
  let rightPayload;
  try { leftPayload = JSON.parse(String(left)); rightPayload = JSON.parse(String(right)); } catch { return null; }
  if (!leftPayload || !rightPayload || typeof leftPayload !== "object" || typeof rightPayload !== "object" || Array.isArray(leftPayload) || Array.isArray(rightPayload)) return null;
  const keys = [...new Set([...Object.keys(leftPayload), ...Object.keys(rightPayload)])].sort();
  return keys.find((key) => stableStringify(leftPayload[key]) !== stableStringify(rightPayload[key])) ?? null;
}
function compareProviderRequests(leftRequests, rightRequests) {
  const count = Math.max(leftRequests.length, rightRequests.length);
  return {
    request_count_equal: leftRequests.length === rightRequests.length,
    comparisons: Array.from({ length: count }, (_, index) => {
      const left = leftRequests[index];
      const right = rightRequests[index];
      return {
        index,
        left: left ? { method: left.method, path: left.path, payload_digest: left.payload_digest, payload_model: left.payload_model, prompt_cache_key_present: left.prompt_cache_key_present } : null,
        right: right ? { method: right.method, path: right.path, payload_digest: right.payload_digest, payload_model: right.payload_model, prompt_cache_key_present: right.prompt_cache_key_present } : null,
        first_divergence: left && right ? { ...firstDivergence(left._body, right._body), top_level_field: firstDifferentTopLevelField(left._body, right._body) } : null,
      };
    }),
  };
}

function parseJsonLines(text) {
  return text.split(/\r?\n/u).flatMap((line) => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
}

function findValue(root, predicate) {
  if (predicate(root)) return root;
  if (Array.isArray(root)) {
    for (const value of root) {
      const found = findValue(value, predicate);
      if (found !== undefined) return found;
    }
  } else if (root && typeof root === "object") {
    for (const value of Object.values(root)) {
      const found = findValue(value, predicate);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

function snapshotStatsFromBody(body) {
  const text = Buffer.isBuffer(body) ? body.toString("utf8") : String(body);
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = undefined; }
  const snapshot = findValue(parsed, (value) => typeof value === "string" && value.includes(SNAPSHOT_START) && value.includes(SNAPSHOT_END));
  const snapshotText = typeof snapshot === "string" ? snapshot.slice(snapshot.indexOf(SNAPSHOT_START), snapshot.indexOf(SNAPSHOT_END) + SNAPSHOT_END.length) : "";
  const categoryBytes = Object.fromEntries(OBSERVED_CATEGORY_NAMES.map((name) => [name, 0]));
  const categoryLines = Object.fromEntries(OBSERVED_CATEGORY_NAMES.map((name) => [name, 0]));
  for (const line of snapshotText.split(/\r?\n/u)) {
    const match = line.match(/(?:^|\s)([^/\\\s]+)(?:[/\\]|$)/u);
    const category = match?.[1];
    if (category && category in categoryBytes) {
      categoryBytes[category] += Buffer.byteLength(line, "utf8") + 1;
      categoryLines[category] += 1;
    }
  }
  const tools = findValue(parsed, (value) => Array.isArray(value) && value.some((item) => item && typeof item === "object" && typeof item.type === "string" && item.type.includes("function")));
  const toolChoice = parsed?.tool_choice ?? findValue(parsed, (value) => value && typeof value === "object" && Object.hasOwn(value, "tool_choice"))?.tool_choice;
  return {
    snapshot_bytes: Buffer.byteLength(snapshotText, "utf8"),
    snapshot_digest: hashText(snapshotText),
    category_bytes: categoryBytes,
    category_lines: categoryLines,
    tool_schema_digest: tools === undefined ? null : hashText(stableStringify(tools)),
    tool_choice: toolChoice === undefined ? null : stableStringify(toolChoice),
    payload_digest: hashText(text),
    ...payloadMetadataFromBody(body),
  };
}

function providerResponseStats(body) {
  const text = Buffer.isBuffer(body) ? body.toString("utf8") : String(body);
  return {
    tool_names: [...text.matchAll(/"name"\s*:\s*"([^"]+)"/gu)].map((match) => match[1]).filter((name) => name === "command_run"),
    argument_bytes: [...text.matchAll(/"arguments"\s*:\s*"([^"]*)"/gu)].reduce((sum, match) => sum + Buffer.byteLength(match[1], "utf8"), 0),
  };
}

function providerUsageFromResponse(body) {
  const text = Buffer.isBuffer(body) ? body.toString("utf8") : String(body);
  let usage;
  for (const line of text.split(/\r?\n/u)) {
    const data = line.startsWith("data:") ? line.slice(5).trim() : "";
    if (!data || data === "[DONE]") continue;
    let event;
    try { event = JSON.parse(data); } catch { continue; }
    const candidate = event?.response?.usage ?? event?.usage ?? event?.response?.response?.usage;
    if (candidate && typeof candidate === "object") usage = candidate;
  }
  const input = Number(usage?.input_tokens ?? usage?.inputTokens ?? 0);
  const cached = Number(usage?.cached_input_tokens ?? usage?.cachedInputTokens ?? usage?.input_tokens_details?.cached_tokens ?? 0);
  const output = Number(usage?.output_tokens ?? usage?.outputTokens ?? 0);
  return { input_tokens: input, cached_input_tokens: cached, uncached_input_tokens: Math.max(0, input - cached), output_tokens: output };
}

function forwardedHeaderStats(headers) {
  const names = Object.keys(headers).sort();
  const material = Object.fromEntries(names
    .filter((name) => !["authorization", "cookie", "proxy-authorization", "x-api-key"].includes(name.toLowerCase()))
    .map((name) => [name, headers[name]]));
  return { forwarded_header_names: names, forwarded_header_fingerprint: hashText(stableStringify(material)) };
}

function usageFromEvents(events) {
  let usage;
  for (const event of events) {
    if (event.type === "turn.completed" && event.usage) usage = event.usage;
    if (event.item?.usage) usage = event.item.usage;
  }
  const input = Number(usage?.input_tokens ?? usage?.inputTokens ?? 0);
  const cached = Number(usage?.cached_input_tokens ?? usage?.cachedInputTokens ?? usage?.input_tokens_details?.cached_tokens ?? 0);
  return { input_tokens: input, cached_input_tokens: cached, uncached_input_tokens: Math.max(0, input - cached), output_tokens: Number(usage?.output_tokens ?? usage?.outputTokens ?? 0) };
}

function commandRunWorkerSummary(workerDiagnostic) {
  const matches = [...String(workerDiagnostic || "").matchAll(/command_run completed results=(\d+) status=(\w+)/gu)];
  const last = matches.at(-1);
  return last ? { completed_results: Number(last[1]), status: last[2] } : null;
}

function verifyTuraOutput(stdout, workerDiagnostic = "") {
  const events = parseJsonLines(stdout);
  const commandItems = events.filter((event) => event.type === "item.completed" && event.item?.type === "command_execution");
  const workerSummary = commandRunWorkerSummary(workerDiagnostic);
  const agentText = events.filter((event) => event.item?.type === "agent_message").map((event) => String(event.item.text || "")).join("\n");
  const commandText = commandItems.map((event) => String(event.item.command || "")).join("\n");
  const unsafe = UNSAFE_COMMAND_PATTERN.test(commandText);
  const itemTypeCounts = Object.fromEntries(events.filter((event) => event.item?.type).reduce((counts, event) => counts.set(event.item.type, (counts.get(event.item.type) || 0) + 1), new Map()));
  const commandShapes = commandItems.map((event) => ({
    keys: Object.keys(event.item).sort(),
    commandType: typeof event.item.command_type === "string" ? event.item.command_type : null,
    commandIndex: Number.isInteger(event.item.command_index) ? event.item.command_index : null,
    commandArrayLength: Array.isArray(event.item.commands) ? event.item.commands.length : null,
    inputArrayLength: Array.isArray(event.item.input) ? event.item.input.length : null,
    outputArrayLength: Array.isArray(event.item.output) ? event.item.output.length : null,
    aggregatedOutputBytes: typeof event.item.aggregated_output === "string" ? Buffer.byteLength(event.item.aggregated_output, "utf8") : null,
  }));
  return {
    tool_name: "command_run",
    tool_count: commandItems.length,
    exact_ten_tools: commandItems.length === 10 || (workerSummary?.completed_results === 10 && workerSummary.status === "completed"),
    final_marker: agentText.includes(MARKER),
    unsafe_command_detected: unsafe,
    item_type_counts: itemTypeCounts,
    command_shapes: commandShapes,
    worker_command_summary: workerSummary,
    usage: usageFromEvents(events),
  };
}

function verifyCodexOutput(stdout) {
  const events = parseJsonLines(stdout);
  const commandItems = events.filter((event) => event.type === "item.completed" && event.item?.type === "command_execution");
  const agentText = events.filter((event) => event.item?.type === "agent_message").map((event) => String(event.item.text || "")).join("\n");
  const commandText = commandItems.map((event) => String(event.item.command || "")).join("\n");
  const itemTypeCounts = Object.fromEntries(events.filter((event) => event.item?.type).reduce((counts, event) => counts.set(event.item.type, (counts.get(event.item.type) || 0) + 1), new Map()));
  return {
    tool_name: "shell",
    tool_count: commandItems.length,
    exact_ten_tools: commandItems.length === 10,
    final_marker: agentText.includes(MARKER),
    unsafe_command_detected: UNSAFE_COMMAND_PATTERN.test(commandText),
    item_type_counts: itemTypeCounts,
    command_shapes: commandItems.map((event) => ({ keys: Object.keys(event.item).sort(), command: String(event.item.command || "") })),
    usage: usageFromEvents(events),
  };
}

function statusSnapshot(workspace) {
  const result = execFileSync("git", ["status", "--short", "--untracked-files=all"], { cwd: workspace, encoding: "utf8", windowsHide: true });
  return String(result).trim();
}

function redactedDiagnostic(text) {
  return String(text || "")
    .replace(/Bearer\s+\S+/giu, "Bearer <redacted>")
    .replace(/(OPENAI_API_KEY|LIGHTRSI_API_KEY)\s*[:=]\s*\S+/giu, "$1=<redacted>")
    .slice(-1000);
}

function killTree(pid) {
  if (!pid) return;
  if (process.platform === "win32") {
    try { execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }); } catch {}
  } else {
    try { process.kill(-pid, "SIGKILL"); } catch {}
  }
}

function runTura({ binary, workspace, projectRoot, configPath, sessionId, agentId, model, apiKey, prompt, turaHome, turaDbRoot }) {
  return new Promise((resolveRun) => {
    const started = performance.now();
    const args = ["--quiet", "--json", "--session-id", sessionId, "--agent-id", agentId, "-C", workspace, "-m", `openai/${model}`, prompt];
    const child = spawn(binary, args, {
      cwd: workspace,
      env: { ...process.env, OPENAI_API_KEY: apiKey, TURA_PROJECT_ROOT: projectRoot, TURA_PROVIDER_CONFIG: configPath, TURA_HOME: turaHome, TURA_DB_ROOT: turaDbRoot, SESSION_LOG_DB_ROOT: turaDbRoot, TURA_BENCH_FORCE_COMMAND_RUN: "1", TURA_DEBUG_RUNTIME: "1", TURA_ROUTER_STDERR_LOG: join(turaHome, "router.stderr.log"), TURA_RUNTIME_WORKER_STDERR_LOG: join(turaHome, "worker.stderr.log") },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let firstOutputMs = null;
    let settled = false;
    const timer = setTimeout(() => { killTree(child.pid); finish(true, 124); }, Number(process.env.TURA_BENCH_TIMEOUT_MS || 180000));
    const finish = async (timedOut, exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const workerDiagnostic = await readFile(join(turaHome, "worker.stderr.log"), "utf8").catch(() => "");
      const verified = verifyTuraOutput(stdout, workerDiagnostic);
      resolveRun({ elapsed_ms: Math.round(performance.now() - started), first_output_ms: firstOutputMs, exit: timedOut ? 124 : (exitCode ?? 1), timed_out: timedOut, stdout, stderr, workerDiagnostic, ...verified });
    };
    child.stdout.on("data", (chunk) => { if (firstOutputMs === null) firstOutputMs = Math.round(performance.now() - started); stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.once("error", () => finish(false, 1));
    child.once("exit", (code) => finish(false, code));
  });
}

function runCodex({ binary, workspace, model, apiKey, prompt, providerUrl, codexHome }) {
  return new Promise((resolveRun) => {
    const started = performance.now();
    const args = ["exec", "--skip-git-repo-check", "--json", "--ephemeral", "-C", workspace, "-m", model, "--dangerously-bypass-approvals-and-sandbox"];
    const child = spawn(binary, args, {
      cwd: workspace,
      env: { ...process.env, CODEX_HOME: codexHome, OPENAI_API_KEY: apiKey, LIGHTRSI_API_KEY: apiKey },
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let firstOutputMs = null;
    let settled = false;
    const timer = setTimeout(() => { killTree(child.pid); finish(true, 124); }, Number(process.env.TURA_BENCH_TIMEOUT_MS || 180000));
    const finish = (timedOut, exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveRun({ elapsed_ms: Math.round(performance.now() - started), first_output_ms: firstOutputMs, exit: timedOut ? 124 : (exitCode ?? 1), timed_out: timedOut, stdout, stderr, ...verifyCodexOutput(stdout) });
    };
    child.stdin.end(prompt);
    child.stdout.on("data", (chunk) => { if (firstOutputMs === null) firstOutputMs = Math.round(performance.now() - started); stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.once("error", () => finish(false, 1));
    child.once("exit", (code) => finish(false, code));
  });
}

function upstreamPath(baseUrl, requestUrl) {
  const base = baseUrl.replace(/\/+$/u, "");
  if (base.endsWith("/v1") && requestUrl.startsWith("/v1")) return `${base.slice(0, -3)}${requestUrl}`;
  return `${base}${requestUrl.startsWith("/") ? requestUrl : `/${requestUrl}`}`;
}

async function reservePort() {
  const server = createServer();
  await new Promise((resolveListen, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolveListen); });
  const port = server.address().port;
  await new Promise((resolveClose) => server.close(resolveClose));
  return port;
}

async function startDiagnosticRelay(providerUrl) {
  const port = await reservePort();
  const requests = [];
  let pending = 0;
  const server = createServer(async (request, response) => {
    pending += 1;
    const requestStart = performance.now();
    const chunks = [];
    for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const body = Buffer.concat(chunks);
    const requestComplete = performance.now();
    const dispatch = performance.now();
    const forwardedHeaders = Object.fromEntries(Object.entries(request.headers).filter(([name]) => !["host", "content-length", "connection", "transfer-encoding", "accept-encoding"].includes(name.toLowerCase()) && !BENCHMARK_CACHE_IRRELEVANT_HEADERS.has(name.toLowerCase())));
    let downstreamAborted = false;
    let requestAborted = false;
    let settleResponse;
    const responseSettled = new Promise((resolve) => { settleResponse = resolve; });
    const record = { relay_request_id: `${Date.now()}-${requests.length + 1}`, method: request.method || "POST", path: request.url || "/", request_bytes: body.length, request_complete_ms: requestComplete - requestStart, dispatch_ms: dispatch - requestStart, response_status: 599, response_bytes: 0, headers_ms: null, first_chunk_ms: null, last_chunk_ms: null, downstream_finish_ms: null, outcome: "pending", ...snapshotStatsFromBody(body), ...forwardedHeaderStats(forwardedHeaders) };
    Object.defineProperty(record, "_body", { value: body.toString("utf8"), enumerable: false });
    requests.push(record);
    request.once("aborted", () => { requestAborted = true; record.request_aborted = true; });
    response.once("finish", () => { record.downstream_finish_ms = performance.now() - dispatch; settleResponse(); });
    response.once("close", () => {
      if (!response.writableFinished) {
        downstreamAborted = true;
        record.response_close_before_finish = true;
      }
      settleResponse();
    });
    try {
      const upstream = await fetch(upstreamPath(providerUrl, request.url || "/"), { method: request.method || "POST", headers: forwardedHeaders, body: body.length ? body : undefined });
      const headersAt = performance.now();
      record.response_status = upstream.status;
      record.headers_ms = headersAt - dispatch;
      const headers = Object.fromEntries([...upstream.headers].filter(([name]) => !["content-length", "transfer-encoding", "connection", "content-encoding"].includes(name.toLowerCase())));
      response.writeHead(upstream.status, headers);
      let responseBytes = 0;
      const responseChunks = [];
      if (upstream.body) {
        for await (const chunk of upstream.body) {
          const now = performance.now();
          if (record.first_chunk_ms === null) record.first_chunk_ms = now - dispatch;
          record.last_chunk_ms = now - dispatch;
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          responseChunks.push(buffer);
          responseBytes += buffer.length;
          response.write(buffer);
        }
      }
      record.response_bytes = responseBytes;
      record.provider_response = providerResponseStats(Buffer.concat(responseChunks));
      record.provider_usage = providerUsageFromResponse(Buffer.concat(responseChunks));
      record.upstream_completed = true;
      response.end();
      await responseSettled;
      record.outcome = downstreamAborted || requestAborted ? "expected_cancelled" : "completed";
    } catch (error) {
      record.error_class = error instanceof Error ? error.name : "unknown";
      record.outcome = downstreamAborted || requestAborted ? "expected_cancelled" : "failed";
      record.response_status = 502;
      if (!response.headersSent) response.writeHead(502, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "benchmark_relay_failed" }));
    } finally {
      if (record.outcome === "pending") record.outcome = downstreamAborted || requestAborted ? "expected_cancelled" : "failed";
      pending -= 1;
    }
  });
  await new Promise((resolveListen, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolveListen); });
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    waitForIdle: async (timeoutMs = 15000) => {
      const deadline = Date.now() + timeoutMs;
      while (pending > 0 && Date.now() < deadline) await new Promise((resolveWait) => setTimeout(resolveWait, 50));
      return pending === 0;
    },
    close: () => new Promise((resolveClose) => server.close(resolveClose)),
  };
}

function writeTuraConfig(endpoint, file, model) {
  const route = { default_temperature: 0.2, providers: [{ provider: "openai", model }] };
  const config = {
    model_catalog: { providers: { openai: { display_name: "Benchmark OpenAI Compatible", runtime_provider: "openai", api_style: "openai_compatible", token_env: "OPENAI_API_KEY", env: ["OPENAI_API_KEY"], domains: ["llm"], capabilities: ["llm.chat", "llm.tool_call"], auth_methods: ["api_key"], models: { fast: [model], thinking: [model] }, status: "local", base_url: endpoint } } },
    provider_auth: {},
    provider_base_url: { openai: endpoint },
    routes: { fast: route, thinking: route, "codex/gpt-5.6-sol": route },
  };
  return writeFile(file, JSON.stringify(config));
}

function writeCodexConfig(endpoint, file, model) {
  return writeFile(file, [`approval_policy = "never"`, `sandbox_mode = "danger-full-access"`, `model_provider = "9router"`, `model = ${JSON.stringify(model)}`, "", "[model_providers.9router]", `name = "9Router"`, `base_url = ${JSON.stringify(endpoint)}`, `wire_api = "responses"`, "requires_openai_auth = true", ""].join("\n"));
}

async function writeBenchmarkAgent(projectRoot, turaRoot) {
  const agentDirectory = join(projectRoot, "agents", "src", "balanced");
  await mkdir(agentDirectory, { recursive: true });
  await cp(join(turaRoot, "agents", "src", "balanced", "prompt.md"), join(agentDirectory, "prompt.md"), { preserveTimestamps: true, force: true });
  await writeFile(join(agentDirectory, "agent_config.json"), JSON.stringify({
    agent_name: "balanced",
    description: "Benchmark tool-enabled agent.",
    aliases: [],
    report_to_user: true,
    default_config: true,
    reflection: false,
    op_manual: true,
    self_reflection: false,
    provider: {
      current_model: null,
      default_model_tier: "thinking",
      tura_llm_name: "thinking",
      stream: true,
      temperature: 0.2,
      max_tokens: 0,
      tool_choice: "Strict",
      time_out_ms: 120000,
    },
    agent_prompt: [{ agent_prompt: "balanced", prompt_directory: "agents/src\\balanced" }],
    agent_capabilities: [
      { capability_name: "apply_patch" },
      { capability_name: "shells" },
      { capability_name: "web_discover" },
      { capability_name: "task_status" },
    ],
    validator: { need_validator: false, validator_name: null },
  }));
}

async function applyWorkspaceCase(fixture, workspaceCase) {
  if (workspaceCase === "unchanged" || workspaceCase === "different-path") return;
  if (workspaceCase === "tracked-source") {
    const sourcePath = join(fixture, "README.md");
    const source = await readFile(sourcePath);
    await writeFile(sourcePath, Buffer.concat([source, Buffer.from("\nbenchmark tracked-source mutation\n")]))
    return;
  }
  await mkdir(join(fixture, "target"), { recursive: true });
  await writeFile(join(fixture, "target", "benchmark-generated.txt"), "benchmark generated mutation\n");
  await mkdir(join(fixture, ".git", "benchmark-generated"), { recursive: true });
  await writeFile(join(fixture, ".git", "benchmark-generated", "marker"), "benchmark git mutation\n");
}
async function restoreWorkspace(fixture, workspace) {
  await rm(workspace, { recursive: true, force: true });
  await cp(fixture, workspace, { recursive: true, preserveTimestamps: true, force: true });
}

async function readTraceRows(tracePath, offset) {
  const content = await readFile(tracePath, "utf8").catch(() => "");
  return content.slice(offset).split(/\r?\n/u).flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
}

async function waitForTrace(tracePath, offset, expected, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = await readTraceRows(tracePath, offset);
    if (rows.filter((row) => ["pure_forward_timing", "pure_forward_cancelled", "pure_forward_failed"].includes(row.stage)).length >= expected) return rows;
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  return readTraceRows(tracePath, offset);
}

async function shutdownRouter(turaDbRoot) {
  const endpointPath = join(turaDbRoot, "session_log", "router.addr");
  const endpoint = JSON.parse(await readFile(endpointPath, "utf8").catch(() => "null"));
  if (!endpoint?.addr) return;
  const separator = endpoint.addr.lastIndexOf(":");
  const host = endpoint.addr.slice(0, separator);
  const port = Number(endpoint.addr.slice(separator + 1));
  if (!host || !Number.isInteger(port)) return;
  await new Promise((resolveShutdown) => {
    const socket = createConnection({ host, port });
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolveShutdown();
    };
    socket.setTimeout(3000, finish);
    socket.on("error", finish);
    socket.on("close", finish);
    socket.on("connect", () => {
      socket.end(`${JSON.stringify({ request_id: "benchmark-shutdown", method: "execution.shutdown", payload: {} })}\n`);
    });
  });
  if (Number.isInteger(endpoint.pid)) killTree(endpoint.pid);
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const endpointExists = await readFile(endpointPath, "utf8").then(() => true).catch(() => false);
    let processExists = false;
    if (Number.isInteger(endpoint.pid)) {
      try {
        process.kill(endpoint.pid, 0);
        processExists = true;
      } catch {}
    }
    if (!endpointExists && !processExists) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
}

async function removeWithRetry(path, attempts = 12) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await rm(path, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt === attempts - 1) throw error;
      await new Promise((resolveWait) => setTimeout(resolveWait, 250));
    }
  }
}

function aggregate(records) {
  const values = (key) => records.map((record) => Number(record[key])).filter(Number.isFinite).sort((a, b) => a - b);
  const median = (list) => list.length ? (list.length % 2 ? list[(list.length - 1) / 2] : (list[list.length / 2 - 1] + list[list.length / 2]) / 2) : 0;
  const percentile = (list, fraction) => list.length ? list[Math.min(list.length - 1, Math.ceil(list.length * fraction) - 1)] : 0;
  const input = records.reduce((sum, record) => sum + record.input_tokens, 0);
  const cached = records.reduce((sum, record) => sum + record.cached_input_tokens, 0);
  const requestUsage = records.flatMap((record) => record.provider_request_usage || []);
  const requestInput = requestUsage.reduce((sum, usage) => sum + Number(usage.input_tokens || 0), 0);
  const requestCached = requestUsage.reduce((sum, usage) => sum + Number(usage.cached_input_tokens || 0), 0);
  return { n: records.length, strict_pass: records.filter((record) => record.strict_pass).length, provider_requests_avg: records.length ? records.reduce((sum, record) => sum + record.provider_requests, 0) / records.length : 0, provider_completed_avg: records.length ? records.reduce((sum, record) => sum + record.provider_completed_requests, 0) / records.length : 0, provider_cancelled_avg: records.length ? records.reduce((sum, record) => sum + record.provider_cancelled_requests, 0) / records.length : 0, provider_failed_avg: records.length ? records.reduce((sum, record) => sum + record.provider_failed_requests, 0) / records.length : 0, accounting_complete: records.every((record) => record.accounting_complete), input_median: median(values("input_tokens")), uncached_median: median(values("uncached_input_tokens")), cache_ratio: input ? 100 * cached / input : 0, provider_request_usage_records: requestUsage.length, provider_request_input_tokens: requestInput, provider_request_cached_input_tokens: requestCached, provider_request_uncached_input_tokens: Math.max(0, requestInput - requestCached), provider_request_cache_ratio: requestInput ? 100 * requestCached / requestInput : 0, latency_p50_ms: median(values("latency_ms")), latency_p95_ms_diagnostic: percentile(values("latency_ms"), 0.95) };
}

async function selfTest() {
  const fakeProvider = await startDiagnosticRelay("http://127.0.0.1:1/v1").catch(() => null);
  if (fakeProvider) await fakeProvider.close();
  const fakeBody = JSON.stringify({ tools: [{ type: "function", name: "command_run" }], input: [{ content: `${SNAPSHOT_START}\nnode_modules/\nsrc/\n${SNAPSHOT_END}` }] });
  const stats = snapshotStatsFromBody(fakeBody);
  if (stats.snapshot_bytes <= 0 || stats.category_lines.node_modules !== 1 || stats.tool_schema_digest === null) throw new Error("snapshot self-test failed");
  const equal = firstDivergence("same", "same");
  const prefix = firstDivergence("prefix-a", "prefix-b");
  const unicode = firstDivergence("a😀", "a😃");
  if (equal.first_divergence_byte !== null || prefix.first_divergence_byte !== 7 || unicode.first_divergence_character !== 1) throw new Error("divergence self-test failed");
  const metadata = payloadMetadataFromBody(JSON.stringify({ model: "m", prompt_cache_key: "k", input: [] }));
  if (metadata.payload_model !== "m" || !metadata.prompt_cache_key_present || !metadata.payload_top_level_keys.includes("model")) throw new Error("payload metadata self-test failed");
  if (firstDifferentTopLevelField(JSON.stringify({ model: "m", input: [1] }), JSON.stringify({ model: "m", input: [2] })) !== "input") throw new Error("top-level divergence self-test failed");
  const output = verifyTuraOutput([
    JSON.stringify({ type: "item.completed", item: { type: "command_execution", command: "pwd" } }),
    ...Array.from({ length: 9 }, (_, index) => JSON.stringify({ type: "item.completed", item: { type: "command_execution", command: `read-${index}` } })),
    JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: MARKER } }),
    JSON.stringify({ type: "turn.completed", usage: { input_tokens: 10, input_tokens_details: { cached_tokens: 4 }, output_tokens: 2 } }),
  ].join("\n"));
  if (!output.exact_ten_tools || !output.final_marker || output.usage.cached_input_tokens !== 4) throw new Error("event self-test failed");
  const codexOutput = verifyCodexOutput([
    ...Array.from({ length: 10 }, (_, index) => JSON.stringify({ type: "item.completed", item: { type: "command_execution", command: `read-${index}` } })),
    JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: MARKER } }),
    JSON.stringify({ type: "turn.completed", usage: { input_tokens: 12, input_tokens_details: { cached_tokens: 5 }, output_tokens: 2 } }),
  ].join("\n"));
  if (!codexOutput.exact_ten_tools || !codexOutput.final_marker || codexOutput.usage.cached_input_tokens !== 5) throw new Error("Codex event self-test failed");
  const providerUsage = providerUsageFromResponse("data: {\"response\":{\"usage\":{\"input_tokens\":10,\"input_tokens_details\":{\"cached_tokens\":4},\"output_tokens\":2}}}\n\ndata: [DONE]\n");
  if (providerUsage.cached_input_tokens !== 4 || providerUsage.uncached_input_tokens !== 6) throw new Error("provider usage self-test failed");
  console.log(JSON.stringify({ ok: true, checks: ["snapshot", "canonical_events", "usage", "redaction"] }));
}

async function liveRun(options) {
  const apiKey = process.env.LIGHTRSI_API_KEY;
  if (!apiKey) throw new Error("LIGHTRSI_API_KEY is required");
  const tempRoot = await mkdtemp(join(tmpdir(), "tura-tl-efficiency-"));
  const fixture = join(tempRoot, "fixture");
  const workspace = join(tempRoot, "workspace");
  const projectRoot = join(tempRoot, "tura-project");
  const turaHome = join(tempRoot, "tura-home");
  const turaDbRoot = join(tempRoot, "tura-db");
  const codexHome = join(tempRoot, "codex-home");
  const authFile = join(process.env.USERPROFILE || "", ".codex", "auth.json");
  const configDirect = join(tempRoot, "direct-provider.json");
  const configProxy = join(tempRoot, "proxy-provider.json");
  const relay = await startDiagnosticRelay(options.providerUrl);
  const stateDir = join(tempRoot, "lightrsi-state");
  let proxy;
  try {
    await mkdir(codexHome, { recursive: true });
    await cp(authFile, join(codexHome, "auth.json"), { preserveTimestamps: false, force: true });
    execFileSync("git", ["clone", "--local", "--no-hardlinks", options.lightrsiRoot, fixture], { windowsHide: true, stdio: "ignore" });
    await applyWorkspaceCase(fixture, options.workspaceCase);
    await mkdir(join(projectRoot, "crates"), { recursive: true });
    await cp(join(options.turaRoot, "crates", "tools"), join(projectRoot, "crates", "tools"), { recursive: true, preserveTimestamps: true, force: true });
    await writeBenchmarkAgent(projectRoot, options.turaRoot);
    await writeTuraConfig(relay.baseUrl, configDirect, options.model);
    const proxyPort = await reservePort();
    await writeCodexConfig(`http://127.0.0.1:${proxyPort}/v1`, join(codexHome, "config.toml"), options.model);
    const runtime = await import(pathToFileURL(join(options.lightrsiRoot, "components/adapters/codex/dist/index.js")).href);
    await writeTuraConfig(`http://127.0.0.1:${proxyPort}/v1`, configProxy, options.model);
    proxy = await runtime.startCodexResponsesProxy({ config: runtime.normalizeTokenPilotCodexConfig({ proxyPort, stateDir, upstream: { name: "benchmark-relay", baseUrl: relay.baseUrl, wireApi: "responses" }, proxyMode: { pureForward: true }, modules: { stabilizer: false, reduction: false } }), logger: runtime.createConsoleLogger(false) });
    const tracePath = join(stateDir, "event-trace.jsonl");
    const records = [];
    for (let repetition = 1; repetition <= options.repetitions; repetition += 1) {
      const order = [...options.arms];
      for (let index = order.length - 1; index > 0; index -= 1) {
        const swapIndex = Math.floor(Math.random() * (index + 1));
        [order[index], order[swapIndex]] = [order[swapIndex], order[index]];
      }
      const pairFamily = `tura-tl-${Date.now()}-${repetition}`;
      for (const arm of order) {
        const currentWorkspace = options.workspaceCase === "different-path" ? join(tempRoot, `workspace-${arm.toLowerCase()}`) : workspace;
        await restoreWorkspace(fixture, currentWorkspace);
        const beforeStatus = statusSnapshot(currentWorkspace);
        const beforeRequests = relay.requests.length;
        const traceBefore = (await stat(tracePath).catch(() => ({ size: 0 }))).size;
        const prompt = `${arm === "L" ? CODEX_PROMPT : TURA_PROMPT} Benchmark family: ${pairFamily}.`;
        const result = arm === "L"
          ? await runCodex({ binary: options.codexBin, workspace: currentWorkspace, model: options.model, apiKey, prompt, providerUrl: `http://127.0.0.1:${proxyPort}/v1`, codexHome })
          : await runTura({ binary: options.turaBin, workspace: currentWorkspace, projectRoot, configPath: arm === "T" ? configDirect : configProxy, sessionId: `tl-benchmark-${repetition}-${arm}`, agentId: options.agentId, model: options.model, apiKey, prompt, turaHome, turaDbRoot });
        if (arm !== "L") await shutdownRouter(turaDbRoot);
        await relay.waitForIdle();
        await new Promise((resolveWait) => setTimeout(resolveWait, 1000));
        const afterStatus = statusSnapshot(currentWorkspace);
        const providerRequests = relay.requests.slice(beforeRequests);
        const traceRows = arm === "T" ? [] : await waitForTrace(tracePath, traceBefore, providerRequests.length, 15000);
        const forwardRows = traceRows.filter((row) => ["pure_forward_timing", "pure_forward_cancelled", "pure_forward_failed"].includes(row.stage));
        const expectedCancellation = (row) => row.stage === "pure_forward_cancelled" && ["request_aborted", "response_close_before_finish"].includes(row.abortSource);
        const completeForwardRows = forwardRows.filter((row) => row.stage === "pure_forward_timing" || expectedCancellation(row));
        const providerCompletedRequests = providerRequests.filter((request) => request.upstream_completed && request.response_status === 200);
        const providerCancelledRequests = providerRequests.filter((request) => request.outcome === "expected_cancelled");
        const providerFailedRequests = providerRequests.filter((request) => request.outcome === "failed" || request.outcome === "pending");
        const accountingComplete = providerRequests.every((request) => request.outcome !== "pending") && (arm === "T" || forwardRows.length === providerRequests.length);
        const strictPass = result.exit === 0 && !result.timed_out && result.exact_ten_tools && result.final_marker && !result.unsafe_command_detected && beforeStatus === afterStatus && providerCompletedRequests.length > 0 && providerFailedRequests.length === 0 && accountingComplete && (arm === "T" || completeForwardRows.length >= providerRequests.length && !forwardRows.some((row) => row.stage === "pure_forward_failed"));
        const firstRequest = providerRequests[0];
        const previousArmRecord = records.find((record) => record.repetition === repetition && record.arm !== arm);
        const matchedPayloadComparison = previousArmRecord ? { left_arm: previousArmRecord.arm, right_arm: arm, ...compareProviderRequests(previousArmRecord._provider_requests, providerRequests) } : null;
        const workerDiagnostic = arm === "L" ? "" : await readFile(join(turaHome, "worker.stderr.log"), "utf8").catch(() => "");
        const record = { benchmark: "tura-tl-efficiency", workspace_case: options.workspaceCase, arm, runner: arm === "L" ? "codex" : "tura", repetition, phase: repetition === 1 ? "workload-cold" : "workload-warm", pair_order: order.join("->"), pair_position: order.indexOf(arm) + 1, strict_pass: strictPass, accounting_complete: accountingComplete, provider_requests: providerRequests.length, provider_completed_requests: providerCompletedRequests.length, provider_cancelled_requests: providerCancelledRequests.length, provider_failed_requests: providerFailedRequests.length, provider_statuses: Object.fromEntries(providerRequests.map((request) => [String(request.response_status), (providerRequests.filter((item) => item.response_status === request.response_status).length)])), request_bytes: providerRequests.reduce((sum, request) => sum + request.request_bytes, 0), response_bytes: providerRequests.reduce((sum, request) => sum + request.response_bytes, 0), snapshot_bytes: firstRequest?.snapshot_bytes ?? 0, snapshot_digest: firstRequest?.snapshot_digest ?? null, category_bytes: firstRequest?.category_bytes ?? {}, tool_schema_digest: firstRequest?.tool_schema_digest ?? null, tool_choice: firstRequest?.tool_choice ?? null, forwarded_header_names: firstRequest?.forwarded_header_names ?? [], forwarded_header_fingerprint: firstRequest?.forwarded_header_fingerprint ?? null, tool_choices: providerRequests.map((request) => request.tool_choice), provider_responses: providerRequests.map((request) => request.provider_response), provider_request_usage: providerRequests.map((request) => request.provider_usage).filter(Boolean), provider_request_paths: providerRequests.map((request) => request.path), provider_request_methods: providerRequests.map((request) => request.method), provider_request_models: providerRequests.map((request) => request.payload_model), provider_request_cache_key_present: providerRequests.map((request) => request.prompt_cache_key_present), models_request_count: providerRequests.filter((request) => request.path.endsWith("/models")).length, payload_digests: providerRequests.map((request) => request.payload_digest), payload_metadata: providerRequests.map((request) => ({ payload_is_json: request.payload_is_json, payload_model: request.payload_model, prompt_cache_key_present: request.prompt_cache_key_present, payload_top_level_keys: request.payload_top_level_keys })), within_chain_divergences: providerRequests.slice(1).map((request, index) => firstDivergence(providerRequests[index]._body, request._body)), matched_payload_comparison: matchedPayloadComparison, input_tokens: result.usage.input_tokens, cached_input_tokens: result.usage.cached_input_tokens, uncached_input_tokens: result.usage.uncached_input_tokens, output_tokens: result.usage.output_tokens, latency_ms: result.elapsed_ms, first_output_ms: result.first_output_ms, relay_first_chunk_ms: firstRequest?.first_chunk_ms ?? null, relay_last_chunk_ms: firstRequest?.last_chunk_ms ?? null, light_forward_rows: forwardRows.length, trace_stages: traceRows.map((row) => row.stage), trace_error_classes: traceRows.map((row) => row.errorClass).filter(Boolean), trace_abort_sources: traceRows.map((row) => row.abortSource).filter(Boolean), tool_name: result.tool_name, exact_ten_tools: result.exact_ten_tools, final_marker: result.final_marker, unsafe_command_detected: result.unsafe_command_detected, item_type_counts: result.item_type_counts, command_shapes: result.command_shapes, diagnostic: redactedDiagnostic(result.stderr), worker_diagnostic: redactedDiagnostic(workerDiagnostic), router_diagnostic: redactedDiagnostic(await readFile(join(turaHome, "router.stderr.log"), "utf8").catch(() => "")), git_status_before: beforeStatus, git_status_after: afterStatus, git_status_unchanged: beforeStatus === afterStatus, exit: result.exit, timed_out: result.timed_out };
        Object.defineProperty(record, "_provider_requests", { value: providerRequests, enumerable: false });
        if (previousArmRecord) previousArmRecord.matched_payload_comparison = matchedPayloadComparison;
        records.push(record);
        console.log(JSON.stringify(record));
      }
    }
    const arms = Object.fromEntries(options.arms.map((arm) => [arm, aggregate(records.filter((record) => record.arm === arm))]));
    const summary = { benchmark: "tura-tl-efficiency", workspace_case: options.workspaceCase, repetitions_per_arm: options.repetitions, records: records.length, arms, records_redacted: records, p95_is_diagnostic: true };
    const outputDir = options.outputDir || join(tempRoot, "evidence");
    await mkdir(outputDir, { recursive: true });
    await writeFile(join(outputDir, "records.jsonl"), records.map((record) => JSON.stringify(record)).join("\n") + "\n");
    await writeFile(join(outputDir, "summary.json"), JSON.stringify(summary, null, 2));
    console.log(JSON.stringify({ summary: join(outputDir, "summary.json"), records: join(outputDir, "records.jsonl") }));
  } finally {
    await proxy?.close().catch(() => {});
    await relay.close();
    await removeWithRetry(tempRoot);
  }
}

const options = parseArgs(process.argv.slice(2));
if (options.selfTest) await selfTest();
else await liveRun(options);



