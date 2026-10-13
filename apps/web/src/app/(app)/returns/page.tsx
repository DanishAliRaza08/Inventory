import { Alert, PageHeader } from '@/components/ui';

export default function Page() {
  return (
    <div className="max-w-3xl">
      <PageHeader title="Returns & refunds" subtitle="Scheduled for Phase 4" />
      <Alert tone="info">Return requests, refunds and their effect on profit, imported from the marketplaces where supported. The database tables already exist; the screens and connector jobs are built in Phase 4. Nothing here is simulated.</Alert>
    </div>
  );
}
