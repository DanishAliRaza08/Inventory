import { Alert, PageHeader } from '@/components/ui';

export default function Page() {
  return (
    <div className="max-w-3xl">
      <PageHeader title="Orders" subtitle="Scheduled for Phase 4" />
      <Alert tone="info">Unified orders from all connected marketplaces, supplier-ordering checklist, fulfilment and tracking (dispatch is recorded only once confirmed), restricted customer details. The database tables already exist; the screens and connector jobs are built in Phase 4. Nothing here is simulated.</Alert>
    </div>
  );
}
