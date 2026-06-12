// Kim Cup picks API
//
// Auth model (magic code):
//   Submitting/reading picks requires a bearer token. To get one, a participant
//   requests a 6-digit code, which is emailed to their on-file roster address;
//   verifying the code issues a short-lived HMAC-signed token. This proves the
//   person controls the roster email — the old name+email check trusted an
//   unverified, group-known email.
//
// Routes:
//   POST /api/auth/request   { name, email } → emails a one-time code
//   POST /api/auth/verify    { name, email, code } → { token, expiresAt }
//   POST /api/picks          submit/update picks (auth: Bearer token)
//   GET  /api/picks          read own picks    (auth: Bearer token)
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
//   AUTH_SECRET      random 32+ char string — HMAC key for session tokens
//   SENDGRID_API_KEY SendGrid key with Mail Send permission
//
// Vars (set in wrangler.toml):
//   CURRENT_MAJOR    e.g. "U.S. Open"
//   PICKS_FILE_PATH  e.g. "src/data/usopen-2026.json"
//   LOCK_AT          ISO-8601 e.g. "2026-06-18T10:30:00Z"
//   GITHUB_OWNER     "nicholasocon-tech"
//   GITHUB_REPO      "kim-cup-tracker"
//   MAIL_FROM        verified SendGrid single-sender address

const ALLOWED_ORIGINS = [
  'https://kim-cup.com',
  'https://www.kim-cup.com',
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

// ───────── Auth: codes, tokens, email ─────────

const CODE_TTL_MS = 10 * 60 * 1000   // a code is valid for 10 minutes
const MAX_VERIFY_ATTEMPTS = 5        // wrong-code guesses before a code dies
const MAX_CODE_REQUESTS = 5          // code requests per name per hour
const TOKEN_MAX_AGE_MS = 24 * 60 * 60 * 1000

const enc = new TextEncoder()

function b64urlFromBytes(bytes) {
  let s = ''
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function b64urlToBytes(str) {
  const b = atob(str.replace(/-/g, '+').replace(/_/g, '/'))
  const out = new Uint8Array(b.length)
  for (let i = 0; i < b.length; i++) out[i] = b.charCodeAt(i)
  return out
}

async function hmacKey(secret) {
  return crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']
  )
}

async function sha256hex(str) {
  const buf = await crypto.subtle.digest('SHA-256', enc.encode(str))
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

// Stateless session token: base64url(JSON payload) + "." + base64url(HMAC).
async function signToken(payload, secret) {
  const body = b64urlFromBytes(enc.encode(JSON.stringify(payload)))
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(body))
  return `${body}.${b64urlFromBytes(sig)}`
}

async function verifyToken(token, secret) {
  if (typeof token !== 'string' || !token.includes('.')) return null
  const [body, sig] = token.split('.')
  if (!body || !sig) return null
  let ok
  try {
    ok = await crypto.subtle.verify('HMAC', await hmacKey(secret), b64urlToBytes(sig), enc.encode(body))
  } catch {
    return null
  }
  if (!ok) return null
  let payload
  try {
    payload = JSON.parse(new TextDecoder().decode(b64urlToBytes(body)))
  } catch {
    return null
  }
  if (!payload.exp || Date.now() > payload.exp) return null
  return payload
}

// The authenticated participant name (normalized) for a request, or null.
async function authedSub(request, env) {
  const m = (request.headers.get('Authorization') ?? '').match(/^Bearer (.+)$/)
  if (!m) return null
  const payload = await verifyToken(m[1], env.AUTH_SECRET)
  return payload?.sub ?? null
}

function genCode() {
  const n = crypto.getRandomValues(new Uint32Array(1))[0] % 1000000
  return String(n).padStart(6, '0')
}

function maskEmail(email) {
  const [user, domain] = email.split('@')
  if (!domain) return '***'
  const head = user.slice(0, 1)
  return `${head}${'*'.repeat(Math.max(1, user.length - 1))}@${domain}`
}

async function sendCodeEmail(env, toEmail, toName, code) {
  const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.SENDGRID_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: toEmail, name: toName }] }],
      from: { email: env.MAIL_FROM, name: 'Kim Cup' },
      subject: `Your Kim Cup code: ${code}`,
      content: [{
        type: 'text/plain',
        value:
          `Your Kim Cup verification code is ${code}\n\n` +
          `It expires in 10 minutes. If you didn't request this, ignore this email.`,
      }],
    }),
  })
  if (!res.ok) {
    const t = await res.text()
    throw new Error(`SendGrid ${res.status}: ${t.slice(0, 200)}`)
  }
}

// ───────── Endpoint handlers ─────────

async function handleAuthRequest(request, env) {
  if (isLocked(env)) {
    return json({ error: 'picks locked for this major' }, 423, request)
  }
  let body
  try {
    body = await request.json()
  } catch {
    return json({ error: 'invalid JSON body' }, 400, request)
  }
  const { name, email } = body ?? {}
  if (!name || !email) return json({ error: 'missing fields' }, 400, request)

  const participant = findParticipant(parseParticipants(env), name)
  if (!emailMatches(participant, email)) {
    return json({ error: 'email does not match our records' }, 403, request)
  }

  // Rate-limit code requests per person (counter with a 1h TTL window).
  const norm = normalizeName(name)
  const rlKey = `otpreq:${norm}`
  const count = Number((await env.KIMCUP_PICKS.get(rlKey)) ?? 0)
  if (count >= MAX_CODE_REQUESTS) {
    return json({ error: 'too many code requests — try again later' }, 429, request)
  }
  await env.KIMCUP_PICKS.put(rlKey, String(count + 1), { expirationTtl: 3600 })

  const code = genCode()
  const codeHash = await sha256hex(`${norm}:${code}`)
  const exp = Date.now() + CODE_TTL_MS
  await env.KIMCUP_PICKS.put(
    `otp:${norm}`,
    JSON.stringify({ codeHash, exp, attempts: 0 }),
    { expirationTtl: Math.ceil(CODE_TTL_MS / 1000) }
  )
  await sendCodeEmail(env, participant.email, participant.name, code)

  return json({ ok: true, sentTo: maskEmail(participant.email) }, 200, request)
}

async function handleAuthVerify(request, env) {
  let body
  try {
    body = await request.json()
  } catch {
    return json({ error: 'invalid JSON body' }, 400, request)
  }
  const { name, email, code } = body ?? {}
  if (!name || !email || !code) return json({ error: 'missing fields' }, 400, request)

  const participant = findParticipant(parseParticipants(env), name)
  if (!emailMatches(participant, email)) {
    return json({ error: 'email does not match our records' }, 403, request)
  }

  const norm = normalizeName(name)
  const key = `otp:${norm}`
  const raw = await env.KIMCUP_PICKS.get(key)
  if (!raw) return json({ error: 'no code requested, or it expired' }, 400, request)
  const rec = JSON.parse(raw)

  if (Date.now() > rec.exp) {
    await env.KIMCUP_PICKS.delete(key)
    return json({ error: 'code expired — request a new one' }, 400, request)
  }
  if (rec.attempts >= MAX_VERIFY_ATTEMPTS) {
    await env.KIMCUP_PICKS.delete(key)
    return json({ error: 'too many attempts — request a new code' }, 429, request)
  }

  const codeHash = await sha256hex(`${norm}:${String(code).trim()}`)
  if (codeHash !== rec.codeHash) {
    const ttl = Math.max(1, Math.ceil((rec.exp - Date.now()) / 1000))
    await env.KIMCUP_PICKS.put(
      key, JSON.stringify({ ...rec, attempts: rec.attempts + 1 }), { expirationTtl: ttl }
    )
    return json({ error: 'incorrect code' }, 401, request)
  }

  await env.KIMCUP_PICKS.delete(key)
  // Token lives until lockAt or 24h, whichever is sooner — no point past lock.
  const exp = Math.min(new Date(env.LOCK_AT).getTime(), Date.now() + TOKEN_MAX_AGE_MS)
  const token = await signToken({ sub: norm, exp }, env.AUTH_SECRET)
  return json({ token, expiresAt: exp }, 200, request)
}

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

  const { major, name, picks } = body ?? {}
  if (!major || !name || !Array.isArray(picks)) {
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
  // Bearer token must be present and belong to this participant.
  const sub = await authedSub(request, env)
  if (sub !== normalizeName(name)) {
    return json({ error: 'not authenticated — request a code first' }, 401, request)
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

  if (!major || !name) {
    return json({ error: 'missing query params' }, 400, request)
  }

  // Bearer token must belong to the participant whose picks are requested.
  const sub = await authedSub(request, env)
  if (sub !== normalizeName(name)) {
    return json({ error: 'not authenticated — request a code first' }, 401, request)
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

// UTF-8-safe base64 ⇄ string (GitHub Contents API content is base64 of UTF-8
// bytes; player names like "Ludvig Åberg" are multi-byte, so plain atob/btoa
// would mangle them).
function utf8ToBase64(str) {
  const bytes = new TextEncoder().encode(str)
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin)
}

function base64ToUtf8(b64) {
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return new TextDecoder().decode(bytes)
}

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
  const currentContent = JSON.parse(base64ToUtf8(fileResp.content.replace(/\n/g, '')))

  // Rebuild participants array in the existing canonical order, merging in submissions
  const newParticipants = currentContent.participants.map((p) => {
    const sub = submissions.get(normalizeName(p.name))
    return { name: p.name, picks: sub ? sub.picks : [] }
  })
  const newContent = { ...currentContent, participants: newParticipants }
  const encoded = utf8ToBase64(JSON.stringify(newContent, null, 2) + '\n')

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

  if (url.pathname === '/api/auth/request' && request.method === 'POST') {
    return handleAuthRequest(request, env)
  }
  if (url.pathname === '/api/auth/verify' && request.method === 'POST') {
    return handleAuthVerify(request, env)
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
