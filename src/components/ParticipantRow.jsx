import { useState } from 'react'
import { formatScore } from '../utils/scoring.js'

const TIER_COLORS = {
  1: 'text-gold-600',
  2: 'text-blue-500',
  3: 'text-pine-600',
  4: 'text-gray-400',
}

const STATUS_BADGE = {
  mc:        { label: 'MC',  cls: 'bg-red-100 text-red-600' },
  protected: { label: 'P',   cls: 'bg-orange-100 text-orange-600' },
  pending:   { label: '-',   cls: 'bg-gray-100 text-gray-400' },
  active:    { label: null,  cls: '' },
}

function scoreColor(n) {
  if (n == null) return 'text-gray-400'
  if (n < 0) return 'text-red-500'
  if (n > 0) return 'text-gray-900'
  return 'text-gray-500'
}

export default function ParticipantRow({ participant, rank, ownership = {} }) {
  const [open, setOpen] = useState(false)
  const { result, noPicks } = participant
  const total = result.total
  const isLeader = participant.place === 1

  return (
    <>
      {/* Summary row */}
      <tr
        className={`cursor-pointer transition-colors border-b ${
          isLeader
            ? 'bg-gold-50 hover:bg-gold-100 border-gold-300'
            : 'border-cream-200 hover:bg-cream-50'
        }`}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen((o) => !o) }
        }}
        tabIndex={0}
        role="button"
        aria-expanded={open}
      >
        <td className={`py-3 px-3 text-sm w-8 ${isLeader ? 'text-gold-700 font-semibold' : 'text-gray-400'}`}>{rank}</td>
        <td className="py-3 px-3 font-medium text-pine-900">
          <span className="flex items-center gap-1.5">
            {participant.name}
            {isLeader && <span className="text-gold-500" title="Leader">🏆</span>}
            {noPicks && (
              <span
                className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-cream-200 text-gray-500"
                title="No picks submitted — +5 penalty team"
              >
                NO PICKS
              </span>
            )}
          </span>
        </td>
        <td className={`py-3 px-3 text-right font-bold tabular-nums text-lg ${scoreColor(total)}`}>
          {formatScore(total)}
        </td>
        <td className={`py-3 px-2 text-right text-sm w-6 ${isLeader ? 'text-gold-500' : 'text-gray-400'}`}>
          {open ? '▲' : '▼'}
        </td>
      </tr>

      {/* Expanded picks */}
      {open && (
        <tr className="bg-cream-50">
          <td colSpan={4} className="px-3 pb-3 pt-1">
            {noPicks ? (
              <div className="text-sm text-gray-500 py-2">
                No picks submitted — penalty team of 8 × +5.{' '}
                <span className={`font-bold ${scoreColor(total)}`}>Best 5 = {formatScore(total)}</span>
              </div>
            ) : (
              <>
            <div className="grid grid-cols-1 gap-1">
              {[...result.picks].sort((a, b) => a.strokes - b.strokes).map((pick, i) => {
                const badge = STATUS_BADGE[pick.status] ?? STATUS_BADGE.active
                const isCounting = pick.counting
                return (
                  <div
                    key={i}
                    className={`flex items-center gap-2 text-sm py-1 border-b border-cream-200 last:border-0 ${
                      isCounting ? '' : 'opacity-40'
                    }`}
                  >
                    {/* Counting indicator */}
                    <span className="w-4 text-center">
                      {isCounting ? (
                        <span className="text-pine-600 text-xs">✓</span>
                      ) : (
                        <span className="text-gray-300 text-xs">✗</span>
                      )}
                    </span>

                    {/* Tier badge */}
                    <span className={`text-xs font-mono w-4 ${TIER_COLORS[pick.tier]}`}>
                      T{pick.tier}
                    </span>

                    {/* Player name */}
                    <span className="flex-1 text-gray-800">{pick.player}</span>

                    {/* Ownership */}
                    {ownership[pick.player] != null && (
                      <span className="text-gray-400 text-xs w-10 text-right">
                        {ownership[pick.player]}%
                      </span>
                    )}

                    {/* Status badge */}
                    {badge.label && (
                      <span className={`text-xs px-1 rounded ${badge.cls}`}>{badge.label}</span>
                    )}

                    {/* Score + Thru */}
                    <span className={`tabular-nums text-right font-medium ${scoreColor(pick.strokes)}`}>
                      {pick.status === 'pending'
                        ? <span className="text-gray-400">-</span>
                        : <>
                            {formatScore(pick.strokes)}
                            {pick.thru && pick.thru !== '-' && (
                              <span className="text-gray-400 font-normal text-xs ml-1">
                                ({pick.thru === 'F' ? 'F' : `thru ${pick.thru}`})
                              </span>
                            )}
                          </>
                      }
                    </span>
                  </div>
                )
              })}
            </div>

            {/* Score breakdown */}
            <div className="mt-2 pt-2 border-t border-cream-200 text-xs text-gray-400 flex gap-4">
              <span>Best 5 of 8 count</span>
              <span className={`font-bold ${scoreColor(total)}`}>
                Total: {formatScore(total)}
              </span>
            </div>
              </>
            )}
          </td>
        </tr>
      )}
    </>
  )
}
