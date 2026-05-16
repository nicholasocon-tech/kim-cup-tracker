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

// 36-hole cut rules per major (no 10-shot rule — discontinued post-2020).
// Used to compute cutLine + MC status once R2 finishes, before ESPN's own
// segment sort kicks in (which only happens after R3 starts and made-cut
// totals start to diverge from preCutTotal).
const CUT_RULES = [
  { match: (t) => t.includes('masters'), topN: 50 },
  { match: (t) => t.includes('pga championship'), topN: 70 },
  { match: (t) => t.includes('u.s. open') || t.includes('us open'), topN: 60 },
  { match: (t) => t.includes('open championship') || t.includes('the open'), topN: 70 },
]

function lookupCutRule(tournamentName) {
  if (!tournamentName) return null
  const t = tournamentName.toLowerCase()
  return CUT_RULES.find((r) => r.match(t)) ?? null
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

    // "R2 fully complete" = this competitor has played all 18 holes of R2.
    // Using displayValue alone is a false positive (it appears mid-round),
    // so check the hole-by-hole linescores instead.
    const r2Holes = rounds[1]?.linescores?.length ?? 0
    const r2Full = r2Holes >= 18

    return { displayName, total, preCutTotal, thru, today, r2Full }
  })

  // Gate cut application to once R2 is fully played for ≥90% of the field
  // (90% tolerates WDs whose R2 never finishes).
  const r2FullCount = records.filter((r) => r.r2Full).length
  const cutApplied = records.length > 0 && r2FullCount / records.length > 0.9

  // Cut resolution has two paths depending on tournament stage:
  //
  // Path A — hardcoded rule (Friday night window). Once R2 is done but R3
  // hasn't started, every competitor's current total still equals their
  // R1+R2 preCutTotal, so ESPN's leaderboard is one flat ascending list with
  // no segment break to detect. We sort by preCutTotal, take top-N + ties
  // per the major's published cut rule, and mark the rest MC.
  //
  // Path B — segment-break (R3 onward). Once R3 starts, made-cut players'
  // current totals diverge from preCutTotal. ESPN keeps MC players in a
  // separate segment sorted by their frozen preCutTotal, so a total
  // decrease vs the previous competitor marks the MC segment start.
  let cutLine = null
  let missedCutSet = new Set()
  if (cutApplied) {
    const rule = lookupCutRule(tournament)
    if (rule) {
      const sortedByPreCut = [...records]
        .map((r, idx) => ({ idx, preCutTotal: r.preCutTotal }))
        .sort((a, b) => a.preCutTotal - b.preCutTotal)
      const ix = rule.topN - 1
      if (ix >= 0 && ix < sortedByPreCut.length) {
        cutLine = sortedByPreCut[ix].preCutTotal
        for (const r of sortedByPreCut) {
          if (r.preCutTotal > cutLine) missedCutSet.add(r.idx)
        }
      }
    }
    // Fallback: if no rule matched (or after R3 starts and we want to trust
    // ESPN's own segmentation), use the segment-break detection.
    if (cutLine == null) {
      let mcStart = -1
      for (let i = 1; i < records.length; i++) {
        if (records[i].total < records[i - 1].total) {
          mcStart = i
          break
        }
      }
      if (mcStart >= 0) {
        cutLine = records[mcStart].preCutTotal - 1
        for (let i = mcStart; i < records.length; i++) missedCutSet.add(i)
      }
    }
  }

  const scores = new Map()
  records.forEach((r, idx) => {
    if (!r.displayName) return
    const key = resolveKey(r.displayName)
    const isMissedCut = missedCutSet.has(idx)
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
