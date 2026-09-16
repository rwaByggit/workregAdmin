/**
 * useModuleAccess Hook
 *
 * Custom hook to check if the current user/account has access to specific modules
 * based on their subscription plan and table permissions.
 */

import { useState, useEffect, useCallback } from 'react';
import { MODULE_TABLE_MAPPINGS, ModuleTableMapping } from '@/lib/module-table-mapping';
import { DatabaseTable } from '@/types';

interface UseModuleAccessResult {
  canAccessModule: (moduleId: string) => boolean;
  accessibleModules: ModuleTableMapping[];
  isLoading: boolean;
  error: string | null;
}

interface UseModuleAccessProps {
  accountId?: bigint | number | string | null;
  subscriptionPlanId?: number | null;
  userAccessLevel?: number | null;
}

/**
 * Hook to check module access based on subscription plan
 *
 * @param accountId - The account ID to check access for
 * @param subscriptionPlanId - Optional subscription plan ID (will be fetched if not provided)
 * @returns Object with access checking functions and state
 *
 * @example
 * ```tsx
 * const { canAccessModule, accessibleModules, isLoading } = useModuleAccess({ accountId: 123 });
 *
 * if (canAccessModule('reports')) {
 *   // Show reports menu
 * }
 * ```
 */
export function useModuleAccess({
  accountId,
  subscriptionPlanId,
  userAccessLevel
}: UseModuleAccessProps = {}): UseModuleAccessResult {
  const [accessibleModules, setAccessibleModules] = useState<ModuleTableMapping[]>([]);
  const [accessibleModuleIds, setAccessibleModuleIds] = useState<Set<string>>(new Set());
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function fetchAccessData() {
      if (!accountId) {
        setAccessibleModuleIds(new Set());
        setAccessibleModules([]);
        setIsLoading(false);
        return;
      }

      try {
        setIsLoading(true);
        setError(null);

        const accessResponse = await fetch(`/api/subscription/access/${accountId}`, {
          cache: 'no-store',
        });
        if (!accessResponse.ok) {
          throw new Error('Failed to fetch subscription access');
        }

        const accessData = await accessResponse.json();
        const moduleIds = new Set<string>(
          Array.isArray(accessData.modules)
            ? accessData.modules.map((module: any) => module.moduleId).filter(Boolean)
            : []
        );

        setAccessibleModuleIds(moduleIds);
        setAccessibleModules(
          MODULE_TABLE_MAPPINGS.filter((module) => moduleIds.has(module.moduleId))
        );

        if (subscriptionPlanId && accessData.subscriptionPlan?.id !== subscriptionPlanId) {
          console.warn('Fetched subscription access for a different plan than requested');
        }
      } catch (err) {
        console.error('Error fetching module access data:', err);
        setError(err instanceof Error ? err.message : 'Unknown error');
        setAccessibleModuleIds(new Set());
        setAccessibleModules([]);
      } finally {
        setIsLoading(false);
      }
    }

    fetchAccessData();
  }, [accountId, subscriptionPlanId, userAccessLevel]);

  const canAccessModule = useCallback((moduleId: string): boolean => {
    if (isLoading || error) return false;
    return accessibleModuleIds.has(moduleId);
  }, [accessibleModuleIds, error, isLoading]);

  return {
    canAccessModule,
    accessibleModules,
    isLoading,
    error
  };
}

/**
 * Simple synchronous module access checker
 * Use when you already have the plan table IDs and all tables loaded
 */
export function checkModuleAccess(
  moduleId: string,
  planTableIds: number[],
  allTables: DatabaseTable[]
): boolean {
  const moduleInfo = MODULE_TABLE_MAPPINGS.find((module) => module.moduleId === moduleId);
  if (!moduleInfo) return true;
  if (moduleInfo.defaultIncluded) return true;

  const planTableNames = new Set(
    allTables
      .filter((table) => planTableIds.includes(table.id))
      .map((table) => table.table_name)
  );

  return moduleInfo.requiredTables.every((tableName) => planTableNames.has(tableName));
}
