import './styles/globals.css'
import React from 'react'
import ReactDOM from 'react-dom/client'
import { createHiveClient } from './api/hive-client'
import { setRendererRpcClient } from './api/rpc-client'
import { detectWebMode } from './api/environment'
import { hasStoredOwnerToken } from './api/web-auth'

const mount = (node: React.ReactNode): void => {
  ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
    <React.StrictMode>{node}</React.StrictMode>
  )
}

const renderApp = async (): Promise<void> => {
  const { default: App } = await import('./App')
  mount(<App />)
}

const renderLogin = async (): Promise<void> => {
  const { WebLogin } = await import('./components/auth/WebLogin')
  // On success the owner token is persisted; a full reload re-runs bootstrap,
  // which now takes the authenticated path and builds an owner-token client.
  mount(<WebLogin onAuthenticated={() => window.location.reload()} />)
}

const bootstrap = async (): Promise<void> => {
  // Hosted web client with no stored owner credential: gate on the Login screen
  // BEFORE creating a client, since there are no valid credentials to connect
  // with yet. Desktop + Vite-dev modes return false from detectWebMode() and
  // keep the original create-client-then-render path unchanged.
  if (detectWebMode() && !hasStoredOwnerToken()) {
    await renderLogin()
    return
  }

  try {
    const client = await createHiveClient()
    setRendererRpcClient(client)
  } catch (error) {
    console.error('Failed to initialize Hive HTTP client', error)
  } finally {
    await renderApp()
  }
}

void bootstrap()
