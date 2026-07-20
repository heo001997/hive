import React, { useState } from 'react'
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View
} from 'react-native'

import { useHive } from '../context/HiveContext'
import { OwnerAuthMessage } from '../components/OwnerAuthMessage'
import { colors, space } from '../theme'

// Sign-in gate: the user points the app at their self-hosted Hive backend
// (server URL) and pastes the durable OWNER TOKEN. We validate via
// `exchangeOwnerToken`, and on success the context persists + connects.
export function LoginScreen(): React.JSX.Element {
  const { signIn, lastServerUrl } = useHive()
  const [serverUrl, setServerUrl] = useState(lastServerUrl ?? '')
  const [ownerToken, setOwnerToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)

  const canSubmit = serverUrl.trim().length > 0 && ownerToken.trim().length > 0 && !busy

  const onSubmit = async () => {
    setBusy(true)
    setError(null)
    try {
      await signIn(serverUrl, ownerToken)
      // On success the root navigator swaps to the signed-in stack; nothing to
      // do here. Clear the token from component state either way.
      setOwnerToken('')
    } catch (err) {
      setError(err)
    } finally {
      setBusy(false)
    }
  }

  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView
        contentContainerStyle={styles.container}
        keyboardShouldPersistTaps="handled"
      >
        <Text style={styles.title}>Hive</Text>
        <Text style={styles.subtitle}>Connect to your self-hosted backend</Text>

        <Text style={styles.label}>Server URL</Text>
        <TextInput
          style={styles.input}
          value={serverUrl}
          onChangeText={setServerUrl}
          placeholder="http://192.168.1.50:3773"
          placeholderTextColor={colors.textMuted}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          inputMode="url"
        />

        <Text style={styles.label}>Owner token</Text>
        <TextInput
          style={styles.input}
          value={ownerToken}
          onChangeText={setOwnerToken}
          placeholder="Paste your owner token"
          placeholderTextColor={colors.textMuted}
          autoCapitalize="none"
          autoCorrect={false}
          secureTextEntry
        />

        {error != null ? <OwnerAuthMessage error={error} /> : null}

        <TouchableOpacity
          style={[styles.button, !canSubmit && styles.buttonDisabled]}
          onPress={onSubmit}
          disabled={!canSubmit}
        >
          {busy ? (
            <ActivityIndicator color={colors.accentText} />
          ) : (
            <Text style={styles.buttonText}>Connect</Text>
          )}
        </TouchableOpacity>

        <Text style={styles.hint}>
          The owner token is stored in your device keychain and only sent to the
          server you specify. It is never logged.
        </Text>
      </ScrollView>
    </KeyboardAvoidingView>
  )
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.bg },
  container: {
    flexGrow: 1,
    justifyContent: 'center',
    padding: space.xl,
    gap: space.sm
  },
  title: { color: colors.text, fontSize: 40, fontWeight: '800', textAlign: 'center' },
  subtitle: {
    color: colors.textMuted,
    fontSize: 15,
    textAlign: 'center',
    marginBottom: space.xl
  },
  label: { color: colors.textMuted, fontSize: 13, marginTop: space.md },
  input: {
    backgroundColor: colors.card,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 10,
    color: colors.text,
    paddingHorizontal: space.md,
    paddingVertical: space.md,
    fontSize: 16
  },
  button: {
    backgroundColor: colors.accent,
    borderRadius: 10,
    paddingVertical: space.md,
    alignItems: 'center',
    marginTop: space.lg
  },
  buttonDisabled: { opacity: 0.5 },
  buttonText: { color: colors.accentText, fontSize: 16, fontWeight: '700' },
  hint: {
    color: colors.textMuted,
    fontSize: 12,
    textAlign: 'center',
    marginTop: space.lg,
    lineHeight: 17
  }
})
