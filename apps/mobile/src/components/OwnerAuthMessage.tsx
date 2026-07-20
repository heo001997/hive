import React from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { OwnerAuthError } from '@hive/client'

import { colors, space } from '../theme'

// Turn a sign-in failure into a human message. `OwnerAuthError.status`
// distinguishes 401 (wrong token) from 403 (owner auth not configured on the
// server); anything else is treated as a connectivity problem.
function describe(error: unknown): string {
  if (error instanceof OwnerAuthError) {
    if (error.status === 401) return 'That owner token was rejected. Double-check the value.'
    if (error.status === 403) {
      return 'This server has owner authentication disabled. Enable it (HIVE owner token) and try again.'
    }
    return 'Authentication failed. Please try again.'
  }
  if (error instanceof Error) {
    return `Could not reach the server: ${error.message}`
  }
  return 'Could not connect. Check the server URL and your network.'
}

export function OwnerAuthMessage({ error }: { error: unknown }): React.JSX.Element {
  return (
    <View style={styles.box}>
      <Text style={styles.text}>{describe(error)}</Text>
    </View>
  )
}

const styles = StyleSheet.create({
  box: {
    backgroundColor: 'rgba(248,81,73,0.12)',
    borderColor: colors.danger,
    borderWidth: 1,
    borderRadius: 8,
    padding: space.md,
    marginTop: space.md
  },
  text: { color: colors.danger, fontSize: 14 }
})
