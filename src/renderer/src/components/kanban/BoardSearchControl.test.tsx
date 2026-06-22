import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BoardSearchControl } from './BoardSearchControl'
import { useBoardSearchStore } from '@/stores/useBoardSearchStore'

const initialSearchState = useBoardSearchStore.getState()

describe('BoardSearchControl', () => {
  beforeEach(() => {
    useBoardSearchStore.setState(initialSearchState, true)
  })

  afterEach(() => {
    cleanup()
    useBoardSearchStore.setState(initialSearchState, true)
  })

  it('renders just the trigger icon when closed', () => {
    render(<BoardSearchControl />)
    expect(screen.getByTestId('board-search-trigger')).toBeTruthy()
    expect(screen.queryByTestId('board-search-input')).toBeNull()
  })

  it('toggles the popup when the trigger is clicked', () => {
    render(<BoardSearchControl />)
    const trigger = screen.getByTestId('board-search-trigger')

    fireEvent.click(trigger)
    expect(screen.getByTestId('board-search-input')).toBeTruthy()
    // The icon stays in the top bar; only the floating field appears.
    expect(screen.getByTestId('board-search-trigger')).toBeTruthy()
    expect(useBoardSearchStore.getState().isOpen).toBe(true)

    fireEvent.click(trigger)
    expect(screen.queryByTestId('board-search-input')).toBeNull()
    expect(useBoardSearchStore.getState().isOpen).toBe(false)
  })

  it('opens on Cmd+F', () => {
    render(<BoardSearchControl />)
    fireEvent.keyDown(window, { key: 'f', metaKey: true })

    expect(screen.getByTestId('board-search-input')).toBeTruthy()
    expect(useBoardSearchStore.getState().isOpen).toBe(true)
  })

  it('writes typed text to the store query', () => {
    useBoardSearchStore.setState({ isOpen: true })
    render(<BoardSearchControl />)

    fireEvent.change(screen.getByTestId('board-search-input'), { target: { value: 'parser' } })
    expect(useBoardSearchStore.getState().query).toBe('parser')
  })

  it('shows the published match count', () => {
    useBoardSearchStore.setState({ isOpen: true, query: 'login', matchCount: 2 })
    render(<BoardSearchControl />)
    expect(screen.getByText('2 matches')).toBeTruthy()

    act(() => useBoardSearchStore.setState({ matchCount: 1 }))
    expect(screen.getByText('1 match')).toBeTruthy()

    act(() => useBoardSearchStore.setState({ matchCount: 0 }))
    expect(screen.getByText('No results')).toBeTruthy()
  })

  it('closes and clears the query on Escape', () => {
    useBoardSearchStore.setState({ isOpen: true, query: 'parser' })
    render(<BoardSearchControl />)

    fireEvent.keyDown(window, { key: 'Escape' })

    expect(screen.queryByTestId('board-search-input')).toBeNull()
    expect(screen.getByTestId('board-search-trigger')).toBeTruthy()
    expect(useBoardSearchStore.getState().isOpen).toBe(false)
    expect(useBoardSearchStore.getState().query).toBe('')
  })

  it('closes when the X button is clicked', () => {
    useBoardSearchStore.setState({ isOpen: true, query: 'parser' })
    render(<BoardSearchControl />)

    fireEvent.click(screen.getByLabelText('Close search'))
    expect(useBoardSearchStore.getState().isOpen).toBe(false)
    expect(useBoardSearchStore.getState().query).toBe('')
  })
})
