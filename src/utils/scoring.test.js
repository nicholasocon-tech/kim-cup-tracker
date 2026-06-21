import { describe, it, expect } from 'vitest'
import { normalizeName } from './espn.js'
import {
  calcParticipantScore,
  buildStandings,
  calcPayouts,
  formatScore,
  PAYOUTS,
  DNS_PENALTY,
} from './scoring.js'

// Build a scores Map keyed the way espn.js produces it: normalizeName(displayName).
// `entries` maps a display name → { total, status?, thru? }.
// NB: normalizeName strips digits, so fixture names must be distinct on letters
// alone (e.g. "Pick A", not "P1") or they collide onto one key.
function scoresFrom(entries) {
  const map = new Map()
  for (const [displayName, data] of Object.entries(entries)) {
    map.set(normalizeName(displayName), {
      total: data.total,
      status: data.status ?? 'active',
      thru: data.thru ?? 'F',
      displayName,
    })
  }
  return map
}

// Eight picks, 2 per tier, named "<prefix> a".."<prefix> h" (digit-free).
const LETTERS = 'abcdefgh'
function eightPicks(prefix) {
  return [1, 1, 2, 2, 3, 3, 4, 4].map((t, i) => [`${prefix} ${LETTERS[i]}`, t])
}
function participant(name, picks) {
  return { name, picks: picks.map(([player, tier]) => ({ player, tier })) }
}

describe('formatScore', () => {
  it('renders even, over, under, and null', () => {
    expect(formatScore(0)).toBe('E')
    expect(formatScore(3)).toBe('+3')
    expect(formatScore(-5)).toBe('-5')
    expect(formatScore(null)).toBe('-')
    expect(formatScore(undefined)).toBe('-')
  })
})

describe('calcParticipantScore — pre-cut (cutLine null)', () => {
  const p = participant('A', eightPicks('pick'))

  it('sums the best 5 of 8 by raw strokes', () => {
    const scores = scoresFrom({
      'pick a': { total: -5 }, 'pick b': { total: -3 }, 'pick c': { total: -2 },
      'pick d': { total: -1 }, 'pick e': { total: 0 }, 'pick f': { total: 2 },
      'pick g': { total: 4 }, 'pick h': { total: 6 },
    })
    const r = calcParticipantScore(p, scores, null)
    // best 5: -5,-3,-2,-1,0 = -11
    expect(r.total).toBe(-11)
    expect(r.counting).toHaveLength(5)
    expect(r.dropped).toHaveLength(3)
    expect(r.dropped.map((d) => d.player.slice(-1)).sort()).toEqual(['f', 'g', 'h'])
  })

  it('treats a not-yet-found player as pending (0 strokes) with no MC penalty', () => {
    const scores = scoresFrom({
      'pick a': { total: -5 }, 'pick b': { total: -3 }, 'pick c': { total: -2 },
      'pick d': { total: -1 }, 'pick e': { total: 2 }, 'pick f': { total: 4 },
      'pick g': { total: 6 }, // "pick h" absent → pending, counts as 0
    })
    const r = calcParticipantScore(p, scores, null)
    const last = r.picks.find((x) => x.player === 'pick h')
    expect(last.status).toBe('pending')
    expect(last.strokes).toBe(0)
    // best 5: -5,-3,-2,-1,0(pick h) = -11
    expect(r.total).toBe(-11)
  })
})

describe('calcParticipantScore — post-cut rules', () => {
  const CUT = 4 // cut line at +4
  const p = participant('A', [
    ['Made', 1], ['Cut', 1], ['Protected', 2], ['Exact', 2],
    ['Fill one', 3], ['Fill two', 3], ['Fill three', 4], ['Fill four', 4],
  ])

  const scores = scoresFrom({
    Made:      { total: -2 },                  // comfortably inside, kept as -2
    Cut:       { total: 7, status: 'cut' },    // missed cut → CUT+1 = 5
    Protected: { total: 10 },                  // made cut but ballooned → capped at CUT-1 = 3
    Exact:     { total: 4 },                   // sitting on the cut line → capped at CUT-1 = 3
    'Fill one': { total: 0 }, 'Fill two': { total: 1 },
    'Fill three': { total: 2 }, 'Fill four': { total: 3 },
  })

  const r = calcParticipantScore(p, scores, CUT)
  const byPlayer = Object.fromEntries(r.picks.map((x) => [x.player, x]))

  it('penalizes a missed cut at cutLine + 1 and marks it mc', () => {
    expect(byPlayer.Cut.strokes).toBe(CUT + 1)
    expect(byPlayer.Cut.status).toBe('mc')
  })

  it('caps a made-cut player who scored worse than cutLine - 1 (protection)', () => {
    expect(byPlayer.Protected.strokes).toBe(CUT - 1)
    expect(byPlayer.Protected.status).toBe('protected')
  })

  it('caps a player sitting exactly on the cut line at cutLine - 1', () => {
    expect(byPlayer.Exact.strokes).toBe(CUT - 1)
    expect(byPlayer.Exact.status).toBe('protected')
  })

  it('leaves a comfortable made-cut score untouched', () => {
    expect(byPlayer.Made.strokes).toBe(-2)
    expect(byPlayer.Made.status).toBe('active')
  })

  it('counts the best 5 after penalties/caps are applied', () => {
    // strokes: Made -2, Fill one 0, Fill two 1, Fill three 2, Fill four 3,
    //          Exact 3, Protected 3, Cut 5  → best 5 = -2,0,1,2,3 = 4
    expect(r.total).toBe(4)
  })

  it('penalizes a pick who never entered the field at cutLine + 1 (post-cut)', () => {
    // "Ghost" isn't in the scores map at all — a golfer who withdrew / was never
    // in the field (e.g. a stale pick from an earlier tier sheet). Once the cut
    // is in, he takes the missed-cut penalty rather than scoring a free 0.
    const ghostP = participant('A', [
      ['Made', 1], ['Ghost', 1], ['Fill a', 2], ['Fill b', 2],
      ['Fill c', 3], ['Fill d', 3], ['Fill e', 4], ['Fill f', 4],
    ])
    const ghostScores = scoresFrom({
      Made: { total: -2 },
      'Fill a': { total: 0 }, 'Fill b': { total: 1 }, 'Fill c': { total: 2 },
      'Fill d': { total: 3 }, 'Fill e': { total: 4 }, 'Fill f': { total: 5 },
      // "Ghost" deliberately absent
    })
    const gr = calcParticipantScore(ghostP, ghostScores, CUT)
    const ghost = gr.picks.find((x) => x.player === 'Ghost')
    expect(ghost.strokes).toBe(CUT + 1)
    expect(ghost.status).toBe('mc')
  })
})

describe('name aliasing — variant spellings resolve to one key', () => {
  const CUT = 4
  it('scores a "Matthew Fitzpatrick" pick against ESPN\'s "Matt Fitzpatrick"', () => {
    const p = participant('A', [
      ['Matthew Fitzpatrick', 1], ['Made', 1], ['Fill a', 2], ['Fill b', 2],
      ['Fill c', 3], ['Fill d', 3], ['Fill e', 4], ['Fill f', 4],
    ])
    const scores = scoresFrom({
      'Matt Fitzpatrick': { total: 3 }, // ESPN's spelling
      Made: { total: -2 },
      'Fill a': { total: 0 }, 'Fill b': { total: 1 }, 'Fill c': { total: 2 },
      'Fill d': { total: 6 }, 'Fill e': { total: 7 }, 'Fill f': { total: 8 },
    })
    const r = calcParticipantScore(p, scores, CUT)
    const fitz = r.picks.find((x) => x.player === 'Matthew Fitzpatrick')
    expect(fitz.strokes).toBe(3)
    expect(fitz.status).toBe('active')
  })
})

describe('calcParticipantScore — duplicate pick robustness', () => {
  // The Worker rejects duplicate golfers, but the scorer must still flag
  // counting picks correctly if a duplicate ever reaches the data: exactly 5
  // picks count, even when the two identical copies straddle the best-5 cut.
  it('flags exactly 5 counting picks when a duplicate straddles the boundary', () => {
    const p = participant('A', [
      ['Low one', 1], ['Low two', 1], ['Dup', 2], ['Dup', 2],
      ['Mid one', 3], ['High one', 3], ['High two', 4], ['High three', 4],
    ])
    const scores = scoresFrom({
      'Low one': { total: -3 }, 'Low two': { total: -2 },
      Dup: { total: 2 }, // both copies resolve here → 5th and 6th lowest
      'Mid one': { total: -1 }, 'High one': { total: 5 },
      'High two': { total: 6 }, 'High three': { total: 7 },
    })
    const r = calcParticipantScore(p, scores, null)
    const countingCount = r.picks.filter((x) => x.counting).length
    expect(countingCount).toBe(5)
    // best 5: -3,-2,-1,0... = -3,-2,-1,2,2 → wait, sorted: -3,-2,-1,2,2,5,6,7
    expect(r.total).toBe(-3 + -2 + -1 + 2 + 2)
  })
})

describe('buildStandings', () => {
  it('orders by total ascending and assigns sequential ranks/places', () => {
    const A = participant('A', eightPicks('a'))
    const B = participant('B', eightPicks('b'))
    const scores = scoresFrom({
      'a a': { total: -5 }, 'a b': { total: -5 }, 'a c': { total: -5 },
      'a d': { total: -5 }, 'a e': { total: -5 }, 'a f': { total: 0 },
      'a g': { total: 0 }, 'a h': { total: 0 },
      'b a': { total: 1 }, 'b b': { total: 1 }, 'b c': { total: 1 },
      'b d': { total: 1 }, 'b e': { total: 1 }, 'b f': { total: 0 },
      'b g': { total: 0 }, 'b h': { total: 0 },
    })
    const rows = buildStandings([A, B], scores, null)
    expect(rows.map((r) => r.name)).toEqual(['A', 'B']) // A: -25, B: 5
    expect(rows[0].place).toBe(1)
    expect(rows[1].place).toBe(2)
    expect(rows.every((r) => !r.tied)).toBe(true)
    expect(rows.map((r) => r.rank)).toEqual([1, 2])
  })

  it('gives a non-submitter the +25 penalty team and ranks them by it', () => {
    const A = participant('A', eightPicks('a'))
    const NP = { name: 'Zed', picks: [] }
    const scores = scoresFrom({
      'a a': { total: -1 }, 'a b': { total: -1 }, 'a c': { total: -1 },
      'a d': { total: -1 }, 'a e': { total: -1 }, 'a f': { total: 0 },
      'a g': { total: 0 }, 'a h': { total: 0 },
    })
    const rows = buildStandings([NP, A], scores, null)
    const zed = rows.find((r) => r.name === 'Zed')
    expect(DNS_PENALTY).toBe(25)            // 8 picks × +5, best 5 = +25
    expect(zed.noPicks).toBe(true)
    expect(zed.result.total).toBe(DNS_PENALTY)
    expect(zed.place).toBe(2)               // ranked, not dumped to null
    expect(rows[0].name).toBe('A')          // real (better) score still on top
  })

  it('marks a live tie (no winner yet) as a shared place', () => {
    const A = participant('A', eightPicks('a'))
    const B = participant('B', eightPicks('b'))
    const flat = {}
    for (const k of ['a', 'b']) for (const c of LETTERS) flat[`${k} ${c}`] = { total: 0 }
    const rows = buildStandings([A, B], scoresFrom(flat), null)
    expect(rows.map((r) => r.place)).toEqual([1, 1])
    expect(rows.every((r) => r.tied)).toBe(true)
  })

  it('breaks a completed 1st-place tie by who picked the winner (§5a)', () => {
    // Both finish even; A picked the winner "Champ", B did not.
    const A = participant('A', [
      ['Champ', 1], ['a b', 1], ['a c', 2], ['a d', 2],
      ['a e', 3], ['a f', 3], ['a g', 4], ['a h', 4],
    ])
    const B = participant('B', eightPicks('b'))
    const flat = { Champ: { total: 0 } }
    for (const c of LETTERS.slice(1)) flat[`a ${c}`] = { total: 0 }
    for (const c of LETTERS) flat[`b ${c}`] = { total: 0 }
    const rows = buildStandings([A, B], scoresFrom(flat), null, 'Champ')
    expect(rows[0].name).toBe('A')
    expect(rows[0].place).toBe(1)
    expect(rows[0].tied).toBe(false)
    expect(rows[1].name).toBe('B')
    expect(rows[1].place).toBe(2)
  })

  it('breaks a completed tie by most cuts made when neither picked the winner (§5b)', () => {
    const CUT = 5
    // A: 8 made cuts. Best 5 = -3,-2,-1,0,1 = -5; rest (2,3,4) dropped.
    const A = participant('A', eightPicks('a'))
    // B: same best 5, but one pick missed the cut (penalty 6, dropped) → 7 cuts.
    const B = participant('B', eightPicks('b'))
    const flat = {
      'a a': { total: -3 }, 'a b': { total: -2 }, 'a c': { total: -1 },
      'a d': { total: 0 }, 'a e': { total: 1 }, 'a f': { total: 2 },
      'a g': { total: 3 }, 'a h': { total: 4 },
      'b a': { total: -3 }, 'b b': { total: -2 }, 'b c': { total: -1 },
      'b d': { total: 0 }, 'b e': { total: 1 }, 'b f': { total: 2 },
      'b g': { total: 3 }, 'b h': { total: 99, status: 'cut' }, // → CUT+1=6, dropped
    }
    const rows = buildStandings([A, B], scoresFrom(flat), CUT, 'Nobody')
    const a = rows.find((r) => r.name === 'A')
    const b = rows.find((r) => r.name === 'B')
    expect(a.result.total).toBe(b.result.total) // genuine tie on score (-5 each)
    expect(a.cutsMade).toBe(8)
    expect(b.cutsMade).toBe(7)
    expect(a.place).toBe(1) // more cuts → wins the week
    expect(b.place).toBe(2)
  })
})

describe('calcPayouts', () => {
  it('pays solo 1st/2nd/3rd straight off the table', () => {
    const rows = [
      { name: 'A', place: 1 }, { name: 'B', place: 2 },
      { name: 'C', place: 3 }, { name: 'D', place: 4 },
    ]
    expect(calcPayouts(rows)).toEqual({ A: 462, B: 231, C: 77 })
  })

  it('splits the 1st+2nd pot evenly for a two-way T-1', () => {
    const rows = [
      { name: 'A', place: 1 }, { name: 'B', place: 1 }, { name: 'C', place: 3 },
    ]
    const pot = (PAYOUTS[1] + PAYOUTS[2]) / 2 // 346.5
    expect(calcPayouts(rows)).toEqual({ A: pot, B: pot, C: PAYOUTS[3] })
  })

  it('splits the 2nd+3rd pot for a two-way T-2 with no separate 3rd', () => {
    const rows = [
      { name: 'A', place: 1 }, { name: 'B', place: 2 }, { name: 'C', place: 2 },
    ]
    const pot = (PAYOUTS[2] + PAYOUTS[3]) / 2 // 154
    expect(calcPayouts(rows)).toEqual({ A: 462, B: pot, C: pot })
  })

  it('ignores places past 3 and unranked (null place) rows', () => {
    const rows = [
      { name: 'A', place: 1 }, { name: 'B', place: 2 }, { name: 'C', place: 3 },
      { name: 'D', place: 4 }, { name: 'Z', place: null },
    ]
    const out = calcPayouts(rows)
    expect(out.D).toBeUndefined()
    expect(out.Z).toBeUndefined()
  })
})
