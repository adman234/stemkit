# StemKit telemetry worker

Anonymous usage counter for StemKit. The app POSTs one tiny heartbeat per
install per day (random install id + version/os/arch, no PII) to `/ping`;
`/stats` returns aggregated counts.

## Deploy

Requires [Wrangler](https://developers.cloudflare.com/workers/wrangler/) and a
Cloudflare account (free).

```sh
cd telemetry-worker

# create the KV namespace and copy its id into wrangler.toml
wrangler kv namespace create DB

# pick a random token for the /stats endpoint
# (or use: wrangler secret put STATS_TOKEN)
# edit wrangler.toml [vars] STATS_TOKEN, then:

wrangler deploy
```

## Point the app at it

The app defaults to `https://stemkit-stats.danielravina.workers.dev/ping` in
`src/main/telemetry.ts`. After deploying, replace that host with your worker's
URL (wrangler prints it, or check the Cloudflare dashboard). The subdomain is
`stemkit-stats.<your-account-subdomain>.workers.dev`.

## View stats

```sh
curl -H "Authorization: Bearer <token>" \
  https://stemkit-stats.<account>.workers.dev/stats
```

Returns total unique installs, installs per platform/version, and a 30-day
daily breakdown (active = unique installs that pinged that day, new = first
pings).