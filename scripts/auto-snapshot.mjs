#!/usr/bin/env node
// Auto-snapshot any completed major that isn't yet in season-2026.json.
//
// Runs on a schedule (Mondays during major season) and on workflow_dispatch.
// For each major: if it's not in completedResults AND its final-round date is
// in the past, fetch ESPN and snapshot it (delegating to snapshot-major.mjs).
// Exits 0 on success; the GitHub Action commits + pushes any resulting diff.

import fs from 'fs'
import path from 'path'
import { execFileSync } from 'child_process'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const REPO_ROOT = path.resolve(__dirname, '..')
const SEASON_FILE = path.join(REPO_ROOT, 'src/data/season-2026.json')

const MAJORS = [
  { name: 'Masters',          picksFile: 'masters-2026.json' },
  { name: 'PGA Championship', picksFile: 'pga-2026.json' },
  { name: 'U.S. Open',        picksFile: 'usopen-2026.json' },
  { name: 'The Open',         picksFile: 'theopen-2026.json' },
]

// Final-round date = the END of the range. Handles single-month ranges
// ("May 14–17" → 20260517) and cross-month ranges ("May 30 – June 2" →
// 20260602), where the end day belongs to the trailing month.
function finalRoundYYYYMMDD(datesField, year) {
  const match = datesField.match(/^([A-Za-z]+)\s+\d+\s*[–-]\s*(?:([A-Za-z]+)\s+)?(\d+)$/)
  if (!match) throw new Error(`Can't parse dates field: "${datesField}"`)
  const [, startMonth, endMonth, endDay] = match
  const monthName = endMonth ?? startMonth
  const month = new Date(`${monthName} 1, ${year}`).getMonth() + 1
  if (isNaN(month) || month === 0) throw new Error(`Bad month "${monthName}"`)
  return `${year}${String(month).padStart(2, '0')}${String(endDay).padStart(2, '0')}`
}

function todayYYYYMMDD() {
  return new Date().toISOString().slice(0, 10).replaceAll('-', '')
}

function main() {
  const season = JSON.parse(fs.readFileSync(SEASON_FILE, 'utf8'))
  const lockedSet = new Set((season.completedResults ?? []).map((r) => r.major))
  const today = todayYYYYMMDD()

  let snapshotsMade = 0
  for (const m of MAJORS) {
    if (lockedSet.has(m.name)) {
      console.log(`✓ ${m.name}: already locked`)
      continue
    }
    const picksPath = path.join(REPO_ROOT, 'src/data', m.picksFile)
    if (!fs.existsSync(picksPath)) {
      console.log(`- ${m.name}: picks file not found, skipping`)
      continue
    }
    const picks = JSON.parse(fs.readFileSync(picksPath, 'utf8'))
    let date
    try {
      date = finalRoundYYYYMMDD(picks.dates, picks.year)
    } catch (e) {
      console.warn(`! ${m.name}: ${e.message}`)
      continue
    }
    if (date >= today) {
      console.log(`- ${m.name}: final round ${date} not in the past (today ${today})`)
      continue
    }
    console.log(`→ ${m.name}: snapshotting (final round ${date})`)
    execFileSync('node', [
      'scripts/snapshot-major.mjs',
      '--major', m.name,
      '--date', date,
    ], { cwd: REPO_ROOT, stdio: 'inherit' })
    snapshotsMade++
  }

  console.log(`\nDone. ${snapshotsMade} new snapshot(s).`)
}

main()
