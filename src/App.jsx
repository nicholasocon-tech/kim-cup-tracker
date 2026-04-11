import { useState } from 'react'
import TournamentView from './components/TournamentView.jsx'
import SeasonView from './components/SeasonView.jsx'
import JayHaasView from './components/JayHaasView.jsx'

const TABS = [
  { id: 'tournament', label: 'Tournament' },
  { id: 'season',     label: 'Season' },
  { id: 'jayhaas',    label: 'Jay Haas' },
]

export default function App() {
  const [tab, setTab] = useState('tournament')

  return (
    <div className="min-h-screen bg-white text-gray-900">
      {/* Header */}
      <header className="border-b border-gray-200 bg-white sticky top-0 z-10">
        <div className="max-w-2xl mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-xl">⛳</span>
            <span className="font-bold text-gray-900 tracking-tight">Kim Cup 2026</span>
          </div>
          <nav className="flex gap-1">
            {TABS.map((t) => (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                className={`px-3 py-1.5 rounded text-sm font-medium transition-colors ${
                  tab === t.id
                    ? 'bg-green-600 text-white'
                    : 'text-gray-500 hover:text-gray-900 hover:bg-gray-100'
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
      </main>
    </div>
  )
}
