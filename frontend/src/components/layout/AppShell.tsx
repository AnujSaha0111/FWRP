import * as DialogPrimitive from '@radix-ui/react-dialog';
import { useQuery } from '@tanstack/react-query';
import {
  Activity,
  BarChart3,
  Bell,
  CalendarClock,
  ClipboardList,
  FileClock,
  Flag,
  HandHeart,
  LayoutDashboard,
  Leaf,
  LogOut,
  Menu,
  Package,
  PackagePlus,
  Search,
  Settings,
  ShieldCheck,
  Sparkles,
  Truck,
  UserCheck,
  UserRound,
  Users,
  X,
} from 'lucide-react';
import { useState, type ComponentType } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate, useNavigation } from 'react-router';
import { notificationsApi } from '@/api/endpoints';
import type { Role } from '@/api/types';
import { ROLE_LABEL, useProfile, useAuth } from '@/auth/AuthProvider';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Alert } from '@/components/ui/surface';
import { cn } from '@/lib/utils';

interface NavItem {
  to: string;
  label: string;
  icon: ComponentType<{ className?: string }>;
  end?: boolean;
}

const NAV: Record<Role, NavItem[]> = {
  PROVIDER: [
    { to: '/provider', label: 'Dashboard', icon: LayoutDashboard, end: true },
    { to: '/provider/donations', label: 'My donations', icon: Package, end: true },
    { to: '/provider/donations/new', label: 'New donation', icon: PackagePlus },
  ],
  RECIPIENT: [
    { to: '/recipient', label: 'Dashboard', icon: LayoutDashboard, end: true },
    { to: '/recipient/matches', label: 'Matches', icon: Sparkles },
    { to: '/recipient/browse', label: 'Browse donations', icon: Search },
    { to: '/recipient/requirements', label: 'Requirements', icon: ClipboardList },
    { to: '/recipient/deliveries', label: 'Deliveries', icon: Truck },
  ],
  VOLUNTEER: [
    { to: '/volunteer', label: 'Dashboard', icon: LayoutDashboard, end: true },
    { to: '/volunteer/deliveries', label: 'Assignments', icon: Truck },
    { to: '/volunteer/availability', label: 'Availability', icon: CalendarClock },
  ],
  ADMIN: [
    { to: '/admin', label: 'Overview', icon: LayoutDashboard, end: true },
    { to: '/admin/pickups', label: 'Pickup queue', icon: UserCheck },
    { to: '/admin/monitoring', label: 'Monitoring', icon: Activity },
    { to: '/admin/organizations', label: 'Verification', icon: ShieldCheck },
    { to: '/admin/users', label: 'Users', icon: Users },
    { to: '/admin/incidents', label: 'Reports & disputes', icon: Flag },
    { to: '/admin/reports', label: 'Analytics & export', icon: BarChart3 },
    { to: '/admin/settings', label: 'Settings', icon: Settings },
    { to: '/admin/activity', label: 'Activity log', icon: FileClock },
  ],
};

const SHARED_NAV: NavItem[] = [
  { to: '/notifications', label: 'Notifications', icon: Bell },
  { to: '/reports', label: 'Report a problem', icon: Flag },
  { to: '/profile', label: 'Profile', icon: UserRound },
];

const ROLE_ICON: Record<Role, ComponentType<{ className?: string }>> = {
  PROVIDER: Package,
  RECIPIENT: HandHeart,
  VOLUNTEER: Truck,
  ADMIN: ClipboardList,
};

function Brand() {
  return (
    <Link to="/" className="flex items-center gap-2 rounded-md font-semibold text-foreground">
      <span className="flex size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
        <Leaf className="size-5" aria-hidden="true" />
      </span>
      <span>FWRP</span>
    </Link>
  );
}

function NavList({ items, onNavigate }: { items: NavItem[]; onNavigate?: () => void }) {
  return (
    <ul className="flex flex-col gap-1">
      {items.map(({ to, label, icon: Icon, end }) => (
        <li key={to}>
          <NavLink
            to={to}
            end={end}
            onClick={onNavigate}
            className={({ isActive }) =>
              cn(
                'flex min-h-11 items-center gap-3 rounded-lg px-3 text-sm font-medium transition-colors duration-200',
                isActive ? 'bg-primary-soft text-primary' : 'text-muted-foreground hover:bg-muted hover:text-foreground'
              )
            }
          >
            <Icon className="size-5 shrink-0" aria-hidden="true" />
            {label}
          </NavLink>
        </li>
      ))}
    </ul>
  );
}

function Sidebar({ role, onNavigate }: { role: Role; onNavigate?: () => void }) {
  return (
    <nav aria-label="Main" className="flex flex-col gap-6">
      <NavList items={NAV[role]} onNavigate={onNavigate} />
      <div>
        <p className="mb-2 px-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">Account</p>
        <NavList items={SHARED_NAV} onNavigate={onNavigate} />
      </div>
    </nav>
  );
}

function NotificationBell() {
  const { data } = useQuery({
    queryKey: ['notifications', 'unread-count'],
    queryFn: notificationsApi.unreadCount,
    refetchInterval: 60_000,
  });
  const count = data?.count ?? 0;
  return (
    <Button asChild variant="ghost" size="icon" className="relative">
      <Link to="/notifications" aria-label={count > 0 ? `Notifications, ${count} unread` : 'Notifications'}>
        <Bell className="size-5" aria-hidden="true" />
        {count > 0 && (
          <span
            className="tabular absolute right-1.5 top-1.5 flex min-w-5 items-center justify-center rounded-full bg-destructive px-1 text-[11px] font-semibold leading-5 text-white"
            aria-hidden="true"
          >
            {count > 99 ? '99+' : count}
          </span>
        )}
      </Link>
    </Button>
  );
}

function UserMenu() {
  const { user } = useProfile();
  const { logout } = useAuth();
  const navigate = useNavigate();
  const RoleIcon = ROLE_ICON[user.role];
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" className="max-w-56 px-2" aria-label={`Account menu for ${user.name}`}>
          <span className="flex size-8 items-center justify-center rounded-full bg-muted text-sm font-semibold text-foreground" aria-hidden="true">
            {user.name.trim().charAt(0).toUpperCase()}
          </span>
          <span className="hidden truncate text-left sm:block">{user.name}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuLabel>
          <span className="block truncate font-medium text-foreground">{user.email}</span>
          <span className="mt-0.5 flex items-center gap-1">
            <RoleIcon className="size-3.5" aria-hidden="true" />
            {ROLE_LABEL[user.role]}
          </span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => navigate('/profile')}>
          <UserRound aria-hidden="true" /> Profile
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => navigate('/reports')}>
          <Flag aria-hidden="true" /> Reports & disputes
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={async () => {
            await logout();
            navigate('/login', { replace: true });
          }}
        >
          <LogOut aria-hidden="true" /> Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function VerificationBanner() {
  const { user, organization } = useProfile();
  if (!organization || organization.verificationStatus === 'VERIFIED' || user.role === 'ADMIN') return null;
  const rejected = organization.verificationStatus === 'REJECTED';
  return (
    <Alert tone={rejected ? 'danger' : 'warning'} className="mb-6" title={rejected ? 'Organization not verified' : 'Verification pending'}>
      {rejected
        ? `${organization.name} was not verified. Contact an administrator or file a report from "Reports & disputes".`
        : `${organization.name} is waiting for an administrator to verify it. Some actions (accepting donations, requirements) unlock once it is verified.`}
    </Alert>
  );
}

export function AppShell() {
  const { user } = useProfile();
  const [menuOpen, setMenuOpen] = useState(false);
  const location = useLocation();
  const navigating = useNavigation().state === 'loading';

  return (
    <div className="min-h-dvh lg:grid lg:grid-cols-[16rem_1fr]">
      <a
        href="#main"
        className="sr-only z-50 rounded-md bg-card px-4 py-2 font-medium focus:not-sr-only focus:fixed focus:left-4 focus:top-4"
      >
        Skip to content
      </a>

      <aside className="sticky top-0 hidden h-dvh flex-col gap-8 overflow-y-auto border-r border-border bg-card px-4 py-5 lg:flex">
        <div className="px-2">
          <Brand />
        </div>
        <Sidebar role={user.role} />
      </aside>

      <DialogPrimitive.Root open={menuOpen} onOpenChange={setMenuOpen}>
        <DialogPrimitive.Portal>
          <DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-foreground/40 lg:hidden" />
          <DialogPrimitive.Content
            className="fixed inset-y-0 left-0 z-50 flex w-72 max-w-[85vw] flex-col gap-8 overflow-y-auto bg-card px-4 py-5 shadow-xl lg:hidden"
            aria-describedby={undefined}
          >
            <div className="flex items-center justify-between px-2">
              <DialogPrimitive.Title asChild>
                <span>
                  <Brand />
                </span>
              </DialogPrimitive.Title>
              <DialogPrimitive.Close className="cursor-pointer rounded-md p-2 text-muted-foreground hover:bg-muted" aria-label="Close menu">
                <X className="size-5" aria-hidden="true" />
              </DialogPrimitive.Close>
            </div>
            <Sidebar role={user.role} onNavigate={() => setMenuOpen(false)} />
          </DialogPrimitive.Content>
        </DialogPrimitive.Portal>
      </DialogPrimitive.Root>

      <div className="flex min-w-0 flex-col">
        <header className="sticky top-0 z-30 flex h-16 items-center gap-2 border-b border-border bg-card/95 px-4 backdrop-blur sm:px-6">
          {navigating && (
            <div className="absolute inset-x-0 top-0 h-0.5 overflow-hidden" role="progressbar" aria-label="Loading page">
              <div className="h-full w-1/3 animate-pulse bg-primary" />
            </div>
          )}
          <Button variant="ghost" size="icon" className="lg:hidden" onClick={() => setMenuOpen(true)} aria-label="Open menu">
            <Menu className="size-5" aria-hidden="true" />
          </Button>
          <div className="lg:hidden">
            <Brand />
          </div>
          <div className="ml-auto flex items-center gap-1">
            <NotificationBell />
            <UserMenu />
          </div>
        </header>

        <main id="main" tabIndex={-1} className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 outline-none sm:px-6 lg:py-8" key={location.pathname}>
          <VerificationBanner />
          <Outlet />
        </main>
      </div>
    </div>
  );
}
