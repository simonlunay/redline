import localFont from 'next/font/local';
import './globals.css';
import './pages.css';
import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { SiteHeader } from '@/components/SiteHeader';

/**
 * Archivo, the UI face, with its width axis (the wide headlines). Loaded through next/font so it's
 * preloaded and self-hosted, with a metric-matched fallback while it loads. Latin only.
 */
const archivo = localFont({
  src: '../../../../node_modules/@fontsource-variable/archivo/files/archivo-latin-wdth-normal.woff2',
  weight: '100 900',
  style: 'normal',
  display: 'swap',
  variable: '--font-archivo',
  declarations: [{ prop: 'font-stretch', value: '62% 125%' }],
});

export const metadata: Metadata = {
  title: {
    default: 'Redline: design checks and an AI that fixes what it finds',
    template: '%s | Redline',
  },
  description:
    'Redline checks a poster, social post or ad against real layout rules and scores it. An AI fix loop repairs what it finds. Watch recorded runs, or check a design in your browser.',
};

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#eef0eb' },
    { media: '(prefers-color-scheme: dark)', color: '#1f2624' },
  ],
};

/**
 * No request may leave the site: everything it loads is its own static files. The policy is a
 * backstop for that (scripts stay inline-allowed because the static export inlines its data).
 * Dev mode needs eval and a websocket for hot reload, so it's only added to production builds.
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self' data: blob:",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
].join('; ');

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={archivo.variable}>
      <head>
        {process.env.NODE_ENV === 'production' ? (
          <meta httpEquiv="Content-Security-Policy" content={CSP} />
        ) : null}
      </head>
      <body>
        <SiteHeader />
        {children}
        <footer className="site-footer">
          <span>
            Redline is open source (MIT). Every run on this site was recorded; nothing here calls an
            API.
          </span>
          <span>
            <a href="https://github.com/simonlunay/redline">Source on GitHub</a>
          </span>
        </footer>
      </body>
    </html>
  );
}
