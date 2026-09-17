'use client';

import {
  ArchiveRestore,
  DatabaseBackup,
  HardDrive,
  type LucideIcon,
} from 'lucide-react';

export type TableWorkspaceTab = 'backup' | 'restore';
export type WorkspaceTab = TableWorkspaceTab | 'storage';

interface WorkspaceTabsProps {
  activeTab: WorkspaceTab;
  onChange: (tab: WorkspaceTab) => void;
}

export function WorkspaceTabs({ activeTab, onChange }: WorkspaceTabsProps) {
  return (
    <div className="border-b border-gray-200 bg-white">
      <div className="mx-auto flex max-w-[1500px] px-4 sm:px-6" role="tablist" aria-label="Database operations">
        <WorkspaceTabButton active={activeTab === 'backup'} icon={DatabaseBackup} label="Backup tables" onClick={() => onChange('backup')} />
        <WorkspaceTabButton active={activeTab === 'restore'} icon={ArchiveRestore} label="Restore tables" onClick={() => onChange('restore')} />
        <WorkspaceTabButton active={activeTab === 'storage'} icon={HardDrive} label="Storage" onClick={() => onChange('storage')} />
      </div>
    </div>
  );
}

function WorkspaceTabButton({ active, icon: Icon, label, onClick }: { active: boolean; icon: LucideIcon; label: string; onClick: () => void }) {
  return <button type="button" role="tab" aria-selected={active} onClick={onClick} className={`flex h-12 items-center gap-2 border-b-2 px-4 text-sm font-medium ${active ? 'border-blue-700 text-blue-700' : 'border-transparent text-gray-600 hover:text-gray-950'}`}><Icon className="h-4 w-4" />{label}</button>;
}
