import React, { useEffect } from 'react'
import { ActivityIndicator, Alert, Text, TouchableOpacity, View } from 'react-native'
import { StatusBar } from 'expo-status-bar'
import {
  DarkTheme,
  NavigationContainer,
  createNavigationContainerRef
} from '@react-navigation/native'
import { createNativeStackNavigator } from '@react-navigation/native-stack'
import { SafeAreaProvider } from 'react-native-safe-area-context'

import { HiveProvider, useHive } from './src/context/HiveContext'
import { attachNotificationTapHandler } from './src/lib/push'
import { LoginScreen } from './src/screens/LoginScreen'
import { SessionListScreen } from './src/screens/SessionListScreen'
import { SessionDetailScreen } from './src/screens/SessionDetailScreen'
import { DiffViewScreen } from './src/screens/DiffViewScreen'
import type { RootStackParamList } from './src/navigation/types'
import { colors } from './src/theme'

const Stack = createNativeStackNavigator<RootStackParamList>()
export const navigationRef = createNavigationContainerRef<RootStackParamList>()

const navTheme = {
  ...DarkTheme,
  colors: {
    ...DarkTheme.colors,
    background: colors.bg,
    card: colors.card,
    text: colors.text,
    border: colors.border,
    primary: colors.accent
  }
}

function SignOutButton(): React.JSX.Element {
  const { signOut } = useHive()
  return (
    <TouchableOpacity
      onPress={() =>
        Alert.alert('Sign out', 'Clear your owner token from this device?', [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Sign out', style: 'destructive', onPress: () => void signOut() }
        ])
      }
    >
      <Text style={{ color: colors.accent, fontWeight: '600' }}>Sign out</Text>
    </TouchableOpacity>
  )
}

function RootNavigator(): React.JSX.Element {
  const { authState } = useHive()

  if (authState === 'loading') {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.bg }}>
        <ActivityIndicator color={colors.accent} />
      </View>
    )
  }

  return (
    <Stack.Navigator
      screenOptions={{
        headerStyle: { backgroundColor: colors.card },
        headerTintColor: colors.text,
        contentStyle: { backgroundColor: colors.bg }
      }}
    >
      {authState === 'signedIn' ? (
        <>
          <Stack.Screen
            name="SessionList"
            component={SessionListScreen}
            options={{ title: 'Sessions', headerRight: () => <SignOutButton /> }}
          />
          <Stack.Screen name="SessionDetail" component={SessionDetailScreen} />
          <Stack.Screen name="DiffView" component={DiffViewScreen} />
        </>
      ) : (
        <Stack.Screen name="Login" component={LoginScreen} options={{ headerShown: false }} />
      )}
    </Stack.Navigator>
  )
}

function DeepLinkBridge(): null {
  const { authState } = useHive()

  useEffect(() => {
    // Route notification taps to the relevant session. Only meaningful once
    // signed in and the navigator is mounted.
    const cleanup = attachNotificationTapHandler((hiveSessionId) => {
      if (authState === 'signedIn' && navigationRef.isReady()) {
        navigationRef.navigate('SessionDetail', { hiveSessionId })
      }
    })
    return cleanup
  }, [authState])

  return null
}

export default function App(): React.JSX.Element {
  return (
    <SafeAreaProvider>
      <HiveProvider>
        <NavigationContainer ref={navigationRef} theme={navTheme}>
          <StatusBar style="light" />
          <RootNavigator />
          <DeepLinkBridge />
        </NavigationContainer>
      </HiveProvider>
    </SafeAreaProvider>
  )
}
