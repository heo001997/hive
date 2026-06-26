export type PetState = 'idle' | 'working' | 'question' | 'permission' | 'plan_ready'
export type PetSize = 'S' | 'M' | 'L'

/** Hard upper bound on per-ticket pets the aggregator ever produces. */
export const MAX_PET_TICKETS = 10
/** Vertical gap (px) between stacked pets. Kept in sync with `.pet-column` gap in pet.css. */
export const PET_COLUMN_GAP = 10
/** Default for `PetSettings.maxVisiblePets` — how many pets render before overflow collapses into a `×N` badge. */
export const DEFAULT_MAX_VISIBLE_PETS = 3

/** Clamp a user-supplied max-visible-pets value into the renderable range [1, MAX_PET_TICKETS]. */
export function clampMaxVisiblePets(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_MAX_VISIBLE_PETS
  return Math.min(Math.max(Math.round(value), 1), MAX_PET_TICKETS)
}

export interface PetSettings {
  enabled: boolean
  petId: string
  size: PetSize
  opacity: number
  animationSpeedEnabled: boolean
  animationSpeed: number
  hasHatched: boolean
  /**
   * How many pets render individually before the rest collapse into a single
   * overflow pet badged `×N`. Keeps the screen tidy when many tickets are active.
   */
  maxVisiblePets: number
}

/**
 * One pet bound to a single kanban ticket. Produced by `computePetTickets` and
 * carried in `PetStatusPayload.pets`. `state` reflects that ticket's current
 * agent activity; clicking the pet opens this ticket's detail.
 */
export interface PetTicket {
  ticketId: string
  projectId: string
  worktreeId: string | null
  state: PetState
  title: string
}

export interface PetStatusPayload {
  /** Aggregated single-pet state — drives the idle fallback when `pets` is empty. */
  state: PetState
  sourceWorktreeId: string | null
  workingSessionCount: number
  /**
   * One entry per active ticket (running / needs-attention), already sorted by
   * priority and capped to `MAX_PET_TICKETS`. Empty → show one idle pet.
   * Optional for back-compat with payloads that predate per-ticket pets.
   */
  pets?: PetTicket[]
}

export interface PetManifest {
  id: string
  name: string
  version: string
  author?: string
  assets: Record<PetState, string>
  lottieAssets?: Partial<Record<PetState, string>>
  lottieScale?: Partial<Record<PetState, number>>
  animations?: Partial<
    Record<
      PetState,
      {
        type: 'loop' | 'static'
        durationMs?: number
        transform?: 'spin' | 'bounce' | 'pulse' | 'none'
        overlay?: { kind: 'bubble' | 'glow' | 'none'; symbol?: string; tint?: string }
      }
    >
  >
  defaultSize?: PetSize
}

export interface LoadedPet extends PetManifest {
  resolvedAssets: Record<PetState, string>
  resolvedLottieAssets?: Partial<Record<PetState, string>>
}

export interface PetPosition {
  x: number
  y: number
}
