import {
  BarChart3,
  Building2,
  CalendarDays,
  ChartNoAxesColumn,
  Contact,
  Database,
  Handshake,
  Hash,
  Home,
  Mail,
  Megaphone,
  Phone,
  Send,
  Sparkles,
  Video,
  Workflow,
  type LucideIcon,
} from 'lucide-react'
import type { IntegrationKind, ObjectKey } from '@rawr/db'

/** Icons cross the server/client boundary as names: a component reference is not
 *  serialisable, so the layout names the icon and the client resolves it here.
 *  One map, so the rail, the command palette, the create menu and a record header
 *  cannot drift into showing three different marks for the same thing. */

export type IconKey = 'home' | 'crm' | 'marketing' | 'reporting' | 'data'

export const SECTION_ICONS: Record<IconKey, LucideIcon> = {
  home: Home,
  crm: Contact,
  marketing: Megaphone,
  reporting: ChartNoAxesColumn,
  data: Database,
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
