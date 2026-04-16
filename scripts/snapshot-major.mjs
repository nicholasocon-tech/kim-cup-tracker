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

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const REPO_ROOT = path.resolve(__dirname, '..')
const SEASON_FILE = path.join(REPO_ROOT, 'src/data/season-2026.json')
const VALID_MAJORS = ['Masters', 'PGA Championship', 'U.S. Open', 'The Open']

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

function normalizeName(name) {
  return name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function parseScore(val) {
  if (val == null) return 0
  const s = String(val).trim()
  if (s === 'E' || s === '') return 0
  const n = Number(s)
  return isNaN(n) ? 0 : n
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
  const records = competitors.map((comp) => {
    const displayName = comp.athlete?.displayName ?? ''
    const rounds = comp.linescores ?? []
    const total = parseScore(comp.score)
    let preCutTotal = 0
    for (let i = 0; i < Math.min(2, rounds.length); i++) {
      const dv = rounds[i]?.displayValue
      if (dv && dv !== '-') preCutTotal += parseScore(dv)
    }
    const roundsPlayed = rounds.filter((r) => (r?.linescores?.length ?? 0) > 0).length
    let thru = '-'
    for (let i = rounds.length - 1; i >= 0; i--) {
      const holes = rounds[i]?.linescores ?? []
      if (holes.length > 0) {
        thru = holes.length >= 18 ? 'F' : String(holes.length)
        break
      }
    }
    return { displayName, total, preCutTotal, thru, roundsPlayed }
  })

  let mcStart = -1
  for (let i = 1; i < records.length; i++) {
    if (records[i].total < records[i - 1].total) {
      mcStart = i
      break
    }
  }
  const cutLine = mcStart >= 0 ? records[mcStart].preCutTotal - 1 : null

  const scores = {}
  records.forEach((r, idx) => {
    if (!r.displayName) return
    const key = normalizeName(r.displayName)
    const isMissedCut = mcStart >= 0 && idx >= mcStart
    scores[key] = {
      total: r.total,
      status: isMissedCut ? 'cut' : 'active',
      displayName: r.displayName,
      thru: r.thru,
    }
  })

  let winner = null
  let bestTotal = Infinity
  for (const r of records) {
    const sc = scores[normalizeName(r.displayName)]
    if (!sc || sc.status !== 'active') continue
    if (r.roundsPlayed < 4) continue
    if (r.total < bestTotal) {
      bestTotal = r.total
      winner = r.displayName
    }
  }

  const snapshot = {
    major: args.major,
    tournament: event.name,
    cutLine,
    winner,
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
