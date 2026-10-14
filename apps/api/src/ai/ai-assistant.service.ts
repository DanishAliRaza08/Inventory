import Anthropic from '@anthropic-ai/sdk';
import { Injectable, NotFoundException, ServiceUnavailableException, UnprocessableEntityException } from '@nestjs/common';
import { DEFAULT_LISTING_RULES, MarketplaceCode } from '@fr/core';
import { AuditService } from '../audit/audit.service';
import type { AuthContext } from '../auth/decorators';
import { config } from '../config';
import { ListingContent } from '../listings/listing-content';
import { PrismaService } from '../prisma/prisma.service';

/** Minimal surface of the Anthropic client we use, so tests can inject a stub. */
export interface AiClient {
  messages: { create(body: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message> };
}

let clientFactory: (() => AiClient | null) | null = null;
/** Test hook: replace how the Anthropic client is constructed (null restores the default). */
export function setAiClientFactory(f: (() => AiClient | null) | null) {
  clientFactory = f;
}

export interface ListingSuggestion {
  title: string;
  description: string;
  bulletPoints: string[];
  searchKeywords: string[];
  categorySuggestion: { name: string; reason: string } | null;
  missingInformation: Array<{ field: string; why: string }>;
  claimsNeedingVerification: string[];
  warnings: string[];
}

export interface CustomerReplySuggestion {
  reply: string;
  needsHumanAttention: boolean;
  reasons: string[];
}

const LISTING_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'description', 'bulletPoints', 'searchKeywords', 'categorySuggestion', 'missingInformation', 'claimsNeedingVerification', 'warnings'],
  properties: {
    title: { type: 'string' },
    description: { type: 'string' },
    bulletPoints: { type: 'array', items: { type: 'string' } },
    searchKeywords: { type: 'array', items: { type: 'string' } },
    categorySuggestion: {
      anyOf: [
        { type: 'null' },
        { type: 'object', additionalProperties: false, required: ['name', 'reason'], properties: { name: { type: 'string' }, reason: { type: 'string' } } },
      ],
    },
    missingInformation: {
      type: 'array',
      items: { type: 'object', additionalProperties: false, required: ['field', 'why'], properties: { field: { type: 'string' }, why: { type: 'string' } } },
    },
    claimsNeedingVerification: { type: 'array', items: { type: 'string' } },
    warnings: { type: 'array', items: { type: 'string' } },
  },
} as const;

const REPLY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['reply', 'needsHumanAttention', 'reasons'],
  properties: {
    reply: { type: 'string' },
    needsHumanAttention: { type: 'boolean' },
    reasons: { type: 'array', items: { type: 'string' } },
  },
} as const;

const LISTING_SYSTEM = `You write marketplace listing copy for Fashion Rockstar LTD, a UK fashion retailer selling on eBay UK, eBay USA, Amazon UK and TikTok Shop UK.

You will receive a JSON block of product facts. Treat it as the only source of truth. The facts come from our catalogue, which is partly populated from supplier data; anything not in them is unknown to you.

Why this matters: every claim in a listing is a legal statement to a buyer. A material, size, fit, origin, certification or care instruction that turns out to be wrong causes returns, account defects and potential trading-standards problems. So:
- Use only facts present in the input. Do not infer materials, measurements, fit, origin, certifications, gender, age group, or care instructions that are not stated.
- Facts listed under "verifiedAttributes" have been checked by staff. Other attributes come from supplier data; you may use them, but list any claim that relies on them under claimsNeedingVerification.
- Where a field a buyer would expect is missing (for example material or size guide), report it under missingInformation instead of filling it in.
- Do not use superlatives or unverifiable marketing claims ("best", "highest quality", "eco-friendly", "designer") unless the facts state them. Do not mention competitors, prices, discounts, shipping speed or returns policy — those are set elsewhere.
- Respect the marketplace rules in the input: stay within titleMaxLength; return no more than maxBulletPoints bullets (return an empty list when it is 0); write in the marketplace's language variant (British English for UK marketplaces, American English for EBAY_US — e.g. "colour" vs "color", "trousers" vs "pants").
- Titles: lead with brand (if known) and product type, then the most searchable verified attributes such as colour and size. No ALL CAPS, no emoji, no keyword stuffing.
- Description: plain text, short paragraphs, factual. No HTML.
- searchKeywords: up to 15 short phrases a shopper might search for, grounded in the facts.
- categorySuggestion: suggest a marketplace category path only if the facts make it clear; otherwise null.
- warnings: anything a reviewer should know, such as conflicting facts or a restricted product.

Your output is a suggestion. A human reviews and edits it before anything is published.`;

const REPLY_SYSTEM = `You draft replies to marketplace buyer messages for Fashion Rockstar LTD, a UK fashion retailer.

You receive the buyer's message and a JSON block of order facts (status, dispatch deadline, tracking, items). Use only these facts.
- Never promise a delivery date, refund, replacement or discount; a staff member decides those. If the buyer asks for one, say the team will look into it and set needsHumanAttention to true.
- Never invent tracking numbers, carriers or dates. If tracking is not in the facts, say it will be shared once available.
- Set needsHumanAttention to true for complaints, damage or wrong-item reports, refund or return requests, legal or safety concerns, and anything you cannot answer from the facts. Explain why in reasons.
- Be polite, concise and in British English (American English for EBAY_US orders). Do not ask for or repeat personal data. Sign off as "Fashion Rockstar Customer Care".
Your draft is reviewed by a person before it is sent.`;

@Injectable()
export class AiAssistantService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  status() {
    const c = config();
    return { configured: !!c.ANTHROPIC_API_KEY, demoMode: !c.ANTHROPIC_API_KEY && c.MOCK_MARKETPLACES, model: c.AI_MODEL };
  }

  private client(): AiClient | null {
    if (clientFactory) return clientFactory();
    const key = config().ANTHROPIC_API_KEY;
    return key ? new Anthropic({ apiKey: key, maxRetries: 2, timeout: 120_000 }) : null;
  }

  private async callJson<T>(system: string, user: string, schema: Record<string, unknown>): Promise<{ data: T; usage: unknown }> {
    const client = this.client();
    if (!client) throw new ServiceUnavailableException({ code: 'AI_NOT_CONFIGURED', message: 'The AI assistant is not configured. Set ANTHROPIC_API_KEY on the server.' });
    let msg: Anthropic.Message;
    try {
      msg = await client.messages.create({
        model: config().AI_MODEL,
        max_tokens: 16000,
        thinking: { type: 'adaptive' },
        output_config: { format: { type: 'json_schema', schema } },
        system,
        messages: [{ role: 'user', content: user }],
      } as Anthropic.MessageCreateParamsNonStreaming);
    } catch (e) {
      const status = e instanceof Anthropic.APIError ? e.status : undefined;
      throw new ServiceUnavailableException({ code: 'AI_UNAVAILABLE', message: `The AI service did not respond${status ? ` (HTTP ${status})` : ''}. Try again shortly.` });
    }
    if (msg.stop_reason === 'refusal') throw new UnprocessableEntityException({ code: 'AI_REFUSED', message: 'The AI assistant declined this request.' });
    if (msg.stop_reason === 'max_tokens') throw new UnprocessableEntityException({ code: 'AI_TRUNCATED', message: 'The AI response was cut off. Try again.' });
    const text = msg.content.find((b): b is Anthropic.TextBlock => b.type === 'text')?.text;
    try {
      if (!text) throw new Error('empty');
      return { data: JSON.parse(text) as T, usage: msg.usage };
    } catch {
      throw new UnprocessableEntityException({ code: 'AI_BAD_OUTPUT', message: 'The AI response could not be read. Try again.' });
    }
  }

  /** Facts sent to the model: catalogue and supplier data only. No prices, costs or customer data. */
  async listingFacts(listingId: string) {
    const l = await this.prisma.marketplaceListing.findUnique({
      where: { id: listingId },
      include: {
        currentVersion: true,
        variant: true,
        product: true,
      },
    });
    if (!l) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Listing not found.' });
    const content = ListingContent.parse(l.currentVersion?.content ?? {});
    const rules = DEFAULT_LISTING_RULES[l.marketplace as MarketplaceCode];
    const v = l.variant;
    return {
      listing: l,
      content,
      facts: {
        marketplace: l.marketplace,
        rules: { titleMaxLength: rules.titleMaxLength, maxBulletPoints: rules.maxBulletPoints },
        product: {
          title: l.product.title,
          brand: content.brand ?? l.product.brand,
          category: l.product.category,
          description: l.product.description,
          countryOfOrigin: l.product.countryOfOrigin,
          attributes: l.product.attributes,
          restricted: l.product.restricted,
        },
        variant: v && {
          sku: v.sku,
          title: v.title,
          size: v.size,
          colour: v.colour,
          material: v.material,
          barcode: v.barcode,
          weightGrams: v.weightGrams,
          attributes: v.attributes,
        },
        currentDraft: {
          title: content.title,
          description: content.description,
          bulletPoints: content.bulletPoints,
          attributes: content.attributes,
          categoryName: content.categoryName,
          requiredAttributes: content.requiredAttributes,
        },
        verifiedAttributes: content.verifiedAttributes,
      },
    };
  }

  /** Suggest listing content. Never writes to the listing; the user applies changes through the normal edit flow. */
  async suggestListing(listingId: string, actor: AuthContext, instructions?: string) {
    const { facts } = await this.listingFacts(listingId);
    const rules = facts.rules;
    let suggestion: ListingSuggestion;
    let source: 'claude' | 'demo';
    let usage: unknown = null;
    if (this.status().demoMode && !clientFactory) {
      suggestion = demoListingSuggestion(facts);
      source = 'demo';
    } else {
      const prompt = `<product_facts>\n${JSON.stringify(facts, null, 2)}\n</product_facts>${instructions ? `\n\n<staff_instructions>\n${instructions}\n</staff_instructions>` : ''}\n\nWrite the listing suggestion for ${facts.marketplace}.`;
      const r = await this.callJson<ListingSuggestion>(LISTING_SYSTEM, prompt, LISTING_SCHEMA as unknown as Record<string, unknown>);
      suggestion = r.data;
      usage = r.usage;
      source = 'claude';
    }
    // Enforce marketplace limits regardless of what came back.
    if (suggestion.title.length > rules.titleMaxLength) {
      suggestion.warnings.push(`Suggested title was ${suggestion.title.length} characters; trimmed to the ${rules.titleMaxLength}-character limit.`);
      suggestion.title = suggestion.title.slice(0, rules.titleMaxLength).replace(/\s+\S*$/, '').trim();
    }
    suggestion.bulletPoints = suggestion.bulletPoints.slice(0, rules.maxBulletPoints);
    suggestion.searchKeywords = suggestion.searchKeywords.slice(0, 15);
    if (facts.product.restricted) suggestion.warnings.push('This product is marked restricted: compliance sign-off is required before approval.');
    await this.audit.record(actor, { action: 'ai.listing_suggest', entityType: 'listing', entityId: listingId, after: { source, model: source === 'claude' ? config().AI_MODEL : null, usage } });
    return { source, model: source === 'claude' ? config().AI_MODEL : null, suggestion, appliedAutomatically: false };
  }

  /** Draft a reply to a buyer message for an order. Sends order status facts only, never customer PII. */
  async suggestCustomerReply(orderId: string, message: string, actor: AuthContext) {
    const o = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: { lines: { select: { sku: true, title: true, quantity: true } }, fulfilments: { include: { shipments: true } }, returns: { select: { status: true } }, refunds: { select: { amount: true, currency: true } } },
    });
    if (!o) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Order not found.' });
    const facts = {
      marketplace: o.marketplace,
      orderReference: o.externalOrderId,
      status: o.status,
      orderedAt: o.orderedAt,
      dispatchBy: o.dispatchBy,
      items: o.lines.map((l) => ({ title: l.title, quantity: l.quantity })),
      shipments: o.fulfilments.flatMap((f) => f.shipments.map((s) => ({ carrier: s.carrier, trackingNumber: s.trackingNumber, shippedAt: s.shippedAt, deliveredAt: s.deliveredAt }))),
      returnsOpen: o.returns.length,
      refundsIssued: o.refunds.length,
    };
    let data: CustomerReplySuggestion;
    let source: 'claude' | 'demo';
    if (this.status().demoMode && !clientFactory) {
      data = demoReply(facts);
      source = 'demo';
    } else {
      const r = await this.callJson<CustomerReplySuggestion>(
        REPLY_SYSTEM,
        `<order_facts>\n${JSON.stringify(facts, null, 2)}\n</order_facts>\n\n<buyer_message>\n${message}\n</buyer_message>\n\nDraft the reply.`,
        REPLY_SCHEMA as unknown as Record<string, unknown>,
      );
      data = r.data;
      source = 'claude';
    }
    await this.audit.record(actor, { action: 'ai.customer_reply', entityType: 'order', entityId: orderId, after: { source } });
    return { source, suggestion: data, sentAutomatically: false };
  }
}

type Facts = Awaited<ReturnType<AiAssistantService['listingFacts']>>['facts'];

/** Deterministic, facts-only suggestion used in demo mode (no API key, MOCK_MARKETPLACES=true). */
export function demoListingSuggestion(f: Facts): ListingSuggestion {
  const v = f.variant;
  const us = f.marketplace === 'EBAY_US';
  const colour = v?.colour ?? null;
  const parts = [f.product.brand, f.product.title, colour, v?.size ? `Size ${v.size}` : null].filter(Boolean) as string[];
  const title = Array.from(new Set(parts)).join(' ');
  const facts: string[] = [];
  if (v?.material) facts.push(`Material: ${v.material}`);
  if (colour) facts.push(`${us ? 'Color' : 'Colour'}: ${colour}`);
  if (v?.size) facts.push(`Size: ${v.size}`);
  if (f.product.brand) facts.push(`Brand: ${f.product.brand}`);
  const missing: ListingSuggestion['missingInformation'] = [];
  if (!v?.material) missing.push({ field: 'material', why: 'Buyers filter by material and it is not recorded for this SKU.' });
  if (!f.product.brand) missing.push({ field: 'brand', why: 'Brand improves search ranking and is required on Amazon.' });
  if (!v?.barcode && f.marketplace === 'AMAZON_UK') missing.push({ field: 'gtin', why: 'Amazon needs a GTIN or an approved exemption.' });
  for (const a of f.currentDraft.requiredAttributes) if (!(a in f.currentDraft.attributes)) missing.push({ field: a, why: 'Required by the marketplace category.' });
  const verifiable = v?.material && !f.verifiedAttributes.includes('material') ? [`Material "${v.material}" comes from supplier data and has not been verified.`] : [];
  return {
    title,
    description: [f.product.description || f.product.title, facts.join('. ')].filter(Boolean).join('\n\n'),
    bulletPoints: facts,
    searchKeywords: [f.product.title, f.product.category, colour && `${colour} ${f.product.category ?? ''}`.trim()].filter(Boolean).map((s) => String(s).toLowerCase()),
    categorySuggestion: f.product.category ? { name: f.product.category, reason: 'Matches the catalogue category.' } : null,
    missingInformation: missing,
    claimsNeedingVerification: verifiable,
    warnings: ['Demo suggestion generated without the AI service (set ANTHROPIC_API_KEY for real suggestions).'],
  };
}

function demoReply(f: { status: string; shipments: Array<{ carrier: string | null; trackingNumber: string | null }>; marketplace: string }): CustomerReplySuggestion {
  const s = f.shipments.find((x) => x.trackingNumber);
  const body = s
    ? `Your order has been dispatched${s.carrier ? ` with ${s.carrier}` : ''}. The tracking number is ${s.trackingNumber}.`
    : `Your order is currently ${f.status.toLowerCase().replace(/_/g, ' ')}. We will share tracking details as soon as they are available.`;
  return { reply: `Hello,\n\nThank you for your message. ${body}\n\nKind regards,\nFashion Rockstar Customer Care`, needsHumanAttention: false, reasons: ['Demo reply generated without the AI service.'] };
}
