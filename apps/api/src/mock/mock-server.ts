import express, { Request, Response } from 'express';
import { createHmac, randomUUID } from 'crypto';
import { XMLBuilder, XMLParser } from 'fast-xml-parser';
import multer from 'multer';
import { Server } from 'http';
import { appCredentials, config } from '../config';
import { tiktokSign } from '../integrations/tiktok/tiktok-connector';
import { EXISTING_SKUS, dummyBuyer, pick, rand, resetRandom } from './mock-data';

/**
 * Mock marketplace & supplier APIs with dummy data, for development and automated tests.
 * Implements the subset of the official API contracts the connectors use. Never used in
 * production (MOCK_MARKETPLACES is refused there).
 */

interface MockListing {
  id: string;
  sku: string;
  title: string;
  price: number;
  currency: string;
  quantity: number;
  status: 'ACTIVE' | 'PENDING' | 'ENDED' | 'PAUSED' | 'FAILED';
  checks: number;
  skuId?: string;
  productType?: string;
  failReason?: string;
}
interface MockOrder {
  id: string;
  createdAt: string;
  status: string;
  lines: Array<{ id: string; sku: string; title: string; qty: number; price: number; listingId: string }>;
  shipping: number;
  buyer: ReturnType<typeof dummyBuyer>;
  currency: string;
  tracking?: string;
  refunded?: boolean;
  packageId: string;
}

type Mp = 'EBAY_UK' | 'EBAY_US' | 'AMAZON_UK' | 'TIKTOK_UK';
const state = {
  listings: { EBAY_UK: [], EBAY_US: [], AMAZON_UK: [], TIKTOK_UK: [] } as Record<Mp, MockListing[]>,
  orders: { EBAY_UK: [], EBAY_US: [], AMAZON_UK: [], TIKTOK_UK: [] } as Record<Mp, MockOrder[]>,
  supplierOrders: [] as Array<{ id: string; product: string; qty: number; tracking: string; supplier: string }>,
  reports: new Map<string, { type: string; body: string }>(),
};

const CURRENCY: Record<Mp, string> = { EBAY_UK: 'GBP', EBAY_US: 'USD', AMAZON_UK: 'GBP', TIKTOK_UK: 'GBP' };

export function resetMockState() {
  resetRandom();
  for (const mp of Object.keys(state.listings) as Mp[]) {
    state.listings[mp] = EXISTING_SKUS.map((sku, i) => ({
      id: mp.startsWith('EBAY') ? String(110000000000 + i + (mp === 'EBAY_US' ? 500 : 0)) : mp === 'TIKTOK_UK' ? String(172900000000000 + i) : sku,
      sku,
      title: `Existing listing ${sku}`,
      price: 19.99 + i * 5,
      currency: CURRENCY[mp],
      quantity: 10,
      status: 'ACTIVE',
      checks: 0,
      skuId: mp === 'TIKTOK_UK' ? String(172910000000000 + i) : undefined,
      productType: 'DRESS',
    }));
    state.orders[mp] = [];
    generateOrders(mp, 6, 20);
  }
  state.supplierOrders = [];
  state.reports.clear();
}

export function generateOrders(mp: Mp, count: number, maxDaysAgo = 5) {
  const active = state.listings[mp].filter((l) => l.status === 'ACTIVE');
  for (let i = 0; i < count && active.length; i++) {
    const l = pick(active);
    const qty = mp === 'TIKTOK_UK' ? 1 : rand() < 0.8 ? 1 : 2;
    const created = new Date(Date.now() - rand() * maxDaysAgo * 86_400_000);
    state.orders[mp].push({
      id: mp.startsWith('EBAY') ? `${Math.floor(10 + rand() * 89)}-${Math.floor(10000 + rand() * 89999)}-${Math.floor(10000 + rand() * 89999)}` : mp === 'AMAZON_UK' ? `202-${Math.floor(1e6 + rand() * 8e6)}-${Math.floor(1e6 + rand() * 8e6)}` : String(576000000000000000 + Math.floor(rand() * 1e9)),
      createdAt: created.toISOString(),
      status: 'PAID',
      lines: [{ id: randomUUID().slice(0, 12), sku: l.sku, title: l.title, qty, price: l.price, listingId: l.id }],
      shipping: rand() < 0.6 ? 0 : 2.99,
      buyer: dummyBuyer(mp === 'EBAY_US' ? 'US' : 'GB'),
      currency: CURRENCY[mp],
      packageId: randomUUID().slice(0, 10),
      refunded: rand() < 0.08,
    });
  }
}

const fee = (o: MockOrder, pct: number, fixed: number) => +((o.lines[0]!.price * o.lines[0]!.qty + o.shipping) * pct + fixed).toFixed(2);

// ───────────────────────────── eBay ─────────────────────────────
const xmlParser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', parseTagValue: false });
const xmlBuilder = new XMLBuilder({ ignoreAttributes: false, attributeNamePrefix: '@_' });
const ebaySite = (siteId: string): Mp => (siteId === '0' ? 'EBAY_US' : 'EBAY_UK');

function tradingReply(res: Response, call: string, body: Record<string, unknown>, errors: Array<{ code: string; msg: string }> = []) {
  const payload: Record<string, unknown> = {
    '@_xmlns': 'urn:ebay:apis:eBLBaseComponents',
    Timestamp: new Date().toISOString(),
    Ack: errors.length ? 'Failure' : 'Success',
    ...(errors.length ? { Errors: errors.map((e) => ({ ShortMessage: e.msg, LongMessage: e.msg, ErrorCode: e.code, SeverityCode: 'Error', ErrorClassification: 'RequestError' })) } : body),
  };
  res.type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?>' + xmlBuilder.build({ [`${call}Response`]: payload }));
}

function ebayRoutes(app: express.Express) {
  app.get('/ebay/oauth2/authorize', (req, res) => {
    res.redirect(`${config().PUBLIC_BASE_URL}/api/integrations/oauth/ebay/callback?code=mock-ebay-code&state=${encodeURIComponent(String(req.query.state))}`);
  });
  app.post('/ebay/identity/v1/oauth2/token', express.urlencoded({ extended: false }), (req, res) => {
    const auth = Buffer.from(String(req.headers.authorization ?? '').replace('Basic ', ''), 'base64').toString();
    const { clientId, clientSecret } = appCredentials().ebay;
    if (auth !== `${clientId}:${clientSecret}`) return res.status(401).json({ error: 'invalid_client' });
    const g = req.body.grant_type;
    res.json({
      access_token: `ebay-access-${randomUUID()}`,
      expires_in: 7200,
      token_type: 'User Access Token',
      ...(g === 'authorization_code' ? { refresh_token: 'ebay-refresh-token', refresh_token_expires_in: 47304000 } : {}),
    });
  });
  app.post('/ebay/ws/api.dll', express.text({ type: '*/*', limit: '5mb' }), (req, res) => {
    const call = String(req.headers['x-ebay-api-call-name']);
    if (!String(req.headers['x-ebay-api-iaf-token'] ?? '').startsWith('ebay-access-')) return tradingReply(res, call, {}, [{ code: '21916984', msg: 'Invalid IAF token.' }]);
    const mp = ebaySite(String(req.headers['x-ebay-api-siteid']));
    const doc = xmlParser.parse(req.body)[`${call}Request`] ?? {};
    const item = doc.Item ?? {};
    const find = (id: string) => state.listings[mp].find((l) => l.id === String(id));
    switch (call) {
      case 'VerifyAddFixedPriceItem':
      case 'AddFixedPriceItem': {
        const errs: Array<{ code: string; msg: string }> = [];
        if (String(item.Title ?? '').length > 80) errs.push({ code: '70', msg: 'The title is longer than 80 characters.' });
        if (!item.PostalCode) errs.push({ code: '21920', msg: 'Item location is missing.' });
        if (!item.PrimaryCategory?.CategoryID) errs.push({ code: '87', msg: 'A category is required.' });
        if (!item.PictureDetails?.PictureURL) errs.push({ code: '21919136', msg: 'At least one picture is required.' });
        if (errs.length) return tradingReply(res, call, {}, errs);
        if (call === 'VerifyAddFixedPriceItem') return tradingReply(res, call, { ItemID: '0', Fees: '' });
        const l: MockListing = { id: String(120000000000 + Math.floor(rand() * 1e9)), sku: String(item.SKU), title: String(item.Title), price: Number(item.StartPrice?.['#text'] ?? item.StartPrice), currency: String(item.Currency), quantity: Number(item.Quantity), status: 'ACTIVE', checks: 0 };
        state.listings[mp].push(l);
        return tradingReply(res, call, { ItemID: l.id, StartTime: new Date().toISOString() });
      }
      case 'ReviseFixedPriceItem': {
        const l = find(item.ItemID);
        if (!l) return tradingReply(res, call, {}, [{ code: '17', msg: 'Item not found.' }]);
        Object.assign(l, { title: String(item.Title ?? l.title), price: Number(item.StartPrice?.['#text'] ?? l.price), quantity: Number(item.Quantity ?? l.quantity) });
        return tradingReply(res, call, { ItemID: l.id });
      }
      case 'ReviseInventoryStatus': {
        const statuses = Array.isArray(doc.InventoryStatus) ? doc.InventoryStatus : [doc.InventoryStatus];
        for (const s of statuses) {
          const l = find(s.ItemID);
          if (!l) return tradingReply(res, call, {}, [{ code: '17', msg: 'Item not found.' }]);
          if (s.Quantity !== undefined) l.quantity = Number(s.Quantity);
          if (s.StartPrice !== undefined) l.price = Number(s.StartPrice);
        }
        return tradingReply(res, call, {});
      }
      case 'EndFixedPriceItem': {
        const l = find(doc.ItemID);
        if (!l) return tradingReply(res, call, {}, [{ code: '17', msg: 'Item not found.' }]);
        l.status = 'ENDED';
        return tradingReply(res, call, { EndTime: new Date().toISOString() });
      }
      case 'GetItem': {
        const l = find(doc.ItemID);
        if (!l) return tradingReply(res, call, {}, [{ code: '17', msg: 'Item not found.' }]);
        return tradingReply(res, call, { Item: { ItemID: l.id, SKU: l.sku, Quantity: l.quantity, StartPrice: { '#text': l.price, '@_currencyID': l.currency }, SellingStatus: { ListingStatus: l.status === 'ENDED' ? 'Completed' : 'Active', QuantitySold: 0 } } });
      }
      case 'GetMyeBaySelling': {
        const active = state.listings[mp].filter((l) => l.status !== 'ENDED');
        return tradingReply(res, call, {
          ActiveList: {
            ItemArray: { Item: active.map((l) => ({ ItemID: l.id, SKU: l.sku, Title: l.title, QuantityAvailable: l.quantity, SellingStatus: { CurrentPrice: { '#text': l.price.toFixed(2), '@_currencyID': l.currency } } })) },
            PaginationResult: { TotalNumberOfPages: 1, TotalNumberOfEntries: active.length },
          },
        });
      }
      default:
        return tradingReply(res, call, {}, [{ code: '2', msg: `Unsupported call ${call} in mock` }]);
    }
  });
  const bearer = (req: Request, res: Response) => {
    if (!String(req.headers.authorization ?? '').startsWith('Bearer ebay-access-')) {
      res.status(401).json({ errors: [{ message: 'Invalid access token' }] });
      return false;
    }
    return true;
  };
  app.get('/ebay/commerce/taxonomy/v1/category_tree/:tree/get_item_aspects_for_category', (req, res) => {
    if (!bearer(req, res)) return;
    res.json({ aspects: [['Brand', true], ['Size', true], ['Colour', true], ['Department', true], ['Material', false], ['Style', false]].map(([n, r]) => ({ localizedAspectName: n, aspectConstraint: { aspectRequired: r } })) });
  });
  const ebayMp = (req: Request): Mp => (req.headers['x-ebay-c-marketplace-id'] === 'EBAY_US' ? 'EBAY_US' : 'EBAY_UK');
  app.get('/ebay/sell/fulfillment/v1/order', (req, res) => {
    if (!bearer(req, res)) return;
    // The mock serves UK and US orders by default from both trees.
    // One eBay seller account sees orders from every site; each line says which site it was listed on.
    const all = [...state.orders.EBAY_UK.map((o) => ({ o, mp: 'EBAY_UK' as Mp })), ...state.orders.EBAY_US.map((o) => ({ o, mp: 'EBAY_US' as Mp }))];
    res.json({
      total: all.length,
      orders: all.map(({ o, mp }) => ({
        orderId: o.id,
        creationDate: o.createdAt,
        orderFulfillmentStatus: o.tracking ? 'FULFILLED' : 'NOT_STARTED',
        orderPaymentStatus: o.refunded ? 'FULLY_REFUNDED' : 'PAID',
        salesRecordReference: mp,
        pricingSummary: { total: { value: (o.lines[0]!.price * o.lines[0]!.qty + o.shipping).toFixed(2), currency: o.currency } },
        fulfillmentStartInstructions: [{ shippingStep: { shipTo: { fullName: o.buyer.name, email: o.buyer.email, primaryPhone: { phoneNumber: o.buyer.phone }, contactAddress: { addressLine1: o.buyer.line1, city: o.buyer.city, stateOrProvince: o.buyer.region, postalCode: o.buyer.postcode, countryCode: o.buyer.country } } } }],
        lineItems: o.lines.map((l) => ({
          lineItemId: l.id, legacyItemId: l.listingId, sku: l.sku, title: l.title, quantity: l.qty, listingMarketplaceId: mp === 'EBAY_US' ? 'EBAY_US' : 'EBAY_GB',
          lineItemCost: { value: (l.price * l.qty).toFixed(2), currency: o.currency }, deliveryCost: { shippingCost: { value: o.shipping.toFixed(2), currency: o.currency } },
          ebayCollectAndRemitTaxes: mp === 'EBAY_US' ? [{ taxType: 'STATE_SALES_TAX', amount: { value: (l.price * l.qty * 0.0825).toFixed(2), currency: 'USD' } }] : [],
          lineItemFulfillmentInstructions: { shipByDate: new Date(new Date(o.createdAt).getTime() + 2 * 86_400_000).toISOString() },
        })),
      })),
    });
  });
  app.post('/ebay/sell/fulfillment/v1/order/:id/shipping_fulfillment', express.json(), (req, res) => {
    if (!bearer(req, res)) return;
    const o = [...state.orders.EBAY_UK, ...state.orders.EBAY_US].find((x) => x.id === req.params.id);
    if (!o) return res.status(404).json({ errors: [{ message: 'Order not found' }] });
    if (!req.body.trackingNumber) return res.status(400).json({ errors: [{ message: 'trackingNumber required' }] });
    o.tracking = req.body.trackingNumber;
    res.status(201).setHeader('Location', `/order/${o.id}/shipping_fulfillment/${randomUUID()}`).end();
  });
  app.get('/ebay/sell/finances/v1/transaction', (req, res) => {
    if (!bearer(req, res)) return;
    const mp = ebayMp(req);
    const txs: unknown[] = [];
    for (const o of state.orders[mp]) {
      const old = Date.now() - new Date(o.createdAt).getTime() > 3 * 86_400_000;
      txs.push({
        transactionId: `SALE-${o.id}`, transactionType: 'SALE', orderId: o.id, transactionDate: o.createdAt, transactionStatus: old ? 'PAYOUT' : 'FUNDS_ON_HOLD', payoutId: old ? `PAYOUT-${o.createdAt.slice(0, 10)}` : undefined,
        amount: { value: (o.lines[0]!.price * o.lines[0]!.qty).toFixed(2), currency: o.currency },
        orderLineItems: o.lines.map((l) => ({ lineItemId: l.id, marketplaceFees: [{ feeType: 'FINAL_VALUE_FEE', amount: { value: fee(o, 0.128, 0).toFixed(2), currency: o.currency } }, { feeType: 'FINAL_VALUE_FEE_FIXED_PER_ORDER', amount: { value: '0.30', currency: o.currency } }] })),
      });
      if (o.refunded) txs.push({ transactionId: `REFUND-${o.id}`, transactionType: 'REFUND', orderId: o.id, transactionDate: new Date(new Date(o.createdAt).getTime() + 86_400_000).toISOString(), amount: { value: (o.lines[0]!.price * o.lines[0]!.qty).toFixed(2), currency: o.currency }, orderLineItems: [{ lineItemId: o.lines[0]!.id }] });
    }
    res.json({ total: txs.length, transactions: txs });
  });
}

// ───────────────────────────── Amazon ─────────────────────────────
function amazonRoutes(app: express.Express) {
  app.get('/amazon/apps/authorize/consent', (req, res) => {
    res.redirect(`${config().PUBLIC_BASE_URL}/api/integrations/oauth/amazon/callback?spapi_oauth_code=mock-amazon-code&selling_partner_id=AMOCKSELLER1&state=${encodeURIComponent(String(req.query.state))}`);
  });
  app.post('/amazon/auth/o2/token', express.urlencoded({ extended: false }), (req, res) => {
    const { clientId, clientSecret } = appCredentials().amazon;
    if (req.body.client_id !== clientId || req.body.client_secret !== clientSecret) return res.status(401).json({ error: 'invalid_client' });
    res.json({ access_token: `Atza|mock-${randomUUID()}`, refresh_token: req.body.grant_type === 'authorization_code' ? 'Atzr|mock-refresh' : undefined, expires_in: 3600, token_type: 'bearer' });
  });
  const auth = (req: Request, res: Response) => {
    if (!String(req.headers['x-amz-access-token'] ?? '').startsWith('Atz')) {
      res.status(403).json({ errors: [{ code: 'Unauthorized', message: 'Access to requested resource is denied.' }] });
      return false;
    }
    return true;
  };
  const L = () => state.listings.AMAZON_UK;
  app.put('/amazon/listings/2021-08-01/items/:seller/:sku', express.json({ limit: '5mb' }), (req, res) => {
    if (!auth(req, res)) return;
    const a = req.body.attributes ?? {};
    const issues: unknown[] = [];
    if (!a.brand) issues.push({ code: '90220', message: "'brand' is required but not supplied.", severity: 'ERROR', attributeNames: ['brand'] });
    if (String(a.item_name?.[0]?.value ?? '').length > 200) issues.push({ code: '8541', message: 'Title too long', severity: 'ERROR' });
    if (issues.length) return res.json({ sku: req.params.sku, status: 'INVALID', submissionId: randomUUID(), issues });
    let l = L().find((x) => x.sku === req.params.sku);
    if (!l) {
      l = { id: req.params.sku!, sku: req.params.sku!, title: a.item_name?.[0]?.value, price: a.purchasable_offer?.[0]?.our_price?.[0]?.schedule?.[0]?.value_with_tax, currency: 'GBP', quantity: a.fulfillment_availability?.[0]?.quantity ?? 0, status: 'PENDING', checks: 0, productType: req.body.productType };
      L().push(l);
    } else Object.assign(l, { title: a.item_name?.[0]?.value ?? l.title, status: 'PENDING', checks: 0 });
    res.json({ sku: req.params.sku, status: 'ACCEPTED', submissionId: randomUUID(), issues: [] });
  });
  app.get('/amazon/listings/2021-08-01/items/:seller/:sku', (req, res) => {
    if (!auth(req, res)) return;
    const l = L().find((x) => x.sku === req.params.sku);
    if (!l || l.status === 'ENDED') return res.status(404).json({ errors: [{ code: 'NOT_FOUND', message: 'Not found' }] });
    l.checks++;
    if (l.status === 'PENDING' && l.checks >= 2) l.status = 'ACTIVE'; // processed after the first check
    res.json({
      sku: l.sku,
      summaries: [{ marketplaceId: 'A1F83G8C2ARO7P', productType: l.productType ?? 'DRESS', status: l.status === 'ACTIVE' ? ['BUYABLE', 'DISCOVERABLE'] : [], itemName: l.title }],
      issues: [],
      fulfillmentAvailability: [{ fulfillmentChannelCode: 'DEFAULT', quantity: l.quantity }],
    });
  });
  app.patch('/amazon/listings/2021-08-01/items/:seller/:sku', express.json(), (req, res) => {
    if (!auth(req, res)) return;
    const l = L().find((x) => x.sku === req.params.sku);
    if (!l) return res.status(404).json({ errors: [{ code: 'NOT_FOUND', message: 'Not found' }] });
    for (const p of req.body.patches ?? []) {
      if (p.path === '/attributes/fulfillment_availability') l.quantity = p.value[0].quantity;
      if (p.path === '/attributes/purchasable_offer') l.price = p.value[0].our_price[0].schedule[0].value_with_tax;
    }
    res.json({ sku: l.sku, status: 'ACCEPTED', submissionId: randomUUID(), issues: [] });
  });
  app.delete('/amazon/listings/2021-08-01/items/:seller/:sku', (req, res) => {
    if (!auth(req, res)) return;
    const l = L().find((x) => x.sku === req.params.sku);
    if (l) l.status = 'ENDED';
    res.json({ sku: req.params.sku, status: 'ACCEPTED', submissionId: randomUUID(), issues: [] });
  });
  app.get('/amazon/definitions/2020-09-01/productTypes/:type', (req, res) => {
    if (!auth(req, res)) return;
    res.json({ productType: req.params.type, schema: { link: { resource: `${config().MOCK_BASE_URL}/amazon/schemas/${req.params.type}.json`, verb: 'GET' } } });
  });
  app.get('/amazon/schemas/:file', (_req, res) => {
    res.json({ required: ['item_name', 'brand', 'externally_assigned_product_identifier', 'product_description', 'bullet_point', 'color', 'size', 'department'], properties: { item_name: {}, brand: {}, color: {}, size: {}, material: {}, department: {}, style: {} } });
  });
  app.post('/amazon/tokens/2021-03-01/restrictedDataToken', express.json(), (req, res) => {
    if (!auth(req, res)) return;
    res.json({ restrictedDataToken: `Atz.sprdt|mock-${randomUUID()}`, expiresIn: 3600 });
  });
  app.get('/amazon/orders/v0/orders', (req, res) => {
    if (!auth(req, res)) return;
    const rdt = String(req.headers['x-amz-access-token']).startsWith('Atz.sprdt');
    res.json({
      payload: {
        Orders: state.orders.AMAZON_UK.map((o) => ({
          AmazonOrderId: o.id, PurchaseDate: o.createdAt, OrderStatus: o.refunded ? 'Canceled' : o.tracking ? 'Shipped' : 'Unshipped', FulfillmentChannel: 'MFN',
          LatestShipDate: new Date(new Date(o.createdAt).getTime() + 2 * 86_400_000).toISOString(), OrderTotal: { CurrencyCode: 'GBP', Amount: (o.lines[0]!.price * o.lines[0]!.qty + o.shipping).toFixed(2) },
          ...(rdt ? { ShippingAddress: { Name: o.buyer.name, AddressLine1: o.buyer.line1, City: o.buyer.city, PostalCode: o.buyer.postcode, CountryCode: 'GB', Phone: o.buyer.phone }, BuyerInfo: { BuyerEmail: o.buyer.email, BuyerName: o.buyer.name } } : {}),
        })),
      },
    });
  });
  app.get('/amazon/orders/v0/orders/:id/orderItems', (req, res) => {
    if (!auth(req, res)) return;
    const o = state.orders.AMAZON_UK.find((x) => x.id === req.params.id);
    if (!o) return res.status(404).json({ errors: [{ code: 'NotFound', message: 'Order not found' }] });
    res.json({
      payload: {
        AmazonOrderId: o.id,
        OrderItems: o.lines.map((l) => {
          const gross = l.price * l.qty;
          return { OrderItemId: l.id, SellerSKU: l.sku, Title: l.title, QuantityOrdered: l.qty, ItemPrice: { CurrencyCode: 'GBP', Amount: gross.toFixed(2) }, ItemTax: { CurrencyCode: 'GBP', Amount: (gross / 6).toFixed(2) }, ShippingPrice: { CurrencyCode: 'GBP', Amount: o.shipping.toFixed(2) }, PromotionDiscount: { CurrencyCode: 'GBP', Amount: '0.00' } };
        }),
      },
    });
  });
  app.post('/amazon/orders/v0/orders/:id/shipmentConfirmation', express.json(), (req, res) => {
    if (!auth(req, res)) return;
    const o = state.orders.AMAZON_UK.find((x) => x.id === req.params.id);
    if (!o) return res.status(404).json({ errors: [{ code: 'NotFound', message: 'Order not found' }] });
    o.tracking = req.body.packageDetail?.trackingNumber;
    res.status(204).end();
  });
  app.get('/amazon/finances/v0/financialEvents', (req, res) => {
    if (!auth(req, res)) return;
    const ship = state.orders.AMAZON_UK.map((o) => ({
      AmazonOrderId: o.id, PostedDate: o.createdAt,
      ShipmentItemList: o.lines.map((l) => ({ OrderItemId: l.id, SellerSKU: l.sku, ItemFeeList: [{ FeeType: 'Commission', FeeAmount: { CurrencyCode: 'GBP', CurrencyAmount: -fee(o, 0.15, 0) } }, { FeeType: 'DigitalServicesFee', FeeAmount: { CurrencyCode: 'GBP', CurrencyAmount: -+(fee(o, 0.15, 0) * 0.02).toFixed(2) } }] })),
    }));
    const refunds = state.orders.AMAZON_UK.filter((o) => o.refunded).map((o) => ({
      AmazonOrderId: o.id, PostedDate: new Date(new Date(o.createdAt).getTime() + 86_400_000).toISOString(),
      ShipmentItemAdjustmentList: [{ OrderItemId: o.lines[0]!.id, ItemChargeAdjustmentList: [{ ChargeType: 'Principal', ChargeAmount: { CurrencyCode: 'GBP', CurrencyAmount: -+(o.lines[0]!.price * 5 / 6).toFixed(2) } }, { ChargeType: 'Tax', ChargeAmount: { CurrencyCode: 'GBP', CurrencyAmount: -+(o.lines[0]!.price / 6).toFixed(2) } }], ItemFeeAdjustmentList: [{ FeeType: 'Commission', FeeAmount: { CurrencyCode: 'GBP', CurrencyAmount: +(fee(o, 0.15, 0) * 0.8).toFixed(2) } }] }],
    }));
    res.json({ payload: { FinancialEvents: { ShipmentEventList: ship, RefundEventList: refunds } } });
  });
  // Reports: settlement (auto-generated) and merchant listings (on request).
  app.post('/amazon/reports/2021-06-30/reports', express.json(), (req, res) => {
    if (!auth(req, res)) return;
    const id = randomUUID();
    const body =
      'seller-sku\titem-name\tprice\tquantity\tstatus\tlisting-id\n' +
      L().filter((l) => l.status !== 'ENDED').map((l) => `${l.sku}\t${l.title}\t${Number(l.price).toFixed(2)}\t${l.quantity}\t${l.status === 'ACTIVE' ? 'Active' : 'Inactive'}\t${l.id}`).join('\n');
    state.reports.set(id, { type: req.body.reportType, body });
    res.status(202).json({ reportId: id });
  });
  app.get('/amazon/reports/2021-06-30/reports/:id', (req, res) => {
    if (!auth(req, res)) return;
    res.json({ reportId: req.params.id, processingStatus: 'DONE', reportDocumentId: `doc-${req.params.id}` });
  });
  app.get('/amazon/reports/2021-06-30/reports', (req, res) => {
    if (!auth(req, res)) return;
    const settled = state.orders.AMAZON_UK.filter((o) => Date.now() - new Date(o.createdAt).getTime() > 3 * 86_400_000);
    const id = 'settlement-1';
    state.reports.set(id, { type: 'GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE_V2', body: 'settlement-id\torder-id\tposted-date\tamount\n' + settled.map((o) => `SETTLE-1\t${o.id}\t${o.createdAt.slice(0, 10)}\t${o.lines[0]!.price}`).join('\n') });
    res.json({ reports: [{ reportId: id, reportType: 'GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE_V2', processingStatus: 'DONE', reportDocumentId: `doc-${id}`, dataEndTime: new Date().toISOString() }] });
  });
  app.get('/amazon/reports/2021-06-30/documents/:docId', (req, res) => {
    if (!auth(req, res)) return;
    res.json({ reportDocumentId: req.params.docId, url: `${config().MOCK_BASE_URL}/amazon/report-files/${req.params.docId.replace('doc-', '')}` });
  });
  app.get('/amazon/report-files/:id', (req, res) => {
    const r = state.reports.get(req.params.id);
    if (!r) return res.status(404).end();
    res.type('text/tab-separated-values').send(r.body);
  });
}

// ───────────────────────────── TikTok Shop ─────────────────────────────
const upload = multer({ storage: multer.memoryStorage() });
function tiktokRoutes(app: express.Express) {
  const ok = (res: Response, data: unknown) => res.json({ code: 0, message: 'Success', request_id: randomUUID(), data });
  const err = (res: Response, code: number, message: string) => res.json({ code, message, request_id: randomUUID() });
  app.get('/tiktok/open/authorize', (req, res) => {
    res.redirect(`${config().PUBLIC_BASE_URL}/api/integrations/oauth/tiktok/callback?code=mock-tiktok-code&state=${encodeURIComponent(String(req.query.state))}`);
  });
  app.get('/tiktok/auth/api/v2/token/get', (req, res) => {
    const { appKey, appSecret } = appCredentials().tiktok;
    if (req.query.app_key !== appKey || req.query.app_secret !== appSecret) return err(res, 105001, 'invalid app');
    const now = Math.floor(Date.now() / 1000);
    ok(res, { access_token: `tts-access-${randomUUID()}`, access_token_expire_in: now + 7 * 86400, refresh_token: 'tts-refresh', refresh_token_expire_in: now + 365 * 86400, seller_name: 'Fashion Rockstar (mock)' });
  });
  // Verify the request signature exactly as TikTok does.
  const verify = (req: Request, res: Response, bodyText: string) => {
    const path = req.path.replace('/tiktok/api', '');
    const q = Object.fromEntries(Object.entries(req.query).map(([k, v]) => [k, String(v)]));
    if (q.sign !== tiktokSign(path, q, bodyText, appCredentials().tiktok.appSecret)) {
      err(res, 106001, 'Invalid signature');
      return false;
    }
    if (!String(req.headers['x-tts-access-token'] ?? '').startsWith('tts-access-')) {
      err(res, 105002, 'Expired credentials');
      return false;
    }
    return true;
  };
  const json = express.text({ type: 'application/json', limit: '5mb' });
  const body = (req: Request) => (typeof req.body === 'string' && req.body ? JSON.parse(req.body) : {});
  const raw = (req: Request) => (typeof req.body === 'string' ? req.body : '');
  const L = () => state.listings.TIKTOK_UK;

  app.get('/tiktok/api/authorization/202309/shops', (req, res) => {
    if (!verify(req, res, '')) return;
    ok(res, { shops: [{ id: '7000000001', name: 'Fashion Rockstar UK (mock)', region: 'GB', cipher: 'GCP_mock_cipher', seller_type: 'LOCAL' }] });
  });
  app.post('/tiktok/api/product/202309/images/upload', upload.single('data'), (req, res) => {
    if (!verify(req, res, '')) return;
    if (!req.file) return err(res, 12052002, 'image data required');
    ok(res, { uri: `tos-mock/${randomUUID()}`, url: 'https://example.invalid/img.jpg', width: 800, height: 800, use_case: 'MAIN_IMAGE' });
  });
  app.get('/tiktok/api/product/202309/categories/:id/attributes', (req, res) => {
    if (!verify(req, res, '')) return;
    ok(res, { attributes: [['100001', 'Material', true], ['100002', 'Pattern', false], ['100003', 'Style', false], ['100004', 'Colour', false]].map(([id, name, req2]) => ({ id, name, type: 'PRODUCT_PROPERTY', is_requried: req2 })) });
  });
  app.post('/tiktok/api/product/202309/products', json, (req, res) => {
    if (!verify(req, res, raw(req))) return;
    const b = body(req);
    if (!b.main_images?.length) return err(res, 12019030, 'main_images is required');
    if (String(b.title ?? '').length < 25) return err(res, 12052048, 'Product title must be at least 25 characters');
    const l: MockListing = { id: String(173000000000000 + Math.floor(rand() * 1e9)), sku: b.skus[0].seller_sku, title: b.title, price: Number(b.skus[0].price.amount), currency: 'GBP', quantity: b.skus[0].inventory[0].quantity, status: 'PENDING', checks: 0, skuId: String(173100000000000 + Math.floor(rand() * 1e9)) };
    if (/\[audit-fail\]/.test(b.title)) l.failReason = 'Prohibited wording in title';
    L().push(l);
    ok(res, { product_id: l.id, skus: [{ id: l.skuId, seller_sku: l.sku }] });
  });
  app.put('/tiktok/api/product/202309/products/:id', json, (req, res) => {
    if (!verify(req, res, raw(req))) return;
    const l = L().find((x) => x.id === req.params.id);
    if (!l) return err(res, 12052700, 'Product not found');
    const b = body(req);
    Object.assign(l, { title: b.title, status: 'PENDING', checks: 0 });
    ok(res, { product_id: l.id, skus: [{ id: l.skuId, seller_sku: l.sku }] });
  });
  app.get('/tiktok/api/product/202309/products/:id', (req, res) => {
    if (!verify(req, res, '')) return;
    const l = L().find((x) => x.id === req.params.id);
    if (!l) return err(res, 12052700, 'Product not found');
    l.checks++;
    if (l.status === 'PENDING' && l.checks >= 2) l.status = l.failReason ? 'FAILED' : 'ACTIVE';
    const status = { ACTIVE: 'ACTIVATE', PENDING: 'PENDING', FAILED: 'FAILED', PAUSED: 'SELLER_DEACTIVATED', ENDED: 'DELETED' }[l.status];
    ok(res, { id: l.id, status, title: l.title, audit_failed_reasons: l.status === 'FAILED' ? [{ reasons: [l.failReason] }] : [], skus: [{ id: l.skuId, seller_sku: l.sku, inventory: [{ quantity: l.quantity }] }] });
  });
  app.post('/tiktok/api/product/202309/products/:id/prices/update', json, (req, res) => {
    if (!verify(req, res, raw(req))) return;
    const l = L().find((x) => x.id === req.params.id);
    if (!l) return err(res, 12052700, 'Product not found');
    l.price = Number(body(req).skus[0].price.amount);
    ok(res, {});
  });
  app.post('/tiktok/api/product/202309/products/:id/inventory/update', json, (req, res) => {
    if (!verify(req, res, raw(req))) return;
    const l = L().find((x) => x.id === req.params.id);
    if (!l) return err(res, 12052700, 'Product not found');
    l.quantity = body(req).skus[0].inventory[0].quantity;
    ok(res, {});
  });
  for (const action of ['deactivate', 'activate'] as const) {
    app.post(`/tiktok/api/product/202309/products/${action}`, json, (req, res) => {
      if (!verify(req, res, raw(req))) return;
      for (const id of body(req).product_ids ?? []) {
        const l = L().find((x) => x.id === id);
        if (l) l.status = action === 'deactivate' ? 'PAUSED' : 'ACTIVE';
      }
      ok(res, {});
    });
  }
  app.delete('/tiktok/api/product/202309/products', json, (req, res) => {
    if (!verify(req, res, raw(req))) return;
    for (const id of body(req).product_ids ?? []) {
      const l = L().find((x) => x.id === id);
      if (l) l.status = 'ENDED';
    }
    ok(res, {});
  });
  app.post('/tiktok/api/product/202309/products/search', json, (req, res) => {
    if (!verify(req, res, raw(req))) return;
    ok(res, { products: L().filter((l) => l.status === 'ACTIVE').map((l) => ({ id: l.id, title: l.title, skus: [{ id: l.skuId, seller_sku: l.sku, price: { sale_price: l.price.toFixed(2), currency: 'GBP' }, inventory: [{ quantity: l.quantity }] }] })), next_page_token: '' });
  });
  const ttOrder = (o: MockOrder) => ({
    id: o.id, status: o.refunded ? 'CANCELLED' : o.tracking ? 'IN_TRANSIT' : 'AWAITING_SHIPMENT', create_time: Math.floor(new Date(o.createdAt).getTime() / 1000),
    rts_sla_time: Math.floor(new Date(o.createdAt).getTime() / 1000) + 2 * 86400, buyer_email: o.buyer.email,
    payment: { currency: 'GBP', sub_total: o.lines[0]!.price.toFixed(2), shipping_fee: o.shipping.toFixed(2), total_amount: (o.lines[0]!.price + o.shipping).toFixed(2) },
    recipient_address: { name: o.buyer.name, phone_number: o.buyer.phone, address_line1: o.buyer.line1, address_line3: o.buyer.city, postal_code: o.buyer.postcode, region_code: 'GB' },
    line_items: o.lines.map((l) => ({ id: l.id, seller_sku: l.sku, product_name: l.title, product_id: l.listingId, original_price: l.price.toFixed(2), sale_price: l.price.toFixed(2), seller_discount: '0.00' })),
    packages: [{ id: o.packageId }],
  });
  app.post('/tiktok/api/order/202309/orders/search', json, (req, res) => {
    if (!verify(req, res, raw(req))) return;
    ok(res, { orders: state.orders.TIKTOK_UK.map(ttOrder), next_page_token: '', total_count: state.orders.TIKTOK_UK.length });
  });
  app.get('/tiktok/api/order/202309/orders', (req, res) => {
    if (!verify(req, res, '')) return;
    const ids = String(req.query.ids ?? '').split(',');
    ok(res, { orders: state.orders.TIKTOK_UK.filter((o) => ids.includes(o.id)).map(ttOrder) });
  });
  app.post('/tiktok/api/fulfillment/202309/packages/:pkg/ship', json, (req, res) => {
    if (!verify(req, res, raw(req))) return;
    const o = state.orders.TIKTOK_UK.find((x) => x.packageId === req.params.pkg);
    if (!o) return err(res, 21011001, 'Package not found');
    o.tracking = body(req).self_shipment?.tracking_number;
    ok(res, {});
  });
  app.get('/tiktok/api/finance/202309/statements', (req, res) => {
    if (!verify(req, res, '')) return;
    ok(res, { statements: [{ id: 'ST-1', statement_time: Math.floor(Date.now() / 1000) - 86400, currency: 'GBP', payment_status: 'PAID' }], next_page_token: '' });
  });
  app.get('/tiktok/api/finance/202309/statements/:id/statement_transactions', (req, res) => {
    if (!verify(req, res, '')) return;
    const tx = state.orders.TIKTOK_UK.flatMap((o) => [
      { id: `T-${o.id}`, type: 'ORDER', order_id: o.id, revenue_amount: o.lines[0]!.price.toFixed(2), platform_commission_amount: (-fee(o, 0.09, 0)).toFixed(2), transaction_fee_amount: (-fee(o, 0.0, 0.2)).toFixed(2) },
      ...(o.refunded ? [{ id: `R-${o.id}`, type: 'REFUND', order_id: o.id, revenue_amount: (-o.lines[0]!.price).toFixed(2) }] : []),
    ]);
    ok(res, { statement_transactions: tx, next_page_token: '' });
  });
}

// ───────────────────────────── Suppliers ─────────────────────────────
function supplierRoutes(app: express.Express) {
  const catalogue = (id: string) => ({ id, price: +(4 + (Number(id.replace(/\D/g, '').slice(-2)) % 10) * 0.75).toFixed(2), shipping: 1.95, stock: (Number(id.replace(/\D/g, '').slice(-1)) || 7) * 37, shipsFrom: Number(id.replace(/\D/g, '').slice(-1)) % 3 === 0 ? 'GB' : 'CN' });
  app.get('/aliexpress/oauth/authorize', (req, res) => {
    res.redirect(`${String(req.query.redirect_uri)}?code=mock-ae-code&state=${encodeURIComponent(String(req.query.state))}`);
  });
  // AliExpress: IOP-style signed requests; system APIs on /rest/<path>, business APIs on /sync?method=
  const aeVerify = (req: Request, res: Response, apiPath: string) => {
    const q = Object.fromEntries(Object.entries({ ...req.query, ...(req.body ?? {}) }).map(([k, v]) => [k, String(v)]));
    const keys = Object.keys(q).filter((k) => k !== 'sign').sort();
    const expected = createHmac('sha256', appCredentials().aliexpress.appSecret).update(apiPath + keys.map((k) => k + q[k]).join('')).digest('hex').toUpperCase();
    if (q.sign !== expected) {
      res.json({ code: 'IncompleteSignature', message: 'The request signature does not conform to platform standards', request_id: randomUUID() });
      return null;
    }
    return q;
  };
  app.all('/aliexpress/rest/auth/token/create', express.urlencoded({ extended: false }), (req, res) => {
    if (!aeVerify(req, res, '/auth/token/create')) return;
    res.json({ code: '0', access_token: `ae-access-${randomUUID()}`, refresh_token: 'ae-refresh', expires_in: 30 * 86400, refresh_expires_in: 60 * 86400, seller_id: '2000000001', account: 'fashionrockstar@example.invalid' });
  });
  app.all('/aliexpress/sync', express.urlencoded({ extended: false }), (req, res) => {
    const q = aeVerify(req, res, '');
    if (!q) return;
    if (!q.access_token?.startsWith('ae-access-')) return res.json({ code: 'IllegalAccessToken', message: 'The specified access token is invalid or expired' });
    switch (q.method) {
      case 'aliexpress.ds.product.get': {
        const p = catalogue(q.product_id!);
        return res.json({
          aliexpress_ds_product_get_response: {
            rsp_code: 200,
            result: {
              ae_item_base_info_dto: { product_id: p.id, subject: `Dummy AliExpress product ${p.id}`, product_status_type: 'onSelling' },
              ae_item_sku_info_dtos: { ae_item_sku_info_d_t_o: [{ sku_id: `${p.id}-1`, sku_price: p.price.toFixed(2), offer_sale_price: p.price.toFixed(2), currency_code: 'USD', sku_available_stock: p.stock, ships_from_country: p.shipsFrom }] },
              logistics_info_dto: { delivery_time: 9, ship_to_country: q.ship_to_country ?? 'GB' },
            },
          },
        });
      }
      case 'aliexpress.ds.order.create': {
        const id = `AE${Math.floor(1e12 + rand() * 9e12)}`;
        state.supplierOrders.push({ id, product: JSON.parse(q.param_place_order_request4_open_api_d_t_o ?? '{}')?.product_items?.[0]?.product_id ?? '', qty: 1, tracking: `LP00${Math.floor(rand() * 1e9)}CN`, supplier: 'ALIEXPRESS' });
        return res.json({ aliexpress_ds_order_create_response: { result: { is_success: true, order_list: { number: [id] } } } });
      }
      case 'aliexpress.ds.order.tracking.get': {
        const o = state.supplierOrders.find((x) => x.id === q.ae_order_id);
        return res.json({ aliexpress_ds_order_tracking_get_response: { result: { ret: !!o, data: { tracking_detail_line_list: o ? [{ mail_no: o.tracking, carrier_name: 'Cainiao', detail_node_list: [{ tracking_name: 'Shipped' }] }] : [] } } } });
      }
      default:
        return res.json({ code: 'InvalidApiPath', message: `Unsupported method ${q.method} in mock` });
    }
  });
  // CJ Dropshipping (API v2): access token, product query, stock, create order, tracking
  app.post('/cj/api2.0/v1/authentication/getAccessToken', express.json(), (req, res) => {
    if (req.body.apiKey !== appCredentials().cj.apiKey) return res.json({ code: 1600001, result: false, message: 'Invalid API key' });
    res.json({ code: 200, result: true, message: 'Success', data: { accessToken: `cj-access-${randomUUID()}`, accessTokenExpiryDate: new Date(Date.now() + 15 * 86400_000).toISOString(), refreshToken: 'cj-refresh' } });
  });
  const cjAuth = (req: Request, res: Response) => {
    if (!String(req.headers['cj-access-token'] ?? '').startsWith('cj-access-')) {
      res.json({ code: 1600100, result: false, message: 'Invalid token' });
      return false;
    }
    return true;
  };
  app.get('/cj/api2.0/v1/product/stock/queryByVid', (req, res) => {
    if (!cjAuth(req, res)) return;
    const p = catalogue(String(req.query.vid));
    res.json({ code: 200, result: true, data: [{ vid: p.id, areaEn: p.shipsFrom === 'GB' ? 'United Kingdom' : 'China', countryCode: p.shipsFrom, storageNum: p.stock }] });
  });
  app.get('/cj/api2.0/v1/product/variant/queryByVid', (req, res) => {
    if (!cjAuth(req, res)) return;
    const p = catalogue(String(req.query.vid));
    res.json({ code: 200, result: true, data: { vid: p.id, variantSku: `CJ-${p.id}`, variantSellPrice: p.price, variantNameEn: `Dummy CJ variant ${p.id}` } });
  });
  app.post('/cj/api2.0/v1/shopping/order/createOrderV2', express.json(), (req, res) => {
    if (!cjAuth(req, res)) return;
    const id = `CJ${Math.floor(1e10 + rand() * 9e10)}`;
    state.supplierOrders.push({ id, product: req.body.products?.[0]?.vid ?? '', qty: req.body.products?.[0]?.quantity ?? 1, tracking: `CJPKL${Math.floor(rand() * 1e9)}`, supplier: 'CJ' });
    res.json({ code: 200, result: true, data: { orderId: id, orderNum: req.body.orderNumber } });
  });
  app.get('/cj/api2.0/v1/logistic/trackInfo', (req, res) => {
    if (!cjAuth(req, res)) return;
    const o = state.supplierOrders.find((x) => x.id === req.query.orderId);
    res.json({ code: 200, result: true, data: o ? [{ trackingNumber: o.tracking, logisticName: 'CJPacket', trackingStatus: 'In transit' }] : [] });
  });
}

export function createMockApp(): express.Express {
  const app = express();
  ebayRoutes(app);
  amazonRoutes(app);
  tiktokRoutes(app);
  supplierRoutes(app);
  // Admin helpers for demos and tests.
  app.post('/mock/reset', (_req, res) => {
    resetMockState();
    res.json({ ok: true });
  });
  app.post('/mock/:mp/orders', express.json(), (req, res) => {
    generateOrders(req.params.mp as Mp, Number(req.body?.count ?? 5), 2);
    res.json({ ok: true, orders: state.orders[req.params.mp as Mp].length });
  });
  app.get('/mock/state', (_req, res) => res.json(state.listings));
  return app;
}

export function startMockServer(port: number): Promise<Server> {
  resetMockState();
  const app = createMockApp();
  return new Promise((resolve) => {
    const s = app.listen(port, () => resolve(s));
  });
}
