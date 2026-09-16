type PlanBillingShape = {
  plan_name?: string | null;
  display_name?: string | null;
  price_monthly?: unknown;
  price_yearly?: unknown;
};

function toFiniteNumber(value: unknown): number {
  const amount = Number(value ?? 0);
  return Number.isFinite(amount) ? amount : 0;
}

function normalizePlanName(plan: PlanBillingShape): string {
  return `${plan.plan_name || ''} ${plan.display_name || ''}`
    .trim()
    .toLowerCase();
}

export function getPlanPriceAmount(plan: Pick<PlanBillingShape, 'price_monthly'> | null | undefined): number {
  return toFiniteNumber(plan?.price_monthly);
}

export function isOneTimePaymentPlan(plan: PlanBillingShape | null | undefined): boolean {
  if (!plan || getPlanPriceAmount(plan) <= 0) return false;

  const yearlyPrice = toFiniteNumber(plan.price_yearly);
  if (yearlyPrice === 0) return true;

  const planName = normalizePlanName(plan);
  return planName.includes('rental singel') || planName.includes('rental single') || planName.includes('rental duo');
}

export function getPlanBillingCycle(plan: PlanBillingShape | null | undefined): 'one-time' | 'monthly' | 'free' {
  const amount = getPlanPriceAmount(plan);
  if (amount <= 0) return 'free';

  return isOneTimePaymentPlan(plan) ? 'one-time' : 'monthly';
}
