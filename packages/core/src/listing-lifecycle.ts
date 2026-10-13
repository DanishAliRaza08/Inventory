import { Permission } from './permissions';

export const LISTING_STATUSES = [
  'INCOMPLETE',
  'DRAFT',
  'VALIDATION_FAILED',
  'AWAITING_APPROVAL',
  'APPROVED',
  'PUBLISHING',
  'ACTIVE',
  'PUBLICATION_FAILED',
  'PAUSED',
  'ENDED',
  'ARCHIVED',
] as const;
export type ListingStatus = (typeof LISTING_STATUSES)[number];

export const LISTING_EVENTS = [
  'SAVE', // user saved edits (status derived from completeness)
  'VALIDATE_PASS',
  'VALIDATE_FAIL',
  'SUBMIT', // submit for approval
  'APPROVE',
  'REJECT',
  'PUBLISH', // queue publication
  'MARKETPLACE_CONFIRMED', // marketplace returned a listing id + active status
  'MARKETPLACE_FAILED',
  'RETRY',
  'PAUSE',
  'RESUME',
  'END',
  'REVISE', // start editing a live / ended / failed listing (creates a new version)
  'ARCHIVE',
] as const;
export type ListingEvent = (typeof LISTING_EVENTS)[number];

/** Who can trigger an event. `system` = only background jobs / marketplace callbacks. */
type Actor = Permission | 'system';

interface Transition {
  from: ListingStatus[];
  to: ListingStatus | ((ctx: TransitionContext) => ListingStatus);
  actor: Actor;
}

export interface TransitionContext {
  /** All required fields present. */
  complete?: boolean;
  /** Unresolved compliance / policy warnings that block publication. */
  blockingWarnings?: number;
  /** The user approving is the same person who submitted. */
  approverIsSubmitter?: boolean;
  /** Whether self-approval is permitted by settings. */
  allowSelfApproval?: boolean;
  /** Emergency kill-switch for publishing is engaged. */
  publishingDisabled?: boolean;
  /** Item flagged as restricted / regulated, requires human compliance sign-off. */
  restrictedUnresolved?: boolean;
}

const EDITABLE: ListingStatus[] = ['INCOMPLETE', 'DRAFT', 'VALIDATION_FAILED', 'AWAITING_APPROVAL', 'APPROVED', 'PUBLICATION_FAILED'];

export const TRANSITIONS: Record<ListingEvent, Transition> = {
  SAVE: { from: EDITABLE, to: (c) => (c.complete ? 'DRAFT' : 'INCOMPLETE'), actor: 'listings.write' },
  VALIDATE_PASS: { from: ['INCOMPLETE', 'DRAFT', 'VALIDATION_FAILED'], to: 'DRAFT', actor: 'listings.write' },
  VALIDATE_FAIL: { from: ['INCOMPLETE', 'DRAFT', 'VALIDATION_FAILED', 'AWAITING_APPROVAL', 'APPROVED'], to: 'VALIDATION_FAILED', actor: 'listings.write' },
  SUBMIT: { from: ['DRAFT'], to: 'AWAITING_APPROVAL', actor: 'listings.submit' },
  APPROVE: { from: ['AWAITING_APPROVAL'], to: 'APPROVED', actor: 'listings.approve' },
  REJECT: { from: ['AWAITING_APPROVAL', 'APPROVED'], to: 'DRAFT', actor: 'listings.approve' },
  PUBLISH: { from: ['APPROVED'], to: 'PUBLISHING', actor: 'listings.publish' },
  MARKETPLACE_CONFIRMED: { from: ['PUBLISHING'], to: 'ACTIVE', actor: 'system' },
  MARKETPLACE_FAILED: { from: ['PUBLISHING'], to: 'PUBLICATION_FAILED', actor: 'system' },
  RETRY: { from: ['PUBLICATION_FAILED'], to: 'PUBLISHING', actor: 'listings.publish' },
  PAUSE: { from: ['ACTIVE'], to: 'PAUSED', actor: 'listings.end' },
  RESUME: { from: ['PAUSED'], to: 'ACTIVE', actor: 'listings.end' },
  END: { from: ['ACTIVE', 'PAUSED'], to: 'ENDED', actor: 'listings.end' },
  REVISE: { from: ['ACTIVE', 'PAUSED', 'ENDED', 'PUBLICATION_FAILED'], to: 'DRAFT', actor: 'listings.write' },
  ARCHIVE: { from: ['INCOMPLETE', 'DRAFT', 'VALIDATION_FAILED', 'ENDED', 'PUBLICATION_FAILED'], to: 'ARCHIVED', actor: 'listings.write' },
};

export class TransitionError extends Error {
  constructor(message: string, public readonly code: string) {
    super(message);
    this.name = 'TransitionError';
  }
}

export interface TransitionResult {
  from: ListingStatus;
  to: ListingStatus;
  event: ListingEvent;
}

/**
 * Pure state machine. Callers pass the permissions of the acting user (or
 * `system: true` for background jobs). Guards enforce the business rules:
 * nothing is shown as ACTIVE without marketplace confirmation, compliance
 * warnings block approval/publication, and publishing honours the kill switch.
 */
export function transition(
  current: ListingStatus,
  event: ListingEvent,
  actor: { permissions: Iterable<string>; system?: boolean },
  ctx: TransitionContext = {},
): TransitionResult {
  const t = TRANSITIONS[event];
  if (!t.from.includes(current)) {
    throw new TransitionError(`Cannot ${event} a listing in status ${current}.`, 'INVALID_TRANSITION');
  }
  if (t.actor === 'system') {
    if (!actor.system) throw new TransitionError(`${event} can only be recorded by the marketplace integration.`, 'SYSTEM_ONLY');
  } else if (!actor.system && !new Set(actor.permissions).has(t.actor)) {
    throw new TransitionError(`Missing permission ${t.actor} for ${event}.`, 'FORBIDDEN');
  }
  if (event === 'SUBMIT' && ctx.complete === false) {
    throw new TransitionError('Listing has missing required fields.', 'INCOMPLETE');
  }
  if ((event === 'APPROVE' || event === 'PUBLISH' || event === 'RETRY') && (ctx.blockingWarnings ?? 0) > 0) {
    throw new TransitionError('Listing has unresolved validation or compliance warnings.', 'BLOCKING_WARNINGS');
  }
  if ((event === 'APPROVE' || event === 'PUBLISH' || event === 'RETRY') && ctx.restrictedUnresolved) {
    throw new TransitionError('Restricted or regulated product requires compliance sign-off.', 'RESTRICTED');
  }
  if (event === 'APPROVE' && ctx.approverIsSubmitter && !ctx.allowSelfApproval) {
    throw new TransitionError('Drafts must be approved by a different user than the submitter.', 'SELF_APPROVAL');
  }
  if ((event === 'PUBLISH' || event === 'RETRY' || event === 'RESUME') && ctx.publishingDisabled) {
    throw new TransitionError('Publishing is disabled by an emergency control.', 'PUBLISHING_DISABLED');
  }
  const to = typeof t.to === 'function' ? t.to(ctx) : t.to;
  return { from: current, to, event };
}

export function allowedEvents(current: ListingStatus): ListingEvent[] {
  return (Object.keys(TRANSITIONS) as ListingEvent[]).filter((e) => TRANSITIONS[e].from.includes(current));
}

export const LIVE_STATUSES: ListingStatus[] = ['ACTIVE', 'PAUSED'];
