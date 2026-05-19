import { useState, useEffect, useMemo, useCallback } from 'react'
import participantsData from '../data/participants-2026.json'
import tiersData from '../data/usopen-2026-tiers.json'
import lockConfig from '../data/lock-config.json'

const TIERS = [1, 2, 3, 4]

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

export default function PicksView() {
  const [selectedName, setSelectedName] = useState('')
  const [email, setEmail] = useState('')
  const [picks, setPicks] = useState({ 1: [], 2: [], 3: [], 4: [] })
  const [status, setStatus] = useState('idle')
  const [statusMessage, setStatusMessage] = useState('')
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

  const togglePick = useCallback((tier, player) => {
    setPicks((prev) => {
      const current = prev[tier]
      if (current.includes(player)) {
        return { ...prev, [tier]: current.filter((p) => p !== player) }
      }
      if (current.length >= 2) {
        setStatusMessage(`Tier ${tier} already has 2 picks. Deselect one first.`)
        setTimeout(() => setStatusMessage(''), 2500)
        return prev
      }
      return { ...prev, [tier]: [...current, player] }
    })
  }, [])

  const loadExisting = useCallback(async () => {
    if (!identityComplete) return
    setStatus('verifying')
    setStatusMessage('')
    try {
      const url = `${lockConfig.apiBaseUrl}/api/picks?major=${encodeURIComponent(lockConfig.currentMajor)}&name=${encodeURIComponent(selectedName)}&email=${encodeURIComponent(email)}`
      const res = await fetch(url)
      if (res.status === 403) {
        setStatus('mismatch')
        setStatusMessage(`That email doesn't match our records for ${selectedName}. Talk to Nick if this is wrong.`)
        return
      }
      if (res.status === 404) {
        setStatus('verified')
        setStatusMessage('No prior submission found. Make your picks below.')
        return
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      const byTier = { 1: [], 2: [], 3: [], 4: [] }
      for (const p of data.picks ?? []) byTier[p.tier].push(p.player)
      setPicks(byTier)
      setSubmittedAt(data.submittedAt)
      setStatus('verified')
      setStatusMessage(`Existing submission loaded. Editable until ${formatLockAt()}.`)
    } catch (e) {
      setStatus('error')
      setStatusMessage(`Couldn't reach the picks server: ${e.message}`)
    }
  }, [selectedName, email, identityComplete])

  const submit = useCallback(async () => {
    if (!allTiersComplete || !identityComplete) return
    setStatus('submitting')
    setStatusMessage('')
    try {
      const flatPicks = TIERS.flatMap((t) =>
        picks[t].map((player) => ({ player, tier: t }))
      )
      const res = await fetch(`${lockConfig.apiBaseUrl}/api/picks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          major: lockConfig.currentMajor,
          name: selectedName,
          email,
          picks: flatPicks,
        }),
      })
      if (res.status === 403) {
        setStatus('mismatch')
        setStatusMessage(`Email doesn't match our records for ${selectedName}.`)
        return
      }
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error ?? `HTTP ${res.status}`)
      }
      const data = await res.json()
      setSubmittedAt(data.submittedAt)
      setStatus('submitted')
      setStatusMessage(`Submitted. Editable until ${formatLockAt()}.`)
    } catch (e) {
      setStatus('error')
      setStatusMessage(`Submission failed: ${e.message}`)
    }
  }, [picks, selectedName, email, allTiersComplete, identityComplete])

  if (locked) {
    return (
      <div className="text-center py-16">
        <h2 className="text-xl font-bold text-gray-900 mb-2">Picks are locked</h2>
        <p className="text-sm text-gray-500">
          {lockConfig.currentMajor} picks closed at {formatLockAt()}.
          Head to the Tournament tab for live scoring.
        </p>
      </div>
    )
  }

  return (
    <div>
      <div className="mb-6">
        <h2 className="text-xl font-bold text-gray-900">
          {lockConfig.currentMajor} 2026 — Submit Picks
        </h2>
        <p className="text-sm text-gray-500 mt-1">
          Pick 2 from each tier (8 total). Best 5 of 8 count, missed cut = cut+1.
        </p>
        <p className="text-xs text-gray-400 mt-1">
          Locks in <span className="font-medium text-gray-700">{formatCountdown(msToLock)}</span> · {formatLockAt()}
        </p>
      </div>

      <div className="mb-6 p-4 rounded border border-gray-200 bg-gray-50">
        <div className="flex flex-col sm:flex-row gap-3">
          <div className="flex-1">
            <label className="block text-xs font-medium text-gray-600 mb-1">Your name</label>
            <select
              value={selectedName}
              onChange={(e) => { setSelectedName(e.target.value); setStatus('idle'); setStatusMessage('') }}
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
              onChange={(e) => { setEmail(e.target.value); setStatus('idle') }}
              onBlur={loadExisting}
              placeholder="you@example.com"
              className="w-full px-3 py-2 border border-gray-300 rounded text-sm bg-white"
            />
          </div>
        </div>
        {statusMessage && (
          <p className={`mt-3 text-xs ${status === 'mismatch' || status === 'error' ? 'text-red-600' : 'text-gray-600'}`}>
            {statusMessage}
          </p>
        )}
      </div>

      {!tiersAvailable ? (
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
                  <h3 className="text-sm font-semibold text-gray-900">Tier {tier}</h3>
                  <span className={`text-xs ${selected.length === 2 ? 'text-green-600' : 'text-gray-400'}`}>
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
                        disabled={status === 'submitting'}
                        className={`text-left px-3 py-2 rounded text-sm border transition-colors ${
                          isSelected
                            ? 'bg-green-50 border-green-400 text-green-900 font-medium'
                            : 'bg-white border-gray-200 text-gray-700 hover:bg-gray-50'
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
              disabled={!identityComplete || !allTiersComplete || status === 'submitting'}
              className="w-full py-3 rounded font-medium text-sm transition-colors disabled:opacity-40 disabled:cursor-not-allowed bg-green-600 hover:bg-green-700 text-white"
            >
              {status === 'submitting'
                ? 'Submitting…'
                : submittedAt
                  ? 'Update picks'
                  : 'Submit picks'}
            </button>
            {!identityComplete && (
              <p className="mt-2 text-xs text-center text-gray-400">Enter your name and email above</p>
            )}
            {identityComplete && !allTiersComplete && (
              <p className="mt-2 text-xs text-center text-gray-400">
                Select exactly 2 picks in each tier
              </p>
            )}
            {submittedAt && status === 'submitted' && (
              <p className="mt-2 text-xs text-center text-green-700">
                Submitted at {new Date(submittedAt).toLocaleString()}
              </p>
            )}
          </div>
        </>
      )}
    </div>
  )
}
