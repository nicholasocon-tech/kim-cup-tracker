import { useState, useMemo } from 'react'
import { buildStandings, calcPayouts, formatScore, PAYOUTS } from '../utils/scoring.js'
import { MAJORS, MAJOR_META, MEMBERS, snapshotToScoresMap } from '../utils/majors.js'
import { useLiveScoreboard } from '../utils/useLiveScoreboard.js'
import seasonData from '../data/season-2026.json'

const PLACE_STYLE = {
  1: { label: '1st', cls: 'bg-gold-100 text-gold-700 border border-gold-300' },
  2: { label: '2nd', cls: 'bg-gray-100 text-gray-600 border border-gray-300' },
  3: { label: '3rd', cls: 'bg-orange-100 text-orange-700 border border-orange-300' },
}

function placeLabel(place, tied) {
  if (place == null || place > 3) return null
  const base = PLACE_STYLE[place]
  if (!base) return null
  return { ...base, label: tied ? `T-${base.label}` : base.label }
}

export default function SeasonView() {
  const { liveMajor, scores, cutLine } = useLiveScoreboard()
  const [sortColumn, setSortColumn] = useState(null)
  const [sortDir, setSortDir] = useState('best')

  const liveStandings = useMemo(() => {
    if (!liveMajor) return []
    const picks = MAJOR_META[liveMajor]?.participants ?? []
    return buildStandings(picks, scores, cutLine)
  }, [liveMajor, scores, cutLine])

  // Per-major standings keyed by major name. Each locked result carries its
  // own `participants` snapshot — the live major's picks file can change after
  // it's locked, so we never reuse another major's picks for historical majors.
  const perMajor = {}
  for (const result of seasonData.completedResults ?? []) {
    const scoresMap = snapshotToScoresMap(result)
    const participants = result.participants ?? MAJOR_META[result.major]?.participants ?? []
    const standings = buildStandings(participants, scoresMap, result.cutLine, result.winner)
    perMajor[result.major] = { standings, locked: true, payouts: calcPayouts(standings) }
  }
  if (liveMajor && liveStandings.length > 0 && !perMajor[liveMajor]) {
    perMajor[liveMajor] = { standings: liveStandings, locked: false, payouts: {} }
  }

  // Build per-participant aggregates over the canonical member roster.
  const aggregated = MEMBERS.map((p) => {
    const perMajorEntries = MAJORS.map((major) => {
      const m = perMajor[major]
      if (!m) return { major, total: null, place: null, tied: false, locked: false, cutsMade: 0 }
      const row = m.standings.find((s) => s.name === p.name)
      if (!row) return { major, total: null, place: null, tied: false, locked: m.locked, cutsMade: 0 }
      // Treat non-submitters as having no score for the major — empty picks
      // would otherwise show as 0 (E) and inflate their season total.
      return {
        major,
        total: row.dns ? null : row.result.total,
        place: row.place,
        tied: row.tied,
        locked: m.locked,
        cutsMade: row.cutsMade,
      }
    })

    const completedTotals = perMajorEntries.filter((e) => e.total != null)
    const seasonTotal = completedTotals.reduce((sum, e) => sum + e.total, 0)
    const seasonWeekWins = perMajorEntries.filter((e) => e.locked && e.place === 1 && !e.tied).length
    const seasonCuts = perMajorEntries.reduce((sum, e) => sum + (e.locked ? e.cutsMade : 0), 0)
    const winnings = perMajorEntries.reduce((sum, e) => {
      if (!e.locked) return sum
      const payout = perMajor[e.major]?.payouts?.[p.name] ?? 0
      return sum + payout
    }, 0)

    return {
      name: p.name,
      perMajor: perMajorEntries,
      seasonTotal,
      seasonWeekWins,
      seasonCuts,
      winnings,
      hasAnyScore: completedTotals.length > 0,
    }
  })

  // Season-long tiebreakers (mirror per-week sequence per user direction).
  // Rules §5 tiebreakers only resolve 1st place; 2nd/3rd ties get no
  // tiebreaker per Payouts §2 (same behavior as per-week).
  const scored = aggregated.filter((r) => r.hasAnyScore)
  const unscored = aggregated.filter((r) => !r.hasAnyScore)
  scored.sort((a, b) => a.seasonTotal - b.seasonTotal)

  let topGroup = []
  let demoted = []
  let rest = scored
  if (scored.length > 1 && scored[0].seasonTotal === scored[1].seasonTotal) {
    const topScore = scored[0].seasonTotal
    let i = 0
    while (i < scored.length && scored[i].seasonTotal === topScore) i++
    topGroup = scored.slice(0, i)
    rest = scored.slice(i)

    const maxWins = Math.max(...topGroup.map((r) => r.seasonWeekWins))
    const winsTop = topGroup.filter((r) => r.seasonWeekWins === maxWins)
    const winsRest = topGroup.filter((r) => r.seasonWeekWins !== maxWins)
    if (winsTop.length > 0 && winsRest.length > 0) {
      topGroup = winsTop
      demoted = winsRest
    }

    if (topGroup.length > 1) {
      const maxCuts = Math.max(...topGroup.map((r) => r.seasonCuts))
      const cutsTop = topGroup.filter((r) => r.seasonCuts === maxCuts)
      const cutsRest = topGroup.filter((r) => r.seasonCuts !== maxCuts)
      if (cutsTop.length > 0 && cutsRest.length > 0) {
        topGroup = cutsTop
        demoted = [...cutsRest, ...demoted]
      }
    }
  }

  const seasonRanked = []
  for (const r of topGroup) {
    seasonRanked.push({ ...r, seasonPlace: 1, seasonTied: topGroup.length > 1 })
  }
  if (demoted.length > 0) {
    const demotedPlace = 1 + topGroup.length
    for (const r of demoted) {
      seasonRanked.push({ ...r, seasonPlace: demotedPlace, seasonTied: demoted.length > 1 })
    }
  }
  let nextPlace = topGroup.length + demoted.length + 1
  let j = 0
  while (j < rest.length) {
    let end = j
    while (end + 1 < rest.length && rest[end + 1].seasonTotal === rest[j].seasonTotal) end++
    const size = end - j + 1
    for (let k = j; k <= end; k++) {
      seasonRanked.push({ ...rest[k], seasonPlace: nextPlace, seasonTied: size > 1 })
    }
    nextPlace += size
    j = end + 1
  }
  for (const r of unscored) {
    seasonRanked.push({ ...r, seasonPlace: null, seasonTied: false })
  }

  // Season payouts (only meaningful once all 4 majors are complete)
  const allMajorsComplete = MAJORS.every((m) => perMajor[m]?.locked)
  const seasonPayouts = allMajorsComplete
    ? calcPayouts(
        seasonRanked.map((r) => ({ name: r.name, place: r.seasonPlace, tied: r.seasonTied })),
        PAYOUTS
      )
    : {}

  function scoreColor(n) {
    if (n == null) return 'text-gray-300'
    if (n < 0) return 'text-red-500'
    if (n > 0) return 'text-gray-900'
    return 'text-gray-500'
  }

  // Sort: null column = default standings order. Clicking a column sorts
  // best-first; clicking again flips to worst-first. Score/total columns are
  // lower=better; winnings is higher=better. Null values always go to the bottom.
  const SORT_COLUMNS = { masters: 0, pga: 1, usopen: 2, theopen: 3, total: null }
  const HIGHER_BETTER = new Set(['winnings'])
  function valueFor(row, col) {
    if (col === 'total') return row.seasonTotal
    if (col === 'winnings') return row.winnings + (seasonPayouts[row.name] ?? 0)
    const idx = SORT_COLUMNS[col]
    return row.perMajor[idx]?.total ?? null
  }
  const displayRows = (() => {
    if (!sortColumn) return seasonRanked
    const dir = sortDir === 'best' ? 1 : -1
    const orient = HIGHER_BETTER.has(sortColumn) ? -1 : 1 // winnings: higher is better
    return [...seasonRanked].sort((a, b) => {
      const av = valueFor(a, sortColumn)
      const bv = valueFor(b, sortColumn)
      if (av == null && bv == null) return 0
      if (av == null) return 1
      if (bv == null) return -1
      return dir * orient * (av - bv)
    })
  })()

  function SortHeader({ col, children, className = '' }) {
    const active = sortColumn === col
    const arrow = !active ? '' : sortDir === 'best' ? ' ↑' : ' ↓'
    const higherBetter = HIGHER_BETTER.has(col)
    const ariaSort = active
      ? (sortDir === 'best'
          ? (higherBetter ? 'descending' : 'ascending')
          : (higherBetter ? 'ascending' : 'descending'))
      : 'none'
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
        aria-sort={ariaSort}
        className={`py-2.5 px-2 text-right cursor-pointer select-none hover:bg-pine-100 ${className}`}
      >
        {children}{arrow}
      </th>
    )
  }

  return (
    <div>
      <div className="mb-4">
        <h2 className="text-2xl font-display font-semibold text-pine-900">2026 Season Standings</h2>
        <p className="text-sm text-gray-500">Cumulative Kim Cup score · Top 3 per major pay out</p>
      </div>

      <div className="overflow-x-auto rounded-xl border border-cream-200 bg-white shadow-sm">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-cream-200 text-xs text-pine-800 uppercase tracking-wider bg-pine-50 font-medium">
              <th className="py-2.5 px-3 text-left w-6">#</th>
              <th className="py-2.5 px-3 text-left">Name</th>
              <SortHeader col="masters">Masters</SortHeader>
              <SortHeader col="pga">PGA</SortHeader>
              <SortHeader col="usopen">US Open</SortHeader>
              <SortHeader col="theopen">The Open</SortHeader>
              <SortHeader col="total" className="font-bold text-pine-800">Total</SortHeader>
              <SortHeader col="winnings" className="font-bold text-pine-700">Winnings</SortHeader>
            </tr>
          </thead>
          <tbody>
            {displayRows.map((row) => {
              const totalWinnings = row.winnings + (seasonPayouts[row.name] ?? 0)
              return (
                <tr key={row.name} className="border-b border-cream-100 hover:bg-cream-50">
                  <td className="py-2.5 px-3 text-gray-400">
                    {row.seasonPlace != null
                      ? (row.seasonTied ? `T${row.seasonPlace}` : row.seasonPlace)
                      : '—'}
                  </td>
                  <td className="py-2.5 px-3 text-gray-800">{row.name}</td>
                  {row.perMajor.map((entry, j) => {
                    const badge = placeLabel(entry.place, entry.tied)
                    return (
                      <td key={j} className="py-2.5 px-2 text-right tabular-nums">
                        <div className="flex items-center justify-end gap-1">
                          {badge && (
                            <span className={`text-xs px-1 rounded font-medium ${badge.cls}`}>
                              {badge.label}
                            </span>
                          )}
                          <span className={scoreColor(entry.total)}>
                            {entry.total == null
                              ? <span className="text-gray-200">—</span>
                              : entry.locked
                                ? formatScore(entry.total)
                                : <span title="Live">{formatScore(entry.total)}*</span>
                            }
                          </span>
                        </div>
                      </td>
                    )
                  })}
                  <td className={`py-2.5 px-2 text-right tabular-nums font-bold ${scoreColor(row.seasonTotal)}`}>
                    {row.hasAnyScore ? formatScore(row.seasonTotal) : '—'}
                  </td>
                  <td className="py-2.5 px-3 text-right tabular-nums font-medium text-pine-700">
                    {totalWinnings > 0
                      ? `$${Number.isInteger(totalWinnings) ? totalWinnings : totalWinnings.toFixed(2)}`
                      : '—'}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      <div className="mt-3 flex flex-wrap gap-4 text-xs text-gray-400 justify-center">
        <span>* Live (in progress)</span>
        <span>Per-major payouts: 1st $462 · 2nd $231 · 3rd $77</span>
      </div>
    </div>
  )
}
