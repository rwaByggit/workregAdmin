'use client';

import { cn } from '@/lib/utils';

interface VersionTagProps {
  version: string;
  className?: string;
}

export default function VersionTag({ version, className }: VersionTagProps) {
  return (
    <div className={cn("fixed bottom-2 left-4 z-[60] pointer-events-none whitespace-nowrap text-[10px] text-gray-400 italic", className)}>
      App: {process.env.NEXT_PUBLIC_APP_VER}; last update: {version}
    </div>
  );
}
