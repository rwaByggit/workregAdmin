'use client';

import ModularMenu from '../components/ModularMenu';
import { ReactNode } from 'react';

interface DefaultLayoutProps {
  children: ReactNode;
}

export default function DefaultLayout({
  children }: DefaultLayoutProps) {
  return (
    <ModularMenu>
      {children}
    </ModularMenu>
  );
}