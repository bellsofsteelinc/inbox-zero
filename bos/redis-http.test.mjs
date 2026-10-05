// Run with: node --test bos/redis-http.test.mjs
import assert from "node:assert/strict";
import net from "node:net";
import { test } from "node:test";
import { ConfigError, createConnection, createServer, encodeCommand, parseReply, RedisError, refused, toJson } from "./redis-http.mjs";

test("commands are framed as RESP arrays of bulk strings", () => {
  assert.equal(encodeCommand(["SET", "k", 5]).toString(), "*3\r\n$3\r\nSET\r\n$1\r\nk\r\n$1\r\n5\r\n");
  assert.throws(() => encodeCommand(["SET", { a: 1 }]), TypeError);
});

test("replies of every RESP2 kind parse, including nested and partial input", () => {
  const b = Buffer.from("+OK\r\n:7\r\n$-1\r\n$4\r\na\r\nb\r\n*2\r\n$1\r\nx\r\n*1\r\n:1\r\n-ERR bad\r\n");
  const [ok, o1] = parseReply(b); assert.equal(ok, "OK");
  const [n, o2] = parseReply(b, o1); assert.equal(n, 7);
  const [nil, o3] = parseReply(b, o2); assert.equal(nil, null);
  const [bulk, o4] = parseReply(b, o3); assert.equal(bulk.toString(), "a\r\nb");
  const [arr, o5] = parseReply(b, o4); assert.equal(arr[0].toString(), "x"); assert.deepEqual(arr[1], [1]);
  const [err, o6] = parseReply(b, o5); assert.ok(err instanceof RedisError && err.message === "ERR bad");
  assert.equal(o6, b.length);
  assert.equal(parseReply(Buffer.from("$5\r\nab")), null);
  assert.equal(parseReply(Buffer.from("*2\r\n:1\r\n")), null);
});

test("JSON conversion follows the Upstash client's expectations", () => {
  assert.deepEqual(toJson([Buffer.from("hi"), 3, null, "OK", [Buffer.from("x")]], false), ["hi", 3, null, "OK", ["x"]]);
  // Inside an array the client decodes every string, "OK" included; only a top-level "OK" is left alone.
  assert.deepEqual(toJson([Buffer.from("hi"), 3, null, "OK", "PONG"], true), ["aGk=", 3, null, "T0s=", "UE9ORw=="]);
  assert.equal(toJson("OK", true), "OK");
  assert.throws(() => createConnection("not a url"), ConfigError);
  assert.throws(() => createConnection("http://x"), ConfigError);
});

// A fake Redis that answers a few commands, enough to drive the HTTP layer end to end.
function fakeRedis({ password = "pw" } = {}) {
  const store = new Map(); const seen = []; const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket); socket.on("close", () => sockets.delete(socket));
    let buffer = Buffer.alloc(0); let authed = false; let multi = null;
    const write = (s) => socket.write(s);
    const bulk = (v) => (v === undefined ? "$-1\r\n" : "$" + Buffer.byteLength(v) + "\r\n" + v + "\r\n");
    const answer = (parts) => {
      const [cmd, ...args] = parts; seen.push(parts);
      if (cmd === "AUTH") { authed = args[1] === password; return authed ? "+OK\r\n" : "-WRONGPASS invalid username-password pair\r\n"; }
      if (!authed) return "-NOAUTH Authentication required.\r\n";
      if (cmd === "MULTI") { multi = []; return "+OK\r\n"; }
      if (cmd === "EXEC") { const q = multi; multi = null; return "*" + q.length + "\r\n" + q.map(answerNow).join(""); }
      if (multi) { multi.push(parts); return "+QUEUED\r\n"; }
      return answerNow(parts);
    };
    const answerNow = ([cmd, ...args]) => {
      if (cmd === "PING") return "+PONG\r\n";
      if (cmd === "SET") { store.set(args[0], args[1]); return "+OK\r\n"; }
      if (cmd === "GET") return bulk(store.get(args[0]));
      if (cmd === "INCR") { const v = Number(store.get(args[0]) || 0) + 1; store.set(args[0], String(v)); return ":" + v + "\r\n"; }
      if (cmd === "CONFIG") return "-NOPERM this user has no permissions to run the 'config' command\r\n";
      if (cmd === "ECHO") return bulk(args[0]);
      if (cmd === "SLEEP") return null; // never answers
      if (cmd === "SELECT") return "+OK\r\n";
      return "-ERR unknown command '" + cmd + "'\r\n";
    };
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        const reply = parseReply(buffer); if (!reply) break;
        buffer = buffer.subarray(reply[1]);
        const out = answer(reply[0].map((b) => b.toString()));
        if (out !== null) write(out);
      }
    });
  });
  return { server, store, seen, sockets, listen: () => new Promise((r) => server.listen(0, "127.0.0.1", () => r(server.address().port))) };
}

async function withStack(fn, options) {
  const redis = fakeRedis(options); const port = await redis.listen();
  const connection = createConnection("redis://default:pw@127.0.0.1:" + port + "/0");
  const server = createServer({ connection, token: "secret" });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = "http://127.0.0.1:" + server.address().port;
  const call = (path, body, headers = {}) => fetch(base + path, { method: "POST", headers: { authorization: "Bearer secret", ...headers }, body: JSON.stringify(body) })
    .then(async (r) => ({ status: r.status, body: await r.json() }));
  try { await fn({ call, base, redis }); } finally { connection.close(); server.close(); redis.server.close(); }
}

test("single commands, base64 replies, errors and auth", () => withStack(async ({ call, base }) => {
  assert.deepEqual(await call("/", ["SET", "a", "hello"]), { status: 200, body: { result: "OK" } });
  assert.deepEqual(await call("/", ["GET", "a"]), { status: 200, body: { result: "hello" } });
  assert.deepEqual(await call("/", ["GET", "a"], { "Upstash-Encoding": "base64" }), { status: 200, body: { result: "aGVsbG8=" } });
  assert.deepEqual(await call("/", ["GET", "missing"]), { status: 200, body: { result: null } });
  assert.deepEqual(await call("/", ["INCR", "n"]), { status: 200, body: { result: 1 } });
  const denied = await call("/", ["CONFIG", "GET", "x"]);
  assert.equal(denied.status, 400); assert.match(denied.body.error, /NOPERM/);
  const r = await fetch(base + "/", { method: "POST", headers: { authorization: "Bearer wrong" }, body: "[\"PING\"]" });
  assert.equal(r.status, 401);
  assert.equal((await call("/", "PING")).status, 400);
}));

test("pipeline and multi-exec return one outcome per command, in order", () => withStack(async ({ call, redis }) => {
  const p = await call("/pipeline", [["SET", "k", "v"], ["GET", "k"], ["NOPE"], ["INCR", "c"]]);
  assert.deepEqual(p, { status: 200, body: [{ result: "OK" }, { result: "v" }, { error: "ERR unknown command 'NOPE'" }, { result: 1 }] });
  const m = await call("/multi-exec", [["INCR", "c"], ["GET", "k"]], { "Upstash-Encoding": "base64" });
  assert.deepEqual(m, { status: 200, body: [{ result: 2 }, { result: "dg==" }] });
  assert.deepEqual(redis.seen.filter((c) => ["MULTI", "EXEC"].includes(c[0])).map((c) => c[0]), ["MULTI", "EXEC"]);
}));

test("a dropped Redis connection fails the request and the next request reconnects", () => withStack(async ({ call, redis }) => {
  assert.equal((await call("/", ["PING"])).body.result, "PONG");
  assert.equal(redis.sockets.size, 1);
  for (const s of redis.sockets) s.destroy();
  await new Promise((r) => setTimeout(r, 50));
  assert.equal((await call("/", ["PING"])).body.result, "PONG");
}));

test("a rejected argument answers 400 and leaves the reply queue aligned", () => withStack(async ({ call }) => {
  await call("/", ["SET", "a", "1"]); await call("/", ["SET", "b", "2"]);
  const bad = await call("/", ["GET", null]);
  assert.equal(bad.status, 400);
  assert.deepEqual((await call("/", ["GET", "a"])).body, { result: "1" });
  assert.deepEqual((await call("/", ["GET", "b"])).body, { result: "2" });
  const mixed = await call("/pipeline", [["GET", "a"], ["GET", { x: 1 }]]);
  assert.equal(mixed.status, 400);
  assert.deepEqual((await call("/", ["ECHO", "still fine"])).body, { result: "still fine" });
}));

test("a refused password does not wedge the front; it retries on the next request", async () => {
  const redis = fakeRedis({ password: "other" }); const port = await redis.listen();
  const connection = createConnection("redis://default:pw@127.0.0.1:" + port);
  const server = createServer({ connection, token: "secret" });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = "http://127.0.0.1:" + server.address().port;
  try {
    for (let i = 0; i < 2; i++) {
      const r = await fetch(base + "/", { method: "POST", headers: { authorization: "Bearer secret" }, body: "[\"PING\"]" });
      assert.equal(r.status, 503); assert.match((await r.json()).error, /WRONGPASS/);
    }
    assert.equal(connection.open, 0, "the refused connection is dropped, not kept");
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(redis.sockets.size, 0, "and its socket is closed");
  } finally { connection.close(); server.close(); redis.server.close(); }
});

test("a timed-out command drops only its own connection; the next request uses exactly one new socket", async () => {
  // A fake Redis that never answers GET, so the command times out.
  const redis = fakeRedis(); const port = await redis.listen();
  const connection = createConnection("redis://default:pw@127.0.0.1:" + port, { commandTimeout: 100 });
  try {
    await assert.rejects(connection.run([["SLEEP"]]), /command timeout/);
    const results = await Promise.allSettled([connection.run([["PING"]]), connection.run([["PING"]]), connection.run([["PING"]])]);
    assert.deepEqual(results.map((r) => r.status), ["fulfilled", "fulfilled", "fulfilled"]);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(redis.sockets.size, 1, "one live socket after recovery");
  } finally { connection.close(); redis.server.close(); }
});

test("a Redis that accepts the connection but never answers AUTH times out instead of hanging", async () => {
  let closed = 0;
  const silent = net.createServer((socket) => { socket.resume(); socket.on("close", () => closed++); }); await new Promise((r) => silent.listen(0, "127.0.0.1", r));
  const connection = createConnection("redis://default:pw@127.0.0.1:" + silent.address().port, { connectTimeout: 150 });
  try {
    const started = Date.now();
    await assert.rejects(connection.run([["PING"]]), /connect timeout/);
    assert.ok(Date.now() - started < 2000);
    assert.equal(connection.open, 0);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(closed, 1, "the socket that never authenticated is destroyed");
  } finally { connection.close(); silent.close(); }
});

test("commands that would change the shared connection's state are refused", () => withStack(async ({ call, redis }) => {
  for (const c of [["SUBSCRIBE", "ch"], ["multi"], ["Select", "1"], ["CLIENT", "REPLY", "OFF"], ["MONITOR"], ["QUIT"]]) assert.ok(refused(c), c[0]);
  for (const c of [["GET", "a"], ["CLIENT", "ID"], ["PUBLISH", "ch", "x"], ["EVAL", "return 1", 0]]) assert.ok(!refused(c), c[0]);
  assert.equal((await call("/", ["SUBSCRIBE", "ch"])).status, 400);
  assert.equal((await call("/pipeline", [["GET", "a"], ["MULTI"]])).status, 400);
  assert.ok(!redis.seen.some((c) => ["SUBSCRIBE", "MULTI"].includes(c[0])), "nothing reached Redis");
}));

test("connection failures keep their real cause, and bad URLs are configuration errors", async () => {
  const dead = net.createServer(); await new Promise((r) => dead.listen(0, "127.0.0.1", r)); const port = dead.address().port; dead.close();
  await new Promise((r) => setTimeout(r, 20));
  await assert.rejects(createConnection("redis://127.0.0.1:" + port).run([["PING"]]), (e) => e.code === "ECONNREFUSED");
  assert.throws(() => createConnection("redis://default:%E0%A4%A@h:6379"), ConfigError);
  assert.throws(() => createConnection("redis://h:6379/notanumber"), ConfigError);
});

test("the database number in REDIS_URL is selected after signing in", async () => {
  const redis = fakeRedis(); const port = await redis.listen();
  const connection = createConnection("redis://default:pw@127.0.0.1:" + port + "/2");
  try {
    await connection.run([["PING"]]);
    assert.deepEqual(redis.seen.map((c) => c[0]), ["AUTH", "SELECT", "PING"]);
  } finally { connection.close(); redis.server.close(); }
});
