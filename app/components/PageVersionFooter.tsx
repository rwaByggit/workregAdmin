'use client';

import { usePathname } from 'next/navigation';
import pageVersions from '@/app/lib/page-versions.json';

interface VersionInfo {
  hash: string;
  file?: string;
  updated: string;
}

type PageVersions = Record<string, VersionInfo>;

interface PageVersionFooterProps {
  version?: string;
}

export default function PageVersionFooter({ version }: PageVersionFooterProps) {
  const pathname = usePathname();
  const versions = pageVersions as PageVersions;

  // Normalize pathname to match routes (remove trailing slash)
  const normalizedPath = !pathname ? '/' : pathname === '/' ? '/' : pathname.replace(/\/$/, '');

  // Try exact match first, then try with dynamic segments removed
  let versionInfo = versions[normalizedPath];

  // If no exact match, try to find a matching pattern
  if (!versionInfo) {
    const pathParts = normalizedPath.split('/');
    // Try matching parent paths for dynamic routes
    for (let i = pathParts.length - 1; i >= 0; i--) {
      const partialPath = pathParts.slice(0, i + 1).join('/') || '/';
      if (versions[partialPath]) {
        versionInfo = versions[partialPath];
        break;
      }
    }
  }

  const pageHash = versionInfo?.hash || '-----';
  const pageDate = versionInfo?.updated || 'unknown';
  const appHash = versions['_app']?.hash || '-----';
  const appDate = versions['_app']?.updated || 'unknown';

  // Format date for display
  const formatDate = (dateStr: string) => {
    if (dateStr === 'unknown') return dateStr;
    try {
      return new Date(dateStr).toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'short',
        day: 'numeric'
      });
    } catch {
      return dateStr;
    }
  };

  return (
    <div className="text-xs text-gray-400 text-center py-2 border-t border-gray-100 mt-auto">
      {version && (
        <>
          <span className="italic" title="Last update version">
            {version}
          </span>
          <span className="mx-2">|</span>
        </>
      )}
      <span title={`Page: ${versionInfo?.file || 'unknown'}\nUpdated: ${pageDate}`}>
        Page: {pageHash} ({formatDate(pageDate)})
      </span>
      <span className="mx-2">|</span>
      <span title={`Application version\nUpdated: ${appDate}`}>
        Commit: {appHash}
      </span>
    </div>
  );
}