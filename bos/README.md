# Running Inbox Zero on BOS Deploy

BOS-specific files. Everything else in this repository is upstream
[elie222/inbox-zero](https://github.com/elie222/inbox-zero).

| File | What it does |
|---|---|
| `../Dockerfile` | Starts from the upstream prebuilt image and adds the files below. |
| `start.sh` | Runs the scheduled-job loops and the Gmail fetcher, then the app. |
| `pull.mjs` | Fetches Gmail notifications from Google instead of receiving them. |
| `redis-http.mjs` | Serves the platform's private Redis over the Upstash-style HTTP protocol the app uses. |

## Redis without Upstash

Inbox Zero talks to Redis through the `@upstash/redis` client, which speaks HTTP.
BOS Deploy's "Add Redis" option supplies a plain Redis as `REDIS_URL`. When that is
set and `REDIS_HTTP_URL` is not, `start.sh` runs `redis-http.mjs` on the container's
loopback address and points the app at it (`REDIS_HTTP_URL=http://127.0.0.1:8079`,
with a token generated at start). Nothing to configure, nothing reachable from
outside the container. `REDIS_URL` is also used directly for subscriptions and, with
`QUEUE_BACKEND=bullmq`, for queues.

It covers what the client sends: single commands, `/pipeline`, `/multi-exec`, and
base64-encoded replies. Commands that change a connection's state (`SUBSCRIBE`,
`MULTI`, `SELECT`, `MONITOR` and similar) are refused, because every request shares
one connection; the app uses `REDIS_URL` directly for subscriptions. Set `REDIS_HTTP_URL` and `REDIS_HTTP_TOKEN` yourself to use
Upstash or another HTTP Redis instead; the front then stays off.

The platform's Redis is memory-only: a restart of the Redis service empties it.
Inbox Zero keeps locks, catch-up markers and queued jobs there, so a queued action
can be lost on a restart; mail itself lives in Gmail.

## Why Gmail notifications are fetched

Every BOS Deploy app is behind Google sign-in, so Google Pub/Sub cannot POST to
`/api/google/webhook` from outside. Instead of opening that address to the
internet, `pull.mjs` connects out to a Pub/Sub **pull** subscription and hands
each notification to the app inside the container. Nothing public is opened and
the sign-in gate is unchanged.

If the fetcher stops, notifications are not lost: Pub/Sub keeps unacknowledged
messages (7 days by default) and they are delivered once it is running again.

## Google Cloud setup (once)

In the project that owns the topic named by `GOOGLE_PUBSUB_TOPIC_NAME`:

1. Create a **pull** subscription on that topic (delivery type "Pull", not "Push")
   with an acknowledgement deadline of 60 seconds. Leave exactly-once delivery off.
   If a push subscription to this app exists, delete it.
2. Create a service account used for nothing else. Give it no project roles.
3. On the subscription only, grant that service account the role
   **Pub/Sub Subscriber**.
4. Create a JSON key for the service account.

## Settings (enter privately in BOS Deploy, never in chat or git)

| Name | Value |
|---|---|
| `GOOGLE_PUBSUB_PULL_SUBSCRIPTION` | `projects/<project>/subscriptions/<name>` |
| `GOOGLE_PUBSUB_PULL_KEY` | The service account JSON key, pasted as-is or base64-encoded |
| `GOOGLE_PUBSUB_VERIFICATION_TOKEN` | Any long random value. The fetcher sends it to the app, which rejects requests without it. |
| `GOOGLE_PUBSUB_PULL_HEARTBEAT_URL` | Optional. A URL fetched after every round in which Google answered and the app accepted everything handed to it, for a dead-man's-switch monitor. |

Without the first two settings the fetcher is off and the app starts as before.

## Checking it works

Container logs show `[pull] fetching Gmail notifications (outbound only)` about
a minute after start, then `[pull] delivered N notification(s)` as mail arrives.
`app unreachable` lines right after a start only mean the app was still starting;
Google redelivers those.

- Repeated `[pull] Pub/Sub pull returned HTTP 401/403/404; retrying` lines mean
  Google is refusing the key, or the subscription name or its permission is wrong.
- `[pull] cannot start: ...` followed by `fetcher is off until its settings are
  corrected` means a setting is malformed. The fetcher stays off (it does not
  retry) until the settings are fixed and the app is redeployed.

## Tests

    node --test bos/pull.test.mjs bos/redis-http.test.mjs

## Upgrading

The `Dockerfile` follows the upstream `latest` image. The fetcher depends on
the request shape `/api/google/webhook` accepts (a `token` query value and
`message.data`); re-run a real notification through after an upstream upgrade.
