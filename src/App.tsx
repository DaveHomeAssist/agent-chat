import { useCallback, useState } from 'react'
import { AgentChatroom } from './AgentChatroom'
import { AuthGate } from './components/AuthGate'
import { toggleTheme, type AppTheme } from './lib/theme'

export default function App() {
  const [theme, setTheme] = useState<AppTheme>('light')
  const onToggleTheme = useCallback(() => setTheme((current) => toggleTheme(current)), [])

  return (
    <AuthGate theme={theme} onToggleTheme={onToggleTheme}>
      <AgentChatroom theme={theme} onToggleTheme={onToggleTheme} />
    </AuthGate>
  )
}
