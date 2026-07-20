import React, { useCallback, useEffect, useLayoutEffect, useState } from 'react'
import {
  ActivityIndicator,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View
} from 'react-native'

// A monospace family that exists on each platform.
const MONO = Platform.OS === 'ios' ? 'Menlo' : 'monospace'

import { useHive } from '../context/HiveContext'
import { getDiff, getDiffStat, type GitDiffStatFile } from '../lib/api'
import type { DiffViewScreenProps } from '../navigation/types'
import { colors, space } from '../theme'

// Read-only git review: a diffstat list for the worktree, and per-file unified
// diffs fetched on demand. No staging, no commits — this is a viewer.
export function DiffViewScreen({ navigation, route }: DiffViewScreenProps): React.JSX.Element {
  const { worktreePath, title } = route.params
  const { client } = useHive()

  const [files, setFiles] = useState<GitDiffStatFile[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [diffText, setDiffText] = useState<string | null>(null)
  const [diffLoading, setDiffLoading] = useState(false)

  useLayoutEffect(() => {
    navigation.setOptions({ title: title ? `Diff · ${title}` : 'Diff' })
  }, [navigation, title])

  useEffect(() => {
    if (!client) return
    let cancelled = false
    ;(async () => {
      try {
        const res = await getDiffStat(client, worktreePath)
        if (cancelled) return
        if (!res.success) throw new Error(res.error || 'Failed to load diff stat.')
        setFiles(res.files ?? [])
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [client, worktreePath])

  const openFile = useCallback(
    async (file: GitDiffStatFile) => {
      if (!client) return
      if (selected === file.path) {
        setSelected(null)
        setDiffText(null)
        return
      }
      setSelected(file.path)
      setDiffText(null)
      setDiffLoading(true)
      try {
        const res = await getDiff(client, worktreePath, file.path)
        setDiffText(res.success ? res.diff || '(no diff)' : res.error || 'Failed to load diff.')
      } catch (err) {
        setDiffText(err instanceof Error ? err.message : String(err))
      } finally {
        setDiffLoading(false)
      }
    },
    [client, selected, worktreePath]
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
    <ScrollView style={styles.flex} contentContainerStyle={styles.content}>
      {files.length === 0 ? (
        <Text style={styles.empty}>No uncommitted changes.</Text>
      ) : (
        files.map((file) => {
          const open = selected === file.path
          return (
            <View key={file.path} style={styles.fileBlock}>
              <TouchableOpacity style={styles.fileRow} onPress={() => openFile(file)}>
                <Text style={styles.filePath} numberOfLines={1}>
                  {file.path}
                </Text>
                {file.binary ? (
                  <Text style={styles.binary}>bin</Text>
                ) : (
                  <Text style={styles.stat}>
                    <Text style={styles.add}>+{file.additions}</Text>{' '}
                    <Text style={styles.del}>-{file.deletions}</Text>
                  </Text>
                )}
              </TouchableOpacity>

              {open ? (
                diffLoading ? (
                  <ActivityIndicator style={styles.pad} color={colors.accent} />
                ) : (
                  <ScrollView horizontal style={styles.diffScroll}>
                    <View>
                      {(diffText ?? '').split('\n').map((line, i) => (
                        <Text key={i} style={[styles.diffLine, lineStyle(line)]}>
                          {line || ' '}
                        </Text>
                      ))}
                    </View>
                  </ScrollView>
                )
              ) : null}
            </View>
          )
        })
      )}
    </ScrollView>
  )
}

function lineStyle(line: string): { color: string } | undefined {
  if (line.startsWith('+') && !line.startsWith('+++')) return { color: colors.add }
  if (line.startsWith('-') && !line.startsWith('---')) return { color: colors.del }
  if (line.startsWith('@@')) return { color: colors.accent }
  return undefined
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.bg },
  content: { padding: space.md, paddingBottom: space.xl },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.bg },
  error: { color: colors.danger, padding: space.lg, textAlign: 'center' },
  empty: { color: colors.textMuted, padding: space.xl, textAlign: 'center' },
  fileBlock: {
    backgroundColor: colors.card,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 10,
    marginBottom: space.sm,
    overflow: 'hidden'
  },
  fileRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: space.md
  },
  filePath: { color: colors.text, fontSize: 14, flex: 1, marginRight: space.sm },
  stat: { fontSize: 13 },
  add: { color: colors.add },
  del: { color: colors.del },
  binary: { color: colors.textMuted, fontSize: 13 },
  diffScroll: {
    backgroundColor: '#0d0d12',
    borderTopWidth: 1,
    borderTopColor: colors.border,
    padding: space.sm
  },
  diffLine: {
    color: colors.text,
    fontFamily: MONO,
    fontSize: 12,
    lineHeight: 17
  },
  pad: { padding: space.md }
})
