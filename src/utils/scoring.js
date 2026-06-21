import { resolveKey } from './espn.js'

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
      const key = resolveKey(pick.player)
      const score = scores.get(key)
      const strokes = score ? score.total : 0
      return {
        ...pick,
        strokes,
        status: score ? 'active' : 'pending',
        thru: score?.thru ?? '-',
      }
    })
    const sorted = [...picks].sort((a, b) => a.strokes - b.strokes)
    const counting = sorted.slice(0, 5)
    const dropped = sorted.slice(5)
    // Flag counting picks by object identity, not by player+tier — a duplicated
    // player would otherwise mark both copies counting and double the total.
    const countingSet = new Set(counting)
    const annotated = picks.map((p) => ({ ...p, counting: countingSet.has(p) }))
    const total = counting.reduce((sum, p) => sum + p.strokes, 0)
    return { total, picks: annotated, counting, dropped }
  }

  const picks = participant.picks.map((pick) => {
    const key = resolveKey(pick.player)
    const score = scores.get(key)

    if (!score) {
      // Cut is in (CUT !== null) but this pick isn't in the ESPN field at all —
      // i.e. the golfer never entered the tournament (e.g. a stale pick left over
      // from an earlier tier sheet). A player who didn't tee it up can't have made
      // the cut, so he takes the missed-cut penalty like everyone below the line.
      return { ...pick, strokes: CUT + 1, status: 'mc', thru: '-' }
    }

    let strokes = score.total
    let status = score.status

    // espn.js / the snapshot script only ever emit 'cut' or 'active' (ESPN's
    // per-competitor status objects are empty, so WD/DQ aren't distinguished —
    // those players just land in the missed-cut segment).
    if (status === 'cut') {
      strokes = CUT + 1
      status = 'mc'
    } else if (strokes > CUT - 1) {
      // Rules §3: "the worst he can finish is one better (-1) than the
      // cut line" — any made-cut player with a total ≥ cut line gets
      // capped at cutLine - 1. (A player already at cutLine - 1 or
      // better keeps their actual score.)
      strokes = CUT - 1
      status = 'protected'
    }

    return {
      ...pick,
      strokes,
      status,
      thru: score.thru ?? '-',
    }
  })

  // Sort ascending (lower = better), then take best 5
  const sorted = [...picks].sort((a, b) => a.strokes - b.strokes)
  const counting = sorted.slice(0, 5)
  const dropped = sorted.slice(5)

  // Map back which original picks are counting vs dropped, by object identity
  // (see pre-cut branch — guards against a duplicated player double-counting).
  const countingSet = new Set(counting)
  const annotated = picks.map((p) => ({
    ...p,
    counting: countingSet.has(p),
  }))

  const total = counting.reduce((sum, p) => sum + p.strokes, 0)

  return { total, picks: annotated, counting, dropped }
}

export const PAYOUTS = { 1: 462, 2: 231, 3: 77 }

// A participant who submits no picks for a major fields a phantom team of all
// +5s (8 picks × +5, best 5 count) for a flat +25 penalty — no free pass for
// skipping. Applied wherever standings are built.
export const DNS_PER_PICK = 5
export const DNS_PENALTY = DNS_PER_PICK * 5

function penaltyResult() {
  return { total: DNS_PENALTY, picks: [], counting: [], dropped: [], noPicks: true }
}

function countCutsMade(participant, scores) {
  let count = 0
  for (const pick of participant.picks) {
    const score = scores.get(resolveKey(pick.player))
    if (score && score.status === 'active') count++
  }
  return count
}

function pickedWinner(participant, winnerName) {
  if (!winnerName) return false
  const target = resolveKey(winnerName)
  return participant.picks.some((pick) => resolveKey(pick.player) === target)
}

/**
 * Build standings sorted by Kim Cup score with tiebreakers applied.
 *
 * When `winnerName` is provided (tournament complete), per-week tiebreakers
 * resolve the 1st-place group only (rules §5):
 *   (a) Team that picked the tournament winner wins the week
 *   (b) Then most cuts made
 *   (c) If still tied → split (handled by calcPayouts)
 *
 * 2nd/3rd-place ties get NO tiebreaker per Payouts §2 — the pot is split.
 *
 * Each row gets `rank` (1..N display order), `place` (medal position; equal
 * for tied groups), and `tied` (boolean).
 */
export function buildStandings(participants, scores, cutLine, winnerName = null) {
  // A non-submitter (no picks) is assigned the +25 all-+5s penalty team and
  // ranks by it like everyone else — no longer dropped to the bottom unscored.
  const rows = participants
    .map((p) => {
      const noPicks = !p.picks || p.picks.length === 0
      return {
        ...p,
        result: noPicks ? penaltyResult() : calcParticipantScore(p, scores, cutLine),
        pickedWinner: pickedWinner(p, winnerName),
        cutsMade: countCutsMade(p, scores),
        noPicks,
      }
    })
    .sort((a, b) => a.result.total - b.result.total)

  let topGroup = []
  let demoted = []
  let rest = rows

  const tournamentComplete = winnerName != null
  if (tournamentComplete && rows.length > 1 && rows[0].result.total === rows[1].result.total) {
    const topScore = rows[0].result.total
    let i = 0
    while (i < rows.length && rows[i].result.total === topScore) i++
    topGroup = rows.slice(0, i)
    rest = rows.slice(i)

    const pickers = topGroup.filter((r) => r.pickedWinner)
    const nonPickers = topGroup.filter((r) => !r.pickedWinner)
    if (pickers.length > 0 && nonPickers.length > 0) {
      topGroup = pickers
      demoted = nonPickers
    }

    if (topGroup.length > 1) {
      const maxCuts = Math.max(...topGroup.map((r) => r.cutsMade))
      const top = topGroup.filter((r) => r.cutsMade === maxCuts)
      const lower = topGroup.filter((r) => r.cutsMade !== maxCuts)
      if (top.length > 0 && lower.length > 0) {
        topGroup = top
        demoted = [...lower, ...demoted]
      }
    }
  }

  const ordered = []
  for (const r of topGroup) {
    ordered.push({ ...r, place: 1, tied: topGroup.length > 1 })
  }
  if (demoted.length > 0) {
    const demotedPlace = 1 + topGroup.length
    for (const r of demoted) {
      ordered.push({ ...r, place: demotedPlace, tied: demoted.length > 1 })
    }
  }
  let nextPlace = topGroup.length + demoted.length + 1
  let j = 0
  while (j < rest.length) {
    let end = j
    while (end + 1 < rest.length && rest[end + 1].result.total === rest[j].result.total) end++
    const size = end - j + 1
    for (let k = j; k <= end; k++) {
      ordered.push({ ...rest[k], place: nextPlace, tied: size > 1 })
    }
    nextPlace += size
    j = end + 1
  }

  return ordered.map((p, i) => ({ ...p, rank: i + 1 }))
}

/**
 * Map place → payout per Payouts §2: tied finishers split the combined pot
 * of the positions they collectively occupy. T-2 (size 2) splits 2nd+3rd
 * evenly with no separate 3rd payout, etc.
 */
export function calcPayouts(rankedRows, payoutTable = PAYOUTS) {
  const result = {}
  const byPlace = new Map()
  for (const r of rankedRows) {
    // Skip unranked players (DNS, no score yet). null coerces to 0 in
    // arithmetic and would otherwise pull pot from the table.
    if (r.place == null) continue
    if (!byPlace.has(r.place)) byPlace.set(r.place, [])
    byPlace.get(r.place).push(r)
  }
  for (const [place, members] of byPlace) {
    if (place > 3) continue
    let pot = 0
    for (let p = place; p < place + members.length && p <= 3; p++) {
      pot += payoutTable[p] ?? 0
    }
    const each = pot / members.length
    for (const m of members) {
      result[m.name] = each
    }
  }
  return result
}

export function formatScore(n) {
  if (n == null) return '-'
  if (n === 0) return 'E'
  return n > 0 ? `+${n}` : String(n)
}
