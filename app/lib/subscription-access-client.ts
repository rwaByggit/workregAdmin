export interface SubscriptionAccessDenial {
  title: string;
  message: string;
  moduleId?: string;
  moduleName?: string;
  actionLabel: string;
}

export async function readSubscriptionAccessDenial(
  res: Response
): Promise<SubscriptionAccessDenial | null> {
  if (res.status !== 403) return null;

  try {
    const data = await res.clone().json();
    const isSubscriptionDenial =
      data?.code === 'SUBSCRIPTION_ACCESS_DENIED' ||
      (data?.moduleId && typeof data.error === 'string');

    if (!isSubscriptionDenial) return null;

    return {
      title: typeof data.title === 'string' ? data.title : 'Feature not included',
      message: typeof data.message === 'string'
        ? data.message
        : typeof data.error === 'string'
          ? data.error
          : 'Your current subscription does not include this feature.',
      moduleId: typeof data.moduleId === 'string' ? data.moduleId : undefined,
      moduleName: typeof data.moduleName === 'string' ? data.moduleName : undefined,
      actionLabel: typeof data.actionLabel === 'string'
        ? data.actionLabel
        : 'Contact an administrator to upgrade or change access.',
    };
  } catch {
    return null;
  }
}
