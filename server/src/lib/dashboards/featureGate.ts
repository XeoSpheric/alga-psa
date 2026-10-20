/**
 * Widget dashboards ship dark: the dashboard page renders exactly as before
 * until an operator sets `DASHBOARD_WIDGETS_ENABLED=true` on the server.
 * An env switch rather than a PostHog flag so self-hosted installs can turn it
 * on without an analytics account.
 */
export function dashboardWidgetsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.DASHBOARD_WIDGETS_ENABLED ?? '').trim().toLowerCase() === 'true';
}
