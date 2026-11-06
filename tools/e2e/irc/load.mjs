#!/usr/bin/env node
/**
 * Optional load check for the SRP v1 IRC server.
 *
 * It connects N real WebSocket clients with N real JWTs, then has S of them send
 * M DIRECT messages each to other connected clients, and reports what was
 * actually measured: connect-to-READY time, end-to-end delivery latency
 * (send -> recipient frame), error frames, and throughput.
 *
 * Managed mode (default) boots the disposable stack from stack.mjs and mints one
 * identity per client. External mode takes tokens from a JSON file:
 *
 *   node tools/e2e/irc/load.mjs                       # 100 clients, 10 senders x 10 msgs
 *   node tools/e2e/irc/load.mjs --clients 200 --messages 5
 *   node tools/e2e/irc/load.mjs --external --tokens-file tools/e2e/irc/.tokens.json \
 *        --url ws://127.0.0.1:3001/v1/connect
 *
 * Numbers are printed only when they were measured; a run that cannot connect
 * its clients exits non-zero instead of reporting a fake result.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { startManagedStack } from './stack.mjs';
import { SrpClient, loadWebSocket } from './ws-client.mjs';

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const option = (name, fallback) => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
};

const CLIENTS = Number(option('clients', process.env.E2E_IRC_LOAD_CLIENTS ?? 100));
const MESSAGES = Number(option('messages', process.env.E2E_IRC_LOAD_MESSAGES ?? 10));
const SENDERS = Math.min(
  Number(option('senders', process.env.E2E_IRC_LOAD_SENDERS ?? Math.max(1, Math.floor(CLIENTS / 10)))),
  CLIENTS,
);
const WS_URL = option('url', process.env.IRC_TEST_WS_URL ?? 'ws://127.0.0.1:3001/v1/connect');
const EXTERNAL = flag('external');
const TOKENS_FILE = option('tokens-file', process.env.IRC_TEST_TOKENS_FILE ?? '');
const DELIVERY_TIMEOUT_MS = Number(option('timeout', 20_000));

const percentile = (sorted, fraction) => {
  if (sorted.length === 0) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
  return sorted[index];
};

const stats = (values) => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return {
    count: sorted.length,
    min: sorted[0],
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    max: sorted[sorted.length - 1],
  };
};

const ms = (value) => (value === null || value === undefined ? 'n/a' : `${value.toFixed(1)}ms`);

function printStats(label, values) {
  const summary = stats(values);
  if (!summary) {
    console.log(`${label}: not measured (0 samples)`);
    return;
  }
  console.log(
    `${label}: n=${summary.count} min=${ms(summary.min)} p50=${ms(summary.p50)} p95=${ms(summary.p95)} max=${ms(summary.max)}`,
  );
}

async function main() {
  const ws = await loadWebSocket();
  console.log(`SRP v1 IRC load check — mode=${EXTERNAL ? 'external' : 'managed'}, client=${ws.source}`);
  console.log(`target: ${CLIENTS} clients, ${SENDERS} senders x ${MESSAGES} DIRECT messages`);

  let stack = null;
  const clients = [];
  const errors = new Map();
  const ackFailures = new Map();

  try {
    let tokens;
    let url = WS_URL;

    if (EXTERNAL) {
      if (!TOKENS_FILE) throw new Error('--external requires --tokens-file <json array of access tokens>');
      const parsed = JSON.parse(readFileSync(path.resolve(TOKENS_FILE), 'utf8'));
      tokens = Array.isArray(parsed) ? parsed : parsed.tokens;
      if (!Array.isArray(tokens) || tokens.length === 0) throw new Error(`${TOKENS_FILE} does not contain a token array`);
      if (tokens.length < CLIENTS) {
        console.log(`note: only ${tokens.length} tokens for ${CLIENTS} clients; extra clients are skipped`);
      }
    } else {
      stack = await startManagedStack({ log: () => {} });
      url = stack.ircWsUrl;
      console.log(`stack: ${stack.infos.irc} (mongo db ${stack.mongoDb})`);
      console.log(`minting ${CLIENTS} identities through the Minecraft handshake...`);
      tokens = [];
      for (let offset = 0; offset < CLIENTS; offset += 10) {
        const batch = [];
        for (let index = offset; index < Math.min(offset + 10, CLIENTS); index += 1) {
          batch.push(stack.mint({ username: `Load${index}` }));
        }
        const minted = await Promise.all(batch);
        tokens.push(...minted.map((session) => session.accessToken));
      }
    }

    const target = Math.min(CLIENTS, tokens.length);
    console.log(`\n== connect phase ==`);
    const connectStart = Date.now();
    const connectTimes = [];
    const connectFailures = [];

    for (let offset = 0; offset < target; offset += 20) {
      const batch = [];
      for (let index = offset; index < Math.min(offset + 20, target); index += 1) {
        const startedAt = Date.now();
        batch.push(
          SrpClient.connect({
            url,
            token: tokens[index],
            WebSocketImpl: ws.C,
            label: `load-${index}`,
            timeoutMs: 15_000,
            // A unique forwarded address per client: the server enforces a per-IP
            // connection budget and the harness runs on one host.
            headers: { 'x-forwarded-for': `10.${Math.floor(index / 250)}.${index % 250}.7` },
          }).then(async (client) => {
            client.ready = await client.waitForOp('READY', {}, { timeoutMs: 15_000, describe: 'READY' });
            connectTimes.push(Date.now() - startedAt);
            clients.push(client);
            return client;
          }),
        );
      }
      const settled = await Promise.allSettled(batch);
      for (const result of settled) {
        if (result.status === 'rejected') connectFailures.push(String(result.reason?.message ?? result.reason));
      }
    }

    console.log(`connected: ${clients.length}/${target} in ${Date.now() - connectStart}ms`);
    if (connectFailures.length > 0) {
      console.log(`connect failures: ${connectFailures.length} (first: ${connectFailures[0]})`);
    }
    printStats('connect -> READY', connectTimes);

    if (clients.length < 2) {
      throw new Error(`only ${clients.length} clients connected; the fan-out measurement needs at least 2`);
    }

    console.log(`\n== fan-out phase ==`);
    const pending = new Map(); // messageId -> { sentAt, from }
    const latencies = [];
    let delivered = 0;

    for (const client of clients) {
      client.onFrame = (frame) => {
        if (frame?.op === 'ERROR') {
          const code = frame.payload?.code ?? 'UNKNOWN';
          errors.set(code, (errors.get(code) ?? 0) + 1);
        }
        if (frame?.op === 'ACK' && frame.payload?.status === 'failed') {
          const reason = frame.payload?.reason ?? 'UNKNOWN';
          ackFailures.set(reason, (ackFailures.get(reason) ?? 0) + 1);
        }
        if (frame?.op === 'MESSAGE') {
          const entry = pending.get(frame.id);
          if (entry) {
            pending.delete(frame.id);
            delivered += 1;
            latencies.push(Date.now() - entry.sentAt);
          }
        }
      };
    }

    const sendStart = Date.now();
    let sent = 0;
    const senderCount = Math.min(SENDERS, clients.length - 1);
    for (let senderIndex = 0; senderIndex < senderCount; senderIndex += 1) {
      const sender = clients[senderIndex];
      for (let messageIndex = 0; messageIndex < MESSAGES; messageIndex += 1) {
        // Round-robin over every other client so the fan-out is spread, not one hotspot.
        let recipientIndex = (senderIndex + 1 + messageIndex) % clients.length;
        if (recipientIndex === senderIndex) recipientIndex = (recipientIndex + 1) % clients.length;
        const recipient = clients[recipientIndex];
        const messageId = `load-${senderIndex}-${messageIndex}-${Date.now()}`;
        const recipientUuid = recipient.ready?.payload?.minecraftUuid;
        if (!recipientUuid) continue;
        pending.set(messageId, { sentAt: Date.now() });
        sender.send({
          v: 1,
          id: messageId,
          op: 'MESSAGE',
          type: 'load.chat.message',
          route: { mode: 'DIRECT', target: recipientUuid },
          payload: { senderIndex, messageIndex, padding: 'x'.repeat(64) },
        });
        sent += 1;
        // Stay under the per-connection token bucket (20/s, burst 40 by default).
        if (messageIndex % 10 === 9) await sleep(60);
      }
      await sleep(60);
    }
    const sendDuration = Date.now() - sendStart;

    const deadline = Date.now() + DELIVERY_TIMEOUT_MS;
    while (pending.size > 0 && Date.now() < deadline) await sleep(50);
    const fanoutDuration = Date.now() - sendStart;

    console.log(`sent: ${sent}, delivered: ${delivered}, undelivered: ${pending.size}`);
    printStats('delivery latency (send -> recipient frame)', latencies);
    console.log(
      `throughput: ${sent} messages in ${sendDuration}ms (${((sent / Math.max(sendDuration, 1)) * 1000).toFixed(1)} msg/s), ` +
        `fan-out completed in ${fanoutDuration}ms`,
    );

    const errorSummary = [...errors.entries()].map(([code, count]) => `${code}=${count}`).join(', ') || 'none';
    const ackSummary = [...ackFailures.entries()].map(([reason, count]) => `${reason}=${count}`).join(', ') || 'none';
    console.log(`error frames: ${errorSummary}`);
    console.log(`ACK failed: ${ackSummary}`);

    const ok = clients.length === target && delivered === sent && sent > 0;
    console.log(
      `\nRESULT: ${ok ? 'PASS' : 'FAIL'} — ${clients.length}/${target} clients, ${delivered}/${sent} messages delivered`,
    );
    process.exitCode = ok ? 0 : 1;
  } finally {
    for (const client of clients) await client.close().catch(() => {});
    if (stack) await stack.close().catch(() => {});
  }
}

main().catch((error) => {
  console.error(`\n[fatal] ${error?.stack ?? error?.message ?? error}`);
  console.error('No numbers were measured; refusing to report a result.');
  process.exitCode = 2;
});
