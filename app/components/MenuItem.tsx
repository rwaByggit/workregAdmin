// app/components/MenuItem.tsx
'use client';

import React, { useState } from 'react';
import { LucideIcon } from 'lucide-react';
import { usePathname } from 'next/navigation';

interface ModuleProps {
  id: string;
  path: string;
  title: string;
  icon: LucideIcon;
  description: string;
}

interface MenuItemProps {
  module: ModuleProps;
  isActive: boolean;
  onClick: (id: string) => void;
  descriptionClassName?: string;
}

const MenuItem: React.FC<MenuItemProps> = ({ module, isActive, onClick, descriptionClassName = 'text-text-light' }) => {
  const [isHovered, setIsHovered] = useState(false);
  const pathname = usePathname();
  const menuItemId = `menu-${module.id.toLowerCase()}`;

  // Check if clicking would navigate to the same page
  const isSamePage = pathname === module.path;

  return (
    <div
      id={menuItemId}
      className="relative"
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      <button
        className={`flex items-start p-3 rounded-lg transition-all duration-200 whitespace-nowrap w-full ${
          isActive
            ? 'bg-primary/10 text-primary'
            : 'hover:bg-primary/5 text-neutral hover:text-accent'
        }`}
        onClick={() => {
          // Don't trigger navigation if already on the same page
          if (!isSamePage) {
            onClick(module.id);
          }
        }}
      >
        <module.icon className="w-6 h-6 shrink-0" />
        { /* The definition for the menu items on mouse hover */ }
        <span
          className="ml-4 font-medium overflow-hidden transition-all duration-200 text-left"
          style={{
            opacity: isHovered || isActive ? 1 : 0.6, // Only apply a faded effect to items that isnt selected or hovered
          }}
        >
          { /* The menu item label */}
          {module.title}
        </span>
      </button>

      {isHovered && (
        <div
          className="absolute top-0 left-[250px] bg-white shadow-lg rounded-lg p-4 w-48 z-50"
        >
          <h3 className="font-heading font-semibold text-accent">{module.title}</h3>
          <p className={`text-sm mt-1 ${descriptionClassName}`}>{module.description}</p>
        </div>
      )}
    </div>
  );
};

export default MenuItem;
