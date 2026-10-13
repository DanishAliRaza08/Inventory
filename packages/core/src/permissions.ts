/**
 * Permission catalogue. Permissions are enforced on the backend for every request;
 * the front end only uses them to hide controls.
 */
export const PERMISSIONS = {
  // Catalogue & inventory
  'products.read': 'View products, SKUs and variations',
  'products.write': 'Create and edit products, SKUs and variations',
  'products.delete': 'Archive / delete products',
  'inventory.read': 'View inventory levels and movements',
  'inventory.adjust': 'Adjust stock and run stock checks',
  'suppliers.read': 'View suppliers and supplier products',
  'suppliers.write': 'Create and edit suppliers and supplier products',
  // Costs & finance
  'costs.read': 'View product costs and cost history',
  'costs.write': 'Edit product costs and supplier prices',
  'fees.write': 'Configure marketplace fee rules',
  'finance.read': 'View profit, fees, expenses and financial reports',
  'finance.reconcile': 'Import and reconcile actual fees and settlements',
  'expenses.write': 'Record business expenses',
  'fx.write': 'Manage exchange rates',
  // Listings
  'listings.read': 'View marketplace listings and drafts',
  'listings.write': 'Create and edit listing drafts, upload images',
  'listings.submit': 'Submit drafts for approval',
  'listings.approve': 'Approve or reject drafts',
  'listings.publish': 'Publish approved listings to marketplaces',
  'listings.end': 'Pause or end live listings',
  // Orders
  'orders.read': 'View orders',
  'orders.manage': 'Manage orders, fulfilment and tracking',
  'orders.customer_pii': 'View customer names and shipping addresses',
  'returns.manage': 'Handle returns and refunds',
  // Platform
  'imports.run': 'Run bulk imports',
  'exports.run': 'Run bulk exports',
  'reports.read': 'View analytics and reports',
  'automation.manage': 'Create and edit automation rules',
  'integrations.manage': 'Connect marketplace and supplier accounts',
  'users.manage': 'Manage staff accounts and roles',
  'audit.read': 'View the audit log',
  'settings.manage': 'Manage system settings and emergency controls',
} as const;

export type Permission = keyof typeof PERMISSIONS;
export const ALL_PERMISSIONS = Object.keys(PERMISSIONS) as Permission[];

export interface RoleDefinition {
  key: string;
  name: string;
  description: string;
  permissions: Permission[];
  /** Privileged roles must enrol in multi-factor authentication. */
  requiresMfa: boolean;
}

export const DEFAULT_ROLES: RoleDefinition[] = [
  {
    key: 'owner',
    name: 'Owner / Super Admin',
    description: 'Full system access including marketplace connections, finance, staff and publishing.',
    permissions: ALL_PERMISSIONS,
    requiresMfa: true,
  },
  {
    key: 'inventory_manager',
    name: 'Inventory Manager',
    description: 'Manage products, SKUs, stock and suppliers; update supplier costs; run stock checks.',
    permissions: [
      'products.read', 'products.write', 'inventory.read', 'inventory.adjust', 'suppliers.read', 'suppliers.write',
      'costs.read', 'costs.write', 'listings.read', 'imports.run', 'exports.run', 'orders.read',
    ],
    requiresMfa: false,
  },
  {
    key: 'listing_manager',
    name: 'Listing Manager',
    description: 'Create and edit listings, upload images, save drafts and submit them for approval.',
    permissions: ['products.read', 'inventory.read', 'suppliers.read', 'listings.read', 'listings.write', 'listings.submit', 'imports.run'],
    requiresMfa: false,
  },
  {
    key: 'listing_approver',
    name: 'Listing Approver',
    description: 'Review, approve or reject drafts and authorise publishing.',
    permissions: ['products.read', 'inventory.read', 'costs.read', 'listings.read', 'listings.approve', 'listings.publish', 'listings.end'],
    requiresMfa: true,
  },
  {
    key: 'order_manager',
    name: 'Order Manager',
    description: 'Manage orders, fulfilment and tracking; handle supported return workflows.',
    permissions: ['products.read', 'inventory.read', 'orders.read', 'orders.manage', 'orders.customer_pii', 'returns.manage', 'suppliers.read'],
    requiresMfa: false,
  },
  {
    key: 'finance_manager',
    name: 'Finance Manager',
    description: 'Review costs, fees, expenses and profit; reconcile actual financial data.',
    permissions: [
      'products.read', 'costs.read', 'fees.write', 'finance.read', 'finance.reconcile', 'expenses.write', 'fx.write',
      'orders.read', 'reports.read', 'exports.run', 'audit.read',
    ],
    requiresMfa: true,
  },
  {
    key: 'viewer',
    name: 'Viewer',
    description: 'Read-only access to specifically permitted screens.',
    permissions: ['products.read', 'inventory.read', 'listings.read', 'orders.read'],
    requiresMfa: false,
  },
];

export function hasPermission(granted: Iterable<string>, required: Permission | Permission[]): boolean {
  const set = new Set(granted);
  const req = Array.isArray(required) ? required : [required];
  return req.every((p) => set.has(p));
}
