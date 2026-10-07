import type { Metadata } from 'next'
import { Lexend_Deca } from 'next/font/google'
import './globals.css'

/** HubSpot's product font. Loaded with the weights the design system actually
 *  uses: 300 for body copy, 500 for labels, 600 for links. */
const lexend = Lexend_Deca({
  subsets: ['latin'],
  weight: ['300', '400', '500', '600'],
  display: 'swap',
})

export const metadata: Metadata = {
  title: 'Rawr',
  description: 'CRM for contacts, companies, deals, forms and bookings',
  robots: { index: false, follow: false },
}

const RootLayout = ({ children }: { children: React.ReactNode }) => (
  <html lang="en" className={lexend.className} suppressHydrationWarning>
    <body>
      {children}
    </body>
  </html>
)

export default RootLayout
