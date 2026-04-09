import { useState, useEffect, useCallback } from 'react'
import { fetchScoreboard } from '../utils/espn.js'
import { buildStandings, formatScore } from '../utils/scoring.js'
import ParticipantRow from './ParticipantRow.jsx'
import mastersData from '../data/masters-2026.json'

const REFRESH_MS = 5 * 60 * 1000 // 5 minutes

function buildOwnership(participants) {
  const counts = {}
  for (const p of participants) {
    for (const pick of p.picks) {
      counts[pick.player] = (counts[pick.player] ?? 0) + 1
    }
  }
  const total = participants.length
  const pct = {}
  for (const [player, count] of Object.entries(counts)) {
    pct[player] = Math.round((count / total) * 100)
  }
  return pct
}

const ownership = buildOwnership(mastersData.participants)

export default function TournamentView() {
  const [standings, setStandings] = useState([])
  const [cutLine, setCutLine] = useState(null)
  const [lastUpdated, setLastUpdated] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const refresh = useCallback(async () => {
    try {
      setError(null)
      const { scores, cutLine: cl } = await fetchScoreboard()
      const sorted = buildStandings(mastersData.participants, scores, cl)
      setStandings(sorted)
      setCutLine(cl)
      setLastUpdated(new Date())
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    refresh()
    const id = setInterval(refresh, REFRESH_MS)
    return () => clearInterval(id)
  }, [refresh])

  function timeSince(date) {
    if (!date) return ''
    const secs = Math.floor((Date.now() - date) / 1000)
    if (secs < 60) return 'just now'
    const mins = Math.floor(secs / 60)
    return `${mins}m ago`
  }

  return (
    <div>
      {/* Tournament header */}
      <div className="mb-4 flex items-center justify-between flex-wrap gap-2">
        <div>
          <h2 className="text-xl font-bold text-gray-900">{mastersData.tournament} {mastersData.year}</h2>
          <p className="text-sm text-gray-500">{mastersData.course} · {mastersData.dates}</p>
        </div>
        <div className="flex items-center gap-3">
          {cutLine != null && (
            <span className="text-sm text-gray-500">
              Cut: <span className="text-gray-900 font-medium">{formatScore(cutLine)}</span>
            </span>
          )}
          {lastUpdated && (
            <span className="text-xs text-gray-400">Updated {timeSince(lastUpdated)}</span>
          )}
          <button
            onClick={refresh}
            disabled={loading}
            className="text-xs px-3 py-1.5 rounded bg-gray-100 hover:bg-gray-200 text-gray-600 disabled:opacity-50 transition-colors"
          >
            {loading ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
      </div>

      {error && (
        <div className="mb-4 p-3 rounded bg-red-50 border border-red-200 text-red-600 text-sm">
          Could not fetch live scores: {error}. Scores may be out of date.
        </div>
      )}

      {loading && standings.length === 0 ? (
        <div className="text-center py-16 text-gray-400">Loading scores…</div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-gray-200">
          <table className="w-full">
            <thead>
              <tr className="border-b border-gray-200 text-xs text-gray-500 uppercase tracking-wide bg-gray-50">
                <th className="py-2 px-3 text-left w-8">#</th>
                <th className="py-2 px-3 text-left">Player</th>
                <th className="py-2 px-3 text-right">Score</th>
                <th className="py-2 px-2 w-6" />
              </tr>
            </thead>
            <tbody>
              {standings.map((p, i) => (
                <ParticipantRow key={p.name} participant={p} rank={i + 1} ownership={ownership} />
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="mt-4 text-xs text-gray-400 text-center">
        Best 5 of 8 picks count · Missed cut penalty = cut + 1 · Tap a row to see picks
      </p>
    </div>
  )
}
