'use client'

import type { ReactNode } from 'react'
import { Button } from './button.tsx'
import { Modal } from './modal.tsx'

export type ConfirmDialogProps = {
  open: boolean
  title: string
  /** The verb on the button, naming what happens: "Delete file", not "OK". */
  confirm: string
  busy?: boolean
  onCancel: () => void
  onConfirm: () => void
  /** What the action does and whether it can be undone. */
  children: ReactNode
}

/** A question before something that cannot be taken back by pressing it again.
 *  Enter confirms and Escape cancels, the same as every other dialog. */
export const ConfirmDialog = ({
  open,
  title,
  confirm,
  busy = false,
  onCancel,
  onConfirm,
  children,
}: ConfirmDialogProps) => (
  <Modal
    open={open}
    size="sm"
    title={title}
    onClose={onCancel}
    onSubmit={onConfirm}
    footer={
      <>
        <Button variant="tertiary" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" variant="destructive" busy={busy}>
          {confirm}
        </Button>
      </>
    }
  >
    {children}
  </Modal>
)
