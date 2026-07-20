import type { NativeStackScreenProps } from '@react-navigation/native-stack'

// The signed-in stack. SessionDetail takes only a hive session id so a push
// deep-link (which carries just that) can route straight to it; the screen
// resolves worktree/opencode ids itself.
export type RootStackParamList = {
  Login: undefined
  SessionList: undefined
  SessionDetail: { hiveSessionId: string }
  DiffView: { worktreePath: string; title?: string }
}

export type SessionListScreenProps = NativeStackScreenProps<RootStackParamList, 'SessionList'>
export type SessionDetailScreenProps = NativeStackScreenProps<RootStackParamList, 'SessionDetail'>
export type DiffViewScreenProps = NativeStackScreenProps<RootStackParamList, 'DiffView'>
