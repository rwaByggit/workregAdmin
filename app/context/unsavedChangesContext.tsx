'use client';

import React, { createContext, useContext, useState, useCallback, ReactNode, useEffect, useRef } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { toast } from "sonner";
import { usePathname } from 'next/navigation';

interface UnsavedChangesContextType {
  hasUnsavedChanges: boolean;
  setUnsavedChanges: (hasChanges: boolean) => void;
  registerComponent: (id: string, hasChanges: boolean) => void;
  unregisterComponent: (id: string) => void;
  confirmNavigation: (callback: () => void) => void;
  UnsavedChangesDialog: React.FC;
}

const UnsavedChangesContext = createContext<UnsavedChangesContextType | undefined>(undefined);

interface UnsavedChangesProviderProps {
  children: ReactNode;
}

export const UnsavedChangesProvider: React.FC<UnsavedChangesProviderProps> = ({ children }) => {
  const [componentsWithChanges, setComponentsWithChanges] = useState<Record<string, boolean>>({});
  const [dialogOpen, setDialogOpen] = useState(false);
  const [pendingCallback, setPendingCallback] = useState<(() => void) | null>(null);
  const pathname = usePathname();
  const previousPathname = useRef(pathname);

  // Determine if any component has unsaved changes
  const hasUnsavedChanges = Object.values(componentsWithChanges).some(hasChanges => hasChanges);

  // Reset unsaved changes when path changes
  useEffect(() => {
    // Only clear changes when the pathname has actually changed
    if (pathname !== previousPathname.current) {
      // Reset the global unsaved changes state
      setComponentsWithChanges({});
      previousPathname.current = pathname;
    }
  }, [pathname]);

  // Register a component with unsaved changes
  const registerComponent = useCallback((id: string, hasChanges: boolean) => {
    setComponentsWithChanges(prev => ({
      ...prev,
      [id]: hasChanges
    }));
  }, []);

  // Unregister a component (e.g., when it unmounts)
  const unregisterComponent = useCallback((id: string) => {
    setComponentsWithChanges(prev => {
      const newState = { ...prev };
      delete newState[id];
      return newState;
    });
  }, []);

  // Simple setter for global unsaved changes state
  const setUnsavedChanges = useCallback((hasChanges: boolean) => {
    registerComponent('global', hasChanges);
  }, [registerComponent]);

  // Handle navigation with confirmation if there are unsaved changes
  const confirmNavigation = useCallback((callback: () => void) => {
    if (hasUnsavedChanges) {
      setPendingCallback(() => callback);
      setDialogOpen(true);
    } else {
      callback();
    }
  }, [hasUnsavedChanges]);

  // Add browser beforeunload event listener
  useEffect(() => {
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      if (hasUnsavedChanges) {
        e.preventDefault();
        e.returnValue = 'You have unsaved changes. Are you sure you want to leave?';
        return e.returnValue;
      }
    };

    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload);
    };
  }, [hasUnsavedChanges]);

  // Cancel navigation
  const handleCancel = useCallback(() => {
    setPendingCallback(null);
    setDialogOpen(false);
  }, []);

  // Confirm navigation (discard changes)
  const handleConfirm = useCallback(() => {
    if (pendingCallback) {
      pendingCallback();
    }
    setPendingCallback(null);
    setDialogOpen(false);
  }, [pendingCallback]);

  // Save changes then navigate
  const handleSave = useCallback(() => {
    // Try to find and trigger the save button
    const saveButton: HTMLButtonElement | null = document.querySelector('button[type="submit"]');
    if (saveButton) {
      saveButton.click();

      // Wait a moment for the save to complete
      setTimeout(() => {
        if (pendingCallback) {
          pendingCallback();
        }
        setPendingCallback(null);
        setDialogOpen(false);
      }, 500);
    } else {
      toast.error("Couldn't find save button. Please save your changes manually.");
    }
  }, [pendingCallback]);

  // Reusable UnsavedChangesDialog component
  const UnsavedChangesDialog: React.FC = () => (
    <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
      <DialogContent className="bg-white w-auto">
        <DialogHeader>
          <DialogTitle>Unsaved Changes</DialogTitle>
          <DialogDescription>
            You have unsaved changes. Would you like to save your changes or discard them?
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="flex justify-end space-x-2">
          <Button
            variant="outline"
            className='hover:bg-gray-50'
            onClick={handleCancel}
          >
            Cancel
          </Button>
          <Button
            variant="outline"
            className="text-amber-600 border-amber-200 hover:bg-amber-50"
            onClick={handleConfirm}
          >
            Discard Changes
          </Button>
          <Button
            className="bg-blue-600 hover:bg-blue-700 text-white"
            onClick={handleSave}
          >
            Save Changes
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );

  const value = {
    hasUnsavedChanges,
    setUnsavedChanges,
    registerComponent,
    unregisterComponent,
    confirmNavigation,
    UnsavedChangesDialog,
  };

  return (
    <UnsavedChangesContext.Provider value={value}>
      {children}
      <UnsavedChangesDialog />
    </UnsavedChangesContext.Provider>
  );
};

// Hook for using the UnsavedChanges context
export const useUnsavedChanges = () => {
  const context = useContext(UnsavedChangesContext);
  if (context === undefined) {
    throw new Error('useUnsavedChanges must be used within a UnsavedChangesProvider');
  }
  return context;
};