// BOS Deploy: fetch Gmail notifications instead of receiving them.
//
// Every BOS app sits behind Google sign-in, so Google Pub/Sub cannot POST to
// /api/google/webhook from outside. This process makes an OUTBOUND connection
// to a Pub/Sub pull subscription and hands each notification to the app on the
// container's own loopback address, in the same shape Pub/Sub push would send.
// Nothing is opened to the internet. No dependencies beyond Node itself.

import { createPrivateKey, createSign } from "node:crypto";
import { pathToFileURL } from "node:url";

const PUBSUB = "https://pubsub.googleapis.com";
const SUBSCRIPTION_PATTERN =
  /^projects\/[a-z][a-z0-9-]{4,28}[a-z0-9]\/subscriptions\/[A-Za-z][A-Za-z0-9._~+-]{2,254}$/;

// Wrong settings cannot fix themselves, so the start script stops retrying on these.
export class ConfigError extends Error {}
export const CONFIG_EXIT_CODE = 78;

const base64url = (value) => Buffer.from(value).toString("base64url");

// Accepts the service-account JSON as-is or base64-encoded (easier to paste
// into a single-line settings field).
export function parseKey(raw) {
  const text = raw.trim().startsWith("{")
    ? raw
    : Buffer.from(raw, "base64").toString("utf8");
  let key;
  try {
    key = JSON.parse(text);
  } catch {
    // The parser's own message quotes part of its input, which here is a secret.
    throw new ConfigError("GOOGLE_PUBSUB_PULL_KEY is not valid JSON or base64-encoded JSON");
  }
  if (!key?.client_email || !key?.private_key)
    throw new ConfigError("Service account key is missing client_email or private_key");
  try {
    createPrivateKey(key.private_key);
  } catch {
    throw new ConfigError("Service account key holds an unreadable private_key");
  }
  return key;
}

// Google APIs accept a self-signed JWT whose audience is the API itself, so no
// token exchange and no extra scope are needed.
export function accessToken(key, nowSeconds = Math.floor(Date.now() / 1000)) {
  const header = { alg: "RS256", typ: "JWT", kid: key.private_key_id };
  const claims = {
    iss: key.client_email,
    sub: key.client_email,
    aud: `${PUBSUB}/`,
    iat: nowSeconds,
    exp: nowSeconds + 3600,
  };
  const unsigned = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`;
  const signature = createSign("RSA-SHA256")
    .update(unsigned)
    .sign(key.private_key, "base64url");
  return `${unsigned}.${signature}`;
}

// A Gmail notification is base64 JSON holding a mailbox address and a history
// counter. Anything else would be rejected by the app on every redelivery.
export function isGmailNotification(data) {
  try {
    const decoded = JSON.parse(Buffer.from(data, "base64").toString("utf8"));
    return typeof decoded.emailAddress === "string" && /^\d+$/.test(String(decoded.historyId).trim());
  } catch {
    return false;
  }
}

// The body Pub/Sub push would have delivered for this pulled message.
export function pushBody(received, subscription) {
  const { data, messageId, publishTime, attributes } = received.message ?? {};
  return {
    message: {
      data,
      messageId,
      message_id: messageId,
      publishTime,
      publish_time: publishTime,
      ...(attributes ? { attributes } : {}),
    },
    subscription,
  };
}

export function readConfig(env = process.env) {
  const subscription = env.GOOGLE_PUBSUB_PULL_SUBSCRIPTION;
  const rawKey = env.GOOGLE_PUBSUB_PULL_KEY;
  if (!subscription || !rawKey) return null;
  if (!SUBSCRIPTION_PATTERN.test(subscription))
    throw new ConfigError(
      "GOOGLE_PUBSUB_PULL_SUBSCRIPTION must look like projects/<project>/subscriptions/<name>",
    );
  const token = env.GOOGLE_PUBSUB_VERIFICATION_TOKEN;
  if (!token)
    throw new ConfigError("GOOGLE_PUBSUB_VERIFICATION_TOKEN must be set to a non-empty value");
  return {
    subscription,
    key: parseKey(rawKey),
    target: `http://127.0.0.1:${env.PORT || 3000}/api/google/webhook?token=${encodeURIComponent(token)}`,
    heartbeatUrl: env.GOOGLE_PUBSUB_PULL_HEARTBEAT_URL || null,
  };
}

export function createPuller(config, { fetchImpl = fetch, log = console.log, now = Date.now } = {}) {
  let cached = null;
  const bearer = () => {
    const seconds = Math.floor(now() / 1000);
    // Re-sign ten minutes before expiry.
    if (!cached || seconds > cached.issued + 3000)
      cached = { issued: seconds, token: accessToken(config.key, seconds) };
    return cached.token;
  };

  const pubsub = async (verb, body, timeoutMs) => {
    const response = await fetchImpl(`${PUBSUB}/v1/${config.subscription}:${verb}`, {
      method: "POST",
      headers: { authorization: `Bearer ${bearer()}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    // Never log response bodies or the request: they can carry mailbox addresses.
    if (!response.ok) throw new Error(`Pub/Sub ${verb} returned HTTP ${response.status}`);
    return response.json();
  };

  // One pull, deliver, acknowledge round. Returns how many were handed over.
  const cycle = async () => {
    let receivedMessages = [];
    let answered = true;
    try {
      // A pull waits at Google until a message arrives or Google's own limit passes.
      ({ receivedMessages = [] } = await pubsub("pull", { maxMessages: 10 }, 90_000));
    } catch (error) {
      // A quiet mailbox can outlast our wait; that is not a failure.
      if (error.name !== "TimeoutError") throw error;
      answered = false;
    }
    const ackIds = [];
    let delivered = 0;
    let undelivered = 0;
    for (const received of receivedMessages) {
      if (!received.message?.data || !isGmailNotification(received.message.data)) {
        // Nothing the app could process; acknowledge so it is not redelivered for days.
        log(`[pull] dropped malformed message ${received.message?.messageId}`);
        ackIds.push(received.ackId);
        continue;
      }
      try {
        const response = await fetchImpl(config.target, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(pushBody(received, config.subscription)),
          signal: AbortSignal.timeout(10_000),
        });
        response.body?.cancel().catch(() => {});
        // Same rule as Pub/Sub push: only a success status acknowledges.
        if (response.ok) {
          ackIds.push(received.ackId);
          delivered += 1;
          continue;
        }
        log(`[pull] app returned HTTP ${response.status} for message ${received.message.messageId}; Google will redeliver`);
      } catch (error) {
        log(`[pull] app unreachable for message ${received.message.messageId}: ${error.name}; Google will redeliver`);
      }
      undelivered += 1;
    }
    if (ackIds.length) await pubsub("acknowledge", { ackIds }, 30_000);
    // The monitor must go quiet when notifications are not reaching the app.
    if (config.heartbeatUrl && answered && !undelivered) {
      await fetchImpl(config.heartbeatUrl, { signal: AbortSignal.timeout(10_000) })
        .then((response) => response.body?.cancel())
        .catch(() => {});
    }
    return delivered;
  };

  return { cycle };
}

async function main() {
  const config = readConfig();
  if (!config) {
    console.log("[pull] GOOGLE_PUBSUB_PULL_SUBSCRIPTION / GOOGLE_PUBSUB_PULL_KEY not set; Gmail fetcher is off");
    return;
  }
  console.log("[pull] fetching Gmail notifications (outbound only)");
  const { cycle } = createPuller(config);
  let failures = 0;
  while (true) {
    try {
      const delivered = await cycle();
      if (delivered) console.log(`[pull] delivered ${delivered} notification(s)`);
      failures = 0;
    } catch (error) {
      failures += 1;
      // Back off up to one minute; Pub/Sub keeps unacknowledged messages meanwhile.
      const wait = Math.min(60, 2 ** Math.min(failures, 6));
      console.log(`[pull] ${error.message}; retrying in ${wait}s`);
      await new Promise((resolve) => setTimeout(resolve, wait * 1000));
    }
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    const fixable = error instanceof ConfigError;
    console.log(`[pull] cannot start: ${fixable ? error.message : error.name}`);
    process.exit(fixable ? CONFIG_EXIT_CODE : 1);
  });
}
