import { normalizeName } from './espn.js'

/**
 * Calculate Kim Cup score for one participant.
 *
 * Rules:
 * - 8 picks; best 5 count, worst 3 are dropped
 * - Missed cut penalty = cutLine + 1
 * - Made cut but score > cutLine - 1 → protected at cutLine - 1
 * - Players not yet started = 0 (treated as E)
 *
 * @param {Object} participant  - { name, picks: [{player, tier}] }
 * @param {Map}    scores       - name→ScoreData from espn.js
 * @param {number|null} cutLine - cut line vs par (e.g. +1 = 1, -1 = -1)
 * @returns {{ total: number, picks: PickResult[], counting: PickResult[], dropped: PickResult[] }}
 */
export function calcParticipantScore(participant, scores, cutLine) {
  // Don't apply cut logic until we have a real cut line from ESPN
  const CUT = cutLine ?? null
  if (CUT === null) {
    // Pre-cut: just use raw scores, no MC penalty or protection
    const picks = participant.picks.map((pick) => {
      const key = normalizeName(pick.player)
      const score = scores.get(key)
      const strokes = score ? score.total : 0
      return {
        ...pick,
        strokes,
        status: score ? 'active' : 'pending',
        displayScore: score ? formatScore(score.total) : '-',
        thru: score?.thru ?? '-',
      }
    })
    const sorted = [...picks].sort((a, b) => a.strokes - b.strokes)
    const counting = sorted.slice(0, 5)
    const dropped = sorted.slice(5)
    const countingKeys = new Set(counting.map((p) => p.player + p.tier))
    const annotated = picks.map((p) => ({ ...p, counting: countingKeys.has(p.player + p.tier) }))
    const total = counting.reduce((sum, p) => sum + p.strokes, 0)
    return { total, picks: annotated, counting, dropped }
  }

  const picks = participant.picks.map((pick) => {
    const key = normalizeName(pick.player)
    const score = scores.get(key)

    if (!score) {
      // Player not found — not yet started or API mismatch
      return { ...pick, strokes: 0, status: 'pending', displayScore: 'E', thru: '-' }
    }

    let strokes = score.total
    let status = score.status

    if (status === 'cut' || status === 'wd' || status === 'dq') {
      strokes = CUT + 1
      status = 'mc'
    } else if (strokes > CUT) {
      // Made the cut but finished strictly worse than the cut line
      // → protected at one better than the cut line (rules §3)
      strokes = CUT - 1
      status = 'protected'
    }

    return {
      ...pick,
      strokes,
      status,
      displayScore: formatScore(score.total),
      thru: score.thru ?? '-',
    }
  })

  // Sort ascending (lower = better), then take best 5
  const sorted = [...picks].sort((a, b) => a.strokes - b.strokes)
  const counting = sorted.slice(0, 5)
  const dropped = sorted.slice(5)

  // Map back which original picks are counting vs dropped
  const countingKeys = new Set(counting.map((p) => p.player + p.tier))
  const annotated = picks.map((p) => ({
    ...p,
    counting: countingKeys.has(p.player + p.tier),
  }))

  const total = counting.reduce((sum, p) => sum + p.strokes, 0)

  return { total, picks: annotated, counting, dropped }
}

/**
 * Build standings: array of participants sorted by Kim Cup score (ascending).
 */
export function buildStandings(participants, scores, cutLine) {
  return participants
    .map((p) => ({ ...p, result: calcParticipantScore(p, scores, cutLine) }))
    .sort((a, b) => a.result.total - b.result.total)
    .map((p, i) => ({ ...p, rank: i + 1 }))
}

export function formatScore(n) {
  if (n == null) return '-'
  if (n === 0) return 'E'
  return n > 0 ? `+${n}` : String(n)
}
