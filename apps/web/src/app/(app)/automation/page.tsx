import { Alert, PageHeader } from '@/components/ui';

export default function Page() {
  return (
    <div className="max-w-3xl">
      <PageHeader title="Automation rules" subtitle="Scheduled for Phase 6" />
      <Alert tone="info">Rules with explicit conditions, actions, frequency, approval and execution logs — e.g. alert on supplier cost increases, pause listings when supplier stock runs out, daily profit report. All thresholds configurable; live-affecting actions require authorisation. The database tables already exist; the screens and connector jobs are built in Phase 6. Nothing here is simulated.</Alert>
    </div>
  );
}
