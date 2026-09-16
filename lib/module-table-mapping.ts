/**
 * Module to Database Table Mapping System
 *
 * This file defines which database tables are required for each module/menu item
 * in the application. Used for subscription management and access control.
 */

export interface ModuleTableMapping {
  moduleId: string;
  moduleName: string;
  modulePath: string;
  description: string;
  requiredTables: string[]; // Array of table names from tbldatabasetable
  category: 'core' | 'management' | 'reporting' | 'admin' | 'system';
  minAccessLevel?: number; // Minimum access level required (optional)
  defaultIncluded?: boolean; // Available to every authenticated account regardless of plan table rows
}

/**
 * Complete mapping of modules to their required database tables
 */
export const MODULE_TABLE_MAPPINGS: ModuleTableMapping[] = [
  {
    moduleId: 'dashboard',
    moduleName: 'Dashboard',
    modulePath: '/dashboard',
    description: 'Overview & analytics dashboard',
    category: 'core',
    defaultIncluded: true,
    requiredTables: [
      'tblaccount',
      'tblaccountuser',
      'tbluser',
      'tblworklog',
      'tblemployee',
      'tblcar',
      'tblchecklisttemplate'
    ]
  },
  {
    moduleId: 'clockin',
    moduleName: 'Clock In',
    modulePath: '/clockin',
    description: 'Employee time tracking',
    category: 'core',
    requiredTables: [
      'tblemployee',
      'tblworklog',
      'tblworktemplate',
      'tblaccount'
    ]
  },
  {
    moduleId: 'worktemplate',
    moduleName: 'Work Schedules',
    modulePath: '/worktemplate',
    description: 'Define work schedules and templates',
    category: 'management',
    requiredTables: [
      'tblworktemplate',
      'tblaccount',
      'tblworklog'
    ]
  },
  {
    moduleId: 'Checklist',
    moduleName: 'Checklists',
    modulePath: '/checklist',
    description: 'Manage checklists and inspections',
    category: 'management',
    requiredTables: [
      'tblchecklisttemplate',
      'tblchecklisttemplateitem',
      'tbluser_checklist_session',
      'tbluser_checklist_item',
      'tblemployee',
      'tblaccount',
      'tblcar_checklist_session'
    ]
  },
  {
    moduleId: 'workorder',
    moduleName: 'Work Orders',
    modulePath: '/workorder',
    description: 'Pickup orders and work assignments',
    category: 'management',
    requiredTables: [
      'tblpickup_order',
      'tblpickup_order_item',
      'tblpickup_order_session',
      'tblworkorder_worklog',
      'tblworkorder_contract',
      'tblworkorder_contract_acceptance',
      'tblcustomers',
      'tblemployee',
      'tblaccount'
    ]
  },
  {
    moduleId: 'customer',
    moduleName: 'Customer Management',
    modulePath: '/customers',
    description: 'Manage customers and keys',
    category: 'management',
    requiredTables: [
      'tblcustomers',
      'tblkey',
      'tblcustomerkey',
      'tblaccount'
    ]
  },
  {
    moduleId: 'carpool',
    moduleName: 'CarPool',
    modulePath: '/carpool',
    description: 'Manage vehicle fleet',
    category: 'management',
    requiredTables: [
      'tblaccount',
      'tblcar',
      'tblcar_checklist_session',
      'tbluser_checklist_session'
    ]
  },
  {
    moduleId: 'rental-order',
    moduleName: 'Rental Order',
    modulePath: '/rental-order',
    description: 'Car rental orders',
    category: 'management',
    requiredTables: [
      'tblrental_order',
      'tblrental_order_event',
      'tblrental_order_contract',
      'tblrental_order_contract_acceptance',
      'tblcustomers',
      'tblcar',
      'tblchecklisttemplate',
      'tblcar_checklist_session',
      'tblaccount'
    ]
  },
  {
    moduleId: 'reports',
    moduleName: 'Reports',
    modulePath: '/reports',
    description: 'Performance reports and analytics',
    category: 'reporting',
    requiredTables: [
      'tblworklog',
      'tblemployee',
      'tblcar',
      'tblchecklisttemplate',
      'tbluser_checklist_session',
      'tbluser_checklist_item',
      'tblaccount'
    ]
  },
  {
    moduleId: 'gallery',
    moduleName: 'Gallery',
    modulePath: '/gallery',
    description: 'Photolog and media files',
    category: 'management',
    requiredTables: [
      'tblworkorder_gallery_image',
      'tblworkorder_gallery_share',
      'tblaccount',
      'tbluser'
    ]
  },
  {
    moduleId: 'messages',
    moduleName: 'InstMsg',
    modulePath: '/admin/messages',
    description: 'Internal messaging system',
    category: 'core',
    requiredTables: [
      'tblmessagedelivery',
      'tblmessagetemplate',
      'tbluser',
      'tblaccount'
    ]
  },
  {
    moduleId: 'profile',
    moduleName: 'Profile Settings',
    modulePath: '/profile',
    description: 'User profile settings',
    category: 'core',
    defaultIncluded: true,
    requiredTables: [
      'tbluser',
      'tbl_password_reset_token'
    ]
  },
  {
    moduleId: 'settings',
    moduleName: 'Account Settings',
    modulePath: '/acc_settings',
    description: 'Account, users, roles & billing',
    category: 'admin',
    minAccessLevel: 10,
    requiredTables: [
      'tblaccount',
      'tblaccountuser',
      'tbluser',
      'tblinvitation',
      'tblsubscriptionplan'
    ]
  },
  {
    moduleId: 'admin',
    moduleName: 'System Admin',
    modulePath: '/admin',
    description: 'System administration panel',
    category: 'system',
    minAccessLevel: 1,
    requiredTables: [
      'tblaccount',
      'tbluser',
      'tblaccountuser',
      'tblsubscriptionplan',
      'tbldatabasetable',
      'tblsubscriptionplanaccess',
      'tblmessagedelivery',
      'tblmessagetemplate'
    ]
  },
  {
    moduleId: 'dbadmin',
    moduleName: 'Database Admin',
    modulePath: '/dbadmin',
    description: 'Database administration',
    category: 'system',
    minAccessLevel: 1,
    requiredTables: [
      'tbldatabasetable'
    ]
  }
];

/**
 * Get all tables required for a specific module
 */
export function getModuleTables(moduleId: string): string[] {
  const moduleMapping = MODULE_TABLE_MAPPINGS.find(m => m.moduleId === moduleId);
  return moduleMapping?.requiredTables || [];
}

/**
 * Get all modules that require a specific table
 */
export function getModulesForTable(tableName: string): ModuleTableMapping[] {
  return MODULE_TABLE_MAPPINGS.filter(module =>
    module.requiredTables.includes(tableName)
  );
}

/**
 * Get all unique tables required for a list of modules
 */
export function getTablesForModules(moduleIds: string[]): string[] {
  const tables = new Set<string>();

  moduleIds.forEach(moduleId => {
    const moduleTables = getModuleTables(moduleId);
    moduleTables.forEach(table => tables.add(table));
  });

  return Array.from(tables);
}

/**
 * Get modules grouped by category
 */
export function getModulesByCategory(): Record<string, ModuleTableMapping[]> {
  return MODULE_TABLE_MAPPINGS.reduce((acc, module) => {
    if (!acc[module.category]) {
      acc[module.category] = [];
    }
    acc[module.category].push(module);
    return acc;
  }, {} as Record<string, ModuleTableMapping[]>);
}

/**
 * Check if a subscription plan has access to a module
 * based on the tables included in the plan
 */
export function hasModuleAccess(
  moduleId: string,
  planTableIds: number[],
  allTables: { id: number; table_name: string }[],
  userAccessLevel?: number | null
): boolean {
  const moduleMapping = MODULE_TABLE_MAPPINGS.find(m => m.moduleId === moduleId);
  if (!moduleMapping) return true;

  if (
    typeof moduleMapping.minAccessLevel === 'number'
    && typeof userAccessLevel === 'number'
    && userAccessLevel > moduleMapping.minAccessLevel
  ) {
    return false;
  }

  if (moduleMapping.defaultIncluded) return true;

  const requiredTables = moduleMapping.requiredTables;
  const planTableNames = allTables
    .filter(t => planTableIds.includes(t.id))
    .map(t => t.table_name);

  // Check if all required tables are in the plan
  return requiredTables.every(table => planTableNames.includes(table));
}

/**
 * Get modules accessible with a subscription plan
 */
export function getAccessibleModules(
  planTableIds: number[],
  allTables: { id: number; table_name: string }[],
  userAccessLevel?: number | null
): ModuleTableMapping[] {
  return MODULE_TABLE_MAPPINGS.filter(module =>
    hasModuleAccess(module.moduleId, planTableIds, allTables, userAccessLevel)
  );
}

/**
 * Get module information by ID
 */
export function getModuleInfo(moduleId: string): ModuleTableMapping | undefined {
  return MODULE_TABLE_MAPPINGS.find(m => m.moduleId === moduleId);
}

/**
 * Get all tables for a specific category
 */
export function getTablesForCategory(category: string): string[] {
  const tables = new Set<string>();

  MODULE_TABLE_MAPPINGS
    .filter(m => m.category === category)
    .forEach(module => {
      module.requiredTables.forEach(table => tables.add(table));
    });

  return Array.from(tables);
}

/**
 * Export module categories as constants
 */
export const MODULE_CATEGORIES = {
  CORE: 'core',
  MANAGEMENT: 'management',
  REPORTING: 'reporting',
  ADMIN: 'admin',
  SYSTEM: 'system'
} as const;

export type ModuleCategory = typeof MODULE_CATEGORIES[keyof typeof MODULE_CATEGORIES];
