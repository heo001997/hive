import { useEffect } from 'react'
import { opencodeApi } from '@/api/opencode-api'
import { unwrapEnvelope } from '@/lib/ipc-envelope'
import { mapOpencodeMessagesToSessionViewMessages } from '@/lib/opencode-transcript'
import { useBoardChatStore } from '@/stores/useBoardChatStore'
import { useSessionStore } from '@/stores/useSessionStore'

/**
 * Flatten every active board-assistant chat across all projects into a set of
 * hive sessionIds. Recomputed per event (from getState) so it never goes stale.
 */
function collectBoardSessionIds(): Set<string> {
  const ids = new Set<string>()
  for (const sessions of useSessionStore.getState().boardAssistantsByProject.values()) {
    for (const session of sessions) ids.add(session.id)
  }
  return ids
}

/**
 * Global router that keeps **background** board-assistant chats live.
 *
 * Mounted once (in AppLayout) beside `useOpenCodeGlobalListener`. The focused
 * chat owns its own token-by-token ingestion via the mounted `BoardAssistantView`
 * (`useSessionStream`); this router handles every *other* board chat so their
 * transcripts/drafts keep updating while they're not on screen.
 *
 * On a background board session going idle it re-pulls the transcript and writes
 * that session's snapshot via `ingestTranscriptForSession`. Ingestion is
 * idempotent (`mergeTranscriptMessages` dedupes by role + normalized content),
 * so brief overlap with the focused view cannot corrupt state.
 */
export function useBoardAssistantStreamRouter(): void {
  useEffect(() => {
    const unsubscribe = opencodeApi.onStream((event) => {
      const sessionId = event.sessionId
      if (!sessionId) return

      // Only care about board-assistant sessions — ignore everything else.
      if (!collectBoardSessionIds().has(sessionId)) return

      const boardStore = useBoardChatStore.getState()

      // session.materialized: persist the real OpenCode session id into the board
      // snapshot. The global listener already mirrors it into the session store.
      if (event.type === 'session.materialized') {
        const newId = (event.data as Record<string, unknown> | undefined)?.newSessionId as
          | string
          | undefined
        if (newId) {
          boardStore.updateOpencodeSessionIdForSession(sessionId, newId)
        }
        return
      }

      // Skip the focused chat — the mounted view ingests it (mirrors the activeId
      // convention in useOpenCodeGlobalListener).
      if (sessionId === useSessionStore.getState().activeBoardAssistantSessionId) return

      // Authoritative completion signal.
      if (event.type !== 'session.status') return
      const status = event.statusPayload || event.data?.status
      if (status?.type !== 'idle') return

      const snapshot = boardStore.getSessionSnapshot(sessionId)
      const runtimePath = snapshot?.runtimePath
      const opencodeSessionId = snapshot?.opencodeSessionId
      // A chat that hasn't sent yet (no runtime) has nothing to pull.
      if (!runtimePath || !opencodeSessionId) return
      if (opencodeSessionId.startsWith('pending::')) return

      void (async () => {
        try {
          const result = unwrapEnvelope(await opencodeApi.getMessages(runtimePath, opencodeSessionId))
          if (!result.success || !result.messages) return
          const mapped = mapOpencodeMessagesToSessionViewMessages(result.messages as unknown[])
          useBoardChatStore.getState().ingestTranscriptForSession(sessionId, mapped, false)
        } catch {
          // Best effort — the chat re-syncs on the next idle event or on focus.
        }
      })()
    })

    return unsubscribe
  }, [])
}
