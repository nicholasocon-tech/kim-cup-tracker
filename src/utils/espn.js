const ESPN_URL =
  'https://site.api.espn.com/apis/site/v2/sports/golf/pga/scoreboard'

export function normalizeName(name) {
  return name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
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

export function parseScore(val) {
  if (val == null) return 0
  const s = String(val).trim()
  if (s === 'E' || s === '') return 0
  const n = Number(s)
  return isNaN(n) ? 0 : n
}

/**
 * Extract the fields we need from one ESPN competitor object. Shared by the
 * live fetch (src) and the offline snapshot script (scripts/) so the two can't
 * drift apart.
 *
 * Returns: { displayName, total, preCutTotal, thru, today, r2Full, roundsPlayed }
 *   total        current total vs par (ESPN provides this directly)
 *   preCutTotal  R1 + R2 display values; diverges from total once R3 starts
 *   thru         '-' | hole count | 'F'
 *   today        current round's vs-par, or null
 *   r2Full       has this competitor played all 18 holes of R2?
 *   roundsPlayed number of rounds with any hole data
 *   order        ESPN finishing position (1 = leader/winner); null if absent
 */
export function extractCompetitorRecord(comp) {
  const displayName = comp.athlete?.displayName ?? ''
  const rounds = comp.linescores ?? []

  const total = parseScore(comp.score)

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

  // "R2 fully complete" = all 18 holes of R2 played. displayValue alone is a
  // false positive (it appears mid-round), so check hole-by-hole linescores.
  const r2Full = (rounds[1]?.linescores?.length ?? 0) >= 18
  const roundsPlayed = rounds.filter((r) => (r?.linescores?.length ?? 0) > 0).length

  return { displayName, total, preCutTotal, thru, today, r2Full, roundsPlayed, order: comp.order ?? null }
}

/**
 * Segment-break cut detection (R3 onward, and final leaderboards). Once R3
 * starts, made-cut players' current totals diverge from preCutTotal. ESPN keeps
 * MC players in a separate segment sorted by their frozen preCutTotal, so a
 * total decrease vs the previous competitor marks the MC segment start.
 * Cut line = (lowest pre-cut total in the MC segment) − 1.
 *
 * Returns { cutLine: number|null, missedCutSet: Set<index> }.
 */
export function detectCutBySegment(records) {
  let mcStart = -1
  for (let i = 1; i < records.length; i++) {
    if (records[i].total < records[i - 1].total) {
      mcStart = i
      break
    }
  }
  const missedCutSet = new Set()
  if (mcStart < 0) return { cutLine: null, missedCutSet }
  const cutLine = records[mcStart].preCutTotal - 1
  for (let i = mcStart; i < records.length; i++) missedCutSet.add(i)
  return { cutLine, missedCutSet }
}

/**
 * Fetch the current PGA Tour scoreboard from ESPN.
 * Returns { scores: Map<normalizedName, ScoreData>, cutLine: number|null, tournament: string }
 *
 * ScoreData: { total: number, today: number|null, thru: string, status: 'active'|'cut', displayName: string }
 *
 * Cut / MC detection has two paths:
 *   Path A — hardcoded rule (Friday night window). Once R2 is done but R3
 *   hasn't started, every total still equals R1+R2, so ESPN's leaderboard is
 *   one flat ascending list with no segment break. We sort by preCutTotal, take
 *   top-N + ties per the major's published cut rule, and mark the rest MC.
 *   Path B — segment-break (R3 onward) via detectCutBySegment.
 */
export async function fetchScoreboard() {
  const res = await fetch(ESPN_URL)
  if (!res.ok) throw new Error(`ESPN API error: ${res.status}`)
  const json = await res.json()

  const event = json.events?.[0]
  if (!event) return { scores: new Map(), cutLine: null, tournament: '' }

  const tournament = event.name ?? ''
  const competitors = event.competitions?.[0]?.competitors ?? []
  const records = competitors.map(extractCompetitorRecord)

  // Gate cut application to once R2 is fully played for ≥90% of the field
  // (90% tolerates WDs whose R2 never finishes).
  const r2FullCount = records.filter((r) => r.r2Full).length
  const cutApplied = records.length > 0 && r2FullCount / records.length > 0.9

  let cutLine = null
  let missedCutSet = new Set()
  if (cutApplied) {
    const rule = lookupCutRule(tournament)
    if (rule) {
      const sortedByPreCut = records
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
    // Fallback: no rule matched (or we want ESPN's own segmentation post-R3).
    if (cutLine == null) {
      ;({ cutLine, missedCutSet } = detectCutBySegment(records))
    }
  }

  const scores = new Map()
  records.forEach((r, idx) => {
    if (!r.displayName) return
    scores.set(resolveKey(r.displayName), {
      total: r.total,
      today: r.today,
      thru: r.thru,
      status: missedCutSet.has(idx) ? 'cut' : 'active',
      displayName: r.displayName,
    })
  })

  return { scores, cutLine, tournament }
}
