const ESPN_URL =
  'https://site.api.espn.com/apis/site/v2/sports/golf/pga/scoreboard'

// Normalize player names for fuzzy matching:
// remove diacritics, lowercase, collapse whitespace
export function normalizeName(name) {
  return name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

// Some players are listed differently in ESPN vs our data
const NAME_OVERRIDES = {
  'haotong li': 'hao-tong li',
  'rasmus hojgaard': 'rasmus hojgaard',
  'nicolai hojgaard': 'nicolai hojgaard',
  'ludvig aberg': 'ludvig aberg',
  'angel cabrera': 'angel cabrera',
  'jose maria olazabal': 'jose maria olazabal',
  'naoyuki kataoka': 'naoyuki kataoka',
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

  const scores = new Map()
  let cutLine = null

  // Try to find cut line from competition details
  if (competition?.situation?.cutLine != null) {
    cutLine = competition.situation.cutLine
  }

  for (const comp of competitors) {
    const displayName = comp.athlete?.displayName ?? ''
    if (!displayName) continue

    const key = resolveKey(displayName)

    // status: active / cut / wd / dq
    const statusId = comp.status?.type?.id ?? ''
    const statusName = comp.status?.type?.name?.toLowerCase() ?? ''
    let status = 'active'
    if (statusName.includes('cut') || statusId === '8') status = 'cut'
    else if (statusName.includes('withdraw') || statusId === '7') status = 'wd'
    else if (statusName.includes('disqualif') || statusId === '9') status = 'dq'

    // Score vs par (total for tournament)
    const scoreStr = comp.score ?? comp.linescores?.[0]?.value ?? '0'
    const total = parseScore(scoreStr)

    // Today's round score
    const rounds = comp.linescores ?? []
    const todayRound = rounds[rounds.length - 1]
    const today = todayRound ? parseScore(todayRound.value ?? todayRound.displayValue) : null

    // Thru (holes completed this round)
    const thru = comp.status?.thru ?? todayRound?.period ?? ''

    scores.set(key, { total, today, thru: String(thru), status, displayName })
  }

  return { scores, cutLine, tournament }
}

function parseScore(val) {
  if (val == null) return 0
  const s = String(val).trim()
  if (s === 'E' || s === '') return 0
  const n = Number(s)
  return isNaN(n) ? 0 : n
}
