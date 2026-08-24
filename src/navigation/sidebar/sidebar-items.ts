import {
  ChartNoAxesCombined,
  CircleUserRound,
  LayoutDashboard,
  type LucideIcon,
  ScrollText,
  Users,
  Video,
} from "lucide-react";

import type { StaffRole } from "@/lib/firebase/staff-access";

export type NavBadge = "new" | "soon";

export interface NavSubItem {
  id: string;
  title: string;
  url: string;
  icon?: LucideIcon;
  badge?: NavBadge;
  disabled?: boolean;
  newTab?: boolean;
  roles?: StaffRole[];
}

interface NavItemBase {
  id: string;
  title: string;
  icon?: LucideIcon;
  badge?: NavBadge;
  disabled?: boolean;
  newTab?: boolean;
  roles?: StaffRole[];
}

export interface NavMainLinkItem extends NavItemBase {
  url: string;
  subItems?: never;
}

export interface NavMainParentItem extends NavItemBase {
  subItems: NavSubItem[];
}

export type NavMainItem = NavMainLinkItem | NavMainParentItem;

export interface NavGroup {
  id: number;
  label?: string;
  items: NavMainItem[];
}

export const sidebarItems: NavGroup[] = [
  {
    id: 1,
    label: "Traffic system",
    items: [
      { id: "dashboard", title: "Dashboard", url: "/dashboard", icon: LayoutDashboard },
      { id: "monitoring", title: "Live Monitoring", url: "/dashboard/monitoring", icon: Video },
      { id: "analytics", title: "Analytics", url: "/dashboard/analytics", icon: ChartNoAxesCombined },
      { id: "logs", title: "System Logs", url: "/dashboard/logs", icon: ScrollText },
      {
        id: "staff",
        title: "Staff Information",
        url: "/dashboard/staff",
        icon: Users,
        roles: ["Administrator"],
      },
      { id: "account", title: "Account", url: "/dashboard/account", icon: CircleUserRound },
    ],
  },
];

function isAllowedForRole(roles: StaffRole[] | undefined, role: StaffRole | null) {
  return !roles || Boolean(role && roles.includes(role));
}

export function getSidebarItemsForRole(role: StaffRole | null): NavGroup[] {
  return sidebarItems.flatMap((group) => {
    const items = group.items.flatMap((item) => {
      if (!isAllowedForRole(item.roles, role)) {
        return [];
      }

      if (!item.subItems) {
        return [item];
      }

      const subItems = item.subItems.filter((subItem) => isAllowedForRole(subItem.roles, role));
      return subItems.length > 0 ? [{ ...item, subItems }] : [];
    });

    return items.length > 0 ? [{ ...group, items }] : [];
  });
}
