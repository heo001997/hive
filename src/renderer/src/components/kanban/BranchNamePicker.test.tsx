import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BranchNamePicker } from './WorktreePickerModal'
import type { BranchNameCandidate } from '@shared/types/branch-utils'

vi.mock('@/hooks/useGhosttySuppression', () => ({ useGhosttySuppression: vi.fn() }))

afterEach(cleanup)

const CANDIDATES: BranchNameCandidate[] = [
  { kind: 'hive-default', label: 'Hive default', hint: 'Ticket title', value: 'add-user-auth' },
  { kind: 'sequential', label: 'Sequential', hint: 'Next number', value: '001-user-auth' },
  { kind: 'timestamp', label: 'Timestamp', hint: 'Date-time', value: '20260721-143022-user-auth' },
  { kind: 'short-name', label: 'Short name', hint: 'Action-noun', value: 'user-auth' }
]

function Harness() {
  const [value, setValue] = useState('add-user-auth')
  const [open, setOpen] = useState(false)
  return (
    <div>
      <span data-testid="current-value">{value}</span>
      <BranchNamePicker
        candidates={CANDIDATES}
        value={value}
        onChange={setValue}
        open={open}
        onOpenChange={setOpen}
      />
    </div>
  )
}

describe('BranchNamePicker', () => {
  it('shows the current value on the trigger and lists every candidate', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    render(<Harness />)
    expect(screen.getByTestId('branch-name-trigger')).toHaveTextContent('add-user-auth')
    await user.click(screen.getByTestId('branch-name-trigger'))
    for (const c of CANDIDATES) {
      expect(screen.getByTestId(`branch-name-candidate-${c.kind}`)).toHaveTextContent(c.value)
    }
  })

  it('applies a selected candidate', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    render(<Harness />)
    await user.click(screen.getByTestId('branch-name-trigger'))
    await user.click(screen.getByTestId('branch-name-candidate-timestamp'))
    await waitFor(() =>
      expect(screen.getByTestId('current-value')).toHaveTextContent('20260721-143022-user-auth')
    )
  })

  it('accepts a custom name and live-strips illegal chars (space→dash, drop slash)', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    render(<Harness />)
    await user.click(screen.getByTestId('branch-name-trigger'))
    const input = screen.getByTestId('branch-name-custom-input')
    await user.clear(input)
    await user.type(input, 'hotfix/login crash')
    await waitFor(() =>
      expect(screen.getByTestId('current-value')).toHaveTextContent('hotfixlogin-crash')
    )
  })
})
