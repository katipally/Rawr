import type { Metadata } from 'next'
import { Lexend_Deca } from 'next/font/google'
import { ThemeScript } from '~/components/theme.tsx'
import './globals.css'

/** HubSpot's product font. Loaded with the weights the design system actually
 *  uses: 300 for body copy, 500 for labels, 600 for links. */
const lexend = Lexend_Deca({
  subsets: ['latin'],
  weight: ['300', '400', '500', '600'],
  display: 'swap',
  variable: '--rawr-font-loaded',
})

export const metadata: Metadata = {
  title: 'Rawr',
  description: 'Datasaur CRM',
}

const RootLayout = ({ children }: { children: React.ReactNode }) => (
  <html lang="en" className={lexend.className} suppressHydrationWarning>
    <body>
      <ThemeScript />
      {children}
    </body>
  </html>
)

export default RootLayout
