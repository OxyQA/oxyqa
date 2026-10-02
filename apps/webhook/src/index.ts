import { serve } from "@hono/node-server";
import { createPrQueue, createRedisConnection, getConfig, jobName } from "@oxyqa/core";
import { App } from "octokit";
import { createWebhookApp } from "./app.js";

const config = getConfig();
const githubApp = new App({ appId: config.github.appId, privateKey: config.github.privateKey });
const { data: identity } = await githubApp.octokit.rest.apps.getAuthenticated();
if (!identity?.slug) throw new Error("GitHub App slug is missing");
const redis = createRedisConnection(config.redisUrl);
const queue = createPrQueue(redis);
const app = createWebhookApp({
  secret: config.github.webhookSecret,
  slug: identity.slug,
  ping: () => redis.ping(),
  enqueue: (job, jobId) => queue.add(jobName(job), job, { jobId }),
});
const server = serve({ fetch: app.fetch, port: config.webhookPort }, (info) => {
  console.log(`[oxyqa-webhook] listening on :${info.port}`);
});
async function shutdown(signal: string) {
  console.log(`[oxyqa-webhook] ${signal} — shutting down`);
  await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
  await queue.close();
  redis.disconnect();
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
