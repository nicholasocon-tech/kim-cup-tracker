// Kim Cup picks API
//
// Routes:
//   POST /api/picks          submit or update picks (auth: name + email match)
//   GET  /api/picks          read own picks (auth: name + email match)
//   GET  /api/lock-status    public — is the current major locked?
//   POST /api/admin/lock     protected by ADMIN_SECRET — manually run the
//                            lock-and-commit flow (fallback if cron misses)
//
// Scheduled (cron set in wrangler.toml):
//   runs at lockAt time, reads all KV entries for the configured major,
//   commits the merged JSON file back to the kim-cup-tracker repo via the
//   GitHub Contents API. GitHub Actions auto-deploys.
//
// Secrets (set via `wrangler secret put`):
//   GITHUB_TOKEN     fine-grained PAT, contents:write scope, repo: nicholasocon-tech/kim-cup-tracker
//   PARTICIPANTS     JSON string matching src/data/participants-2026.json
//   ADMIN_SECRET     opaque string for the manual lock endpoint
//   GITHUB_OWNER     "nicholasocon-tech"
//   GITHUB_REPO      "kim-cup-tracker"
//
// Vars (set in wrangler.toml):
//   CURRENT_MAJOR    e.g. "U.S. Open"
//   PICKS_FILE_PATH  e.g. "src/data/usopen-2026.json"
//   LOCK_AT          ISO-8601 e.g. "2026-06-11T10:30:00Z"

const ALLOWED_ORIGINS = [
  'https://nicholasocon-tech.github.io',
  'http://localhost:5173',
  'http://localhost:4173',
]

function corsHeaders(request) {
  const origin = request.headers.get('Origin') ?? ''
  const allowOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0]
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
  }
}

function json(data, status, request) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(request) },
  })
}

function normalizeName(name) {
  return name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function parseParticipants(env) {
  return JSON.parse(env.PARTICIPANTS).members
}

function findParticipant(participants, name) {
  return participants.find((p) => p.name === name)
}

function emailMatches(participant, email) {
  if (!participant || !email) return false
  return participant.email.trim().toLowerCase() === email.trim().toLowerCase()
}

function kvKey(major, name) {
  return `${major}:${normalizeName(name)}`
}

function isLocked(env) {
  return Date.now() >= new Date(env.LOCK_AT).getTime()
}

// ───────── Endpoint handlers ─────────

async function handleSubmit(request, env) {
  if (isLocked(env)) {
    return json({ error: 'picks locked for this major' }, 423, request)
  }

  let body
  try {
    body = await request.json()
  } catch {
    return json({ error: 'invalid JSON body' }, 400, request)
  }

  const { major, name, email, picks } = body ?? {}
  if (!major || !name || !email || !Array.isArray(picks)) {
    return json({ error: 'missing fields' }, 400, request)
  }
  // Bound work before the validation loop — a valid entry is exactly 8 picks.
  if (picks.length > 8) {
    return json({ error: 'too many picks (expected 8)' }, 400, request)
  }
  if (major !== env.CURRENT_MAJOR) {
    return json({ error: `submissions only accepted for ${env.CURRENT_MAJOR}` }, 400, request)
  }

  const participant = findParticipant(parseParticipants(env), name)
  if (!participant) {
    return json({ error: 'unknown participant' }, 403, request)
  }
  if (!emailMatches(participant, email)) {
    return json({ error: 'email does not match our records' }, 403, request)
  }

  // Tier shape: exactly 2 per tier, 8 total
  const byTier = { 1: 0, 2: 0, 3: 0, 4: 0 }
  for (const p of picks) {
    if (!p || typeof p.player !== 'string' || ![1, 2, 3, 4].includes(p.tier)) {
      return json({ error: 'invalid pick shape' }, 400, request)
    }
    byTier[p.tier]++
  }
  for (const t of [1, 2, 3, 4]) {
    if (byTier[t] !== 2) {
      return json({ error: `tier ${t} must have exactly 2 picks` }, 400, request)
    }
  }

  // No duplicate golfers across tiers — a repeated pick would double-count in
  // the best-5 scoring. The UI prevents this; this guards direct API calls.
  const playerKeys = picks.map((p) => normalizeName(p.player))
  if (new Set(playerKeys).size !== playerKeys.length) {
    return json({ error: 'each golfer can only be picked once' }, 400, request)
  }

  const submittedAt = new Date().toISOString()
  const record = { name, email: participant.email, picks, submittedAt }
  await env.KIMCUP_PICKS.put(kvKey(major, name), JSON.stringify(record))

  return json({ submittedAt, lockAt: env.LOCK_AT }, 200, request)
}

async function handleRead(request, env) {
  const url = new URL(request.url)
  const major = url.searchParams.get('major')
  const name = url.searchParams.get('name')
  const email = url.searchParams.get('email')

  if (!major || !name || !email) {
    return json({ error: 'missing query params' }, 400, request)
  }

  const participant = findParticipant(parseParticipants(env), name)
  if (!emailMatches(participant, email)) {
    return json({ error: 'email does not match our records' }, 403, request)
  }

  const raw = await env.KIMCUP_PICKS.get(kvKey(major, name))
  if (!raw) return json({ error: 'no submission found' }, 404, request)

  const record = JSON.parse(raw)
  return json({ picks: record.picks, submittedAt: record.submittedAt }, 200, request)
}

function handleLockStatus(request, env) {
  return json(
    { locked: isLocked(env), lockAt: env.LOCK_AT, major: env.CURRENT_MAJOR },
    200,
    request
  )
}

async function handleAdminLock(request, env) {
  const auth = request.headers.get('Authorization') ?? ''
  const expected = `Bearer ${env.ADMIN_SECRET}`
  if (auth !== expected) return json({ error: 'unauthorized' }, 401, request)

  try {
    const result = await performLock(env)
    return json({ ok: true, ...result }, 200, request)
  } catch (e) {
    return json({ error: e.message }, 500, request)
  }
}

// ───────── Lock-and-commit flow ─────────

async function ghApi(env, method, path, body) {
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      'Authorization': `Bearer ${env.GITHUB_TOKEN}`,
      'Accept': 'application/vnd.github+json',
      'User-Agent': 'kim-cup-picks-api',
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  if (!res.ok) {
    throw new Error(`GitHub ${method} ${path} → ${res.status}: ${text.slice(0, 200)}`)
  }
  return text ? JSON.parse(text) : null
}

async function performLock(env) {
  const major = env.CURRENT_MAJOR
  const participants = parseParticipants(env)

  // Collect all submissions for this major from KV
  const submissions = new Map()
  let cursor = undefined
  do {
    const list = await env.KIMCUP_PICKS.list({ prefix: `${major}:`, cursor })
    for (const { name: key } of list.keys) {
      const raw = await env.KIMCUP_PICKS.get(key)
      if (raw) {
        const record = JSON.parse(raw)
        submissions.set(normalizeName(record.name), record)
      }
    }
    cursor = list.list_complete ? undefined : list.cursor
  } while (cursor)

  // Read the existing file from GitHub to preserve metadata (tournament/year/dates/course)
  const filePath = env.PICKS_FILE_PATH
  const fileResp = await ghApi(
    env,
    'GET',
    `/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/contents/${encodeURIComponent(filePath)}?ref=main`
  )
  const currentContent = JSON.parse(atob(fileResp.content.replace(/\n/g, '')))

  // Rebuild participants array in the existing canonical order, merging in submissions
  const newParticipants = currentContent.participants.map((p) => {
    const sub = submissions.get(normalizeName(p.name))
    return { name: p.name, picks: sub ? sub.picks : [] }
  })
  const newContent = { ...currentContent, participants: newParticipants }
  const encoded = btoa(unescape(encodeURIComponent(JSON.stringify(newContent, null, 2) + '\n')))

  await ghApi(
    env,
    'PUT',
    `/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/contents/${encodeURIComponent(filePath)}`,
    {
      message: `Lock ${major} 2026 picks (auto)`,
      content: encoded,
      sha: fileResp.sha,
      branch: 'main',
    }
  )

  return {
    major,
    submittedCount: submissions.size,
    totalParticipants: newParticipants.length,
    commitPath: filePath,
  }
}

// ───────── Router ─────────

async function handleRequest(request, env) {
  const url = new URL(request.url)

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders(request) })
  }

  if (url.pathname === '/api/picks' && request.method === 'POST') {
    return handleSubmit(request, env)
  }
  if (url.pathname === '/api/picks' && request.method === 'GET') {
    return handleRead(request, env)
  }
  if (url.pathname === '/api/lock-status' && request.method === 'GET') {
    return handleLockStatus(request, env)
  }
  if (url.pathname === '/api/admin/lock' && request.method === 'POST') {
    return handleAdminLock(request, env)
  }

  return json({ error: 'not found' }, 404, request)
}

export default {
  async fetch(request, env) {
    try {
      return await handleRequest(request, env)
    } catch (e) {
      return json({ error: e.message }, 500, request)
    }
  },
  async scheduled(_event, env) {
    if (!isLocked(env)) {
      // Cron fired before lock time — skip
      console.log('scheduled fired before lockAt, skipping')
      return
    }
    try {
      const result = await performLock(env)
      console.log('lock complete:', JSON.stringify(result))
    } catch (e) {
      console.error('scheduled lock failed:', e.message)
    }
  },
}
