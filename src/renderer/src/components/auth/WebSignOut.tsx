import { clearWebAuth } from '@/api/web-auth'
import { Button } from '@/components/ui/button'

// Minimal sign-out affordance for hosted web mode. Rendered by `App` only when
// `detectWebMode()` is true, so desktop / Vite-dev never show it. Clears the
// stored owner token + cached session token and reloads back to the Login gate.

export function WebSignOut(): React.JSX.Element {
  const handleSignOut = (): void => {
    clearWebAuth()
    window.location.reload()
  }

  return (
    <div className="fixed bottom-3 left-3 z-50">
      <Button
        variant="outline"
        size="sm"
        className="opacity-70 hover:opacity-100"
        onClick={handleSignOut}
      >
        Sign out
      </Button>
    </div>
  )
}
