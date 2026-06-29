import { create } from 'zustand'
import { monitorApi, type MonitorSnapshot, type MonitorAlert } from '@/api/monitor-api'

// How many snapshots to retain in the renderer for sparkline rendering.
const MAX_HISTORY = 200
const MAX_ALERTS = 100

interface MonitorState {
  isOpen: boolean
  snapshot: MonitorSnapshot | null
  history: MonitorSnapshot[]
  alerts: MonitorAlert[]
  /** Alerts that arrived while the panel was closed — drives the header badge. */
  unseenAlertCount: number

  open: () => void
  close: () => void
  setHistory: (history: MonitorSnapshot[]) => void
  applySnapshot: (snapshot: MonitorSnapshot) => void
  setAlerts: (alerts: MonitorAlert[]) => void
  pushAlert: (alert: MonitorAlert) => void
  markAlertsSeen: () => void
}

export const useMonitorStore = create<MonitorState>((set, get) => ({
  isOpen: false,
  snapshot: null,
  history: [],
  alerts: [],
  unseenAlertCount: 0,

  open: () => {
    set({ isOpen: true, unseenAlertCount: 0 })
    void monitorApi.setActive(true).catch(() => undefined)
  },

  close: () => {
    set({ isOpen: false })
    void monitorApi.setActive(false).catch(() => undefined)
  },

  setHistory: (history) => {
    const bounded = history.slice(-MAX_HISTORY)
    set({ history: bounded, snapshot: bounded[bounded.length - 1] ?? get().snapshot })
  },

  applySnapshot: (snapshot) => {
    set((state) => {
      const history = [...state.history, snapshot]
      if (history.length > MAX_HISTORY) history.splice(0, history.length - MAX_HISTORY)
      return { snapshot, history }
    })
  },

  // Server keeps alerts oldest-first; the feed (and pushAlert) shows newest-first,
  // so reverse on hydration to keep the order consistent with live alerts.
  setAlerts: (alerts) => set({ alerts: alerts.slice(-MAX_ALERTS).reverse() }),

  pushAlert: (alert) =>
    set((state) => {
      const alerts = [alert, ...state.alerts].slice(0, MAX_ALERTS)
      return {
        alerts,
        unseenAlertCount: state.isOpen ? 0 : state.unseenAlertCount + 1
      }
    }),

  markAlertsSeen: () => set({ unseenAlertCount: 0 })
}))
