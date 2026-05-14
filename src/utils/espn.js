const ESPN_URL =
  'https://site.api.espn.com/apis/site/v2/sports/golf/pga/scoreboard'

export function normalizeName(name) {
  return name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

const NAME_OVERRIDES = {
  'haotong li': 'hao-tong li',
}

function resolveKey(name) {
  const norm = normalizeName(name)
  return NAME_OVERRIDES[norm] ?? norm
}

/**
 * Fetch the current PGA Tour scoreboard from ESPN.
 * Returns { scores: Map<normalizedName, ScoreData>, cutLine: number|null, tournament: string }
 *
 * ScoreData: { total: number, today: number|null, thru: string, status: 'active'|'cut'|'wd'|'dq' }
 *
 * Cut / MC detection:
 *   ESPN does NOT populate competition.situation.cutLine, and per-competitor
 *   status objects are empty. What ESPN *does* do is sort the competitors list
 *   as two segments after a cut: made-cut players first (ascending by current
 *   total), then missed-cut players (ascending by their pre-cut total). The
 *   second segment restarts at a lower score, so we find the cut by scanning
 *   for the first index where `score` decreases from the previous competitor.
 *   Cut line = (lowest pre-cut total in the MC segment) − 1.
 *
 * ESPN structure:
 *   competitor.score                = current total vs par as a string ("-12", "+4", "E")
 *   competitor.linescores[]         = one entry per round
 *   competitor.linescores[i].displayValue = vs-par score for that round ("-5")
 *   competitor.linescores[i].linescores[] = hole-by-hole for that round (18 entries when finished)
 */
export async function fetchScoreboard() {
  const res = await fetch(ESPN_URL)
  if (!res.ok) throw new Error(`ESPN API error: ${res.status}`)
  const json = await res.json()

  const event = json.events?.[0]
  if (!event) return { scores: new Map(), cutLine: null, tournament: '' }

  const tournament = event.name ?? ''
  const competition = event.competitions?.[0]
  const competitors = competition?.competitors ?? []

  // First pass: extract per-competitor raw data in list order.
  const records = competitors.map((comp) => {
    const displayName = comp.athlete?.displayName ?? ''
    const rounds = comp.linescores ?? []

    // Current total vs par — ESPN provides this directly on the competitor.
    const total = parseScore(comp.score)

    // Pre-cut total = sum of R1 and R2 display values. For made-cut players
    // this can differ from `total` once they start Round 3.
    let preCutTotal = 0
    for (let i = 0; i < Math.min(2, rounds.length); i++) {
      const dv = rounds[i]?.displayValue
      if (dv && dv !== '-') preCutTotal += parseScore(dv)
    }

    // Current-round progress: last round that has any hole data.
    let thru = '-'
    let today = null
    for (let i = rounds.length - 1; i >= 0; i--) {
      const round = rounds[i]
      const holes = round?.linescores ?? []
      if (holes.length > 0) {
        thru = holes.length >= 18 ? 'F' : String(holes.length)
        today = round.displayValue ? parseScore(round.displayValue) : null
        break
      }
    }

    // R2 completion is the signal for "cut has been applied" — ESPN only
    // re-sorts the leaderboard into MC/non-MC segments after R2 is done.
    const r2dv = rounds[1]?.displayValue
    const r2Complete = !!(r2dv && r2dv !== '-' && r2dv !== '')

    return { displayName, total, preCutTotal, thru, today, r2Complete }
  })

  // Gate: only run segment detection once the cut has actually been applied.
  // Pre-cut (during R1/R2), ESPN sorts unstarted (E) players to the end of
  // the leaderboard, AFTER in-progress over-par players. That creates a
  // false "total decreases" boundary which incorrectly marks every unstarted
  // player as missed cut. We avoid this by requiring ≥90% of the field to
  // have completed R2 (90% threshold tolerates a few WDs).
  const r2CompleteCount = records.filter((r) => r.r2Complete).length
  const cutApplied = records.length > 0 && r2CompleteCount / records.length > 0.9

  // Second pass: detect the cut segment boundary. ESPN re-sorts MC players
  // into their own ascending segment after made-cut players, so the first
  // place `total` drops vs the previous competitor marks the start of MC.
  let mcStart = -1
  if (cutApplied) {
    for (let i = 1; i < records.length; i++) {
      if (records[i].total < records[i - 1].total) {
        mcStart = i
        break
      }
    }
  }

  let cutLine = null
  if (mcStart >= 0) {
    // The first MC player is the one who most narrowly missed the cut,
    // so their pre-cut total is exactly cutLine + 1.
    cutLine = records[mcStart].preCutTotal - 1
  }

  // Build the output map with status resolved from the detected segment.
  const scores = new Map()
  records.forEach((r, idx) => {
    if (!r.displayName) return
    const key = resolveKey(r.displayName)
    const isMissedCut = mcStart >= 0 && idx >= mcStart
    scores.set(key, {
      total: r.total,
      today: r.today,
      thru: r.thru,
      status: isMissedCut ? 'cut' : 'active',
      displayName: r.displayName,
    })
  })

  return { scores, cutLine, tournament }
}

function parseScore(val) {
  if (val == null) return 0
  const s = String(val).trim()
  if (s === 'E' || s === '') return 0
  const n = Number(s)
  return isNaN(n) ? 0 : n
}
