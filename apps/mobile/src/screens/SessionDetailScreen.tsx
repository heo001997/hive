import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  ActivityIndicator,
  Alert,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View
} from 'react-native'

import { useHive } from '../context/HiveContext'
import {
  connectSession,
  extractText,
  getMessages,
  getSession,
  getWorktree,
  permissionList,
  permissionReply,
  planApprove,
  planReject,
  promptSession,
  subscribeSessionStream,
  type OpenCodeStreamEvent,
  type Session,
  type Worktree
} from '../lib/api'
import type { SessionDetailScreenProps } from '../navigation/types'
import { colors, space } from '../theme'

interface Entry {
  readonly key: string
  readonly label: string
  readonly text: string
  readonly self?: boolean
}

interface PendingPermission {
  readonly id: string
  readonly title: string
}

// Read-only live view of one agent session, plus a prompt box and the
// Approve / answer-needs-input actions. Takes only a hive session id so a push
// deep-link can open it directly; the worktree path + opencode session id are
// resolved here (mirroring the CLI's loadSessionTarget).
export function SessionDetailScreen({
  navigation,
  route
}: SessionDetailScreenProps): React.JSX.Element {
  const { hiveSessionId } = route.params
  const { client } = useHive()

  const [session, setSession] = useState<Session | null>(null)
  const [worktree, setWorktree] = useState<Worktree | null>(null)
  const [opencodeSessionId, setOpencodeSessionId] = useState<string | null>(null)
  const [entries, setEntries] = useState<Entry[]>([])
  const [pending, setPending] = useState<PendingPermission[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)

  const listRef = useRef<FlatList<Entry>>(null)
  const seq = useRef(0)

  const appendEntry = useCallback((label: string, text: string, self?: boolean) => {
    if (!text) return
    seq.current += 1
    setEntries((prev) => [...prev, { key: `e${seq.current}`, label, text, self }])
  }, [])

  const refreshApprovals = useCallback(async () => {
    if (!client || !worktree) return
    try {
      const res = await permissionList(client, worktree.path)
      if (!res.success) return
      const rows: PendingPermission[] = res.permissions.map((p, i) => {
        const rec = p as Record<string, unknown>
        const id = typeof rec.id === 'string' ? rec.id : String(rec.requestId ?? `perm-${i}`)
        const title =
          (typeof rec.title === 'string' && rec.title) ||
          (typeof rec.pattern === 'string' && rec.pattern) ||
          (typeof rec.tool === 'string' && rec.tool) ||
          extractText(p) ||
          'Permission request'
        return { id, title }
      })
      setPending(rows)
    } catch {
      // ignore — best effort
    }
  }, [client, worktree])

  // Resolve session -> worktree -> opencode session id, then seed messages.
  useEffect(() => {
    if (!client) return
    let cancelled = false
    ;(async () => {
      try {
        const s = await getSession(client, hiveSessionId)
        if (!s) throw new Error(`Session ${hiveSessionId} not found.`)
        if (cancelled) return
        setSession(s)
        if (!s.worktree_id) throw new Error('Session has no worktree.')

        const wt = await getWorktree(client, s.worktree_id)
        if (!wt) throw new Error('Worktree not found.')
        if (cancelled) return
        setWorktree(wt)

        // Prefer the persisted opencode session id; if none, connect to obtain
        // one and persist it back (same handshake the desktop/CLI perform).
        let ocId = s.opencode_session_id
        if (!ocId) {
          const res = await connectSession(client, wt.path, s.id)
          if (!res.success || !res.sessionId) {
            throw new Error(res.error || 'Failed to connect the session.')
          }
          ocId = res.sessionId
          await client.request('db.session.update', {
            id: s.id,
            data: { opencode_session_id: ocId }
          })
        }
        if (cancelled) return
        setOpencodeSessionId(ocId)

        const msgs = await getMessages(client, wt.path, ocId)
        if (cancelled) return
        if (msgs.success) {
          for (const m of msgs.messages) {
            appendEntry('message', extractText(m))
          }
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [appendEntry, client, hiveSessionId])

  // Subscribe to the live stream once resolved.
  useEffect(() => {
    if (!client || !opencodeSessionId) return
    const unsubscribe = subscribeSessionStream(client, hiveSessionId, (event: OpenCodeStreamEvent) => {
      appendEntry(event.type, extractText(event.data))
      // A stream event may signal a pending approval; refresh the list.
      if (/permission|question|ask|approval/i.test(event.type)) {
        void refreshApprovals()
      }
    })
    return unsubscribe
  }, [appendEntry, client, hiveSessionId, opencodeSessionId, refreshApprovals])

  useLayoutEffect(() => {
    navigation.setOptions({
      title: session?.name || 'Session',
      headerRight: () =>
        worktree ? (
          <TouchableOpacity
            onPress={() =>
              navigation.navigate('DiffView', {
                worktreePath: worktree.path,
                title: worktree.branch_name || worktree.name
              })
            }
          >
            <Text style={styles.headerBtn}>Diff</Text>
          </TouchableOpacity>
        ) : null
    })
  }, [navigation, session, worktree])

  const onSend = useCallback(async () => {
    const text = draft.trim()
    if (!text || !client || !worktree || !opencodeSessionId) return
    setSending(true)
    try {
      appendEntry('you', text, true)
      setDraft('')
      const res = await promptSession(client, worktree.path, opencodeSessionId, text)
      if (!res.success) appendEntry('error', res.error || 'Prompt failed.')
    } catch (err) {
      appendEntry('error', err instanceof Error ? err.message : String(err))
    } finally {
      setSending(false)
    }
  }, [appendEntry, client, draft, opencodeSessionId, worktree])

  const onApprovePlan = useCallback(async () => {
    if (!client || !worktree) return
    try {
      const res = await planApprove(client, worktree.path, hiveSessionId)
      appendEntry('system', res.success ? 'Plan approved.' : res.error || 'Approve failed.')
    } catch (err) {
      appendEntry('error', err instanceof Error ? err.message : String(err))
    }
  }, [appendEntry, client, hiveSessionId, worktree])

  const doReject = useCallback(
    async (feedback: string) => {
      if (!client || !worktree) return
      try {
        const res = await planReject(client, worktree.path, hiveSessionId, feedback || 'Rejected.')
        appendEntry('system', res.success ? 'Plan rejected.' : res.error || 'Reject failed.')
      } catch (err) {
        appendEntry('error', err instanceof Error ? err.message : String(err))
      }
    },
    [appendEntry, client, hiveSessionId, worktree]
  )

  const onRejectPlan = useCallback(() => {
    if (!client || !worktree) return
    // Alert.prompt is iOS-only; on Android fall back to the current draft text
    // (or a default) so the action still works.
    if (typeof Alert.prompt === 'function') {
      Alert.prompt('Reject plan', 'Feedback for the agent:', (feedback?: string) => {
        void doReject(feedback || 'Rejected.')
      })
    } else {
      void doReject(draft.trim() || 'Rejected.')
    }
  }, [client, doReject, draft, worktree])

  const onPermission = useCallback(
    async (id: string, reply: 'once' | 'always' | 'reject') => {
      if (!client || !worktree) return
      try {
        const res = await permissionReply(client, id, reply, worktree.path)
        appendEntry('system', res.success ? `Permission: ${reply}.` : res.error || 'Reply failed.')
        setPending((prev) => prev.filter((p) => p.id !== id))
      } catch (err) {
        appendEntry('error', err instanceof Error ? err.message : String(err))
      }
    },
    [appendEntry, client, worktree]
  )

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.accent} />
      </View>
    )
  }

  if (error) {
    return (
      <View style={styles.center}>
        <Text style={styles.error}>{error}</Text>
      </View>
    )
  }

  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={90}
    >
      <FlatList
        ref={listRef}
        style={styles.flex}
        contentContainerStyle={styles.listContent}
        data={entries}
        keyExtractor={(item) => item.key}
        onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: true })}
        renderItem={({ item }) => (
          <View style={[styles.bubble, item.self ? styles.bubbleSelf : styles.bubbleAgent]}>
            <Text style={styles.bubbleLabel}>{item.label}</Text>
            <Text style={styles.bubbleText}>{item.text}</Text>
          </View>
        )}
        ListEmptyComponent={<Text style={styles.empty}>No messages yet.</Text>}
      />

      {pending.length > 0 ? (
        <View style={styles.approvals}>
          <Text style={styles.approvalsTitle}>Needs your input</Text>
          {pending.map((p) => (
            <View key={p.id} style={styles.approvalRow}>
              <Text style={styles.approvalText} numberOfLines={2}>
                {p.title}
              </Text>
              <View style={styles.approvalBtns}>
                <TouchableOpacity style={styles.smallBtn} onPress={() => onPermission(p.id, 'once')}>
                  <Text style={styles.smallBtnText}>Once</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.smallBtn} onPress={() => onPermission(p.id, 'always')}>
                  <Text style={styles.smallBtnText}>Always</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.smallBtn, styles.smallBtnDanger]}
                  onPress={() => onPermission(p.id, 'reject')}
                >
                  <Text style={styles.smallBtnText}>Reject</Text>
                </TouchableOpacity>
              </View>
            </View>
          ))}
        </View>
      ) : null}

      <View style={styles.actionBar}>
        <TouchableOpacity style={styles.action} onPress={onApprovePlan}>
          <Text style={styles.actionText}>Approve plan</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.action} onPress={onRejectPlan}>
          <Text style={styles.actionText}>Reject plan</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.action} onPress={() => void refreshApprovals()}>
          <Text style={styles.actionText}>Check input</Text>
        </TouchableOpacity>
      </View>

      <View style={styles.composer}>
        <TextInput
          style={styles.composerInput}
          value={draft}
          onChangeText={setDraft}
          placeholder="Send a prompt…"
          placeholderTextColor={colors.textMuted}
          multiline
        />
        <TouchableOpacity
          style={[styles.sendBtn, (sending || !draft.trim()) && styles.sendBtnDisabled]}
          onPress={onSend}
          disabled={sending || !draft.trim()}
        >
          {sending ? (
            <ActivityIndicator color={colors.accentText} />
          ) : (
            <Text style={styles.sendBtnText}>Send</Text>
          )}
        </TouchableOpacity>
      </View>
    </KeyboardAvoidingView>
  )
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.bg },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.bg },
  error: { color: colors.danger, padding: space.lg, textAlign: 'center' },
  empty: { color: colors.textMuted, textAlign: 'center', padding: space.xl },
  headerBtn: { color: colors.accent, fontSize: 16, fontWeight: '600', paddingHorizontal: space.sm },
  listContent: { padding: space.md, gap: space.sm },
  bubble: {
    borderRadius: 12,
    padding: space.md,
    borderWidth: 1,
    borderColor: colors.border,
    maxWidth: '92%'
  },
  bubbleAgent: { backgroundColor: colors.card, alignSelf: 'flex-start' },
  bubbleSelf: { backgroundColor: colors.cardAlt, alignSelf: 'flex-end' },
  bubbleLabel: {
    color: colors.textMuted,
    fontSize: 11,
    marginBottom: space.xs,
    textTransform: 'uppercase',
    letterSpacing: 0.5
  },
  bubbleText: { color: colors.text, fontSize: 15, lineHeight: 21 },
  approvals: {
    backgroundColor: colors.card,
    borderTopWidth: 1,
    borderTopColor: colors.warn,
    padding: space.md
  },
  approvalsTitle: { color: colors.warn, fontWeight: '700', marginBottom: space.sm },
  approvalRow: { marginBottom: space.sm },
  approvalText: { color: colors.text, marginBottom: space.xs },
  approvalBtns: { flexDirection: 'row', gap: space.sm },
  smallBtn: {
    backgroundColor: colors.cardAlt,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 8,
    paddingVertical: space.xs,
    paddingHorizontal: space.md
  },
  smallBtnDanger: { borderColor: colors.danger },
  smallBtnText: { color: colors.text, fontSize: 13 },
  actionBar: {
    flexDirection: 'row',
    gap: space.sm,
    paddingHorizontal: space.md,
    paddingTop: space.sm
  },
  action: {
    flex: 1,
    backgroundColor: colors.cardAlt,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 8,
    paddingVertical: space.sm,
    alignItems: 'center'
  },
  actionText: { color: colors.text, fontSize: 13, fontWeight: '600' },
  composer: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: space.sm,
    padding: space.md,
    borderTopWidth: 1,
    borderTopColor: colors.border
  },
  composerInput: {
    flex: 1,
    maxHeight: 120,
    backgroundColor: colors.card,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 10,
    color: colors.text,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    fontSize: 15
  },
  sendBtn: {
    backgroundColor: colors.accent,
    borderRadius: 10,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    justifyContent: 'center'
  },
  sendBtnDisabled: { opacity: 0.5 },
  sendBtnText: { color: colors.accentText, fontWeight: '700' }
})
