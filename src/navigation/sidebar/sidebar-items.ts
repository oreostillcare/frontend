import {
  ChartNoAxesCombined,
  CircleUserRound,
  LayoutDashboard,
  type LucideIcon,
  ScrollText,
  Users,
  Video,
} from "lucide-react";

export type NavBadge = "new" | "soon";

export interface NavSubItem {
  id: string;
  title: string;
  url: string;
  icon?: LucideIcon;
  badge?: NavBadge;
  disabled?: boolean;
  newTab?: boolean;
}

interface NavItemBase {
  id: string;
  title: string;
  icon?: LucideIcon;
  badge?: NavBadge;
  disabled?: boolean;
  newTab?: boolean;
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
      { id: "staff", title: "Staff Information", url: "/dashboard/staff", icon: Users },
      { id: "account", title: "Account", url: "/dashboard/account", icon: CircleUserRound },
    ],
  },
];
