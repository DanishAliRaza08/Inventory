import { config } from '../config';
import { startMockServer } from './mock-server';

const port = Number(new URL(config().MOCK_BASE_URL).port || 4100);
void startMockServer(port).then(() => {
  // eslint-disable-next-line no-console
  console.log(`Mock marketplaces (dummy data) listening on :${port} — eBay, Amazon, TikTok Shop, AliExpress, CJ`);
});
