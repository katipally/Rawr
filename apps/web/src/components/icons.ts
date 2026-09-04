import {
  Building2,
  ChartNoAxesColumn,
  Contact,
  Database,
  Handshake,
  Home,
  Megaphone,
  type LucideIcon,
} from 'lucide-react'
import type { ObjectKey } from '@rawr/db'

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
