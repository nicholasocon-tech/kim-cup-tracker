#!/usr/bin/env node
// Convert a commissioners' tier sheet CSV into the JSON shape the PicksView
// expects at src/data/<major>-2026-tiers.json.
//
// Usage:
//   node scripts/build-tiers.mjs \
//     --in  '/path/to/USOpenTiers_2026.csv' \
//     --out src/data/usopen-2026-tiers.json \
//     --tournament "U.S. Open"
//
// CSV shape (header optional):
//   Player,Tier
//   Scottie Scheffler,1
//   Rory McIlroy,1
//   ...
//
// Player names are written through unchanged — they should already be in the
// canonical form the front-end and Worker will compare against.

import fs from 'node:fs/promises'
import path from 'node:path'

function parseArgs(argv) {
  const args = {}
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--in') args.in = argv[++i]
    else if (a === '--out') args.out = argv[++i]
    else if (a === '--tournament') args.tournament = argv[++i]
    else if (a === '--year') args.year = Number(argv[++i])
    else throw new Error(`Unknown arg: ${a}`)
  }
  if (!args.in || !args.out || !args.tournament) {
    throw new Error('Required: --in <csv> --out <json> --tournament <name>')
  }
  args.year = args.year ?? 2026
  return args
}

function parseCsvLine(line) {
  // Naive CSV: split on first comma. Player names may contain commas (rare on
  // the PGA Tour), but the canonical sheets so far don't.
  const idx = line.indexOf(',')
  if (idx < 0) return null
  return [line.slice(0, idx).trim(), line.slice(idx + 1).trim()]
}

async function main() {
  const args = parseArgs(process.argv)
  const csv = await fs.readFile(args.in, 'utf8')
  const lines = csv.replace(/^﻿/, '').split(/\r?\n/).filter(Boolean)

  const tiers = { 1: [], 2: [], 3: [], 4: [] }
  let header = false
  let bad = []
  for (const line of lines) {
    const parsed = parseCsvLine(line)
    if (!parsed) continue
    const [player, tierStr] = parsed
    if (!header && /player/i.test(player) && /tier/i.test(tierStr)) {
      header = true
      continue
    }
    const tier = Number(tierStr)
    if (![1, 2, 3, 4].includes(tier)) {
      bad.push({ player, tierStr })
      continue
    }
    tiers[tier].push(player)
  }

  const output = {
    tournament: args.tournament,
    year: args.year,
    tiers,
  }
  await fs.writeFile(args.out, JSON.stringify(output, null, 2) + '\n', 'utf8')

  const counts = [1, 2, 3, 4].map((t) => `T${t}:${tiers[t].length}`).join(' ')
  console.log(`Wrote ${path.resolve(args.out)} (${counts})`)
  if (bad.length > 0) {
    console.warn(`⚠ Skipped ${bad.length} rows with non-numeric tier:`)
    for (const b of bad.slice(0, 5)) console.warn(`  ${b.player} | ${b.tierStr}`)
  }
}

main().catch((e) => {
  console.error(`Error: ${e.message}`)
  process.exit(1)
})
