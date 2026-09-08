import {
  Ban,
  Bookmark,
  Briefcase,
  Building2,
  ChartNoAxesColumn,
  ChevronDown,
  ChevronUp,
  Contact,
  Copy,
  Database,
  Handshake,
  Home,
  Megaphone,
  Pencil,
  RotateCcw,
  Send,
  Trash2,
  Unlink,
  type LucideIcon,
} from 'lucide-react'
import type { ObjectKey } from '@rawr/db'

/** Icons cross the server/client boundary as names: a component reference is not
 *  serialisable, so the layout names the icon and the client resolves it here.
 *  One map, so the rail, the command palette, the create menu and a record header
 *  cannot drift into showing three different marks for the same thing. */

export type IconKey =
  | 'home'
  | 'bookmarks'
  | 'crm'
  | 'marketing'
  | 'sales'
  | 'data'
  | 'reporting'

/** HubSpot's rail, top to bottom. */
export const SECTION_ICONS: Record<IconKey, LucideIcon> = {
  home: Home,
  bookmarks: Bookmark,
  crm: Contact,
  marketing: Megaphone,
  sales: Briefcase,
  data: Database,
  reporting: ChartNoAxesColumn,
}

export const OBJECT_ICONS: Record<ObjectKey, LucideIcon> = {
  contact: Contact,
  company: Building2,
  deal: Handshake,
}

export const objectIcon = (object: string): LucideIcon =>
  OBJECT_ICONS[object as ObjectKey] ?? Contact


/** The verbs that act on one row of a list. Named here for the same reason the
 *  object icons are: a delete that is a bin in one list and a cross in another is
 *  two things to learn instead of one.
 *
 *  Only verbs whose mark is genuinely unambiguous live here. A decision the reader
 *  has to weigh — cancelling somebody's meeting, sending a campaign, declaring two
 *  records not the same — keeps its words, because a glyph cannot ask a question. */
export const ACTION_ICONS = {
  moveUp: ChevronUp,
  moveDown: ChevronDown,
  edit: Pencil,
  rename: Pencil,
  delete: Trash2,
  restore: RotateCcw,
  resend: Send,
  revoke: Ban,
  unlink: Unlink,
  copy: Copy,
} satisfies Record<string, LucideIcon>
