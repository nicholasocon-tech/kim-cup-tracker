import { useState, useEffect, useCallback } from 'react'
import { fetchScoreboard } from '../utils/espn.js'
import { buildStandings, formatScore } from '../utils/scoring.js'
import mastersData from '../data/masters-2026.json'
import seasonData from '../data/season-2026.json'

const MAJORS = ['Masters', 'PGA Championship', 'U.S. Open', 'The Open']
const REFRESH_MS = 5 * 60 * 1000

const PAYOUTS = { 1: 462, 2: 231, 3: 77 }

const PLACE_STYLE = {
  1: { label: '1st', cls: 'bg-yellow-100 text-yellow-700 border border-yellow-300' },
  2: { label: '2nd', cls: 'bg-gray-100 text-gray-600 border border-gray-300' },
  3: { label: '3rd', cls: 'bg-orange-100 text-orange-600 border border-orange-300' },
}

/** Given a { name → score } map, return { name → place (1/2/3 or null) } */
function calcPlacements(scoreMap) {
  const entries = Object.entries(scoreMap).sort((a, b) => a[1] - b[1])
  const placements = {}
  let rank = 1
  for (let i = 0; i < entries.length; i++) {
    const [name, score] = entries[i]
    const prev = entries[i - 1]
    if (i > 0 && score === prev[1]) {
      // tie — same rank as previous
      placements[name] = placements[prev[0]]
    } else {
      placements[name] = rank <= 3 ? rank : null
    }
    rank = i + 2
  }
  return placements
}

export default function SeasonView() {
  const [liveStandings, setLiveStandings] = useState([])
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    try {
      const { scores, cutLine: cl } = await fetchScoreboard()
      setLiveStandings(buildStandings(mastersData.participants, scores, cl))
    } catch {
      // silent
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    refresh()
    const id = setInterval(refresh, REFRESH_MS)
    return () => clearInterval(id)
  }, [refresh])

  // Build completed score + placement maps per major
  const completedMap = {}   // { name: { major: score } }
  const placementMap = {}   // { major: { name: place } }

  for (const result of seasonData.completedResults ?? []) {
    const scores = result.scores ?? {}
    placementMap[result.major] = calcPlacements(scores)
    for (const [name, score] of Object.entries(scores)) {
      if (!completedMap[name]) completedMap[name] = {}
      completedMap[name][result.major] = score
    }
  }

  // Live Masters scores + placements
  const liveScoreMap = {}
  for (const p of liveStandings) liveScoreMap[p.name] = p.result.total
  const livePlacements = Object.keys(liveScoreMap).length > 0
    ? calcPlacements(liveScoreMap)
    : {}

  const allNames = mastersData.participants.map((p) => p.name)

  const rows = allNames.map((name) => {
    const scores = MAJORS.map((major) => {
      if (completedMap[name]?.[major] != null) return completedMap[name][major]
      if (major === 'Masters') return liveScoreMap[name] ?? null
      return null
    })

    const places = MAJORS.map((major) => {
      if (placementMap[major]) return placementMap[major][name] ?? null
      if (major === 'Masters') return livePlacements[name] ?? null
      return null
    })

    const total = scores.reduce((sum, s) => (s != null ? sum + s : sum), 0)

    // Winnings: only count completed majors (not live)
    const winnings = MAJORS.reduce((sum, major, i) => {
      const isCompleted = !!seasonData.completedResults?.find(r => r.major === major)
      if (!isCompleted) return sum
      const place = places[i]
      return sum + (PAYOUTS[place] ?? 0)
    }, 0)

    return { name, scores, places, total, winnings }
  })

  rows.sort((a, b) => {
    const aHas = a.scores.some((s) => s != null)
    const bHas = b.scores.some((s) => s != null)
    if (aHas && !bHas) return -1
    if (!aHas && bHas) return 1
    return a.total - b.total
  })

  function scoreColor(n) {
    if (n == null) return 'text-gray-300'
    if (n < 0) return 'text-red-500'
    if (n > 0) return 'text-gray-900'
    return 'text-gray-500'
  }

  return (
    <div>
      <div className="mb-4">
        <h2 className="text-xl font-bold text-gray-900">2026 Season Standings</h2>
        <p className="text-sm text-gray-500">Cumulative Kim Cup score · Top 3 per major pay out</p>
      </div>

      {loading ? (
        <div className="text-center py-16 text-gray-400">Loading…</div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-gray-200">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-200 text-xs text-gray-500 uppercase tracking-wide bg-gray-50">
                <th className="py-2 px-3 text-left w-6">#</th>
                <th className="py-2 px-3 text-left">Name</th>
                <th className="py-2 px-2 text-right">Masters</th>
                <th className="py-2 px-2 text-right">PGA</th>
                <th className="py-2 px-2 text-right">US Open</th>
                <th className="py-2 px-2 text-right">The Open</th>
                <th className="py-2 px-2 text-right font-bold text-gray-700">Total</th>
                <th className="py-2 px-3 text-right font-bold text-green-700">Winnings</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => (
                <tr key={row.name} className="border-b border-gray-100 hover:bg-gray-50">
                  <td className="py-2.5 px-3 text-gray-400">{i + 1}</td>
                  <td className="py-2.5 px-3 text-gray-800">{row.name}</td>
                  {row.scores.map((score, j) => {
                    const place = row.places[j]
                    const badge = PLACE_STYLE[place]
                    return (
                      <td key={j} className="py-2.5 px-2 text-right tabular-nums">
                        <div className="flex items-center justify-end gap-1">
                          {badge && (
                            <span className={`text-xs px-1 rounded font-medium ${badge.cls}`}>
                              {badge.label}
                            </span>
                          )}
                          <span className={scoreColor(score)}>
                            {score == null
                              ? <span className="text-gray-200">—</span>
                              : j === 0 && !completedMap[row.name]?.['Masters']
                                ? <span title="Live">{formatScore(score)}*</span>
                                : formatScore(score)
                            }
                          </span>
                        </div>
                      </td>
                    )
                  })}
                  <td className={`py-2.5 px-2 text-right tabular-nums font-bold ${scoreColor(row.total)}`}>
                    {row.scores.some((s) => s != null) ? formatScore(row.total) : '—'}
                  </td>
                  <td className="py-2.5 px-3 text-right tabular-nums font-medium text-green-700">
                    {row.winnings > 0 ? `$${row.winnings}` : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="mt-3 flex flex-wrap gap-4 text-xs text-gray-400 justify-center">
        <span>* Live (in progress)</span>
        <span>Payouts: 1st $462 · 2nd $231 · 3rd $77</span>
      </div>
    </div>
  )
}
