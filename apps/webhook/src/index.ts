// @oxyqa/webhook — ingress service (Hono + Octokit).
//
// Phase 1 responsibility (fast path, do almost nothing inline):
//   1. verify GitHub webhook signature
//   2. dedup by PR head SHA
//   3. enqueue a job onto BullMQ
//   4. return 200 in <1s (GitHub times out at ~10s)
//
// Nothing implemented yet — Phase 0 skeleton.
export {};
