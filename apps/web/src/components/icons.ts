import {
  BarChart3,
  Ban,
  Bookmark,
  Bot,
  Briefcase,
  Building2,
  CalendarDays,
  ChartNoAxesColumn,
  ChevronDown,
  ChevronUp,
  Contact,
  Copy,
  Database,
  FileText,
  Handshake,
  Hash,
  Home,
  LifeBuoy,
  Mail,
  Megaphone,
  Pencil,
  Phone,
  Receipt,
  RotateCcw,
  Send,
  Sparkles,
  Trash2,
  Unlink,
  Video,
  Workflow,
  type LucideIcon,
} from 'lucide-react'
import type { IntegrationKind, ObjectKey } from '@rawr/db'

/** Icons cross the server/client boundary as names: a component reference is not
 *  serialisable, so the layout names the icon and the client resolves it here.
 *  One map, so the rail, the command palette, the create menu and a record header
 *  cannot drift into showing three different marks for the same thing. */

export type IconKey =
  | 'home'
  | 'bookmarks'
  | 'crm'
  | 'marketing'
  | 'content'
  | 'sales'
  | 'commerce'
  | 'service'
  | 'data'
  | 'agents'
  | 'reporting'

/** HubSpot's rail, top to bottom. */
export const SECTION_ICONS: Record<IconKey, LucideIcon> = {
  home: Home,
  bookmarks: Bookmark,
  crm: Contact,
  marketing: Megaphone,
  content: FileText,
  sales: Briefcase,
  commerce: Receipt,
  service: LifeBuoy,
  data: Database,
  agents: Bot,
  reporting: ChartNoAxesColumn,
}

export const OBJECT_ICONS: Record<ObjectKey, LucideIcon> = {
  contact: Contact,
  company: Building2,
  deal: Handshake,
}

export const objectIcon = (object: string): LucideIcon =>
  OBJECT_ICONS[object as ObjectKey] ?? Contact

/** One mark per provider, so a row in the integrations list is recognisable
 *  before its name is read. Lucide rather than brand logos: shipping somebody
 *  else's trademark is a licence question, and a glyph for what it does is more
 *  use than a logo anyway. */
export const INTEGRATION_ICONS: Record<IntegrationKind, LucideIcon> = {
  brevo: Mail,
  apollo: Sparkles,
  clay: Database,
  lusha: Phone,
  woodpecker: Send,
  hubspot: Workflow,
  slack: Hash,
  ga4: BarChart3,
  zoom: Video,
  google_calendar: CalendarDays,
}

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
