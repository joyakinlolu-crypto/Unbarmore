import { Queue, type ConnectionOptions } from 'bullmq';
import { env } from '../config/env.js';

const url = new URL(env.REDIS_URL);
export const redisConnection: ConnectionOptions = {
  host: url.hostname,
  port: Number(url.port || 6379),
  username: url.username || undefined,
  password: url.password ? decodeURIComponent(url.password) : undefined,
  tls: url.protocol === 'rediss:' ? {} : undefined,
  maxRetriesPerRequest: null, // required by BullMQ workers
};

export const QUEUE = {
  inbound: 'inbound-messages',
  imageBatch: 'image-batches',
  video: 'video-render',
  cron: 'cron',
} as const;

const defaults = {
  attempts: 3,
  backoff: { type: 'exponential' as const, delay: 2000 },
  removeOnComplete: { age: 3600, count: 1000 },
  removeOnFail: { age: 7 * 86400 },
};

export const inboundQueue = new Queue(QUEUE.inbound, { connection: redisConnection, defaultJobOptions: defaults });
export const imageBatchQueue = new Queue(QUEUE.imageBatch, { connection: redisConnection, defaultJobOptions: defaults });
export const videoQueue = new Queue(QUEUE.video, {
  connection: redisConnection,
  defaultJobOptions: { ...defaults, attempts: 2, backoff: { type: 'fixed', delay: 15000 } },
});
export const cronQueue = new Queue(QUEUE.cron, { connection: redisConnection, defaultJobOptions: { ...defaults, attempts: 1 } });

export interface VideoJob {
  videoId: string;
  businessId: string;
  phone: string;
}
