import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { fetchScoreboard } from '../utils/espn.js'
import { buildStandings, formatScore } from '../utils/scoring.js'
import ParticipantRow from './ParticipantRow.jsx'
import seasonData from '../data/season-2026.json'
import mastersMeta from '../data/masters-2026.json'
import pgaMeta from '../data/pga-2026.json'
import usopenMeta from '../data/usopen-2026.json'
import theopenMeta from '../data/theopen-2026.json'

const REFRESH_MS = 5 * 60 * 1000

const MAJORS_ORDER = ['Masters', 'PGA Championship', 'U.S. Open', 'The Open']

// Short labels for the selector pills.
const SHORT_LABEL = {
  'Masters': 'Masters',
  'PGA Championship': 'PGA',
  'U.S. Open': 'US Open',
  'The Open': 'The Open',
}

// Per-major metadata pulled from each major's picks file.
const MAJOR_META = {
  'Masters':          { course: mastersMeta.course, dates: mastersMeta.dates, participants: mastersMeta.participants },
  'PGA Championship': { course: pgaMeta.course,     dates: pgaMeta.dates,     participants: pgaMeta.participants },
  'U.S. Open':        { course: usopenMeta.course,  dates: usopenMeta.dates,  participants: usopenMeta.participants },
  'The Open':         { course: theopenMeta.course, dates: theopenMeta.dates, participants: theopenMeta.participants },
}

function matchMajor(tournamentName) {
  if (!tournamentName) return null
  const t = tournamentName.toLowerCase()
  if (t.includes('masters')) return 'Masters'
  if (t.includes('pga championship')) return 'PGA Championship'
  if (t.includes('u.s. open') || t.includes('us open')) return 'U.S. Open'
  if (t.includes('open championship') || t.includes('the open')) return 'The Open'
  return null
}

function snapshotToScoresMap(snapshot) {
  return new Map(Object.entries(snapshot.scores))
}

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
  const open = MAJORS_ORDER.find((m) => !lockedByMajor[m])
  return open ?? MAJORS_ORDER[MAJORS_ORDER.length - 1]
}

export default function TournamentView() {
  const lockedByMajor = useMemo(() => {
    const map = {}
    for (const r of seasonData.completedResults ?? []) map[r.major] = r
    return map
  }, [])

  const [selected, setSelected] = useState(() => initialPick(lockedByMajor))
  const userPickedRef = useRef(false)

  const [liveMajor, setLiveMajor] = useState(null)
  const [liveScores, setLiveScores] = useState(new Map())
  const [liveCutLine, setLiveCutLine] = useState(null)
  const [lastUpdated, setLastUpdated] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [resolved, setResolved] = useState(false)

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const { scores, cutLine, tournament } = await fetchScoreboard()
      const m = matchMajor(tournament)
      // A major is "live" only if ESPN reports it and we haven't locked it.
      if (m && !lockedByMajor[m]) {
        setLiveMajor(m)
        setLiveScores(scores)
        setLiveCutLine(cutLine)
      } else {
        setLiveMajor(null)
        setLiveScores(new Map())
        setLiveCutLine(null)
      }
      setLastUpdated(new Date())
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
      setResolved(true)
    }
  }, [lockedByMajor])

  useEffect(() => {
    refresh()
    const id = setInterval(refresh, REFRESH_MS)
    return () => clearInterval(id)
  }, [refresh])

  // Auto-target the right major once the scoreboard fetch resolves, unless
  // the user has already clicked a pill (then we respect their choice).
  useEffect(() => {
    if (!resolved || userPickedRef.current) return
    if (liveMajor) {
      setSelected(liveMajor)
    } else {
      const completed = MAJORS_ORDER.filter((m) => lockedByMajor[m])
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
      <span className="text-xs px-2 py-1 rounded bg-green-100 text-green-700 font-medium">Final</span>
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
          className="text-xs px-3 py-1.5 rounded bg-gray-100 hover:bg-gray-200 text-gray-600 disabled:opacity-50 transition-colors"
        >
          {loading ? 'Refreshing…' : 'Refresh'}
        </button>
      </>
    )
  } else {
    body = <UpcomingPlaceholder major={selected} meta={meta} />
    rightIndicator = (
      <span className="text-xs px-2 py-1 rounded bg-gray-100 text-gray-500 font-medium">Upcoming</span>
    )
  }

  return (
    <div>
      {/* Major selector pills */}
      <div className="mb-4 flex gap-1.5 overflow-x-auto pb-1 -mx-1 px-1">
        {MAJORS_ORDER.map((m) => {
          const s = statusFor(m)
          const isActive = m === selected
          const stateCls = isActive
            ? 'bg-green-600 text-white shadow-sm'
            : s === 'upcoming'
              ? 'bg-gray-50 text-gray-400 hover:bg-gray-100 border border-gray-200'
              : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
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
                <span className={`text-[10px] ${isActive ? 'text-white' : 'text-green-600'}`}>✓</span>
              )}
              <span>{SHORT_LABEL[m]}</span>
            </button>
          )
        })}
      </div>

      {/* Major header */}
      <div className="mb-4 flex items-center justify-between flex-wrap gap-2">
        <div>
          <h2 className="text-xl font-bold text-gray-900">{selected} 2026</h2>
          <p className="text-sm text-gray-500">{meta.course} · {meta.dates}</p>
        </div>
        <div className="flex items-center gap-3">
          {status !== 'upcoming' && (() => {
            const cutLine = status === 'completed' ? lockedByMajor[selected].cutLine : liveCutLine
            return cutLine != null ? (
              <span className="text-sm text-gray-500">
                Cut: <span className="text-gray-900 font-medium">{formatScore(cutLine)}</span>
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
    <div className="rounded-lg border border-gray-200 bg-gray-50 px-6 py-16 text-center">
      <div className="text-4xl mb-3">⛳</div>
      <div className="text-base font-medium text-gray-700">{major} 2026</div>
      <div className="text-sm text-gray-500 mt-1">{meta.course} · {meta.dates}</div>
      <div className="mt-4 text-xs text-gray-400 max-w-xs mx-auto">
        Tournament hasn't started yet. Leaderboard and pick breakdowns will appear here when play begins.
      </div>
    </div>
  )
}
