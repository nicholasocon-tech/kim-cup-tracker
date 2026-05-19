# Kim Cup Picks API (Cloudflare Worker)

Tiny serverless backend for collecting Kim Cup picks. The React tracker on
GitHub Pages POSTs submissions here; this Worker validates them, holds them
privately in KV during the submission window, then commits them all to
`src/data/<major>-2026.json` in the kim-cup-tracker repo at lock time.

## Architecture

```
PicksView (React, GH Pages)
    │ POST /api/picks
    ▼
Worker (this code)
    │ validate name+email, write to KV
    ▼
Cloudflare KV (KIMCUP_PICKS namespace) — private until lock time
    │
    │ cron fires at lockAt (or POST /api/admin/lock)
    ▼
Worker.scheduled handler
    │ read all KV entries → merge into existing JSON file
    │ commit via GitHub Contents API
    ▼
kim-cup-tracker repo → GH Actions → Pages auto-deploy
```

## First-time setup

You'll need a Cloudflare account (free signup at https://dash.cloudflare.com)
and a GitHub fine-grained PAT.

### 1. Install + login

```sh
cd worker
npm install
npx wrangler login
```

Browser opens for Cloudflare OAuth.

### 2. Create the KV namespace

```sh
npx wrangler kv namespace create KIMCUP_PICKS
```

Copy the returned `id` value into `wrangler.toml` (replace `REPLACE_AFTER_KV_CREATE`).

### 3. Create a GitHub PAT for the Worker

1. Go to https://github.com/settings/tokens?type=beta → **Generate new token**
   (use fine-grained, not classic — smaller blast radius)
2. **Repository access**: only `nicholasocon-tech/kim-cup-tracker`
3. **Repository permissions**: `Contents: Read and write`
4. **Expiration**: 1 year (max for fine-grained)
5. Generate, copy the token (`github_pat_...`)

### 4. Set Worker secrets

```sh
npx wrangler secret put GITHUB_TOKEN
# paste the PAT when prompted

npx wrangler secret put PARTICIPANTS
# paste the entire JSON contents of src/data/participants-2026.json
# (on one line, or use heredoc)

npx wrangler secret put ADMIN_SECRET
# paste a random opaque string (used for the manual lock fallback endpoint)
# generate one with: openssl rand -hex 32
```

### 5. Deploy

```sh
npx wrangler deploy
```

Worker URL is printed at the end (e.g. `https://kim-cup-picks-api.<your-cloudflare-subdomain>.workers.dev`).

### 6. Wire the URL into the front-end

Edit `src/data/lock-config.json` → update `apiBaseUrl` to the Worker URL from
step 5. Commit and push.

## Per-major workflow

Each major (U.S. Open, The Open, etc.), you'll need to:

1. **Update `worker/wrangler.toml`**:
   - `CURRENT_MAJOR` → e.g. `"The Open"`
   - `PICKS_FILE_PATH` → e.g. `"src/data/theopen-2026.json"`
   - `LOCK_AT` → ISO timestamp of first tee
   - `crons` → matching cron expression (UTC)
2. **Redeploy**: `npx wrangler deploy`
3. **Update the front-end** in parallel:
   - `src/data/lock-config.json` → matching `currentMajor`, `currentMajorFile`, `tiersFile`, `lockAt`
   - Create `src/data/<major>-2026.json` skeleton (24 names, empty picks)
   - Build and commit `src/data/<major>-2026-tiers.json` from the commissioners' tier sheet:
     ```sh
     node scripts/build-tiers.mjs \
       --in '/path/to/CommissionersTiers.csv' \
       --out src/data/<major>-2026-tiers.json \
       --tournament "The Open"
     ```

## Endpoints

All accept CORS preflight from the GH Pages origin + localhost dev.

### `POST /api/picks`
Submit or update picks. Body:
```json
{ "major": "U.S. Open", "name": "Nick O'Connor",
  "email": "nicholas.ocon@gmail.com",
  "picks": [{"player": "Scottie Scheffler", "tier": 1}, ...] }
```
Validates: name in participants, email matches, exactly 2 picks per tier.
Returns `{submittedAt, lockAt}` on success. 423 if past lock.

### `GET /api/picks?major=...&name=...&email=...`
Read own submission. Email must match participant record. Returns
`{picks, submittedAt}` or 404 if nothing submitted yet.

### `GET /api/lock-status?major=...`
Public. Returns `{locked, lockAt, major}`.

### `POST /api/admin/lock`
Header: `Authorization: Bearer <ADMIN_SECRET>`. Manually runs the
lock-and-commit flow (fallback if cron misses). Returns commit summary.

## Local development

```sh
cd worker
npx wrangler dev          # worker on localhost:8787
```

Run the tracker side in another shell with `VITE_API_BASE` env var pointed
at localhost (or just edit `lock-config.json#apiBaseUrl` locally — don't
commit that change).

For local KV: `wrangler dev` uses an in-memory KV by default. To inspect:
`wrangler kv key list --namespace-id <id>`.

## Operations

### Inspect submissions
```sh
npx wrangler kv key list --binding KIMCUP_PICKS
npx wrangler kv key get --binding KIMCUP_PICKS '<key>'
```

### Manually trigger lock (if cron misses)
```sh
curl -X POST https://<worker-url>/api/admin/lock \
  -H "Authorization: Bearer <ADMIN_SECRET>"
```

### View live logs
```sh
npx wrangler tail
```

### Rotate the GitHub PAT before it expires
```sh
npx wrangler secret put GITHUB_TOKEN
# paste the new PAT
```

## Costs

Cloudflare free tier (as of 2026):
- 100,000 Worker requests/day
- 1,000 KV writes/day (we do ~24 per major × 4 majors = 96/year)
- Scheduled triggers included

Expected usage: well under 1% of free tier. Cost: $0.
