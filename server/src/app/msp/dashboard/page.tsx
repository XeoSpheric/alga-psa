import { Suspense } from 'react';
import DashboardContainer from '@/components/dashboard/DashboardContainer';
import AlgaDeskDashboard from '@/components/dashboard/AlgaDeskDashboard';
import { getDashboardMobileAppCardDismissedAction } from '@/lib/actions/dashboardMobileAppActions';
import { getAlgaDeskDashboardSummary } from '@/lib/actions/algadeskDashboardActions';
import { getCurrentTenantProduct } from '@/lib/productAccess';
import { getDashboardWelcomeSettingsAction } from '@alga-psa/tenancy/actions/tenant-settings-actions/dashboardWelcomeActions';
import { isSelfHostLicensing } from '@alga-psa/licensing';
import { DashboardOnboardingSkeleton, DashboardOnboardingSlot } from '@alga-psa/onboarding/components';
import { isEnterprise } from '@/lib/features';
import type { Metadata } from 'next';
import { getServerTranslation } from '@alga-psa/ui/lib/i18n/serverOnly';
import { isActionMessageError, isActionPermissionError } from '@alga-psa/ui/lib/errorHandling';
import { resolveDashboardForPage } from '@/lib/dashboards/dashboardActions';
import { dashboardWidgetsEnabled } from '@/lib/dashboards/featureGate';
import { DashboardPageShell } from '@/components/dashboard/widgets/DashboardPageShell';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getServerTranslation(undefined, 'metadata');

  return {
    title: t('msp.dashboard.title', { defaultValue: 'Dashboard' }),
  };
}

export const dynamic = 'force-dynamic';

interface DashboardPageProps {
  searchParams?: Promise<{ [key: string]: string | string[] | undefined }>;
}

async function DashboardPage({ searchParams }: DashboardPageProps) {
  const productCode = await getCurrentTenantProduct();

  if (productCode === 'algadesk') {
    const summary = await getAlgaDeskDashboardSummary();
    return <AlgaDeskDashboard summary={summary} />;
  }

  const mobileAppCardDismissed = await getDashboardMobileAppCardDismissedAction().catch(() => false);
  const selfHost = await isSelfHostLicensing().catch(() => false);
  // Opt-in, and only when there is a company to name — the banner must never
  // fail the page, so a lookup problem falls back to the stock title.
  const welcome = await getDashboardWelcomeSettingsAction().catch(() => null);
  const welcomeCompanyName = welcome?.useCompanyName ? welcome.companyName : null;

  const home = (
    <DashboardContainer
      onboardingSection={
        isEnterprise ? (
          <Suspense fallback={<DashboardOnboardingSkeleton />}>
            <DashboardOnboardingSlot />
          </Suspense>
        ) : undefined
      }
      initialMobileAppCardDismissed={mobileAppCardDismissed}
      selfHost={selfHost}
      welcomeCompanyName={welcomeCompanyName}
    />
  );

  if (!dashboardWidgetsEnabled()) return home;

  // Widget dashboards are additive: any failure here falls back to Home
  // exactly as it rendered before the feature existed.
  const params = (await searchParams) ?? {};
  const requested = typeof params.d === 'string' && params.d.length > 0 ? params.d : null;
  const resolved = await resolveDashboardForPage(requested).catch(() => null);
  if (!resolved || isActionMessageError(resolved) || isActionPermissionError(resolved)) return home;

  return (
    <DashboardPageShell
      collection={resolved.collection}
      active={resolved.active}
      notFound={resolved.notFound}
      home={home}
    />
  );
}

export default DashboardPage;
