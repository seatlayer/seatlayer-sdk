/**
 * Sales-channel planning — the pure, DOM-free half of Channels mode.
 *
 * Everything here is deterministic and testable without a canvas: the marker
 * palette, the mixed-source selection summary, the LOCAL staged preview of an
 * assignment, and the bucket rows the Review sheet renders.
 *
 * The local preview deliberately produces the SAME `AssignmentBuckets` shape the
 * server returns from `POST /channels/assignments`. There is no dry-run endpoint,
 * so the review sheet is drawn from this local computation and then REDRAWN from
 * the authoritative server response after Apply. One renderer, two sources —
 * which is why the shapes must match exactly.
 *
 * Spec: sales-channels-product-ux-spec §8.4–8.5.
 */

/**
 * Public sale is a built-in pseudo-channel. The server's sentinel for it is the
 * literal string `'public'` — it is what `GET /channels` returns as
 * `publicSale.id`, what `GET /channels/allocation` reports for an unallocated
 * unit, and what `POST /channels/assignments` accepts (alongside `null`) as the
 * target meaning "send these back to public sale".
 *
 * This constant was `''` until 2026-08-02, which silently made every public unit
 * look like an unknown PRIVATE channel to `planAssignment` and `markerOf` — the
 * cause of the Review sheet's phantom "moved out of another channel" line and
 * the rail's "?" marker. Keep it byte-identical to the server's
 * `eventChannels.PUBLIC_CHANNEL_ID`.
 */
export const PUBLIC_CHANNEL_ID = 'public';
export const PUBLIC_CHANNEL_NAME = 'Public sale';

/** True for every spelling of "public sale" a worker may hand us. */
export function isPublicChannelId(id: string | null | undefined): boolean {
  return id == null || id === '' || id === PUBLIC_CHANNEL_ID;
}

export type ChannelState = 'active' | 'paused' | 'archived';

/** Physical inventory status, as the manage surface speaks it. */
export type ChannelSeatStatus = 'free' | 'held' | 'booked' | 'blocked';

export interface ChannelCounts {
  allocated: number;
  free: number;
  held: number;
  booked: number;
  blocked: number;
  units: number;
}

/** Buyer-access intents the server stores per channel. */
export type ChannelAccessIntent = 'none' | 'internal' | 'server' | 'hosted_link';

/**
 * Buyer-access summary on a channel row. Shipped by the access hardening branch
 * (merged to app main). Still optional in this type: a worker that predates the
 * merge simply omits it and the rail reads "—" rather than inventing a state.
 */
export interface ChannelAccessSummary {
  intent?: ChannelAccessIntent | string;
  hasActiveGrants?: boolean;
  lastMintAt?: number | null;
  /** Free-text detail (partner host, who paused it) when the server offers one. */
  detail?: string | null;
}

export interface ChannelRecord {
  id: string;
  name: string;
  color: string | null;
  marker: string | null;
  externalRef: string | null;
  state: ChannelState;
  archiveDestination: string | null;
  createdAt: number;
  updatedAt: number;
  archivedAt: number | null;
  counts: ChannelCounts;
  access?: ChannelAccessSummary | null;
}

export interface PublicSaleChannel {
  /** `'public'` on every shipped worker; typed loosely so an older build that
   *  still answers `''` is normalised rather than rejected. */
  id: string;
  name: string;
  state: 'active';
  counts: ChannelCounts;
  access?: ChannelAccessSummary | null;
}

export interface ChannelListResult {
  assignmentVersion: number;
  publicSale: PublicSaleChannel;
  channels: ChannelRecord[];
}

export interface AssignmentBucketCount {
  count: number;
}

export interface AssignmentSkippedBucket extends AssignmentBucketCount {
  labels: string[];
  truncated: boolean;
}

export interface AssignmentBuckets {
  changedFromPublic: AssignmentBucketCount;
  movedFromOtherChannel: AssignmentBucketCount & {
    channels: Array<{ channelId: string; name: string | null; count: number }>;
  };
  alreadyInTarget: AssignmentBucketCount;
  skippedHeld: AssignmentSkippedBucket;
  skippedBooked: AssignmentSkippedBucket;
  /** Requested labels that are not inventory in this event. */
  notFound: AssignmentSkippedBucket;
}

export interface AssignmentResult {
  ok: true;
  targetChannelId: string;
  assignmentVersion: number;
  requested: number;
  applied: number;
  buckets: AssignmentBuckets;
}

export interface ArchiveBlockedDetails {
  activeHolds?: number;
  heldUnits?: number;
  latestHoldExpiresAt?: number | null;
  retryAfterMs?: number;
}

/**
 * Administrative colors. Always paired with a LETTER on every surface — the
 * comp's rule and spec §13's: channel identity never rests on hue alone.
 */
export const CHANNEL_COLORS = [
  '#a78bfa', '#2dd4bf', '#fb923c', '#60a5fa', '#f472b6',
  '#a3e635', '#f87171', '#38bdf8', '#c084fc', '#facc15',
] as const;

/** Public sale keeps the cockpit's gold, distinct from every private channel. */
export const PUBLIC_CHANNEL_COLOR = '#f4b740';

const LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I/O — they read as 1/0

/**
 * Clamp any marker text down to the ONE uppercase character every surface draws.
 *
 * The server stores `marker` as free text (it only length-caps it), so a channel
 * created outside this widget can carry "star" or "VIP". The comp's marker chip
 * is a single glyph: taking two characters ("ST") overflows the 22px chip and
 * stops reading as a letter. Non-letter leading characters (an emoji, a digit,
 * punctuation) are skipped in favour of the first real letter.
 */
export function markerLetter(raw: string | null | undefined, fallback: string): string {
  const text = (raw ?? '').trim();
  const letter = /\p{L}/u.exec(text)?.[0] ?? text[0] ?? '';
  return (letter || fallback).toUpperCase().slice(0, 1);
}

/**
 * Suggest a marker for a new channel: the first letter of its name when that
 * letter is still free, otherwise the next unused letter. Deterministic so the
 * Create dialog's preview matches what actually gets stored.
 */
export function suggestMarker(
  name: string,
  taken: Iterable<string>,
): { letter: string; color: string } {
  const used = new Set([...taken].map((m) => markerLetter(m, '')).filter(Boolean));
  const first = markerLetter(name, '');
  const letter = LETTERS.includes(first) && !used.has(first)
    ? first
    : ([...LETTERS].find((candidate) => !used.has(candidate)) ?? (first || 'X'));
  return { letter, color: CHANNEL_COLORS[used.size % CHANNEL_COLORS.length] };
}

/** The letter + color a channel actually renders with (server value wins). */
export function markerOf(
  channel: { id: string; name: string; marker?: string | null; color?: string | null },
  index = 0,
): { letter: string; color: string } {
  if (isPublicChannelId(channel.id)) {
    return {
      letter: markerLetter(channel.marker, 'P'),
      color: channel.color || PUBLIC_CHANNEL_COLOR,
    };
  }
  const letter = markerLetter(channel.marker || channel.name, '?');
  return { letter, color: channel.color || CHANNEL_COLORS[index % CHANNEL_COLORS.length] };
}

/** One line of the rail's mixed-source selection summary (§8.4). */
export interface SelectionSourceRow {
  channelId: string;
  name: string;
  count: number;
}

/**
 * Group the current selection by the channel each unit is allocated to today.
 * Public sale is listed first; the rest follow in list order so the rail's
 * ordering never jitters as the selection changes.
 */
export function selectionSources(
  labels: string[],
  allocation: Map<string, string>,
  list: ChannelListResult | null,
): SelectionSourceRow[] {
  const counts = new Map<string, number>();
  for (const label of labels) {
    const channelId = normalizeChannelId(allocation.get(label));
    counts.set(channelId, (counts.get(channelId) ?? 0) + 1);
  }
  const order: Array<{ id: string; name: string }> = [
    { id: PUBLIC_CHANNEL_ID, name: list?.publicSale?.name ?? PUBLIC_CHANNEL_NAME },
    ...(list?.channels ?? []).map((channel) => ({ id: channel.id, name: channel.name })),
  ];
  const rows: SelectionSourceRow[] = [];
  for (const entry of order) {
    const count = counts.get(entry.id);
    if (count) rows.push({ channelId: entry.id, name: entry.name, count });
    counts.delete(entry.id);
  }
  // Anything the list does not know about (archived, or a mid-flight rename).
  for (const [channelId, count] of counts) {
    rows.push({
      channelId,
      name: isPublicChannelId(channelId) ? PUBLIC_CHANNEL_NAME : 'Another channel',
      count,
    });
  }
  return rows;
}

/**
 * Fold every "this unit is on public sale" spelling onto ONE id.
 *
 * The allocation map is built from `GET /channels/allocation`, which reports an
 * unallocated unit as the server's `'public'` sentinel; a missing entry means
 * the same thing. Comparing raw values here is what made public units classify
 * as `movedFromOtherChannel` in the staged preview while the server's
 * authoritative reply said `changedFromPublic`.
 */
function normalizeChannelId(id: string | null | undefined): string {
  return isPublicChannelId(id) ? PUBLIC_CHANNEL_ID : id as string;
}

const SKIP_SAMPLE = 12;

function skipBucket(labels: string[]): AssignmentSkippedBucket {
  return {
    count: labels.length,
    labels: labels.slice(0, SKIP_SAMPLE),
    truncated: labels.length > SKIP_SAMPLE,
  };
}

/**
 * The LOCAL staged preview of "move these labels to this channel".
 *
 * Mirrors the DO's rules exactly (eventChannels.applyAssignment):
 *   - a unit already in the target is `alreadyInTarget`, whatever its status;
 *   - otherwise held and booked units are skipped and never rewritten;
 *   - otherwise a public unit is `changedFromPublic`, a private one is
 *     `movedFromOtherChannel` (itemised per source);
 *   - a label that is not inventory in this event is `notFound`.
 *
 * Every requested label lands in exactly one bucket — the property the Review
 * sheet's "every selected seat is in exactly one line" promise depends on.
 */
export function planAssignment(input: {
  labels: string[];
  targetChannelId: string;
  allocation: Map<string, string>;
  statusOf: (label: string) => ChannelSeatStatus | undefined;
  nameOf: (channelId: string) => string | null;
}): AssignmentBuckets {
  const { labels, allocation, statusOf, nameOf } = input;
  const targetChannelId = normalizeChannelId(input.targetChannelId);
  const seen = new Set<string>();
  let fromPublic = 0;
  let alreadyIn = 0;
  const movedBySource = new Map<string, number>();
  const held: string[] = [];
  const booked: string[] = [];
  const missing: string[] = [];

  for (const label of labels) {
    if (seen.has(label)) continue;
    seen.add(label);
    const status = statusOf(label);
    if (!status) { missing.push(label); continue; }
    const current = normalizeChannelId(allocation.get(label));
    if (current === targetChannelId) { alreadyIn += 1; continue; }
    if (status === 'held') { held.push(label); continue; }
    if (status === 'booked') { booked.push(label); continue; }
    if (current === PUBLIC_CHANNEL_ID) fromPublic += 1;
    else movedBySource.set(current, (movedBySource.get(current) ?? 0) + 1);
  }

  const channels = [...movedBySource.entries()].map(([channelId, count]) => ({
    channelId,
    name: nameOf(channelId),
    count,
  }));
  return {
    changedFromPublic: { count: fromPublic },
    movedFromOtherChannel: {
      count: channels.reduce((sum, row) => sum + row.count, 0),
      channels,
    },
    alreadyInTarget: { count: alreadyIn },
    skippedHeld: skipBucket(held),
    skippedBooked: skipBucket(booked),
    notFound: skipBucket(missing),
  };
}

/** Units this plan will actually mutate — what the Apply button counts. */
export function mutationCount(buckets: AssignmentBuckets): number {
  return buckets.changedFromPublic.count + buckets.movedFromOtherChannel.count;
}

/** True when moving inventory out of another PRIVATE channel — §8.5 requires an
 *  explicit confirmation line for exactly this case. */
export function needsMoveConfirmation(buckets: AssignmentBuckets): boolean {
  return buckets.movedFromOtherChannel.count > 0;
}

export interface BucketRow {
  kind: 'add' | 'move' | 'same' | 'skip';
  icon: string;
  count: number;
  text: string;
  why?: string;
  /** Sampled seat labels for a skipped bucket, when the server sent any. */
  peek?: string;
}

/**
 * Render-ready rows for the Review sheet. The comp shows five lines; the server
 * carries a sixth bucket (`notFound`) which is emitted only when it is non-zero,
 * so a normal review still reads exactly like the approved design.
 *
 * Empty buckets are dropped — a zero line is noise, not honesty.
 */
export function bucketRows(buckets: AssignmentBuckets, targetName: string): BucketRow[] {
  const rows: BucketRow[] = [];
  if (buckets.changedFromPublic.count) {
    rows.push({
      kind: 'add', icon: '+', count: buckets.changedFromPublic.count,
      text: `${buckets.changedFromPublic.count.toLocaleString()} from ${PUBLIC_CHANNEL_NAME}`,
    });
  }
  for (const source of buckets.movedFromOtherChannel.channels) {
    rows.push({
      kind: 'move', icon: '⇄', count: source.count,
      text: `${source.count.toLocaleString()} moved out of ${source.name ?? 'another channel'}`,
      why: 'needs this confirmation',
    });
  }
  if (buckets.alreadyInTarget.count) {
    rows.push({
      kind: 'same', icon: '=', count: buckets.alreadyInTarget.count,
      text: `${buckets.alreadyInTarget.count.toLocaleString()} already in ${targetName}`,
      why: 'unchanged',
    });
  }
  if (buckets.skippedHeld.count) {
    rows.push({
      kind: 'skip', icon: '⏸', count: buckets.skippedHeld.count,
      text: `${buckets.skippedHeld.count.toLocaleString()} in a buyer's checkout`,
      why: "can't move while held",
      peek: peekOf(buckets.skippedHeld),
    });
  }
  if (buckets.skippedBooked.count) {
    rows.push({
      kind: 'skip', icon: '🔒', count: buckets.skippedBooked.count,
      text: `${buckets.skippedBooked.count.toLocaleString()} already sold`,
      why: 'sales are never rewritten',
      peek: peekOf(buckets.skippedBooked),
    });
  }
  if (buckets.notFound.count) {
    rows.push({
      kind: 'skip', icon: '?', count: buckets.notFound.count,
      text: `${buckets.notFound.count.toLocaleString()} not on this map`,
      why: 'these seats are no longer part of the event',
      peek: peekOf(buckets.notFound),
    });
  }
  return rows;
}

function peekOf(bucket: AssignmentSkippedBucket): string | undefined {
  if (!bucket.labels.length) return undefined;
  const shown = bucket.labels.slice(0, 4).join(', ');
  return bucket.truncated || bucket.labels.length > 4 ? `${shown}…` : shown;
}

/**
 * "try again in ~N minutes" for the archive-blocked-by-holds 409 (§8.8).
 * Rounds up so the organizer never comes back one tick early.
 */
export function retryAfterCopy(details: ArchiveBlockedDetails | null | undefined): string {
  const ms = details?.retryAfterMs ?? (details?.latestHoldExpiresAt
    ? Math.max(0, details.latestHoldExpiresAt - Date.now())
    : 0);
  if (!ms) return 'in a moment';
  const minutes = Math.ceil(ms / 60_000);
  if (minutes <= 1) return 'in about a minute';
  return `in about ${minutes} minutes`;
}

/** The access line under a channel row. Falls back to "—" before the hardening
 *  branch lands the `access` field, never to a guess. */
export function accessLine(access: ChannelAccessSummary | null | undefined): string {
  if (!access || !access.intent) return '—';
  const base = access.intent === 'internal' ? 'Internal selling · no buyer access needed'
    : access.intent === 'server' ? 'Server integration'
      : access.intent === 'hosted_link' ? 'Hosted access link'
        : 'No buyer access configured';
  const grants = access.hasActiveGrants ? 'in use now'
    : access.lastMintAt ? `last used ${new Date(access.lastMintAt).toLocaleDateString()}` : null;
  const detail = access.detail ?? grants;
  return detail ? `${base} · ${detail}` : base;
}

/** Plain-language label for the access-intent control. */
export function accessIntentLabel(intent: ChannelAccessIntent): string {
  return intent === 'internal' ? 'Internal selling — our own staff sell these'
    : intent === 'server' ? 'Server integration — our backend lets buyers in'
      : intent === 'hosted_link' ? 'Hosted access link — SeatLayer issues the link'
        : 'No buyer access yet — the allocation is just protected';
}

// ---------------------------------------------------------------------------
// Hosted access links (M8)
// ---------------------------------------------------------------------------

/** Lifecycle the server stores. `rotated` means a newer link replaced this one. */
export type AccessLinkState = 'active' | 'revoked' | 'rotated';

/** What the organizer surface renders: `state`, unless an active link has run
 *  out of time or out of redemptions. Never a capability, never a hash. */
export type AccessLinkStatus = AccessLinkState | 'expired' | 'exhausted';

/**
 * One hosted link, exactly as `GET …/access-links` projects it.
 *
 * There is deliberately NO `url` and NO `capability` field here — the listing
 * route does not return them, no other route returns them, and this type must
 * not tempt a caller into believing otherwise. The secret exists in exactly one
 * place for exactly one moment: the create/rotate response (`AccessLinkReveal`).
 */
export interface AccessLinkRecord {
  id: string;
  channelId: string;
  label: string | null;
  includePublic: boolean;
  expiresAt: number;
  maxRedemptions: number;
  redemptions: number;
  /** Guest-weighted per-buyer ceiling handed to every session this link mints. */
  maxQuantity: number;
  sessionTtlSeconds: number;
  state: AccessLinkState;
  status: AccessLinkStatus;
  createdAt: number;
  createdBy: string | null;
  revokedAt: number | null;
  lastRedeemedAt: number | null;
  /** Rotation lineage: the link this replaced, and the one that replaced it. */
  rotatedFrom: string | null;
  rotatedTo: string | null;
}

/** A listed link, with the live session count the rotate dialog needs to state
 *  "N buyers got in with this link and still have access". */
export interface AccessLinkStatusRecord extends AccessLinkRecord {
  activeSessions?: number;
}

/**
 * The ONE-TIME reveal. `url` and `capability` are on the wire exactly once, in
 * the create/rotate response, and are unrecoverable afterwards: SeatLayer stores
 * only a hash. Nothing may persist this — see `ChannelsMode.revealLink`.
 */
export interface AccessLinkReveal {
  link: AccessLinkRecord;
  url: string;
  capability: string;
  revealedOnce: true;
  /** Rotation only: the link that just stopped working, and how many live buyer
   *  sessions from it were ended (0 when the organizer let them finish). */
  previous?: AccessLinkRecord;
  endedSessions?: number;
}

/**
 * Owner-set defaults for a new link. Expiry is NOT here: "when the event starts"
 * is the server's own default (it knows `starts_at`; the cockpit does not), so
 * the create form expresses that choice by omitting `expiresAt` entirely rather
 * than by guessing a timestamp the server would then have to correct.
 */
export const ACCESS_LINK_DEFAULTS = {
  maxRedemptions: 100,
  maxQuantity: 4,
} as const;

/** Plain-language state badge for a hosted link (§9: no internal vocabulary). */
export function accessLinkBadge(link: Pick<AccessLinkRecord, 'status' | 'state'>): {
  text: string; kind: 'active' | 'paused' | 'archived';
} {
  switch (link.status ?? link.state) {
    case 'active': return { text: 'Active', kind: 'active' };
    case 'expired': return { text: 'Expired', kind: 'archived' };
    case 'exhausted': return { text: 'All used', kind: 'paused' };
    case 'rotated': return { text: 'Replaced', kind: 'archived' };
    default: return { text: 'Revoked', kind: 'archived' };
  }
}

/** Only an `active` link can be rotated or revoked; the server agrees (409
 *  `access_link_not_active`), so the buttons are absent rather than failing. */
export function accessLinkIsLive(link: Pick<AccessLinkRecord, 'status' | 'state'>): boolean {
  return link.state === 'active' && link.status === 'active';
}

function formatMoment(ms: number): string {
  if (!Number.isFinite(ms)) return '—';
  return new Date(ms).toLocaleString(undefined, {
    day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit',
  });
}

/**
 * The policy an organizer is agreeing to, in one list. Used by BOTH the reveal
 * (what you just created) and the status card (what is live), so the two can
 * never drift into describing the same link differently.
 */
export function accessLinkPolicyLines(link: AccessLinkRecord): Array<{ k: string; v: string }> {
  return [
    { k: 'Expires', v: formatMoment(link.expiresAt) },
    {
      k: 'Redemptions',
      v: `${link.redemptions.toLocaleString()} of ${link.maxRedemptions.toLocaleString()} used`,
    },
    {
      k: 'Seats per buyer',
      v: `${link.maxQuantity.toLocaleString()} seat${link.maxQuantity === 1 ? '' : 's'} maximum`,
    },
    {
      k: 'Covers',
      v: link.includePublic
        ? "This channel's allocation and Public sale seats"
        : "This channel's allocation only",
    },
  ];
}

/**
 * Plain language for a refused hosted-link call.
 *
 * The PLATFORM BOUNDS live on the server (60s–180d expiry, 1–10 000 redemptions,
 * 1–100 seats per buyer, 20 live links per channel) and the server states them
 * in `message`. We surface that sentence rather than re-encoding the numbers
 * here, so the client can never disagree with the rule it is reporting.
 */
export function accessLinkErrorCopy(
  err: { code?: string; serverMessage?: string; status?: number } | null | undefined,
): string {
  const fromServer = err?.serverMessage?.trim();
  switch (err?.code) {
    case 'invalid_expiry':
    case 'invalid_max_redemptions':
    case 'invalid_max_quantity':
    case 'invalid_session_ttl':
    case 'invalid_label':
      return fromServer || 'That setting is outside what a hosted link allows. Adjust it and try again.';
    case 'too_many_access_links':
      return fromServer
        || 'This channel already has as many live links as it can hold. Revoke one before creating another.';
    case 'access_link_not_active':
      return 'That link is no longer active, so it cannot be rotated or revoked.';
    case 'channel_unavailable':
      return 'This channel is paused or archived, so it cannot let new buyers in. Resume it first.';
    case 'end_active_sessions_required':
      return 'Choose what happens to the buyers who already came in through this link.';
    case 'not_found':
      return 'That link is no longer here. Refresh and try again.';
    default:
      if (err?.status === 403) return 'Hosted access links need channel-management permission.';
      return fromServer || 'That did not go through. Try again.';
  }
}

/**
 * The chart-update refusal `channel_assignment_would_drop` (409) deliberately
 * mirrors the Apply skipped buckets, so ONE review component renders both.
 * This adapts it into the same `BucketRow[]` the Review sheet already draws.
 */
export interface AssignmentDropDetails {
  droppedUnits?: number;
  channels?: Array<{ channelId: string; name: string | null; count: number; labels?: string[]; truncated?: boolean }>;
  acknowledgeWith?: string;
}

export function dropReviewRows(details: AssignmentDropDetails | null | undefined): BucketRow[] {
  return (details?.channels ?? []).map((channel) => ({
    kind: 'skip' as const,
    icon: '⚠',
    count: channel.count,
    text: `${channel.count.toLocaleString()} would leave ${channel.name ?? 'a channel'}`,
    why: 'the new chart no longer has these seats',
    peek: channel.labels?.length
      ? peekOf({ count: channel.count, labels: channel.labels, truncated: channel.truncated ?? false })
      : undefined,
  }));
}

/** Plain-language state badge text (§9: no internal vocabulary on user surfaces). */
export function stateBadge(state: ChannelState | 'builtin'): string {
  return state === 'builtin' ? 'Built-in'
    : state === 'active' ? 'Active'
      : state === 'paused' ? 'Paused' : 'Archived';
}
