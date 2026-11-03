import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createRootRoute,
  createRoute,
  createRouter,
  Link,
  Outlet,
  RouterProvider,
  useRouterState,
} from '@tanstack/react-router';
import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ApiError } from './api/client';
import { AuthProvider, useAuth } from './auth';
import { Icon, OrbLoader } from './components/ui';
import { DashboardPage } from './pages/Dashboard';
import { DiaryPage } from './pages/Diary';
import { LoginPage } from './pages/Login';
import { RecipesPage } from './pages/Recipes';
import { SettingsPage } from './pages/Settings';
import { WeightPage } from './pages/Weight';
import './styles.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      // Don't hammer the server with requests that can't succeed.
      retry: (n, err) => n < 2 && !(err instanceof ApiError && err.status < 500),
    },
  },
});

const TABS = [
  { to: '/', label: 'Dashboard', icon: 'dashboard' },
  { to: '/diary', label: 'Diary', icon: 'diary' },
  { to: '/recipes', label: 'Recipes', icon: 'recipes' },
  { to: '/weight', label: 'Weight', icon: 'weight' },
  { to: '/settings', label: 'Settings', icon: 'settings' },
] as const;

function Shell() {
  const { session } = useAuth();
  const path = useRouterState({ select: (s) => s.location.pathname });
  const scrolled = useScrolled(48);
  if (session === undefined) return <OrbLoader message="Connecting…" />;
  if (session === null) return <LoginPage />;
  const title = TABS.find((t) => t.to === path)?.label ?? 'MacroTracker';
  return (
    <>
      <header className={`nav-bar glass${scrolled ? ' scrolled' : ''}`}>
        <span className="title">{title}</span>
      </header>
      <main>
        <Outlet />
      </main>
      <nav className="tab-bar glass" aria-label="Sections">
        {TABS.map((t) => (
          <Link key={t.to} to={t.to} aria-current={path === t.to ? 'page' : undefined}>
            <Icon name={t.icon} />
            {t.label}
          </Link>
        ))}
      </nav>
    </>
  );
}

function useScrolled(past: number): boolean {
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const on = () => setScrolled(window.scrollY > past);
    on();
    window.addEventListener('scroll', on, { passive: true });
    return () => window.removeEventListener('scroll', on);
  }, [past]);
  return scrolled;
}

const root = createRootRoute({ component: Shell });
const routes = [
  createRoute({ getParentRoute: () => root, path: '/', component: DashboardPage }),
  createRoute({
    getParentRoute: () => root,
    path: '/diary',
    component: DiaryPage,
    validateSearch: (s: Record<string, unknown>): { date?: string } =>
      typeof s.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s.date) ? { date: s.date } : {},
  }),
  createRoute({ getParentRoute: () => root, path: '/recipes', component: RecipesPage }),
  createRoute({ getParentRoute: () => root, path: '/weight', component: WeightPage }),
  createRoute({ getParentRoute: () => root, path: '/settings', component: SettingsPage }),
];
const router = createRouter({ routeTree: root.addChildren(routes) });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <RouterProvider router={router} />
      </AuthProvider>
    </QueryClientProvider>
  </StrictMode>,
);
