export interface SupplierPriceStockResult {
  price: string;
  currency: string;
  reportedQuantity: number | null;
  stockStatus: 'IN_STOCK' | 'LOW_STOCK' | 'OUT_OF_STOCK' | 'UNKNOWN' | 'DISCONTINUED';
  shipsFromCountry: string | null;
}
