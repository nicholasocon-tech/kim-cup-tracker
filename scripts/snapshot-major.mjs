#!/usr/bin/env node
// Fetch an ESPN final leaderboard and write a completedResults entry into
// src/data/season-2026.json.
//
// Usage:
//   node scripts/snapshot-major.mjs --major "Masters" --date 20260412
//   node scripts/snapshot-major.mjs --major "PGA Championship" --date 20260519
//
// --major   Major name as it should appear in season-2026.json (canonical
//           set: "Masters", "PGA Championship", "U.S. Open", "The Open")
// --date    YYYYMMDD of the final round
// --dry     Print the snapshot without writing
//
// The script mirrors the parsing logic in src/utils/espn.js and derives the
// winner (lowest-total competitor with all 4 rounds played). Re-running
// replaces any existing entry for the same major.

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import {
  resolveKey,
  extractCompetitorRecord,
  detectCutBySegment,
} from '../src/utils/espn.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const REPO_ROOT = path.resolve(__dirname, '..')
const SEASON_FILE = path.join(REPO_ROOT, 'src/data/season-2026.json')
const VALID_MAJORS = ['Masters', 'PGA Championship', 'U.S. Open', 'The Open']

// Picks file per major. Snapshot embeds these into completedResults so locked
// standings stay correct even after the live `*-2026.json` for the next major
// overwrites the current participants array.
const PICKS_FILES = {
  'Masters': 'masters-2026.json',
  'PGA Championship': 'pga-2026.json',
  'U.S. Open': 'usopen-2026.json',
  'The Open': 'theopen-2026.json',
}

function parseArgs(argv) {
  const args = { dry: false }
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--dry') args.dry = true
    else if (arg === '--major') args.major = argv[++i]
    else if (arg === '--date') args.date = argv[++i]
    else throw new Error(`Unknown arg: ${arg}`)
  }
  if (!args.major) throw new Error('Missing --major')
  if (!args.date) throw new Error('Missing --date (YYYYMMDD)')
  if (!VALID_MAJORS.includes(args.major)) {
    throw new Error(`--major must be one of: ${VALID_MAJORS.join(', ')}`)
  }
  if (!/^\d{8}$/.test(args.date)) throw new Error('--date must be YYYYMMDD')
  return args
}

function matchesMajor(tournamentName, major) {
  const t = tournamentName.toLowerCase()
  if (major === 'Masters') return t.includes('masters')
  if (major === 'PGA Championship') return t.includes('pga championship')
  if (major === 'U.S. Open') return t.includes('u.s. open') || t.includes('us open')
  if (major === 'The Open') return t.includes('open championship') || t.includes('the open')
  return false
}

async function main() {
  const args = parseArgs(process.argv)
  const url = `https://site.api.espn.com/apis/site/v2/sports/golf/pga/scoreboard?dates=${args.date}`
  console.log(`Fetching ${url}`)
  const res = await fetch(url)
  if (!res.ok) throw new Error(`ESPN API error: ${res.status}`)
  const json = await res.json()
  const event = json.events?.[0]
  if (!event) throw new Error('No events returned for that date')
  if (!matchesMajor(event.name, args.major)) {
    throw new Error(
      `Event "${event.name}" does not match --major "${args.major}". ` +
      `Try a different date or fix --major.`
    )
  }
  if (event.status?.type?.name !== 'STATUS_FINAL') {
    console.warn(`WARNING: event status is ${event.status?.type?.name}, not STATUS_FINAL`)
  }

  const competitors = event.competitions?.[0]?.competitors ?? []
  const records = competitors.map(extractCompetitorRecord)

  // Final leaderboards expose the same MC segment as live R3+ play, so the
  // shared segment-break detector applies directly.
  const { cutLine, missedCutSet } = detectCutBySegment(records)

  const scores = {}
  records.forEach((r, idx) => {
    if (!r.displayName) return
    const key = resolveKey(r.displayName)
    scores[key] = {
      total: r.total,
      status: missedCutSet.has(idx) ? 'cut' : 'active',
      displayName: r.displayName,
      thru: r.thru,
    }
  })

  // Winner: lowest 72-hole total among players who finished all four rounds.
  // A tie at the top (playoff) is broken by ESPN's `order` field — the winner
  // is assigned order 1 — and we warn so a human can confirm the result, since
  // the winner drives the §5a payout tiebreaker.
  const finishers = records.filter((r) => {
    const sc = scores[resolveKey(r.displayName)]
    return sc && sc.status === 'active' && r.roundsPlayed >= 4
  })
  let winner = null
  let bestTotal = null
  if (finishers.length > 0) {
    bestTotal = Math.min(...finishers.map((r) => r.total))
    const tiedAtTop = finishers
      .filter((r) => r.total === bestTotal)
      .sort((a, b) => (a.order ?? Infinity) - (b.order ?? Infinity))
    winner = tiedAtTop[0].displayName
    if (tiedAtTop.length > 1) {
      console.warn(
        `WARNING: ${tiedAtTop.length}-way tie at ${bestTotal} for the win ` +
        `(${tiedAtTop.map((r) => r.displayName).join(', ')}). Using ESPN finishing ` +
        `order → "${winner}". Verify the playoff result before trusting payouts.`
      )
    }
  }

  const picksFile = PICKS_FILES[args.major]
  const picksPath = path.join(REPO_ROOT, 'src/data', picksFile)
  if (!fs.existsSync(picksPath)) {
    throw new Error(
      `Picks file ${picksFile} not found for ${args.major}. ` +
      `Create it (or update PICKS_FILES) before snapshotting.`
    )
  }
  const picksJson = JSON.parse(fs.readFileSync(picksPath, 'utf8'))

  const snapshot = {
    major: args.major,
    tournament: event.name,
    cutLine,
    winner,
    participants: picksJson.participants,
    scores,
  }

  const madeCut = Object.values(scores).filter((s) => s.status === 'active').length
  const missedCut = Object.values(scores).filter((s) => s.status === 'cut').length
  console.log(`\nTournament: ${snapshot.tournament}`)
  console.log(`Cut line: ${cutLine == null ? 'n/a' : (cutLine >= 0 ? '+' : '') + cutLine}`)
  console.log(`Winner: ${winner} (${bestTotal})`)
  console.log(`Made cut: ${madeCut} · Missed cut: ${missedCut}`)

  if (args.dry) {
    console.log('\n--dry: not writing')
    return
  }

  const existing = JSON.parse(fs.readFileSync(SEASON_FILE, 'utf8'))
  const filtered = (existing.completedResults ?? []).filter((r) => r.major !== args.major)
  existing.completedResults = [...filtered, snapshot]
  fs.writeFileSync(SEASON_FILE, JSON.stringify(existing, null, 2) + '\n')
  console.log(`\nWrote ${SEASON_FILE}`)
}

main().catch((e) => {
  console.error(`Error: ${e.message}`)
  process.exit(1)
})
