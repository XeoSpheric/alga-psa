# MSP Dashboard Widget System — Plan

Status: draft (2026-10-19)
Goal: add user-built, shareable widget dashboards to `/msp/dashboard` alongside
the existing page (which stays the default "Home"). Dashboards are grids of
pre-built widgets (tickets, assets, time, SLA, surveys, projects). Every chart
segment / number is clickable and deep-links to the matching filtered list
elsewhere in the app.

## 1. What exists today

| Area | Current state | Ref |
|---|---|---|
| Dashboard | `DashboardContainer` = welcome banner, onboarding slot, static feature cards, mobile-app card. No data widgets. | `server/src/components/dashboard/DashboardContainer.tsx` |
| Tile chrome | `BentoTile` (title, icon, action, error, empty state) used by ticket bento + inventory | `packages/ui/src/components/bento/BentoTile.tsx` |
| Charts | `recharts` only (SLA + survey dashboards use it). No shared chart wrappers. | `packages/sla/src/components/dashboard/*`, `packages/surveys/src/components/dashboard/*` |
| Drag/drop | `@dnd-kit/*` installed and used. No grid-layout lib. | `packages/user-activities/.../GroupedActivitiesView.tsx` |
| User prefs | `user_preferences (tenant,user_id,setting_name)` JSON value | `dashboardMobileAppActions.ts` (upsert pattern, Citus-safe `now`) |
| Tenant prefs | tenant settings JSON, `settings:update` gate | `dashboardWelcomeActions.ts` |
| Aggregates | helpdesk reports, SLA reporting, survey metrics, project hours | `packages/reporting/src/actions/*`, `packages/sla/src/actions/slaReportingActions.ts`, `packages/surveys/src/actions/survey-actions/*` |

### Deep-link readiness of target pages

| Page | URL filters? | Notes |
|---|---|---|
| `/msp/tickets` | **Yes**, read + write | `statusId=open`, `priorityId=<uuid>`, `assignedToIds`, `boardIds`, `clientId`, `slaStatusFilter=breached`, `dueDateFilter=overdue`, `includeUnassigned`, `responseState`… These params suppress the remembered board view (`boardTabs.ts:182`). |
| `/msp/projects` | **Yes** | `projectStatus=open/closed`, `deadlineType`/`deadlineDate`, `managerId`, `clientId` |
| `/msp/assets` | **No** | Filters are local `useState`; page calls `listAssets({})`. Saved-view shape exists (`statuses, types, clientIds, agentStatuses, rmmManaged`). |
| `/msp/opportunities` | Partial | `tab`, `stage` |
| `/msp/surveys/*` | No | filters client-side only |
| `/msp/time-entry` | No | period view, only `subjectUserId` |
| `/msp/clients` | No | |

Known ticket-list gaps:
- `statusId=closed` is parsed but **not applied** on MSP list (`optimizedTicketActions.ts:1246-1258`) → shows everything.
- No `createdFrom/createdTo` or `closedFrom/closedTo` params → "Created last 10 days" / "Completed last 10 days" can't drill.
- No priority-by-name param; widgets must carry the `priority_id` uuid (fine — the widget query groups by id anyway).

## 2. Architecture

### 2.1 Widget registry (new package `packages/dashboard` or `packages/ui` + `server`)

```ts
type WidgetSize = 'sm' | 'md' | 'lg' | 'wide';   // grid spans: 1x1, 1x2, 2x2, 2x1 on a 4-col grid

interface WidgetDefinition<TConfig, TData> {
  id: string;                         // 'tickets.open-by-priority'
  category: 'tickets' | 'assets' | 'time' | 'sla' | 'surveys' | 'projects' | 'sales';
  titleKey: string;                   // i18n, msp/dashboard namespace
  requires: Array<[resource: string, action: string]>;   // e.g. [['ticket','read']]
  products?: Array<'psa' | 'algadesk'>;
  sizes: WidgetSize[]; defaultSize: WidgetSize;
  defaultConfig: TConfig;             // e.g. { scope: 'all' | 'mine' | 'team', days: 7, boardIds?: [] }
  configFields?: WidgetConfigField[]; // drives a generic settings popover
  load: (ctx: WidgetLoadCtx, config: TConfig) => Promise<TData>;   // server-only
  Component: React.FC<{ data: TData; config: TConfig; size: WidgetSize }>;
}
```

- Server registry (`load` fns) and client registry (`Component`) split so server code never ships to the client.
- One server action `getDashboardWidgetData(widgetId, config)`:
  `withAuth` → look up def → `hasPermission` for every `requires` pair → `load()`.
  Never trust the client's layout for permissions.
- Every datum a widget returns carries its own `href` (built server-side by a
  shared `links.ts` helper: `ticketListHref({ statusId:'open', priorityId })`).
  Components just render `<Link href={datum.href}>` / `onClick={() => router.push(datum.href)}`.
  One place to maintain URL formats; unit-testable.

### 2.2 Data loading & perf

- Each widget fetches independently (client, parallel) so one slow query doesn't block the page; skeleton per tile, `BentoTile` error state on failure.
- Short server cache per `(tenant, widgetId, configHash, userId-if-user-scoped)` — 60s TTL, same in-process cache pattern as the API-key auth cache (`f7a5312a79`).
- Optional auto-refresh (default 5 min) + manual refresh in the tile menu.
- All aggregates are `COUNT/SUM ... GROUP BY` on tenant-scoped tables; verify indexes on `tickets(tenant, status_id, priority_id)`, `tickets(tenant, entered_at)`, `tickets(tenant, closed_at)`, `time_entries(tenant, user_id, start_time)`.

### 2.3 Dashboards, layout & sharing

**Default experience is unchanged.** The current page (welcome banner, onboarding
slot, feature cards, mobile-app card) becomes a built-in, non-deletable
**"Home"** dashboard and stays the landing page for every user. Widget
dashboards are additive.

**Navigation.** Dashboard switcher (tabs / dropdown) at top of `/msp/dashboard`:
Home, then "My dashboards", then "Shared with me" (owner name + role badge). Selected dashboard in URL:
`/msp/dashboard?d=<dashboard_id>` (bookmarkable, shareable link). A user may pin
any dashboard they can see as their landing page (user pref
`msp_dashboard_landing_id`; missing/unauthorised id → Home).

**Grid.** CSS grid, 4 cols desktop / 2 tablet / 1 mobile, fixed row height,
fixed tile sizes (`sm` 1x1, `md` 1x2, `wide` 2x1, `lg` 2x2). No `react-grid-layout`.

**Edit mode** (owner or edit role): drag to reorder
(`@dnd-kit/sortable`), size picker, remove, per-widget settings, "Add widget"
drawer grouped by category (only widgets the editor may read), rename,
delete, duplicate.

**Storage — new tables**, modelled on `list_views`
(`server/migrations/20260922120000_create_list_views.cjs`: composite
`(tenant, id)` PK, Citus `ensureTenantDistribution`, FKs added outside a
transaction, no `ON DELETE SET NULL`):

```
dashboards
  tenant uuid, dashboard_id uuid  (PK tenant, dashboard_id)
  name text (1..100)
  owner_user_id uuid → users      -- exactly one owner, always
  layout jsonb      -- { version:1, widgets:[{ instanceId, widgetId, size, config }] }
  schema_version int, created_at, updated_at
  INDEX (tenant, owner_user_id)

dashboard_shares
  tenant, dashboard_id, share_id   (PK tenant, share_id)
  principal_type text CHECK in ('user','team')
  principal_id uuid               -- users.user_id or teams.team_id
  role text CHECK in ('edit','view')
  UNIQUE (tenant, dashboard_id, principal_type, principal_id)
  INDEX (tenant, principal_type, principal_id)   -- "shared with me" lookup
```

- No visibility column: a dashboard with no share rows is private.
- Owner is a column, not a share row, so "exactly one owner" is enforced by
  the schema rather than by code.
- Unknown `widgetId`s in `layout` dropped on read (lets us retire widgets).
- Owner deletion: dashboards with no shares are deleted; shared ones get
  ownership transferred (to the deleting admin, mirroring `list_views`).
  Hook into the user-deletion action. Deleted team → its share rows removed.

**Roles on a dashboard.**

| | Owner (1) | Edit | View |
|---|---|---|---|
| See dashboard | ✓ | ✓ | ✓ |
| Change layout / widgets / name | ✓ | ✓ | |
| Duplicate to own private copy | ✓ | ✓ | ✓ |
| Add / change / remove shares | ✓ (needs `dashboard:share`) | | |
| Transfer ownership | ✓ | | |
| Delete dashboard | ✓ | | |
| Remove self from share ("Leave") | | ✓ | ✓ |

- Effective role = owner, else highest of (direct user share, any team share
  via `team_members`). Edit beats view.
- **Transfer ownership**: owner picks an existing user; new owner replaces
  `owner_user_id`, old owner is kept as an `edit` share (single transaction).
- Admin override: `dashboard:manage` acts as owner on any dashboard
  (fix orphaned/misbehaving shares, transfer, delete).

**Sharing semantics.**
- Sharing shares the *layout*, never the data. Each viewer's widgets load with
  the **viewer's** permissions; a widget the viewer can't read renders a
  "No access" tile instead of data. Editors can only *add* widgets they can
  read themselves.
- "Mine"-scoped widgets (My open tickets, My hours) resolve to the viewer, so
  one shared "Tech dashboard" works for the whole team.
- Team shares are live: joining/leaving a team grants/revokes access with no
  extra step.

**Permissions** (catalog entries in `server/migrations/utils/permissions/catalog.cjs`
+ reconcile migration, same as `20260922120100_add_list_view_permissions.cjs`):
- `dashboard:share` — share a dashboard you own with users/teams.
  Default grant: **`msp:Admin` only** (psa). Admins can grant it to other roles later in the role editor; no code change.
- `dashboard:manage` — act as owner on any dashboard. Default grant: `msp:Admin`.
- Creating/editing/deleting your own dashboards needs no extra permission.

**Share dialog** (owner only): user + team picker, per-row role select
(Edit / View), remove; "Transfer ownership…" action; read-only list of
who has access for editors/viewers.

**Actions** (`withAuth`, tenant-scoped, role checked server-side on every call):
`listDashboards` (owned + shared-with-me, with effective role),
`getDashboard`, `createDashboard`, `updateDashboard` (edit role; optimistic
`updated_at` check so two editors don't clobber each other — on conflict,
reload and show "updated by X"), `deleteDashboard` (owner), `duplicateDashboard`
(any role), `setDashboardShares` (owner + `dashboard:share`),
`transferDashboardOwnership` (owner), `leaveDashboard`, `setLandingDashboard`.

**Templates.** "New dashboard" offers blank or a starter template
(Service Desk, Technician, Owner/Exec, Assets) — templates are just code-side
layout JSON.

### 2.4 Shared chart primitives (`packages/ui/src/components/charts/`)

Recharts-based, theme-token colors, keyboard focusable segments, all accept `onSelect(datum)` / per-datum `href`:
- `DonutChart` (center total, legend with counts — "Open Tickets by Priority", "Device Counts")
- `RingStat` (number inside progress ring + label — "Open Ticket Summary")
- `GaugeChart` (half-donut with min/max/value — survey score, hours vs target)
- `HBarChart` (grouped horizontal bars — "Missing patches by device type")
- `StatGrid` (big colored numbers + labels — "Project Summary")
- `MiniList` (top-N rows with link — SLA at risk, opportunities closing)

Priority colors come from the priority row's `color` column when present, else palette.

## 3. Widget catalog (v1)

Drill targets marked **✓** work today; **✗** need a list-page change (see §4).

### Tickets
| Widget | Viz | Click → |
|---|---|---|
| Open tickets by priority | Donut | ✓ `/msp/tickets?statusId=open&priorityId=<uuid>` |
| Open tickets by status | Donut/bar | ✓ `?statusId=<uuid>` |
| Open tickets by board | Bar | ✓ `?statusId=open&boardIds=<uuid>` |
| Open tickets by assignee (+ Unassigned) | Bar | ✓ `?statusId=open&assignedToIds=<uuid>` / `includeUnassigned=true` |
| Ticket summary (created 7d, completed 7d, FR met %, open, unassigned, critical) | RingStat ×6 | open/critical/unassigned ✓; created/completed ✗ (date params); FR% → SLA dashboard |
| Overdue / due today | StatGrid | ✓ `?statusId=open&dueDateFilter=overdue|today` |
| SLA breached / at risk | Stat + MiniList | ✓ `?statusId=open&slaStatusFilter=breached`; at-risk rows → ticket |
| Ticket aging (0-2d, 3-7d, 8-30d, 30d+) | Bar | ✗ (needs created-date params) |
| My open tickets | MiniList | ✓ `?statusId=open&assignedToIds=<me>` |

### Assets / RMM
| Widget | Viz | Click → |
|---|---|---|
| Device counts by type | Donut | ✗ `/msp/assets?types=server` |
| Agent status (online/offline/overdue) | Donut | ✗ `?agentStatuses=offline` |
| Devices with missing patches by type | HBar (pending patches + device count) | ✗ `?types=workstation&patchState=pending` |
| Antivirus status (protected/at risk/unknown) | Donut | ✗ `?avStatus=at_risk` |
| Stale devices (last seen > 30d) | Stat | ✗ `?lastSeenBefore=<date>` |

Data: `assets.asset_type`, `assets.agent_status`, `last_seen_at`; `workstation_assets`/`server_assets.pending_patches, failed_patches, antivirus_status`.

### Time
| Widget | Viz | Click → |
|---|---|---|
| My hours this week vs target | Gauge | `/msp/time-entry` |
| Team hours this week by tech (billable/non-billable stacked) | HBar | `/msp/time-entry?subjectUserId=<uuid>` |
| Billable % (team, 30d) | Gauge | reports |
| Timesheets awaiting approval | Stat | `/msp/time-sheet-approvals` |

Reuse `getTimeUtilizationReport` / `getEmployeeUtilizationReport` queries.

### SLA / Surveys / Projects / Sales
| Widget | Viz | Click → |
|---|---|---|
| SLA compliance (30d) | Gauge | SLA dashboard |
| Avg survey score (30d) company/contact/tech | Gauge ×3 | surveys dashboard (✗ no URL filters; acceptable v1) |
| Project summary (active, overdue, ending next 7d, completed 7d) | StatGrid | ✓ `/msp/projects?projectStatus=open&deadlineType=before&deadlineDate=<today>` |
| Opportunities closing this month | MiniList | `/msp/opportunities?tab=pipeline` / opportunity |
| Quick links (old feature cards) | Links | existing routes |

Deferred: "Out this week" (skipped by decision), "Opportunities vs quota" (needs data model check).

Default time window for all period-based widgets: **last 7 days** (configurable per widget: 7 / 14 / 30 / 90).

## 4. Supporting changes outside the dashboard

1. **Tickets list** (`packages/tickets`, `server/src/app/msp/tickets/page.tsx`)
   - Apply `statusId=closed` (`is_closed = true`) in `optimizedTicketActions.ts`.
   - Add `createdFrom/createdTo`, `closedFrom/closedTo` params (parse, pass into `ITicketListFilters`, apply in query, write back in `replaceState`, add to `hasTicketViewFilterParams`).
2. **Assets list** (`server/src/app/msp/assets/page.tsx`, `AssetDashboardClient.tsx`)
   - Read `types, statuses, clientIds, agentStatuses, rmmManaged, view` from `searchParams` as initial filter state; write back with `replaceState` like tickets/projects.
   - New filters: `patchState` (`pending|failed|none`), `avStatus`, `lastSeenBefore` — server side in `listAssets`.
3. **SLA actions** lack `hasPermission`; widget loader enforces `ticket:read`/`reports:read` itself.
4. i18n keys in `server/public/locales/*/msp/dashboard.json`.

## 5. Phases

**Phase 0 — foundation** (behind feature flag)
- `dashboards` / `dashboard_shares` migrations, `dashboard:share|manage` permissions (Admin default), CRUD actions with owner/edit/view role checks.
- Home = current `DashboardContainer` unchanged; switcher + `?d=` routing; landing pref.
- Registry types, data dispatcher + permission gate + cache; `links.ts` href builders + tests.
- Chart primitives in `packages/ui`; grid + edit mode.
- 2 widgets to prove the loop: Open tickets by priority, Quick links.

**Phase 1 — tickets**: ticket widgets + ticket-list gaps (closed, created/closed date ranges).

**Phase 2 — sharing**: share dialog (users + teams, Edit/View), transfer ownership,
leave, duplicate, "Shared with me", no-access tiles, edit-conflict handling,
owner-deletion/team-deletion cleanup, starter templates.

**Phase 3 — assets**: assets page URL filters + patch/AV/last-seen filters + asset widgets.

**Phase 4 — time, SLA, surveys, projects, sales widgets.**

**Later**: widget-level scope filters (client/board/team), extension-contributed
widgets, auto-refresh tuning, TV/kiosk mode.

## 6. Testing

- Unit: href builders, layout (de)serialisation + unknown-widget drop, per-widget `load` against seeded DB (vitest + test DB).
- Permission: user without `asset:read` never sees asset widgets in Add drawer and gets permission error from loader.
- Sharing: unshared dashboard invisible to others; user share and team share both grant access; removing user from team revokes it; edit beats view when both apply; view role cannot `updateDashboard`; editor cannot `setDashboardShares`/delete/transfer; non-admin owner (no `dashboard:share`) cannot add shares; transfer keeps exactly one owner and leaves old owner as editor; concurrent edit returns conflict; viewer without `asset:read` sees "No access" tile.
- Default: user with no dashboards lands on Home, which renders exactly as before.
- E2E (Playwright): add widget, reorder, reload persists; click "High" slice → tickets list shows only open High tickets and filter chips reflect it.

## 7. Decisions (2026-10-19)

1. Users can have **multiple dashboards** and **share** them. Default landing stays **today's dashboard** ("Home").
2. **Fixed tile sizes** for now.
3. **AlgaDesk** product dashboard out of scope — left untouched.
4. Default window **7 days**.
5. **"Out this week" skipped** for now.
6. Share targets: **users and/or teams** (no roles, no "everyone").
7. Dashboard roles: **Owner** (exactly one, transferable), **Edit**, **View**.
8. Only **admins** can share by default (`dashboard:share` → `msp:Admin`); grantable to other roles later.

## 8. Remaining open questions

None blocking Phase 0.
