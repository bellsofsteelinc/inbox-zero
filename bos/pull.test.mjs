// Run with: node --test bos/pull.test.mjs
import assert from "node:assert/strict";
import { createVerify, generateKeyPairSync } from "node:crypto";
import { test } from "node:test";
import { accessToken, ConfigError, createPuller, isGmailNotification, parseKey, pushBody, readConfig } from "./pull.mjs";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const key = {
  client_email: "puller@example-project.iam.gserviceaccount.com",
  private_key: privateKey.export({ type: "pkcs8", format: "pem" }),
  private_key_id: "kid-1",
};
const subscription = "projects/example-project/subscriptions/inbox-zero-pull";
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });

function fakeFetch(handlers) {
  const calls = [];
  const impl = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    for (const [match, respond] of handlers) if (String(url).includes(match)) return respond(options);
    throw new Error(`unexpected request to ${url}`);
  };
  return { impl, calls };
}

test("parseKey accepts raw JSON and base64", () => {
  const raw = JSON.stringify(key);
  assert.equal(parseKey(raw).client_email, key.client_email);
  assert.equal(parseKey(Buffer.from(raw).toString("base64")).client_email, key.client_email);
  assert.throws(() => parseKey(JSON.stringify({ client_email: "x" })), /missing/);
  assert.throws(() => parseKey(JSON.stringify({ client_email: "x", private_key: "not a key" })), (error) => error instanceof ConfigError && /unreadable/.test(error.message));
  assert.throws(() => parseKey("secret-service-account-material"), (error) => error instanceof ConfigError && !error.message.includes("secret"));
});

test("accessToken is a verifiable RS256 token for the Pub/Sub audience", () => {
  const [header, claims, signature] = accessToken(key, 1_000).split(".");
  const decoded = JSON.parse(Buffer.from(claims, "base64url"));
  assert.deepEqual(decoded, { iss: key.client_email, sub: key.client_email, aud: "https://pubsub.googleapis.com/", iat: 1_000, exp: 4_600 });
  assert.equal(JSON.parse(Buffer.from(header, "base64url")).kid, "kid-1");
  assert.ok(createVerify("RSA-SHA256").update(`${header}.${claims}`).verify(publicKey, signature, "base64url"));
});

test("pushBody matches the Pub/Sub push shape", () => {
  const body = pushBody({ ackId: "a", message: { data: "ZGF0YQ==", messageId: "7", publishTime: "2026-10-02T00:00:00Z" } }, subscription);
  assert.deepEqual(body, {
    message: { data: "ZGF0YQ==", messageId: "7", message_id: "7", publishTime: "2026-10-02T00:00:00Z", publish_time: "2026-10-02T00:00:00Z" },
    subscription,
  });
});

test("readConfig is off without settings and strict about their shape", () => {
  assert.equal(readConfig({}), null);
  const env = { GOOGLE_PUBSUB_PULL_SUBSCRIPTION: subscription, GOOGLE_PUBSUB_PULL_KEY: JSON.stringify(key), GOOGLE_PUBSUB_VERIFICATION_TOKEN: "s e/cret", PORT: "3100" };
  assert.equal(readConfig(env).target, "http://127.0.0.1:3100/api/google/webhook?token=s%20e%2Fcret");
  assert.throws(() => readConfig({ ...env, GOOGLE_PUBSUB_PULL_SUBSCRIPTION: "https://evil.example/x" }), /must look like/);
  assert.throws(() => readConfig({ ...env, GOOGLE_PUBSUB_VERIFICATION_TOKEN: "" }), /VERIFICATION_TOKEN/);
});

const config = { subscription, key, target: "http://127.0.0.1:3000/api/google/webhook?token=t", heartbeatUrl: null };
const notification = Buffer.from(JSON.stringify({ emailAddress: "person@example.com", historyId: 12345 })).toString("base64");
const received = (id, data = notification) => ({ ackId: `ack-${id}`, message: { data, messageId: id, publishTime: "2026-10-02T00:00:00Z" } });

test("isGmailNotification accepts only a mailbox address with a numeric history counter", () => {
  assert.ok(isGmailNotification(notification));
  assert.ok(isGmailNotification(Buffer.from(JSON.stringify({ emailAddress: "a@example.com", historyId: "7" })).toString("base64url")));
  for (const bad of ["ZGF0YQ==", Buffer.from(JSON.stringify({ emailAddress: "a@example.com", historyId: "x" })).toString("base64"), Buffer.from("{}").toString("base64")])
    assert.ok(!isGmailNotification(bad));
});

test("cycle acknowledges what the app accepted, drops malformed messages and withholds the heartbeat on failure", async () => {
  let appCalls = 0;
  const { impl, calls } = fakeFetch([
    [":pull", () => json({ receivedMessages: [received("1"), received("2"), received("3", "ZGF0YQ=="), { ackId: "ack-empty", message: {} }] })],
    ["127.0.0.1", () => (++appCalls === 1 ? json({ ok: true }) : json({}, 500))],
    [":acknowledge", () => json({})],
    ["heartbeat", () => json({})],
  ]);
  const logs = [];
  const delivered = await createPuller({ ...config, heartbeatUrl: "https://monitor.example/heartbeat" }, { fetchImpl: impl, log: (line) => logs.push(line) }).cycle();
  assert.equal(delivered, 1);
  const ack = calls.find((c) => c.url.endsWith(":acknowledge"));
  assert.deepEqual(JSON.parse(ack.options.body), { ackIds: ["ack-1", "ack-3", "ack-empty"] });
  assert.match(calls[0].options.headers.authorization, /^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
  assert.equal(JSON.parse(calls[1].options.body).subscription, subscription);
  assert.equal(appCalls, 2);
  assert.ok(logs.some((line) => /HTTP 500 for message 2/.test(line)));
  assert.ok(!calls.some((c) => c.url.includes("heartbeat")));
  assert.ok(!logs.join("\n").includes("person@example.com"));
});

test("the heartbeat needs an answer from Google; a quiet pull timeout is neither an error nor a heartbeat", async () => {
  const quiet = fakeFetch([[":pull", () => { throw Object.assign(new Error("timed out"), { name: "TimeoutError" }); }]]);
  assert.equal(await createPuller({ ...config, heartbeatUrl: "https://monitor.example/heartbeat" }, { fetchImpl: quiet.impl }).cycle(), 0);
  assert.equal(quiet.calls.length, 1);
  const clean = fakeFetch([[":pull", () => json({})], ["heartbeat", () => json({})]]);
  await createPuller({ ...config, heartbeatUrl: "https://monitor.example/heartbeat" }, { fetchImpl: clean.impl }).cycle();
  assert.ok(clean.calls.some((c) => c.url.includes("heartbeat")));
});

test("cycle with nothing waiting does not acknowledge", async () => {
  const { impl, calls } = fakeFetch([[":pull", () => json({})]]);
  assert.equal(await createPuller(config, { fetchImpl: impl }).cycle(), 0);
  assert.equal(calls.length, 1);
});

test("cycle surfaces Pub/Sub errors without leaking the response body", async () => {
  const { impl } = fakeFetch([[":pull", () => json({ error: { message: "user@example.com denied" } }, 403)]]);
  await assert.rejects(createPuller(config, { fetchImpl: impl }).cycle(), (error) => error.message === "Pub/Sub pull returned HTTP 403");
});

test("the signed token is reused, then re-signed before it expires", async () => {
  let clock = 0;
  const { impl, calls } = fakeFetch([[":pull", () => json({})]]);
  const { cycle } = createPuller(config, { fetchImpl: impl, now: () => clock });
  await cycle();
  clock = 1_000_000;
  await cycle();
  clock = 3_100_000;
  await cycle();
  const tokens = calls.map((c) => c.options.headers.authorization);
  assert.equal(tokens[0], tokens[1]);
  assert.notEqual(tokens[1], tokens[2]);
});
