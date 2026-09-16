import Link from 'next/link';
import { LockKeyhole } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import type { SubscriptionAccessDenial } from '@/app/lib/subscription-access-client';

interface SubscriptionAccessNoticeProps {
  denial: SubscriptionAccessDenial;
  backHref?: string;
  backLabel?: string;
}

export default function SubscriptionAccessNotice({
  denial,
  backHref = '/dashboard',
  backLabel = 'Back to dashboard',
}: SubscriptionAccessNoticeProps) {
  return (
    <Card className="border-amber-300 bg-amber-50 shadow-sm">
      <CardHeader className="space-y-2">
        <div className="flex h-10 w-10 items-center justify-center rounded-full bg-amber-100 text-amber-800">
          <LockKeyhole className="h-5 w-5" aria-hidden="true" />
        </div>
        <CardTitle className="text-xl text-amber-950">{denial.title}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4 text-amber-950">
        <p className="text-sm leading-6">{denial.message}</p>
        <p className="text-sm leading-6">{denial.actionLabel}</p>
        <Button asChild variant="outline" className="border-amber-300 bg-white hover:bg-amber-100">
          <Link href={backHref}>{backLabel}</Link>
        </Button>
      </CardContent>
    </Card>
  );
}
