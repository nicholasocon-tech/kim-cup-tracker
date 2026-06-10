// Shared major metadata, canonical roster, and tournament-name matching.
// Single source of truth for the four views (Tournament/Season/Jay Haas) so the
// major list, short labels, and ESPN name matching can't drift between them.

import mastersMeta from '../data/masters-2026.json'
import pgaMeta from '../data/pga-2026.json'
import usopenMeta from '../data/usopen-2026.json'
import theopenMeta from '../data/theopen-2026.json'
import participantsData from '../data/participants-2026.json'

// Canonical chronological order.
export const MAJORS = ['Masters', 'PGA Championship', 'U.S. Open', 'The Open']

// Short labels for selector pills.
export const SHORT_LABEL = {
  'Masters': 'Masters',
  'PGA Championship': 'PGA',
  'U.S. Open': 'US Open',
  'The Open': 'The Open',
}

// Per-major metadata + picks, pulled from each major's picks file. `participants`
// here is the live/most-recent picks set for that major; locked majors instead
// carry their own embedded `participants` snapshot in season-2026.json.
const META_BY_MAJOR = {
  'Masters': mastersMeta,
  'PGA Championship': pgaMeta,
  'U.S. Open': usopenMeta,
  'The Open': theopenMeta,
}

export const MAJOR_META = Object.fromEntries(
  MAJORS.map((m) => {
    const meta = META_BY_MAJOR[m]
    return [m, { course: meta.course, dates: meta.dates, participants: meta.participants }]
  })
)

// Canonical member roster — the rows the Season and Jay Haas tables iterate.
// Never derive the roster from a single major's picks file: a member absent
// from that file would silently vanish from the standings.
export const MEMBERS = participantsData.members

/**
 * Map an ESPN tournament name to its canonical major name, or null if the
 * current event isn't one of the four majors.
 */
export function matchMajor(tournamentName) {
  if (!tournamentName) return null
  const t = tournamentName.toLowerCase()
  if (t.includes('masters')) return 'Masters'
  if (t.includes('pga championship')) return 'PGA Championship'
  if (t.includes('u.s. open') || t.includes('us open')) return 'U.S. Open'
  if (t.includes('open championship') || t.includes('the open')) return 'The Open'
  return null
}

// Rehydrate a season-snapshot's plain `scores` object into the Map shape the
// scoring functions expect.
export function snapshotToScoresMap(snapshot) {
  return new Map(Object.entries(snapshot.scores))
}
