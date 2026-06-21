import { useState } from 'react'
import { resolveKey } from '../utils/espn.js'
import { MAJORS, MAJOR_META, MEMBERS, snapshotToScoresMap } from '../utils/majors.js'
import { useLiveScoreboard } from '../utils/useLiveScoreboard.js'
import seasonData from '../data/season-2026.json'

const TOTAL_PICKS = 8

/**
 * Count picks whose golfer made the cut in a given scores map.
 * Made the cut = status 'active' (espn.js only emits 'active' or 'cut').
 * Returns null if cutMade is false (cut not yet made — live pre-cut state).
 */
function countCuts(participant, scores, cutMade) {
  if (!cutMade) return null
  let made = 0
  for (const pick of participant.picks) {
    const key = resolveKey(pick.player)
    const score = scores.get(key)
    if (!score || score.status === 'cut') continue
    made++
  }
  return made
}

export default function JayHaasView() {
  const { liveMajor, scores: liveScores, cutLine, resolved } = useLiveScoreboard()
  const liveCutMade = cutLine != null
  const [sortColumn, setSortColumn] = useState('total')
  const [sortDir, setSortDir] = useState('best')

  // Each locked result carries its own `participants` snapshot. A player's
  // Masters cuts must be counted against their Masters picks, not their picks
  // for whatever major is currently live.
  const lockedScoresByMajor = {}
  const lockedPicksByMajor = {}
  for (const result of seasonData.completedResults ?? []) {
    lockedScoresByMajor[result.major] = snapshotToScoresMap(result)
    lockedPicksByMajor[result.major] = result.participants ?? MAJOR_META[result.major]?.participants ?? []
  }

  function findPicks(participantList, name) {
    return participantList.find((q) => q.name === name) ?? { name, picks: [] }
  }

  const rows = MEMBERS.map((p) => {
    const cutsByMajor = MAJORS.map((major) => {
      if (lockedScoresByMajor[major]) {
        return countCuts(findPicks(lockedPicksByMajor[major], p.name), lockedScoresByMajor[major], true)
      }
      if (major === liveMajor) {
        return countCuts(findPicks(MAJOR_META[liveMajor].participants, p.name), liveScores, liveCutMade)
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
    if (pct >= 75) return 'text-pine-600 font-bold'
    if (pct >= 60) return 'text-gray-800'
    return 'text-red-500'
  }

  function SortHeader({ col, children, className = '' }) {
    const active = sortColumn === col
    const arrow = !active ? '' : sortDir === 'best' ? ' ↑' : ' ↓'
    const toggle = () => {
      if (sortColumn === col) setSortDir(sortDir === 'best' ? 'worst' : 'best')
      else { setSortColumn(col); setSortDir('best') }
    }
    return (
      <th
        onClick={toggle}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle() } }}
        tabIndex={0}
        role="button"
        aria-sort={active ? (sortDir === 'best' ? 'descending' : 'ascending') : 'none'}
        className={`py-2.5 px-2 text-right cursor-pointer select-none hover:bg-pine-100 ${className}`}
      >
        {children}{arrow}
      </th>
    )
  }

  return (
    <div>
      <div className="mb-4">
        <h2 className="text-2xl font-display font-semibold text-pine-900">Jay Haas Award</h2>
        <p className="text-sm text-gray-500">Most cuts made across all 4 majors · {TOTAL_PICKS} picks per major</p>
      </div>

      {noDataYet && resolved && (
        <div className="mb-4 p-3 rounded bg-yellow-50 border border-yellow-200 text-yellow-700 text-sm">
          No major data yet. Data populates as majors finish.
        </div>
      )}

      {!resolved ? (
        <div className="text-center py-16 text-gray-400">Loading…</div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-cream-200 bg-white shadow-sm">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-cream-200 text-xs text-pine-800 uppercase tracking-wider bg-pine-50 font-medium">
                <th className="py-2 px-3 text-left w-6">#</th>
                <th className="py-2 px-3 text-left">Name</th>
                <SortHeader col="masters">Masters</SortHeader>
                <SortHeader col="pga">PGA</SortHeader>
                <SortHeader col="usopen">US Open</SortHeader>
                <SortHeader col="theopen">The Open</SortHeader>
                <SortHeader col="total" className="font-bold text-pine-800">Total</SortHeader>
                <SortHeader col="cutRate" className="font-bold text-pine-800">Cut %</SortHeader>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => (
                <tr key={row.name} className="border-b border-cream-100 hover:bg-cream-50">
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
              <tr className="border-t border-cream-200 bg-pine-50 text-xs text-pine-800 font-medium">
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
