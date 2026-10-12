'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const NAV = [
  { href: '/gallery/', label: 'Runs' },
  { href: '/check/', label: 'Check a design' },
  { href: 'https://github.com/simonlunay/redline', label: 'GitHub' },
  { href: 'https://www.npmjs.com/package/@simonlunay/redline', label: 'npm' },
];

export function SiteHeader() {
  const path = usePathname();
  return (
    <header className="site-header">
      <Link href="/" className="wordmark" aria-label="Redline, home">
        Redline
        <svg viewBox="0 0 100 7" preserveAspectRatio="none" aria-hidden="true">
          <path
            d="M1 4.5 C 20 2.2, 45 5.6, 70 3.4 S 95 3.2, 99 3"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinecap="round"
          />
        </svg>
      </Link>
      <nav className="site-nav" aria-label="Main">
        {NAV.map((item) =>
          item.href.startsWith('http') ? (
            <a key={item.href} href={item.href}>
              {item.label}
            </a>
          ) : (
            <Link
              key={item.href}
              href={item.href}
              aria-current={path?.startsWith(item.href.replace(/\/$/, '')) ? 'page' : undefined}
            >
              {item.label}
            </Link>
          ),
        )}
      </nav>
    </header>
  );
}
