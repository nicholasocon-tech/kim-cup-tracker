import { useState, useEffect, useCallback } from 'react'
import { fetchScoreboard, normalizeName } from '../utils/espn.js'
import mastersData from '../data/masters-2026.json'
import seasonData from '../data/season-2026.json'

const MAJORS = ['Masters', 'PGA Championship', 'U.S. Open', 'The Open']
const TOTAL_PICKS = 8
const REFRESH_MS = 5 * 60 * 1000

function matchMajor(tournamentName) {
  if (!tournamentName) return null
  const t = tournamentName.toLowerCase()
  if (t.includes('masters')) return 'Masters'
  if (t.includes('pga championship')) return 'PGA Championship'
  if (t.includes('u.s. open') || t.includes('us open')) return 'U.S. Open'
  if (t.includes('open championship') || t.includes('the open')) return 'The Open'
  return null
}

/**
 * Count picks whose golfer made the cut in a given scores map.
 * Made the cut = status is not 'cut', 'wd', or 'dq'.
 * Returns null if cutLine is null (cut not yet made — live pre-cut state).
 */
function countCuts(participant, scores, cutMade) {
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

function snapshotToScoresMap(snapshot) {
  return new Map(Object.entries(snapshot.scores))
}

export default function JayHaasView() {
  const [liveMajor, setLiveMajor] = useState(null)
  const [liveScores, setLiveScores] = useState(new Map())
  const [liveCutMade, setLiveCutMade] = useState(false)
  const [loading, setLoading] = useState(true)
  const [sortColumn, setSortColumn] = useState('total')
  const [sortDir, setSortDir] = useState('best')

  const refresh = useCallback(async () => {
    try {
      const { scores, cutLine, tournament } = await fetchScoreboard()
      const major = matchMajor(tournament)
      const alreadyLocked = (seasonData.completedResults ?? []).some((r) => r.major === major)
      if (major && !alreadyLocked) {
        setLiveMajor(major)
        setLiveScores(scores)
        setLiveCutMade(cutLine != null)
      } else {
        setLiveMajor(null)
        setLiveScores(new Map())
        setLiveCutMade(false)
      }
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

  const lockedByMajor = {}
  for (const result of seasonData.completedResults ?? []) {
    lockedByMajor[result.major] = snapshotToScoresMap(result)
  }

  const participants = mastersData.participants

  const rows = participants.map((p) => {
    const cutsByMajor = MAJORS.map((major) => {
      if (lockedByMajor[major]) {
        return countCuts(p, lockedByMajor[major], true)
      }
      if (major === liveMajor) {
        return countCuts(p, liveScores, liveCutMade)
      }
      return null
    })

    const totalCuts = cutsByMajor.reduce((sum, c) => (c != null ? sum + c : sum), 0)
    const completedMajors = cutsByMajor.filter((c) => c != null).length
    const maxPossible = completedMajors * TOTAL_PICKS
    const cutRate = maxPossible > 0 ? (totalCuts / maxPossible) * 100 : null

    return { name: p.name, cutsByMajor, totalCuts, cutRate }
  })

  // Sort: for Jay Haas, higher = better for all sortable columns (cuts, %).
  // "best-first" = descending numerically. Null values always go last.
  const MAJOR_COL_IDX = { masters: 0, pga: 1, usopen: 2, theopen: 3 }
  function valueFor(row, col) {
    if (col === 'total') return row.totalCuts
    if (col === 'cutRate') return row.cutRate
    return row.cutsByMajor[MAJOR_COL_IDX[col]] ?? null
  }
  const dir = sortDir === 'best' ? -1 : 1 // best-first = descending for higher-is-better
  rows.sort((a, b) => {
    const av = valueFor(a, sortColumn)
    const bv = valueFor(b, sortColumn)
    if (av == null && bv == null) return 0
    if (av == null) return 1
    if (bv == null) return -1
    return dir * (av - bv)
  })

  const colAvgs = MAJORS.map((_, i) => {
    const vals = rows.map((r) => r.cutsByMajor[i]).filter((v) => v != null)
    if (!vals.length) return null
    return (vals.reduce((s, v) => s + v, 0) / vals.length).toFixed(1)
  })
  const totalAvg = (rows.reduce((s, r) => s + r.totalCuts, 0) / rows.length).toFixed(1)
  const rateRows = rows.filter((r) => r.cutRate != null)
  const rateAvg = rateRows.length
    ? rateRows.reduce((s, r) => s + r.cutRate, 0) / rateRows.length
    : null

  const noDataYet = rows.every((r) => r.totalCuts === 0 && r.cutsByMajor.every((c) => c == null))

  function cutRateColor(pct) {
    if (pct == null) return 'text-gray-400'
    if (pct >= 75) return 'text-green-600 font-bold'
    if (pct >= 60) return 'text-gray-800'
    return 'text-red-500'
  }

  function SortHeader({ col, children, className = '' }) {
    const active = sortColumn === col
    const arrow = !active ? '' : sortDir === 'best' ? ' ↑' : ' ↓'
    return (
      <th
        onClick={() => {
          if (sortColumn === col) setSortDir(sortDir === 'best' ? 'worst' : 'best')
          else { setSortColumn(col); setSortDir('best') }
        }}
        className={`py-2 px-2 text-right cursor-pointer select-none hover:bg-gray-100 ${className}`}
      >
        {children}{arrow}
      </th>
    )
  }

  return (
    <div>
      <div className="mb-4">
        <h2 className="text-xl font-bold text-gray-900">Jay Haas Award</h2>
        <p className="text-sm text-gray-500">Most cuts made across all 4 majors · {TOTAL_PICKS} picks per major</p>
      </div>

      {noDataYet && !loading && (
        <div className="mb-4 p-3 rounded bg-yellow-50 border border-yellow-200 text-yellow-700 text-sm">
          No major data yet. Data populates as majors finish.
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
                <SortHeader col="masters">Masters</SortHeader>
                <SortHeader col="pga">PGA</SortHeader>
                <SortHeader col="usopen">US Open</SortHeader>
                <SortHeader col="theopen">The Open</SortHeader>
                <SortHeader col="total" className="font-bold text-gray-700">Total</SortHeader>
                <SortHeader col="cutRate" className="font-bold text-gray-700">Cut %</SortHeader>
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
                <td className="py-2 px-3 text-right tabular-nums">{rateAvg != null ? `${rateAvg.toFixed(1)}%` : '—'}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </div>
  )
}
