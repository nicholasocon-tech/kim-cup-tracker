import { useState, useEffect, useCallback } from 'react'
import { fetchScoreboard } from '../utils/espn.js'
import { buildStandings, formatScore } from '../utils/scoring.js'
import mastersData from '../data/masters-2026.json'
import seasonData from '../data/season-2026.json'

const MAJORS = ['Masters', 'PGA Championship', 'U.S. Open', 'The Open']
const REFRESH_MS = 5 * 60 * 1000

export default function SeasonView() {
  const [liveStandings, setLiveStandings] = useState([])
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    try {
      const { scores, cutLine: cl } = await fetchScoreboard()
      setLiveStandings(buildStandings(mastersData.participants, scores, cl))
    } catch {
      // silent fail on season view
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    refresh()
    const id = setInterval(refresh, REFRESH_MS)
    return () => clearInterval(id)
  }, [refresh])

  const completedMap = {}
  for (const result of seasonData.completedResults ?? []) {
    for (const [name, score] of Object.entries(result.scores ?? {})) {
      if (!completedMap[name]) completedMap[name] = {}
      completedMap[name][result.major] = score
    }
  }

  const liveMap = {}
  for (const p of liveStandings) {
    liveMap[p.name] = p.result.total
  }

  const allNames = mastersData.participants.map((p) => p.name)

  const rows = allNames.map((name) => {
    const scores = MAJORS.map((major) => {
      if (completedMap[name]?.[major] != null) return completedMap[name][major]
      if (major === 'Masters') return liveMap[name] ?? null
      return null
    })
    const total = scores.reduce((sum, s) => (s != null ? sum + s : sum), 0)
    return { name, scores, total }
  })

  rows.sort((a, b) => {
    const aHas = a.scores.some((s) => s != null)
    const bHas = b.scores.some((s) => s != null)
    if (aHas && !bHas) return -1
    if (!aHas && bHas) return 1
    return a.total - b.total
  })

  function cellColor(n) {
    if (n == null) return 'text-gray-300'
    if (n < 0) return 'text-red-500'
    if (n > 0) return 'text-gray-900'
    return 'text-gray-500'
  }

  return (
    <div>
      <div className="mb-4">
        <h2 className="text-xl font-bold text-gray-900">2026 Season Standings</h2>
        <p className="text-sm text-gray-500">Cumulative Kim Cup score across all 4 majors</p>
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
                {MAJORS.map((m) => (
                  <th key={m} className="py-2 px-2 text-right whitespace-nowrap">
                    {m === 'Masters' ? 'Masters' : m === 'PGA Championship' ? 'PGA' : m === 'U.S. Open' ? 'US Open' : 'The Open'}
                  </th>
                ))}
                <th className="py-2 px-3 text-right font-bold text-gray-900">Total</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => (
                <tr key={row.name} className="border-b border-gray-100 hover:bg-gray-50">
                  <td className="py-2.5 px-3 text-gray-400">{i + 1}</td>
                  <td className="py-2.5 px-3 text-gray-800">{row.name}</td>
                  {row.scores.map((score, j) => (
                    <td key={j} className={`py-2.5 px-2 text-right tabular-nums ${cellColor(score)}`}>
                      {score == null
                        ? <span className="text-gray-200">—</span>
                        : j === 0 && !completedMap[row.name]?.['Masters']
                          ? <span title="Live">{formatScore(score)}*</span>
                          : formatScore(score)
                      }
                    </td>
                  ))}
                  <td className={`py-2.5 px-3 text-right tabular-nums font-bold ${cellColor(row.total)}`}>
                    {row.scores.some((s) => s != null) ? formatScore(row.total) : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="mt-3 text-xs text-gray-400 text-center">
        * Live (in progress) · Season total = sum of all completed + in-progress scores
      </p>
    </div>
  )
}
