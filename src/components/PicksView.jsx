import { useState, useEffect, useMemo, useCallback } from 'react'
import participantsData from '../data/participants-2026.json'
import tiersData from '../data/theopen-2026-tiers.json'
import lockConfig from '../data/lock-config.json'
import { resolveKey } from '../utils/espn.js'

const TIERS = [1, 2, 3, 4]
const AUTH_KEY = 'kimcup_auth'

// Map every golfer in the current tier sheet (by normalized name) to their tier
// and canonical display name. Saved picks are re-mapped through this on load so
// they always render under the tier the app now shows — otherwise a player who
// was re-tiered, renamed, or dropped since submitting becomes an invisible pick
// with no button to deselect, jamming that tier at "2 picks" (see loadExisting).
const CURRENT_BY_NAME = (() => {
  const m = new Map()
  for (const [tier, players] of Object.entries(tiersData.tiers)) {
    for (const player of players) {
      m.set(resolveKey(player), { tier: Number(tier), name: player })
    }
  }
  return m
})()

function lockTime() {
  return new Date(lockConfig.lockAt).getTime()
}

function formatCountdown(ms) {
  if (ms <= 0) return 'Locked'
  const days = Math.floor(ms / 86400000)
  const hours = Math.floor((ms % 86400000) / 3600000)
  const mins = Math.floor((ms % 3600000) / 60000)
  if (days > 0) return `${days}d ${hours}h ${mins}m`
  if (hours > 0) return `${hours}h ${mins}m`
  return `${mins}m`
}

function formatLockAt() {
  const d = new Date(lockConfig.lockAt)
  return d.toLocaleString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
  })
}

// Session token persisted across reloads; dropped once expired.
function loadStoredAuth() {
  try {
    const a = JSON.parse(localStorage.getItem(AUTH_KEY))
    if (!a?.token || !a?.expiresAt || Date.now() >= a.expiresAt) {
      localStorage.removeItem(AUTH_KEY)
      return null
    }
    return a // { name, token, expiresAt }
  } catch {
    return null
  }
}

export default function PicksView() {
  const [auth, setAuth] = useState(loadStoredAuth)
  const [phase, setPhase] = useState(() => (auth ? 'authed' : 'identity'))
  const [selectedName, setSelectedName] = useState(() => auth?.name ?? '')
  const [email, setEmail] = useState('')
  const [code, setCode] = useState('')
  const [picks, setPicks] = useState({ 1: [], 2: [], 3: [], 4: [] })
  const [busy, setBusy] = useState('') // '' | sending | verifying | loading | submitting
  const [message, setMessage] = useState(null) // { kind: 'info'|'error'|'success', text }
  const [submittedAt, setSubmittedAt] = useState(null)
  const [now, setNow] = useState(Date.now())

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30000)
    return () => clearInterval(id)
  }, [])

  const locked = now >= lockTime()
  const msToLock = lockTime() - now

  const tiersAvailable = useMemo(
    () => TIERS.every((t) => (tiersData.tiers[t] ?? []).length > 0),
    []
  )
  const allTiersComplete = TIERS.every((t) => picks[t].length === 2)
  const identityComplete = selectedName && email.trim().length > 0

  const signOut = useCallback(() => {
    localStorage.removeItem(AUTH_KEY)
    setAuth(null)
    setPhase('identity')
    setCode('')
    setPicks({ 1: [], 2: [], 3: [], 4: [] })
    setSubmittedAt(null)
    setMessage(null)
  }, [])

  const loadExisting = useCallback(async (token, name) => {
    setBusy('loading')
    try {
      const url = `${lockConfig.apiBaseUrl}/api/picks?major=${encodeURIComponent(lockConfig.currentMajor)}&name=${encodeURIComponent(name)}`
      const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
      if (res.status === 401) {
        signOut()
        setMessage({ kind: 'error', text: 'Your session expired — please verify again.' })
        return
      }
      if (res.status === 404) {
        setMessage({ kind: 'info', text: 'No prior submission found. Make your picks below.' })
        return
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      // Re-map each saved pick to its CURRENT tier + canonical name so it renders
      // (and can be deselected) under the tier sheet now in effect. Players no
      // longer in the field drop out entirely and must be re-picked. Re-tiering
      // can leave a tier with !=2 picks; the grid surfaces that and submit stays
      // disabled until every tier has exactly 2 again.
      const byTier = { 1: [], 2: [], 3: [], 4: [] }
      const dropped = []
      for (const p of data.picks ?? []) {
        const cur = CURRENT_BY_NAME.get(resolveKey(p.player))
        if (cur) byTier[cur.tier].push(cur.name)
        else dropped.push(p.player)
      }
      setPicks(byTier)
      setSubmittedAt(data.submittedAt)
      if (dropped.length > 0) {
        const list = dropped.join(' and ')
        const plural = dropped.length > 1
        setMessage({
          kind: 'info',
          text: `Loaded your saved picks. ${list} ${plural ? 'are' : 'is'} no longer in the field — pick ${plural ? 'replacements' : 'a replacement'}. Some picks may have shifted tiers, so double-check each tier has exactly 2. Editable until ${formatLockAt()}.`,
        })
      } else {
        setMessage({ kind: 'info', text: `Loaded your saved picks. Editable until ${formatLockAt()}.` })
      }
    } catch (e) {
      setMessage({ kind: 'error', text: `Couldn't load your picks: ${e.message}` })
    } finally {
      setBusy('')
    }
  }, [signOut])

  // On mount, if we have a live token, pull any existing submission.
  useEffect(() => {
    if (auth?.token) loadExisting(auth.token, auth.name)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const requestCode = useCallback(async () => {
    if (!identityComplete) return
    setBusy('sending')
    setMessage(null)
    try {
      const res = await fetch(`${lockConfig.apiBaseUrl}/api/auth/request`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: selectedName, email: email.trim() }),
      })
      const data = await res.json().catch(() => ({}))
      if (res.status === 403) {
        setMessage({ kind: 'error', text: `That email doesn't match our records for ${selectedName}. Talk to Nick if this is wrong.` })
        return
      }
      if (res.status === 429) {
        setMessage({ kind: 'error', text: 'Too many code requests — wait a bit and try again.' })
        return
      }
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`)
      setPhase('awaitingCode')
      setMessage({ kind: 'info', text: `We emailed a 6-digit code to ${data.sentTo ?? 'your address'}. It expires in 10 minutes.` })
    } catch (e) {
      setMessage({ kind: 'error', text: `Couldn't send a code: ${e.message}` })
    } finally {
      setBusy('')
    }
  }, [identityComplete, selectedName, email])

  const verifyCode = useCallback(async () => {
    if (!code.trim()) return
    setBusy('verifying')
    setMessage(null)
    try {
      const res = await fetch(`${lockConfig.apiBaseUrl}/api/auth/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: selectedName, email: email.trim(), code: code.trim() }),
      })
      const data = await res.json().catch(() => ({}))
      if (res.status === 401) {
        setMessage({ kind: 'error', text: 'Incorrect code — try again.' })
        return
      }
      if (res.status === 400 || res.status === 429) {
        setMessage({ kind: 'error', text: data.error ?? 'Code problem — request a new one.' })
        return
      }
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`)
      const a = { name: selectedName, token: data.token, expiresAt: data.expiresAt }
      localStorage.setItem(AUTH_KEY, JSON.stringify(a))
      setAuth(a)
      setPhase('authed')
      setCode('')
      setMessage(null)
      loadExisting(a.token, a.name)
    } catch (e) {
      setMessage({ kind: 'error', text: `Verification failed: ${e.message}` })
    } finally {
      setBusy('')
    }
  }, [code, selectedName, email, loadExisting])

  const togglePick = useCallback((tier, player) => {
    setPicks((prev) => {
      const current = prev[tier]
      if (current.includes(player)) {
        return { ...prev, [tier]: current.filter((p) => p !== player) }
      }
      if (current.length >= 2) {
        setMessage({ kind: 'error', text: `Tier ${tier} already has 2 picks. Deselect one first.` })
        return prev
      }
      return { ...prev, [tier]: [...current, player] }
    })
  }, [])

  const submit = useCallback(async () => {
    if (!allTiersComplete || !auth?.token) return
    setBusy('submitting')
    setMessage(null)
    try {
      const flatPicks = TIERS.flatMap((t) => picks[t].map((player) => ({ player, tier: t })))
      const res = await fetch(`${lockConfig.apiBaseUrl}/api/picks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${auth.token}` },
        body: JSON.stringify({ major: lockConfig.currentMajor, name: auth.name, picks: flatPicks }),
      })
      const data = await res.json().catch(() => ({}))
      if (res.status === 401) {
        signOut()
        setMessage({ kind: 'error', text: 'Your session expired — please verify again.' })
        return
      }
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`)
      setSubmittedAt(data.submittedAt)
      setMessage({ kind: 'success', text: `Submitted. Editable until ${formatLockAt()}.` })
    } catch (e) {
      setMessage({ kind: 'error', text: `Submission failed: ${e.message}` })
    } finally {
      setBusy('')
    }
  }, [picks, auth, allTiersComplete, signOut])

  if (locked) {
    return (
      <div className="text-center py-16">
        <h2 className="text-2xl font-display font-semibold text-pine-900 mb-2">Picks are locked</h2>
        <p className="text-sm text-gray-500">
          {lockConfig.currentMajor} picks closed at {formatLockAt()}.
          Head to the Tournament tab for live scoring.
        </p>
      </div>
    )
  }

  const messageCls =
    message?.kind === 'error' ? 'text-red-600'
      : message?.kind === 'success' ? 'text-pine-700'
        : 'text-gray-600'

  return (
    <div>
      <div className="mb-6">
        <h2 className="text-2xl font-display font-semibold text-pine-900">
          {lockConfig.currentMajor} 2026 — Submit Picks
        </h2>
        <p className="text-sm text-gray-500 mt-1">
          Pick 2 from each tier (8 total). Best 5 of 8 count, missed cut = cut+1.
        </p>
        <p className="text-xs text-gray-400 mt-1">
          Locks in <span className="font-medium text-gray-700">{formatCountdown(msToLock)}</span> · {formatLockAt()}
        </p>
      </div>

      {/* ── Auth card ── */}
      <div className="mb-6 p-4 rounded-xl border border-cream-200 bg-white shadow-sm">
        {phase === 'identity' && (
          <>
            <div className="flex flex-col sm:flex-row gap-3">
              <div className="flex-1">
                <label className="block text-xs font-medium text-gray-600 mb-1">Your name</label>
                <select
                  value={selectedName}
                  onChange={(e) => { setSelectedName(e.target.value); setMessage(null) }}
                  className="w-full px-3 py-2 border border-gray-300 rounded text-sm bg-white"
                >
                  <option value="">— select —</option>
                  {participantsData.members.map((m) => (
                    <option key={m.name} value={m.name}>{m.name}</option>
                  ))}
                </select>
              </div>
              <div className="flex-1">
                <label className="block text-xs font-medium text-gray-600 mb-1">Your email</label>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => { setEmail(e.target.value); setMessage(null) }}
                  onKeyDown={(e) => { if (e.key === 'Enter' && identityComplete) requestCode() }}
                  placeholder="you@example.com"
                  className="w-full px-3 py-2 border border-gray-300 rounded text-sm bg-white"
                />
              </div>
            </div>
            <button
              onClick={requestCode}
              disabled={!identityComplete || busy === 'sending'}
              className="mt-3 px-4 py-2 rounded text-sm font-medium bg-pine-700 hover:bg-pine-800 text-white disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {busy === 'sending' ? 'Sending…' : 'Email me a code'}
            </button>
            <p className="mt-2 text-xs text-gray-400">
              We'll email a 6-digit code to your address on file to confirm it's you.
            </p>
          </>
        )}

        {phase === 'awaitingCode' && (
          <>
            <label className="block text-xs font-medium text-gray-600 mb-1">
              Enter the code we emailed you
            </label>
            <div className="flex gap-2">
              <input
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                value={code}
                onChange={(e) => { setCode(e.target.value.replace(/\D/g, '').slice(0, 6)); setMessage(null) }}
                onKeyDown={(e) => { if (e.key === 'Enter') verifyCode() }}
                placeholder="123456"
                className="flex-1 px-3 py-2 border border-gray-300 rounded text-sm bg-white tracking-widest font-mono"
              />
              <button
                onClick={verifyCode}
                disabled={code.length < 6 || busy === 'verifying'}
                className="px-4 py-2 rounded text-sm font-medium bg-pine-700 hover:bg-pine-800 text-white disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {busy === 'verifying' ? 'Verifying…' : 'Verify'}
              </button>
            </div>
            <div className="mt-3 flex gap-4 text-xs">
              <button
                onClick={requestCode}
                disabled={busy === 'sending'}
                className="text-gray-500 hover:text-gray-900 underline disabled:opacity-50"
              >
                {busy === 'sending' ? 'Resending…' : 'Resend code'}
              </button>
              <button
                onClick={() => { setPhase('identity'); setCode(''); setMessage(null) }}
                className="text-gray-500 hover:text-gray-900 underline"
              >
                Use a different name/email
              </button>
            </div>
          </>
        )}

        {phase === 'authed' && (
          <div className="flex items-center justify-between">
            <span className="text-sm text-gray-700">
              Signed in as <span className="font-medium text-pine-900">{auth?.name}</span>
            </span>
            <button
              onClick={signOut}
              className="text-xs text-gray-500 hover:text-gray-900 underline"
            >
              Sign out
            </button>
          </div>
        )}

        {message && <p className={`mt-3 text-xs ${messageCls}`}>{message.text}</p>}
      </div>

      {/* ── Picks grid (only once authenticated) ── */}
      {phase !== 'authed' ? null : !tiersAvailable ? (
        <div className="text-center py-12 text-gray-400 text-sm">
          Tier sheet for {lockConfig.currentMajor} not yet posted. Check back closer to tournament week.
        </div>
      ) : (
        <>
          {TIERS.map((tier) => {
            const players = tiersData.tiers[tier] ?? []
            const selected = picks[tier]
            return (
              <div key={tier} className="mb-6">
                <div className="flex items-baseline justify-between mb-2">
                  <h3 className="text-sm font-semibold text-pine-900">Tier {tier}</h3>
                  <span className={`text-xs ${selected.length === 2 ? 'text-pine-600' : 'text-gray-400'}`}>
                    {selected.length} of 2 selected
                  </span>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
                  {players.map((player) => {
                    const isSelected = selected.includes(player)
                    return (
                      <button
                        key={player}
                        onClick={() => togglePick(tier, player)}
                        disabled={busy === 'submitting'}
                        className={`text-left px-3 py-2 rounded text-sm border transition-colors ${
                          isSelected
                            ? 'bg-pine-50 border-pine-500 text-pine-900 font-medium'
                            : 'bg-white border-cream-200 text-gray-700 hover:bg-cream-50'
                        }`}
                      >
                        {isSelected && <span className="mr-1.5">✓</span>}
                        {player}
                      </button>
                    )
                  })}
                </div>
              </div>
            )
          })}

          <div className="sticky bottom-0 bg-white border-t border-gray-200 pt-4 pb-2 mt-6">
            <button
              onClick={submit}
              disabled={!allTiersComplete || busy === 'submitting'}
              className="w-full py-3 rounded font-medium text-sm transition-colors disabled:opacity-40 disabled:cursor-not-allowed bg-pine-700 hover:bg-pine-800 text-white"
            >
              {busy === 'submitting'
                ? 'Submitting…'
                : submittedAt
                  ? 'Update picks'
                  : 'Submit picks'}
            </button>
            {!allTiersComplete && (
              <p className="mt-2 text-xs text-center text-gray-400">
                Select exactly 2 picks in each tier
              </p>
            )}
            {submittedAt && message?.kind === 'success' && (
              <p className="mt-2 text-xs text-center text-pine-700">
                Submitted at {new Date(submittedAt).toLocaleString()}
              </p>
            )}
          </div>
        </>
      )}
    </div>
  )
}
