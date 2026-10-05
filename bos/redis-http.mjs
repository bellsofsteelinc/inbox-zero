// BOS Deploy: an Upstash-style HTTP front for the platform's private Redis.
//
// Inbox Zero talks to Redis through @upstash/redis, which speaks HTTP, while the
// platform supplies a plain Redis (REDIS_URL). This process listens on the
// container's loopback address only and translates: POST / (one command),
// POST /pipeline and POST /multi-exec, JSON bodies, "Upstash-Encoding: base64"
// replies, Bearer token auth. No dependencies beyond Node itself.

import http from "node:http";
import net from "node:net";
import { pathToFileURL } from "node:url";

const CRLF = "\r\n";

// ---- RESP2 ----------------------------------------------------------------

export function encodeCommand(parts) {
  const items = parts.map((p) => {
    if (typeof p === "number" || typeof p === "boolean") return String(p);
    if (typeof p === "string") return p;
    throw new TypeError("Command arguments must be strings or numbers");
  });
  return Buffer.concat([
    Buffer.from("*" + items.length + CRLF),
    ...items.map((s) => { const b = Buffer.from(s); return Buffer.concat([Buffer.from("$" + b.length + CRLF), b, Buffer.from(CRLF)]); }),
  ]);
}

export class RedisError extends Error {}
export class ConfigError extends Error {}

// Parses one reply from `buffer` at `offset`. Returns [value, nextOffset] or null if incomplete.
export function parseReply(buffer, offset = 0) {
  const end = buffer.indexOf(CRLF, offset);
  if (end < 0) return null;
  const kind = String.fromCharCode(buffer[offset]);
  const line = buffer.toString("utf8", offset + 1, end);
  const next = end + 2;
  switch (kind) {
    case "+": return [line, next];
    case "-": return [new RedisError(line), next];
    case ":": return [Number(line), next];
    case "$": {
      const size = Number(line);
      if (size < 0) return [null, next];
      if (buffer.length < next + size + 2) return null;
      return [buffer.subarray(next, next + size), next + size + 2];
    }
    case "*": {
      const count = Number(line);
      if (count < 0) return [null, next];
      const items = []; let cursor = next;
      for (let i = 0; i < count; i++) {
        const item = parseReply(buffer, cursor);
        if (!item) return null;
        items.push(item[0]); cursor = item[1];
      }
      return [items, cursor];
    }
    default: throw new RedisError("Unsupported reply type " + kind);
  }
}

// One live connection at a time; commands on it are answered in order. Each attempt
// owns its socket, queue and buffer, so a failing old socket can never touch a newer
// one. A connection that fails is dropped and the next request opens a fresh one.
export function createConnection(url, { connectTimeout = 10_000, commandTimeout = 30_000 } = {}) {
  let target;
  try { target = new URL(url); } catch { throw new ConfigError("REDIS_URL is not a valid URL"); }
  if (target.protocol !== "redis:") throw new ConfigError("REDIS_URL must start with redis://");
  const host = target.hostname.replace(/^\[(.*)\]$/, "$1");
  const port = Number(target.port) || 6379;
  let password, username;
  try { password = decodeURIComponent(target.password || ""); username = decodeURIComponent(target.username || "default"); }
  catch { throw new ConfigError("REDIS_URL has a badly encoded username or password"); }
  const database = target.pathname.replace(/^\//, "");
  if (database && !/^\d+$/.test(database)) throw new ConfigError("REDIS_URL database must be a number");
  let current = null;

  const fail = (conn, error) => {
    if (conn.failed) return;
    conn.failed = true; conn.cause = error;
    if (current === conn) current = null;
    clearTimeout(conn.timer);
    conn.socket.destroy();
    const waiting = conn.pending; conn.pending = [];
    for (const p of waiting) p.reject(error);
  };

  const write = (conn, frame) => new Promise((resolve, reject) => {
    if (conn.failed) return reject(new Error("Redis connection closed"));
    conn.pending.push({ resolve, reject });
    conn.socket.write(frame);
  });

  const open = () => {
    const socket = net.connect({ host, port });
    const conn = { socket, pending: [], buffer: Buffer.alloc(0), failed: false, timer: null };
    socket.setNoDelay(true); socket.setKeepAlive(true, 30_000);
    // Covers both the TCP connect and the AUTH reply.
    conn.timer = setTimeout(() => fail(conn, new Error("Redis connect timeout")), connectTimeout);
    socket.on("error", (error) => fail(conn, error));
    socket.on("close", () => fail(conn, new Error("Redis connection closed")));
    socket.on("data", (chunk) => {
      if (conn.failed) return;
      conn.buffer = conn.buffer.length ? Buffer.concat([conn.buffer, chunk]) : chunk;
      let offset = 0;
      while (conn.pending.length) {
        let reply;
        try { reply = parseReply(conn.buffer, offset); } catch (error) { fail(conn, error); return; }
        if (!reply) break;
        offset = reply[1];
        conn.pending.shift().resolve(reply[0]);
      }
      if (offset) conn.buffer = conn.buffer.subarray(offset);
      // Data nobody asked for (a pushed message) would be handed to the next request.
      if (!conn.pending.length && conn.buffer.length) fail(conn, new Error("Unexpected data from Redis"));
    });
    conn.ready = new Promise((resolve, reject) => {
      socket.once("connect", () => {
        const auth = password ? write(conn, encodeCommand(["AUTH", username, password])) : Promise.resolve("OK");
        auth.then((reply) => {
          // A refused credential is a dead connection, not a reply to pass on.
          if (reply instanceof RedisError) { fail(conn, reply); reject(reply); return; }
          return database && database !== "0" ? write(conn, encodeCommand(["SELECT", database])) : "OK";
        }).then((reply) => {
          if (reply === undefined) return;
          if (reply instanceof RedisError) { fail(conn, reply); reject(reply); return; }
          clearTimeout(conn.timer); resolve(conn);
        }, reject);
      });
      socket.once("close", () => reject(conn.cause ?? new Error("Redis connection closed")));
    });
    conn.ready.catch(() => {});
    return conn;
  };

  return {
    // Sends the commands back to back on one connection and returns their replies in order.
    async run(commands) {
      const frames = commands.map(encodeCommand); // validate every argument before touching a socket
      if (!current) current = open();
      const conn = await current.ready;
      let timer;
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => { const e = new Error("Redis command timeout"); fail(conn, e); reject(e); }, commandTimeout);
      });
      try {
        return await Promise.race([Promise.all(frames.map((frame) => write(conn, frame))), timeout]);
      } finally { clearTimeout(timer); }
    },
    close() { if (current) fail(current, new Error("closed")); },
    // For tests: how many sockets this front holds open.
    get open() { return current && !current.failed ? 1 : 0; },
  };
}

// ---- Upstash-style JSON ----------------------------------------------------

// The client leaves a top-level "OK" alone but decodes every string inside an array.
export function toJson(value, base64, top = true) {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return value;
  if (Buffer.isBuffer(value)) return base64 ? value.toString("base64") : value.toString("utf8");
  if (value instanceof RedisError) value = value.message;
  if (typeof value === "string") return base64 && !(top && value === "OK") ? Buffer.from(value).toString("base64") : value;
  if (Array.isArray(value)) return value.map((v) => toJson(v, base64, false));
  return String(value);
}

// These change the state of the one shared connection, which would corrupt other requests.
const STATEFUL = new Set(["SUBSCRIBE", "PSUBSCRIBE", "SSUBSCRIBE", "UNSUBSCRIBE", "PUNSUBSCRIBE", "SUNSUBSCRIBE", "MONITOR", "MULTI", "EXEC", "DISCARD", "WATCH", "UNWATCH", "SELECT", "RESET", "QUIT", "HELLO", "AUTH", "SYNC", "PSYNC"]);
export const refused = (command) => STATEFUL.has(String(command[0]).toUpperCase()) || (String(command[0]).toUpperCase() === "CLIENT" && String(command[1] ?? "").toUpperCase() === "REPLY");

const outcome = (reply, base64) => (reply instanceof RedisError ? { error: reply.message } : { result: toJson(reply, base64) });

export function createServer({ connection, token, maxBody = 16 * 1024 * 1024 }) {
  return http.createServer(async (req, res) => {
    const reply = (status, body) => {
      res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(body));
    };
    try {
      if ((req.headers.authorization || "") !== "Bearer " + token) return reply(401, { error: "Unauthorized" });
      if (req.method !== "POST") return reply(405, { error: "Use POST" });
      if ((req.headers.accept || "").includes("text/event-stream")) return reply(400, { error: "Subscriptions are not supported over HTTP here" });
      const path = new URL(req.url, "http://localhost").pathname.replace(/\/+$/, "") || "/";
      const chunks = []; let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > maxBody) return reply(413, { error: "Request too large" });
        chunks.push(chunk);
      }
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return reply(400, { error: "Invalid JSON" }); }
      const base64 = req.headers["upstash-encoding"] === "base64";
      const isCommand = (c) => Array.isArray(c) && c.length > 0 && typeof c[0] === "string";
      if (path === "/") {
        if (!isCommand(body)) return reply(400, { error: "Expected a command array" });
        if (refused(body)) return reply(400, { error: "ERR this command is not available over HTTP" });
        const [r] = await connection.run([body]);
        const out = outcome(r, base64);
        return reply(out.error ? 400 : 200, out);
      }
      if (path === "/pipeline" || path === "/multi-exec") {
        if (!Array.isArray(body) || body.length === 0 || !body.every(isCommand)) return reply(400, { error: "Expected an array of commands" });
        if (body.some(refused)) return reply(400, { error: "ERR a command in this request is not available over HTTP" });
        if (path === "/pipeline") {
          const replies = await connection.run(body);
          return reply(200, replies.map((r) => outcome(r, base64)));
        }
        const replies = await connection.run([["MULTI"], ...body, ["EXEC"]]);
        const exec = replies.at(-1);
        if (exec instanceof RedisError && exec.message.startsWith("EXECABORT")) {
          // A command was rejected when queued, so nothing ran: report each one.
          const queued = replies.slice(1, -1);
          return reply(200, body.map((_, i) => ({ error: queued[i] instanceof RedisError ? queued[i].message : exec.message })));
        }
        if (exec instanceof RedisError) return reply(400, { error: exec.message });
        if (!Array.isArray(exec)) return reply(400, { error: "Transaction aborted" });
        return reply(200, exec.map((r) => outcome(r, base64)));
      }
      return reply(404, { error: "Not found" });
    } catch (error) {
      // The connection drops itself on failure and reconnects on the next request.
      reply(error instanceof TypeError ? 400 : 503, { error: error instanceof RedisError || error instanceof TypeError ? error.message : "Redis unavailable" });
    }
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const url = process.env.REDIS_URL, token = process.env.REDIS_HTTP_TOKEN;
  if (!url || !token) { console.log("[redis-http] REDIS_URL or REDIS_HTTP_TOKEN not set; HTTP front is off"); process.exit(78); }
  const port = Number(process.env.REDIS_HTTP_PORT) || 8079;
  let connection;
  try { connection = createConnection(url); }
  catch (error) { console.log("[redis-http] cannot start: " + (error instanceof ConfigError ? error.message : error.name)); process.exit(78); }
  createServer({ connection, token }).listen(port, "127.0.0.1", () =>
    console.log("[redis-http] serving the private Redis over HTTP on 127.0.0.1:" + port));
}
