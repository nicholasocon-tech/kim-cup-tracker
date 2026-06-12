import { useState, useEffect } from 'react'
import TournamentView from './components/TournamentView.jsx'
import SeasonView from './components/SeasonView.jsx'
import JayHaasView from './components/JayHaasView.jsx'
import PicksView from './components/PicksView.jsx'
import lockConfig from './data/lock-config.json'

const ALL_TABS = [
  { id: 'tournament', label: 'Tournament' },
  { id: 'season',     label: 'Season' },
  { id: 'jayhaas',    label: 'Jay Haas' },
  { id: 'picks',      label: 'Picks' },
]

const lockAt = new Date(lockConfig.lockAt).getTime()

export default function App() {
  const [tab, setTab] = useState('tournament')

  // Re-check the lock on an interval so the Picks tab hides at lock time even
  // if the page has been left open (module-load evaluation would miss it).
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30000)
    return () => clearInterval(id)
  }, [])
  const TABS = now >= lockAt ? ALL_TABS.filter((t) => t.id !== 'picks') : ALL_TABS

  return (
    <div className="min-h-screen bg-cream text-pine-900">
      {/* Header */}
      <header className="bg-pine-800 text-cream sticky top-0 z-10 shadow-md">
        <div className="max-w-2xl mx-auto px-4 py-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-baseline gap-2 whitespace-nowrap">
            <span className="text-xl">⛳</span>
            <span className="font-display font-semibold text-lg tracking-tight text-cream">Kim Cup</span>
            <span className="font-display text-gold-500 text-sm">2026</span>
          </div>
          <nav className="flex gap-1 overflow-x-auto -mx-1 px-1">
            {TABS.map((t) => (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                className={`px-3 py-1.5 rounded-full text-sm font-medium whitespace-nowrap transition-colors ${
                  tab === t.id
                    ? 'bg-cream text-pine-800 shadow-sm'
                    : 'text-cream/70 hover:text-cream hover:bg-pine-700'
                }`}
              >
                {t.label}
              </button>
            ))}
          </nav>
        </div>
      </header>

      {/* Content */}
      <main className="max-w-2xl mx-auto px-4 py-6">
        {tab === 'tournament' && <TournamentView />}
        {tab === 'season'     && <SeasonView />}
        {tab === 'jayhaas'    && <JayHaasView />}
        {tab === 'picks'      && <PicksView />}
      </main>
    </div>
  )
}
