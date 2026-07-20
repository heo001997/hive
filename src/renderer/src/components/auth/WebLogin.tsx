import { useState, type FormEvent } from 'react'
import { exchangeOwnerToken, OwnerAuthError } from '@hive/client'
import { resolveBackendTarget } from '@/api/environment'
import { storeOwnerToken } from '@/api/web-auth'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

// Owner-token login gate for a hosted web Hive (Decision A: self-host single
// owner). Shown ONLY in browser mode when no owner token is stored yet. On
// submit it validates the pasted token against `/api/auth/owner-exchange` via
// `@hive/client`; on success it persists the token (localStorage) and hands off
// to `onAuthenticated`. On 401/403 it shows a clear, retry-able error.
//
// The token is treated as a root secret: it is only ever read from the password
// input and passed to `exchangeOwnerToken` / `storeOwnerToken`. It is never
// logged and never rendered back to the DOM.

export interface WebLoginProps {
  /** Called once the owner token is validated and persisted. */
  readonly onAuthenticated: () => void
}

const messageForError = (error: unknown): string => {
  if (error instanceof OwnerAuthError) {
    if (error.status === 403) {
      return 'Owner-token login is not enabled on this server.'
    }
    if (error.status === 401) {
      return 'That owner token was not accepted. Check it and try again.'
    }
    return 'Could not sign in with that owner token.'
  }
  return 'Could not reach the Hive server. Check your connection and try again.'
}

export function WebLogin({ onAuthenticated }: WebLoginProps): React.JSX.Element {
  const [token, setToken] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const handleSubmit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    const trimmed = token.trim()
    if (!trimmed || submitting) return

    setSubmitting(true)
    setError(null)
    try {
      const target = await resolveBackendTarget()
      await exchangeOwnerToken(target.httpBaseUrl, trimmed)
      storeOwnerToken(trimmed)
      onAuthenticated()
    } catch (caught) {
      setError(messageForError(caught))
      setSubmitting(false)
    }
  }

  return (
    <div className="flex min-h-screen w-full items-center justify-center bg-background px-4 text-foreground">
      <form
        onSubmit={(event) => {
          void handleSubmit(event)
        }}
        className="w-full max-w-sm space-y-6 rounded-xl border border-border bg-card p-8 shadow-sm"
      >
        <div className="space-y-1.5">
          <h1 className="text-lg font-semibold">Sign in to Hive</h1>
          <p className="text-sm text-muted-foreground">
            Enter your owner token to connect to this Hive server.
          </p>
        </div>

        <div className="space-y-2">
          <Input
            type="password"
            autoFocus
            autoComplete="off"
            spellCheck={false}
            placeholder="Owner token"
            aria-label="Owner token"
            aria-invalid={error ? true : undefined}
            value={token}
            disabled={submitting}
            onChange={(event) => {
              setToken(event.target.value)
              if (error) setError(null)
            }}
          />
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
        </div>

        <Button type="submit" className="w-full" disabled={submitting || !token.trim()}>
          {submitting ? 'Connecting…' : 'Connect'}
        </Button>
      </form>
    </div>
  )
}
