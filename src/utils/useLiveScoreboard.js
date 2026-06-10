import { useState, useEffect, useCallback } from 'react'
import { fetchScoreboard } from './espn.js'
import { matchMajor } from './majors.js'
import seasonData from '../data/season-2026.json'

const REFRESH_MS = 5 * 60 * 1000

function isLocked(major) {
  return (seasonData.completedResults ?? []).some((r) => r.major === major)
}

/**
 * Poll the ESPN scoreboard on a fixed interval and expose the live major's
 * scores. A major is "live" only if ESPN reports it AND it isn't already locked
 * in season-2026.json (a locked major is served from its frozen snapshot, not
 * live). Shared by the Tournament, Season, and Jay Haas views.
 *
 * Returns:
 *   liveMajor   canonical major name, or null when no major is live
 *   scores      Map<normalizedName, ScoreData> (empty when not live)
 *   cutLine     number|null
 *   lastUpdated Date|null   timestamp of the last successful fetch
 *   loading     boolean     a fetch is in flight
 *   error       string|null last fetch error message
 *   resolved    boolean     at least one fetch has completed
 *   refresh     ()=>Promise manual refetch
 */
export function useLiveScoreboard() {
  const [data, setData] = useState({ liveMajor: null, scores: new Map(), cutLine: null })
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
      if (m && !isLocked(m)) {
        setData({ liveMajor: m, scores, cutLine })
      } else {
        setData({ liveMajor: null, scores: new Map(), cutLine: null })
      }
      setLastUpdated(new Date())
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
      setResolved(true)
    }
  }, [])

  useEffect(() => {
    refresh()
    const id = setInterval(refresh, REFRESH_MS)
    return () => clearInterval(id)
  }, [refresh])

  return { ...data, lastUpdated, loading, error, resolved, refresh }
}
