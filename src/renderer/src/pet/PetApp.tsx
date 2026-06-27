import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type * as React from 'react'
import {
  clampMaxVisiblePets,
  type PetPosition,
  type PetSettings,
  type PetState,
  type PetStatusPayload,
  type PetTicket
} from '@shared/types/pet'
import { getPet } from './registry'
import { HatchCeremony } from './HatchCeremony'
import { PetSprite } from './PetSprite'
import { usePetDrag } from './usePetDrag'
import { usePetHover } from './usePetHover'
import { petApi } from '@/api/pet-api'

const DEFAULT_STATUS: PetStatusPayload = {
  state: 'idle',
  sourceWorktreeId: null,
  workingSessionCount: 0,
  pets: []
}

export function PetApp(): React.JSX.Element {
  const [settings, setSettings] = useState<PetSettings | null>(null)
  const [position, setPosition] = useState<PetPosition | null>(null)
  const [status, setStatus] = useState<PetStatusPayload>(DEFAULT_STATUS)
  const [hatching, setHatching] = useState(false)
  const latestStatusRef = useRef(DEFAULT_STATUS)

  const pet = useMemo(() => getPet(settings?.petId ?? 'bee'), [settings?.petId])
  const { isDraggingRef, wasDraggedRef, onPointerDown } = usePetDrag(position)
  const hover = usePetHover(isDraggingRef)

  useEffect(() => {
    let cancelled = false

    async function loadInitialState(): Promise<void> {
      const [config, currentStatus] = await Promise.all([
        petApi.getConfig(),
        petApi.getCurrentStatus()
      ])
      if (cancelled) return
      setSettings(config.settings)
      setPosition(config.position)
      setStatus(currentStatus)
      latestStatusRef.current = currentStatus
      setHatching(!config.settings.hasHatched)
    }

    loadInitialState().catch(console.error)
    const cleanupStatus = petApi.onStatus((payload) => {
      latestStatusRef.current = payload
      setStatus(payload)
    })
    const cleanupSettings = petApi.onSettingsUpdated((nextSettings) => {
      setSettings(nextSettings)
    })

    return () => {
      cancelled = true
      cleanupStatus()
      cleanupSettings()
    }
  }, [])

  const handleHatchComplete = useCallback(() => {
    setHatching(false)
    setSettings((current) => (current ? { ...current, hasHatched: true } : current))
    petApi.markHatched()
  }, [])

  // Shared across every pet: a pointer-down that turned into a drag must
  // suppress the click that follows so we don't open a ticket while moving.
  const consumeDragClick = useCallback(
    (event: React.MouseEvent<HTMLElement>): boolean => {
      if (wasDraggedRef.current) {
        event.preventDefault()
        event.stopPropagation()
        wasDraggedRef.current = false
        return true
      }
      return false
    },
    [wasDraggedRef]
  )

  const handleTicketClick = useCallback(
    (ticket: PetTicket) =>
      (event: React.MouseEvent<HTMLElement>): void => {
        if (consumeDragClick(event)) return
        petApi
          .focusMain({
            worktreeId: null,
            projectId: ticket.projectId,
            ticketId: ticket.ticketId
          })
          .catch(console.error)
      },
    [consumeDragClick]
  )

  const handleFallbackClick = useCallback(
    (event: React.MouseEvent<HTMLElement>): void => {
      if (consumeDragClick(event)) return
      petApi
        .focusMain({ worktreeId: latestStatusRef.current.sourceWorktreeId })
        .catch(console.error)
    },
    [consumeDragClick]
  )

  const handleContextMenu = useCallback((event: React.MouseEvent<HTMLElement>) => {
    event.preventDefault()
    petApi.hide().catch(console.error)
  }, [])

  if (!settings) return <div className="pet-root" />

  if (hatching) {
    return (
      <div className="pet-root">
        <HatchCeremony pet={pet} settings={settings} onComplete={handleHatchComplete} />
      </div>
    )
  }

  const pets = status.pets ?? []

  // No active ticket → keep the single ambient pet just standing.
  if (pets.length === 0) {
    return (
      <div className="pet-root">
        <PetSprite
          pet={pet}
          state="idle"
          settings={settings}
          workingSessionCount={status.workingSessionCount}
          onPointerDown={onPointerDown}
          onMouseEnter={hover.onMouseEnter}
          onMouseLeave={hover.onMouseLeave}
          onClick={handleFallbackClick}
          onContextMenu={handleContextMenu}
        />
      </div>
    )
  }

  // Beyond the user's visible limit, collapse the tail into a single overflow
  // pet badged `×N` (pets are pre-sorted by attention priority, so the most
  // urgent stay individual). The overflow pet inherits the top hidden ticket's
  // state and click target, keeping the screen tidy without losing access.
  const maxVisible = clampMaxVisiblePets(settings.maxVisiblePets)
  const overflowing = pets.length > maxVisible
  const individual = overflowing ? pets.slice(0, maxVisible - 1) : pets
  const overflow = overflowing ? pets.slice(maxVisible - 1) : []
  const overflowLead = overflow[0]

  return (
    <div className="pet-root">
      <div className="pet-column">
        {individual.map((ticket) => (
          <PetSprite
            key={ticket.ticketId}
            pet={pet}
            state={ticket.state as PetState}
            settings={settings}
            workingSessionCount={status.workingSessionCount}
            hitPadding={0}
            title={ticket.title}
            onPointerDown={onPointerDown}
            onMouseEnter={hover.onMouseEnter}
            onMouseLeave={hover.onMouseLeave}
            onClick={handleTicketClick(ticket)}
            onContextMenu={handleContextMenu}
          />
        ))}
        {overflowLead && (
          <PetSprite
            key="pet-overflow"
            pet={pet}
            state={overflowLead.state as PetState}
            settings={settings}
            workingSessionCount={status.workingSessionCount}
            hitPadding={0}
            title={`${overflow.length} more tickets`}
            countBadge={overflow.length}
            onPointerDown={onPointerDown}
            onMouseEnter={hover.onMouseEnter}
            onMouseLeave={hover.onMouseLeave}
            onClick={handleTicketClick(overflowLead)}
            onContextMenu={handleContextMenu}
          />
        )}
      </div>
    </div>
  )
}
