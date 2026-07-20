import React, { useCallback, useEffect, useState } from 'react'
import {
  ActivityIndicator,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View
} from 'react-native'

import { useHive } from '../context/HiveContext'
import {
  listProjects,
  listSessions,
  listWorktrees,
  type Project,
  type Session,
  type Worktree
} from '../lib/api'
import type { SessionListScreenProps } from '../navigation/types'
import { colors, space } from '../theme'

// Lazily-loaded, expandable tree: projects -> worktrees -> sessions. Tapping a
// session opens SessionDetail. Read-only browse; no mutation here.
export function SessionListScreen({ navigation }: SessionListScreenProps): React.JSX.Element {
  const { client } = useHive()
  const [projects, setProjects] = useState<Project[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [expandedProjects, setExpandedProjects] = useState<Record<string, boolean>>({})
  const [worktreesByProject, setWorktreesByProject] = useState<Record<string, Worktree[]>>({})
  const [expandedWorktrees, setExpandedWorktrees] = useState<Record<string, boolean>>({})
  const [sessionsByWorktree, setSessionsByWorktree] = useState<Record<string, Session[]>>({})

  const loadProjects = useCallback(async () => {
    if (!client) return
    setError(null)
    try {
      const rows = await listProjects(client)
      setProjects(rows)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load projects.')
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [client])

  useEffect(() => {
    void loadProjects()
  }, [loadProjects])

  const onRefresh = useCallback(() => {
    setRefreshing(true)
    // Drop caches so re-expanding refetches fresh data.
    setWorktreesByProject({})
    setSessionsByWorktree({})
    void loadProjects()
  }, [loadProjects])

  const toggleProject = useCallback(
    async (project: Project) => {
      const next = !expandedProjects[project.id]
      setExpandedProjects((s) => ({ ...s, [project.id]: next }))
      if (next && !worktreesByProject[project.id] && client) {
        try {
          const rows = (await listWorktrees(client, project.id)).filter(
            (w) => w.status !== 'archived'
          )
          setWorktreesByProject((s) => ({ ...s, [project.id]: rows }))
        } catch {
          setWorktreesByProject((s) => ({ ...s, [project.id]: [] }))
        }
      }
    },
    [client, expandedProjects, worktreesByProject]
  )

  const toggleWorktree = useCallback(
    async (worktree: Worktree) => {
      const next = !expandedWorktrees[worktree.id]
      setExpandedWorktrees((s) => ({ ...s, [worktree.id]: next }))
      if (next && !sessionsByWorktree[worktree.id] && client) {
        try {
          const rows = await listSessions(client, worktree.id)
          setSessionsByWorktree((s) => ({ ...s, [worktree.id]: rows }))
        } catch {
          setSessionsByWorktree((s) => ({ ...s, [worktree.id]: [] }))
        }
      }
    },
    [client, expandedWorktrees, sessionsByWorktree]
  )

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.accent} />
      </View>
    )
  }

  return (
    <ScrollView
      style={styles.flex}
      contentContainerStyle={styles.content}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={onRefresh}
          tintColor={colors.accent}
        />
      }
    >
      {error ? <Text style={styles.error}>{error}</Text> : null}
      {projects.length === 0 ? (
        <Text style={styles.empty}>No projects. Create one in the Hive desktop app first.</Text>
      ) : null}

      {projects.map((project) => {
        const open = !!expandedProjects[project.id]
        const worktrees = worktreesByProject[project.id]
        return (
          <View key={project.id} style={styles.projectBlock}>
            <TouchableOpacity style={styles.projectRow} onPress={() => toggleProject(project)}>
              <Text style={styles.chevron}>{open ? '▾' : '▸'}</Text>
              <Text style={styles.projectName} numberOfLines={1}>
                {project.name}
              </Text>
            </TouchableOpacity>

            {open ? (
              worktrees == null ? (
                <ActivityIndicator style={styles.pad} color={colors.accent} />
              ) : worktrees.length === 0 ? (
                <Text style={styles.nested}>No active worktrees.</Text>
              ) : (
                worktrees.map((wt) => {
                  const wOpen = !!expandedWorktrees[wt.id]
                  const sessions = sessionsByWorktree[wt.id]
                  return (
                    <View key={wt.id} style={styles.worktreeBlock}>
                      <TouchableOpacity
                        style={styles.worktreeRow}
                        onPress={() => toggleWorktree(wt)}
                      >
                        <Text style={styles.chevron}>{wOpen ? '▾' : '▸'}</Text>
                        <Text style={styles.worktreeName} numberOfLines={1}>
                          {wt.branch_name || wt.name}
                        </Text>
                      </TouchableOpacity>

                      {wOpen ? (
                        sessions == null ? (
                          <ActivityIndicator style={styles.pad} color={colors.accent} />
                        ) : sessions.length === 0 ? (
                          <Text style={styles.nestedDeep}>No sessions.</Text>
                        ) : (
                          sessions.map((session) => (
                            <TouchableOpacity
                              key={session.id}
                              style={styles.sessionRow}
                              onPress={() =>
                                navigation.navigate('SessionDetail', {
                                  hiveSessionId: session.id
                                })
                              }
                            >
                              <View style={[styles.dot, dotStyle(session.status)]} />
                              <View style={styles.flex}>
                                <Text style={styles.sessionName} numberOfLines={1}>
                                  {session.name || session.id}
                                </Text>
                                <Text style={styles.sessionMeta}>
                                  {session.agent_sdk} · {session.mode} · {session.status}
                                </Text>
                              </View>
                            </TouchableOpacity>
                          ))
                        )
                      ) : null}
                    </View>
                  )
                })
              )
            ) : null}
          </View>
        )
      })}
    </ScrollView>
  )
}

function dotStyle(status: Session['status']): { backgroundColor: string } {
  if (status === 'active') return { backgroundColor: colors.add }
  if (status === 'error') return { backgroundColor: colors.danger }
  return { backgroundColor: colors.textMuted }
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.bg },
  content: { padding: space.md, paddingBottom: space.xl },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.bg },
  error: { color: colors.danger, padding: space.md },
  empty: { color: colors.textMuted, padding: space.lg, textAlign: 'center' },
  projectBlock: {
    backgroundColor: colors.card,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 12,
    marginBottom: space.md,
    overflow: 'hidden'
  },
  projectRow: { flexDirection: 'row', alignItems: 'center', padding: space.md },
  projectName: { color: colors.text, fontSize: 17, fontWeight: '700', flex: 1 },
  worktreeBlock: { borderTopWidth: 1, borderTopColor: colors.border },
  worktreeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: space.sm,
    paddingHorizontal: space.md,
    paddingLeft: space.xl
  },
  worktreeName: { color: colors.text, fontSize: 15, fontWeight: '600', flex: 1 },
  chevron: { color: colors.textMuted, width: 18, fontSize: 14 },
  sessionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: space.sm,
    paddingRight: space.md,
    paddingLeft: 44,
    backgroundColor: colors.cardAlt
  },
  dot: { width: 8, height: 8, borderRadius: 4, marginRight: space.sm },
  sessionName: { color: colors.text, fontSize: 14 },
  sessionMeta: { color: colors.textMuted, fontSize: 12, marginTop: 2 },
  pad: { padding: space.md },
  nested: { color: colors.textMuted, paddingVertical: space.sm, paddingLeft: space.xl },
  nestedDeep: { color: colors.textMuted, paddingVertical: space.sm, paddingLeft: 44 }
})
