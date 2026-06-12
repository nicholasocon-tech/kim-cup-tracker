import { useState, useEffect, useMemo, useRef } from 'react'
import { buildStandings, formatScore } from '../utils/scoring.js'
import { MAJORS, SHORT_LABEL, MAJOR_META, snapshotToScoresMap } from '../utils/majors.js'
import { useLiveScoreboard } from '../utils/useLiveScoreboard.js'
import ParticipantRow from './ParticipantRow.jsx'
import seasonData from '../data/season-2026.json'

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

function timeSince(date) {
  if (!date) return ''
  const secs = Math.floor((Date.now() - date) / 1000)
  if (secs < 60) return 'just now'
  const mins = Math.floor(secs / 60)
  return `${mins}m ago`
}

// Initial pill selection before the ESPN fetch resolves: first not-yet-locked
// major (the upcoming/in-progress one). This matches the live tournament most
// of the time and avoids a visible swap when the fetch returns.
function initialPick(lockedByMajor) {
  const open = MAJORS.find((m) => !lockedByMajor[m])
  return open ?? MAJORS[MAJORS.length - 1]
}

export default function TournamentView() {
  const lockedByMajor = useMemo(() => {
    const map = {}
    for (const r of seasonData.completedResults ?? []) map[r.major] = r
    return map
  }, [])

  const [selected, setSelected] = useState(() => initialPick(lockedByMajor))
  const userPickedRef = useRef(false)

  const {
    liveMajor,
    scores: liveScores,
    cutLine: liveCutLine,
    lastUpdated,
    loading,
    error,
    resolved,
    refresh,
  } = useLiveScoreboard()

  // Auto-target the right major once the scoreboard fetch resolves, unless
  // the user has already clicked a pill (then we respect their choice).
  useEffect(() => {
    if (!resolved || userPickedRef.current) return
    if (liveMajor) {
      setSelected(liveMajor)
    } else {
      const completed = MAJORS.filter((m) => lockedByMajor[m])
      if (completed.length > 0) setSelected(completed[completed.length - 1])
    }
  }, [resolved, liveMajor, lockedByMajor])

  function statusFor(major) {
    if (lockedByMajor[major]) return 'completed'
    if (liveMajor === major) return 'live'
    return 'upcoming'
  }

  function handlePillClick(major) {
    userPickedRef.current = true
    setSelected(major)
  }

  const status = statusFor(selected)
  const meta = MAJOR_META[selected]

  // Body content + the header-right indicator both depend on status.
  let body, rightIndicator
  if (status === 'completed') {
    const snap = lockedByMajor[selected]
    const participants = snap.participants ?? meta.participants
    const scoresMap = snapshotToScoresMap(snap)
    const standings = buildStandings(participants, scoresMap, snap.cutLine, snap.winner)
    const ownership = buildOwnership(participants)
    body = (
      <Leaderboard
        standings={standings}
        ownership={ownership}
        cutLine={snap.cutLine}
      />
    )
    rightIndicator = (
      <span className="text-xs px-2 py-1 rounded bg-gold-100 text-gold-700 font-medium">Final</span>
    )
  } else if (status === 'live') {
    const participants = meta.participants
    const standings = buildStandings(participants, liveScores, liveCutLine)
    const ownership = buildOwnership(participants)
    body = standings.length > 0 ? (
      <Leaderboard
        standings={standings}
        ownership={ownership}
        cutLine={liveCutLine}
      />
    ) : (
      <div className="text-center py-16 text-gray-400">Loading scores…</div>
    )
    rightIndicator = (
      <>
        {lastUpdated && (
          <span className="text-xs text-gray-400">Updated {timeSince(lastUpdated)}</span>
        )}
        <button
          onClick={refresh}
          disabled={loading}
          className="text-xs px-3 py-1.5 rounded-full bg-pine-50 hover:bg-pine-100 text-pine-700 disabled:opacity-50 transition-colors"
        >
          {loading ? 'Refreshing…' : 'Refresh'}
        </button>
      </>
    )
  } else {
    body = <UpcomingPlaceholder major={selected} meta={meta} />
    rightIndicator = (
      <span className="text-xs px-2 py-1 rounded bg-cream-100 text-gray-500 font-medium border border-cream-200">Upcoming</span>
    )
  }

  return (
    <div>
      {/* Major selector pills */}
      <div className="mb-4 flex gap-1.5 overflow-x-auto pb-1 -mx-1 px-1">
        {MAJORS.map((m) => {
          const s = statusFor(m)
          const isActive = m === selected
          const stateCls = isActive
            ? 'bg-pine-700 text-cream shadow-sm'
            : s === 'upcoming'
              ? 'bg-white text-gray-400 hover:bg-cream-100 border border-cream-200'
              : 'bg-pine-50 text-pine-800 hover:bg-pine-100'
          return (
            <button
              key={m}
              onClick={() => handlePillClick(m)}
              className={`px-3 py-1.5 rounded-full text-xs font-medium whitespace-nowrap transition-colors flex items-center gap-1.5 ${stateCls}`}
            >
              {s === 'live' && (
                <span className={`w-1.5 h-1.5 rounded-full ${isActive ? 'bg-white' : 'bg-red-500'} animate-pulse`} />
              )}
              {s === 'completed' && (
                <span className={`text-[10px] ${isActive ? 'text-gold-300' : 'text-gold-600'}`}>✓</span>
              )}
              <span>{SHORT_LABEL[m]}</span>
            </button>
          )
        })}
      </div>

      {/* Major header */}
      <div className="mb-4 flex items-center justify-between flex-wrap gap-2">
        <div>
          <h2 className="text-2xl font-display font-semibold text-pine-900">{selected} 2026</h2>
          <p className="text-sm text-gray-500">{meta.course} · {meta.dates}</p>
        </div>
        <div className="flex items-center gap-3">
          {status !== 'upcoming' && (() => {
            const cutLine = status === 'completed' ? lockedByMajor[selected].cutLine : liveCutLine
            return cutLine != null ? (
              <span className="text-sm text-gray-500">
                Cut: <span className="text-pine-900 font-medium">{formatScore(cutLine)}</span>
              </span>
            ) : null
          })()}
          {rightIndicator}
        </div>
      </div>

      {error && status === 'live' && (
        <div className="mb-4 p-3 rounded bg-red-50 border border-red-200 text-red-600 text-sm">
          Could not fetch live scores: {error}. Scores may be out of date.
        </div>
      )}

      {body}
    </div>
  )
}

function Leaderboard({ standings, ownership }) {
  return (
    <>
      <div className="overflow-x-auto rounded-xl border border-cream-200 bg-white shadow-sm">
        <table className="w-full">
          <thead>
            <tr className="border-b border-cream-200 text-xs text-pine-800 uppercase tracking-wider bg-pine-50 font-medium">
              <th className="py-2.5 px-3 text-left w-8">#</th>
              <th className="py-2.5 px-3 text-left">Player</th>
              <th className="py-2.5 px-3 text-right">Score</th>
              <th className="py-2.5 px-2 w-6" />
            </tr>
          </thead>
          <tbody>
            {standings.map((p) => (
              <ParticipantRow
                key={p.name}
                participant={p}
                rank={p.tied ? `T${p.place}` : p.place}
                ownership={ownership}
              />
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-4 text-xs text-gray-400 text-center">
        Best 5 of 8 picks count · Missed cut penalty = cut + 1 · Tap a row to see picks
      </p>
    </>
  )
}

function UpcomingPlaceholder({ major, meta }) {
  return (
    <div className="rounded-xl border border-cream-200 bg-cream-50 px-6 py-16 text-center">
      <div className="text-4xl mb-3">⛳</div>
      <div className="text-lg font-display font-semibold text-pine-900">{major} 2026</div>
      <div className="text-sm text-gray-500 mt-1">{meta.course} · {meta.dates}</div>
      <div className="mt-4 text-xs text-gray-400 max-w-xs mx-auto">
        Tournament hasn't started yet. Leaderboard and pick breakdowns will appear here when play begins.
      </div>
    </div>
  )
}
