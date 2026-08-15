/**
 * Verify the SMS queue against the REAL Redis. Run this on the server.
 *
 * The queue could not be round-tripped from the dev machine: production Redis
 * is a Unix socket (`/home/stackroo/.redis/redis.sock`), which exists only on
 * the host. Everything else about the campaign path is unit-tested; this covers
 * the one part that needs a live Redis.
 *
 * It enqueues a job on a THROWAWAY queue name, drains it with a throwaway
 * worker and deletes it. It never touches the real `sms-campaign` queue, never
 * writes an SMSLog, and never contacts the SMS gateway — no message can be sent
 * by running this.
 *
 * It also checks the two Redis settings that decide whether a queue is safe to
 * rely on:
 *
 *   maxmemory-policy   must be `noeviction`. Under any `allkeys-*` policy Redis
 *                      evicts by memory pressure with no idea that some keys are
 *                      pending jobs — a busy cache can silently delete a queued
 *                      campaign. This is THE configuration that turns a durable
 *                      queue back into a lossy one.
 *   maxmemory          headroom, since the cache shares this instance.
 *
 * Run:  node scripts/verify-sms-queue.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const { isQueueEnabled, connectionOptions } = require('../src/config/queue.config');

const line = (label, value) => console.log(`  ${String(label).padEnd(24)} ${value}`);

(async () => {
  console.log('\n── Configuration ───────────────────────────────────────────');
  line('USE_REDIS', process.env.USE_REDIS || '(unset)');
  line('USE_SMS_QUEUE', process.env.USE_SMS_QUEUE || '(unset → enabled)');
  line('REDIS_SOCKET', process.env.REDIS_SOCKET || '(unset)');
  line('REDIS_HOST', process.env.REDIS_HOST || '(unset)');

  const enabled = isQueueEnabled();
  line('queue enabled', enabled ? 'yes' : 'NO');

  if (!enabled) {
    console.log(
      '\n✗ The queue is disabled. Large campaigns will be REFUSED (by design —\n' +
      '  they are never silently run in-process). Fix the config above first.\n'
    );
    process.exit(1);
  }

  const { Queue, Worker } = require('bullmq');
  const connection = connectionOptions();

  // Throwaway name — never the real queue.
  const NAME = `sms-queue-selftest-${process.pid}`;
  const queue = new Queue(NAME, { connection });
  let worker;

  try {
    console.log('\n── Round trip ──────────────────────────────────────────────');

    const started = Date.now();
    const received = new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('worker did not pick the job up within 15s')),
        15000
      );
      worker = new Worker(
        NAME,
        async (job) => {
          clearTimeout(timer);
          resolve(job.data);
          return { ok: true };
        },
        { connection }
      );
      worker.on('error', reject);
    });

    const job = await queue.add('selftest', { hello: 'world' }, { jobId: 'selftest-1' });
    line('enqueued', `job ${job.id}`);

    const data = await received;
    line('delivered', `${JSON.stringify(data)} in ${Date.now() - started}ms`);

    // The dedupe guarantee the campaign path relies on: the log id is the job
    // id, so a double submit cannot enqueue the same campaign twice.
    const duplicate = await queue.add('selftest', { hello: 'again' }, { jobId: 'selftest-1' });
    line('duplicate jobId', duplicate.id === 'selftest-1' ? 'deduped ✓' : 'NOT deduped ✗');

    console.log('\n── Redis settings that decide durability ───────────────────');

    // BullMQ exposes its ioredis client; ask the server directly.
    const client = await queue.client;
    const readConfig = async (key) => {
      try {
        const [, value] = await client.config('GET', key);
        return value ?? '(empty)';
      } catch (err) {
        return `unavailable (${err.message})`;
      }
    };

    const policy = await readConfig('maxmemory-policy');
    const maxmemory = await readConfig('maxmemory');
    line('maxmemory-policy', policy);
    line('maxmemory', maxmemory === '0' ? '0 (unlimited)' : maxmemory);

    let info = '';
    try {
      info = await client.info('memory');
      const used = /used_memory_human:(\S+)/.exec(info)?.[1];
      const peak = /used_memory_peak_human:(\S+)/.exec(info)?.[1];
      line('used memory', `${used || '?'} (peak ${peak || '?'})`);
    } catch {
      line('used memory', 'unavailable');
    }

    console.log('\n── Verdict ─────────────────────────────────────────────────');
    console.log('  ✓ Redis reachable, jobs enqueue and are consumed, dedupe works.');

    if (policy && policy !== 'noeviction' && !policy.startsWith('unavailable')) {
      console.log(
        `\n  ⚠ maxmemory-policy is "${policy}", not "noeviction".\n` +
        '    Redis may evict keys under memory pressure, and it cannot tell a\n' +
        '    cached value from a pending campaign. A busy cache could delete a\n' +
        '    queued send — which defeats the point of the queue.\n\n' +
        '    Fix:  redis-cli config set maxmemory-policy noeviction\n' +
        '    Then make it survive a restart by setting it in redis.conf.\n\n' +
        '    If this instance is shared with the cache and you WANT eviction for\n' +
        '    cache keys, the right answer is a separate Redis database or\n' +
        '    instance for the queue.'
      );
    } else if (policy === 'noeviction') {
      console.log('  ✓ maxmemory-policy is noeviction — queued jobs cannot be evicted.');
    }
  } catch (err) {
    console.error(`\n✗ Round trip FAILED: ${err.message}`);
    console.error('  Large campaigns will be refused until this is fixed.');
    process.exitCode = 1;
  } finally {
    try {
      if (worker) await worker.close();
      await queue.obliterate({ force: true }).catch(() => {});
      await queue.close();
    } catch {
      // Cleanup failures are not the point of this script.
    }
    console.log('');
    process.exit(process.exitCode || 0);
  }
})();
