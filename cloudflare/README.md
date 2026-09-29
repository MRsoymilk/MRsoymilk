# Cloudflare profile updater

This Worker replaces GitHub Actions for the profile README updater.

## Deploy

```bash
cd cloudflare
npm install
npx wrangler login
npx wrangler secret put GITHUB_TOKEN
npm run deploy
```

Use a GitHub fine-grained personal access token restricted to the `MRsoymilk/MRsoymilk` repository with **Contents: Read and write** permission.

The Cron Trigger runs at `17 0 * * *` (00:17 UTC) every day.

## Test locally

```bash
npm run dev
```

The HTTP endpoint is only a health response. Profile updates are performed by the scheduled handler.

For a local scheduled-event test:

```bash
npx wrangler dev --test-scheduled
```

Then request the scheduled endpoint printed by Wrangler.
