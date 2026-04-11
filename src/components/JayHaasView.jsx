import { useState, useEffect, useCallback } from 'react'
import { fetchScoreboard, normalizeName } from '../utils/espn.js'
import mastersData from '../data/masters-2026.json'
import seasonData from '../data/season-2026.json'

const MAJORS = ['Masters', 'PGA Championship', 'U.S. Open', 'The Open']
const TOTAL_PICKS = 8
const REFRESH_MS = 5 * 60 * 1000

// Max possible cuts = 8 picks × 4 majors = 32
const MAX_CUTS = TOTAL_PICKS * MAJORS.length

/**
 * Count how many of a participant's picks made the cut in the current tournament.
 * A pick "made the cut" = status is not 'cut', 'wd', or 'dq'.
 * Returns null if the cut hasn't been made yet (pre-cut round 1/2).
 */
function countLiveCuts(participant, scores, cutMade) {
  if (!cutMade) return null
  let made = 0
  for (const pick of participant.picks) {
    const key = normalizeName(pick.player)
    const score = scores.get(key)
    if (!score || score.status === 'cut' || score.status === 'wd' || score.status === 'dq') continue
    made++
  }
  return made
}

export default function JayHaasView() {
  const [liveScores, setLiveScores] = useState(new Map())
  const [cutMade, setCutMade] = useState(false)
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    try {
      const { scores, cutLine } = await fetchScoreboard()
      setLiveScores(scores)
      // Cut is considered "made" once ESPN provides a cut line
      setCutMade(cutLine != null)
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

  // Build completed cuts map from season data: { participantName: { major: cutsCount } }
  const completedCuts = {}
  for (const entry of seasonData.cutsData ?? []) {
    for (const [name, count] of Object.entries(entry.cuts ?? {})) {
      if (!completedCuts[name]) completedCuts[name] = {}
      completedCuts[name][entry.major] = count
    }
  }

  const participants = mastersData.participants

  // Build rows
  const rows = participants.map((p) => {
    const cutsByMajor = MAJORS.map((major) => {
      if (major === 'Masters') {
        return countLiveCuts(p, liveScores, cutMade)
      }
      return completedCuts[p.name]?.[major] ?? null
    })

    const totalCuts = cutsByMajor.reduce((sum, c) => (c != null ? sum + c : sum), 0)
    const completedMajors = cutsByMajor.filter((c) => c != null).length
    const maxPossible = completedMajors * TOTAL_PICKS
    const cutRate = maxPossible > 0 ? (totalCuts / maxPossible) * 100 : null

    return { name: p.name, cutsByMajor, totalCuts, cutRate }
  })

  // Sort by total cuts descending (most cuts = Jay Haas Award leader)
  rows.sort((a, b) => b.totalCuts - a.totalCuts)

  // Column averages
  const colAvgs = MAJORS.map((_, i) => {
    const vals = rows.map((r) => r.cutsByMajor[i]).filter((v) => v != null)
    if (!vals.length) return null
    return (vals.reduce((s, v) => s + v, 0) / vals.length).toFixed(1)
  })
  const totalAvg = (rows.reduce((s, r) => s + r.totalCuts, 0) / rows.length).toFixed(1)
  const rateAvg = rows
    .filter((r) => r.cutRate != null)
    .reduce((s, r) => s + r.cutRate, 0) / rows.filter((r) => r.cutRate != null).length

  function cutRateColor(pct) {
    if (pct == null) return 'text-gray-400'
    if (pct >= 75) return 'text-green-600 font-bold'
    if (pct >= 60) return 'text-gray-800'
    return 'text-red-500'
  }

  return (
    <div>
      <div className="mb-4">
        <h2 className="text-xl font-bold text-gray-900">Jay Haas Award</h2>
        <p className="text-sm text-gray-500">Most cuts made across all 4 majors · {TOTAL_PICKS} picks per major</p>
      </div>

      {!cutMade && !loading && (
        <div className="mb-4 p-3 rounded bg-yellow-50 border border-yellow-200 text-yellow-700 text-sm">
          Cut hasn't been made yet — Masters column will populate after Round 2.
        </div>
      )}

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
                <th className="py-2 px-3 text-right font-bold text-gray-700">Cut %</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => (
                <tr key={row.name} className="border-b border-gray-100 hover:bg-gray-50">
                  <td className="py-2.5 px-3 text-gray-400">{i + 1}</td>
                  <td className="py-2.5 px-3 text-gray-800 font-medium">{row.name}</td>
                  {row.cutsByMajor.map((cuts, j) => (
                    <td key={j} className="py-2.5 px-2 text-right tabular-nums text-gray-700">
                      {cuts == null ? <span className="text-gray-300">—</span> : cuts}
                    </td>
                  ))}
                  <td className="py-2.5 px-2 text-right tabular-nums font-bold text-gray-900">
                    {row.totalCuts}
                  </td>
                  <td className={`py-2.5 px-3 text-right tabular-nums ${cutRateColor(row.cutRate)}`}>
                    {row.cutRate != null ? `${row.cutRate.toFixed(1)}%` : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t border-gray-300 bg-gray-50 text-xs text-gray-500 font-medium">
                <td className="py-2 px-3" colSpan={2}>Avg</td>
                {colAvgs.map((avg, i) => (
                  <td key={i} className="py-2 px-2 text-right tabular-nums">{avg ?? '—'}</td>
                ))}
                <td className="py-2 px-2 text-right tabular-nums font-bold text-gray-700">{totalAvg}</td>
                <td className="py-2 px-3 text-right tabular-nums">{rateAvg ? `${rateAvg.toFixed(1)}%` : '—'}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </div>
  )
}
