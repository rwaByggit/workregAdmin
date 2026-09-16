'use client';

import { useEffect, ReactNode } from 'react';
import { usePathname } from 'next/navigation';

interface LoginLayoutProps  {
  children: ReactNode;
}

export default function LoginLayout({ children }: LoginLayoutProps) {
    const pathname = usePathname();  // <-- HOOK CALLED AT TOP LEVEL
    
    useEffect(() => {
        document.title = "Login WorgReg";
    }, [pathname]); // This effect runs whenever the pathname changes

    return (
        <div className="min-h-screen flex items-center justify-center bg-gray-100">
            {children}
        </div>
    );
}