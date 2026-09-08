import { AgentChatroom } from './AgentChatroom'
import { AuthGate } from './components/AuthGate'

export default function App() {
  return <AuthGate><AgentChatroom /></AuthGate>
}
