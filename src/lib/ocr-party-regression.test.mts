import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { File } from 'node:buffer';
import ts from 'typescript';
import { z } from 'zod';

const root = process.cwd();
class CheckinError extends Error { constructor(message: string, public status = 400, public code?: string) { super(message); } }
const parsed = { firstName: 'Sample', familyName: 'Person', passportNumber: 'TEST123', nationality: 'USA', dateOfBirth: '2000-01-01', gender: 'M' };
const jsonResponse = { json: (body: unknown, init?: { status?: number }) => ({ body, status: init?.status ?? 200 }) };
function load(path: string, stubs: Record<string, any> = {}, globals: Record<string, any> = {}) {
  const exports: Record<string, any> = {};
  const code = ts.transpileModule(readFileSync(resolve(root, path), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText;
  runInNewContext(code, {
    exports, module: { exports }, Buffer, File, Blob, FormData, URL, URLSearchParams, AbortController,
    console, setTimeout: (fn: Function) => { fn(); return 0; }, clearTimeout: () => {},
    require: (id: string) => stubs[id] ?? (id === 'next/server' ? { NextResponse: jsonResponse } : {}), ...globals,
  }, { filename: path });
  return exports;
}
function query(result: any, mutate?: (kind: string, payload: any) => void) {
  let kind = 'read'; let payload: any;
  const chain: any = new Proxy({}, { get: (_target, key) => {
    if (key === 'then') return (resolvePromise: Function) => { mutate?.(kind, payload); resolvePromise(typeof result === 'function' ? result(kind, payload) : result); };
    return (...args: any[]) => { if (key === 'delete' || key === 'insert' || key === 'update') { kind = String(key); payload = args[0]; } return chain; };
  } });
  return chain;
}
function routeStubs(client: any, mobile: Record<string, any> = {}): Record<string, any> {
  return {
    '@/lib/supabase/server': { createServerSupabaseClient: () => client },
    '@/lib/mobile-checkin': { MobileCheckinError: CheckinError, requireMobileCheckinAuth: async () => ({ userId: 'operator' }), getBusinessDate: async () => '2026-01-01', computeMrzConfidence: () => 90, levenshteinRatioPercent: () => 90, ...mobile },
    '@/lib/passport-ocr/vision': { detectPassportTextFromBuffer: async () => 'fixture' },
    '@/lib/passport-ocr/mrz': { parsePassportMrz: () => parsed },
    '@/lib/reservation-party': { linkPrimaryGuestToReservation: async () => {} },
  };
}
function imageRequest(fields: Record<string, string> = {}) {
  const form = new FormData(); form.set('image', new File(['image'], 'passport.jpg', { type: 'image/jpeg' }));
  for (const [key, value] of Object.entries(fields)) form.set(key, value);
  return { formData: async () => form, headers: new Headers() };
}
function pageHarness(path: string, fixture: Record<string, any> = {}, fetcher: any = async () => ({ ok: true, json: async () => ({ success: true, data: { rooms: [] }, guests: [] }) })) {
  let cursor = 0; const cells: any[] = []; const effects: Function[] = []; const refs: any[] = []; const storage = new Map<string, string>(); let clicks = 0;
  const react = {
    useState: (initial: any) => { const i = cursor++; if (!(i in cells)) cells[i] = typeof initial === 'function' ? initial() : initial;
      if (!(i in cells)) cells[i] = initial;
      return [cells[i], (value: any) => { cells[i] = typeof value === 'function' ? value(cells[i]) : value; }]; },
    useRef: (initial: any) => { const i = cursor++; refs[i] ??= { current: initial ?? { click: () => { clicks++; }, value: '' } }; return refs[i]; },
    useEffect: (fn: Function) => { effects.push(fn); },
  };
  const jsx = (type: any, props: any) => ({ type, props });
  const sessionStorage = { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) };
  const mod = load(path, {
    react, 'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'fragment' },
    'next/navigation': { useParams: () => ({ resId: 'reservation' }), useRouter: () => ({ push: () => {}, replace: () => {} }), useSearchParams: () => new URLSearchParams(fixture.search ?? '') },
    'next/link': { default: 'link' }, 'lucide-react': new Proxy({}, { get: (_t, name) => name }),
    '@/lib/passport-ocr/client-preprocess': { buildPassportMrzBlob: async (file: File) => file, PASSPORT_OCR_MAX_FILE_BYTES: 10000000 },
  }, { fetch: fetcher, sessionStorage, window: {}, alert: () => {}, confirm: () => true });
  const render = () => { cursor = 0; return mod.default(); };
  render();
  if (path.includes('guest-info')) { cells[0] = { full_name: 'Sample Person', passport_no: '', nationality: '', date_of_birth: '', gender: '' }; cells[1] = fixture.accompanying ?? []; cells[2] = false; }
  return { render, effects, storage, clicks: () => clicks };
}
function nodes(tree: any): any[] {
  if (Array.isArray(tree)) return tree.flatMap(nodes);
  if (!tree || typeof tree !== 'object') return [];
  return [tree, ...nodes(tree.props?.children)];
}
function text(node: any): string { if (typeof node === 'string') return node; if (Array.isArray(node)) return node.map(text).join(''); return text(node?.props?.children ?? ''); }

test('unreadable MRZ keeps the uploaded scan receipt for manual recovery', async () => {
  let inserted: any;
  const client = { from: () => query({ data: { id: 'scan', image_path: 'image' }, error: null }, (kind, payload) => { if (kind === 'insert') inserted = payload; }), storage: { from: () => ({ upload: async () => ({ error: null }) }) } };
  const stubs = routeStubs(client); stubs['@/lib/passport-ocr/mrz'] = { parsePassportMrz: () => null };
  const { POST } = load('src/app/api/checkin/scan-passport/route.ts', stubs);
  const response = await POST(imageRequest());
  assert.equal(response.status, 200);
  assert.equal(response.body.data.scan_id, 'scan');
  assert.equal(response.body.data.mrz_failed, true);
  assert.equal(response.body.data.parsed, null);
  assert.equal(inserted.ocr_parsed, null);
});

test('guest-info save preserves previously entered payment and deposit', () => {
  const harness = pageHarness('src/app/pms/mobile-checkin/guest-info/[resId]/page.tsx');
  harness.storage.set('mobile-checkin-reservation', JSON.stringify({ payment: { amount: 100 }, deposit: { amount: 50 } }));
  const next = nodes(harness.render()).find(n => n.type === 'button' && text(n).trim() === 'Next');
  assert.ok(next); next.props.onClick();
  const saved = JSON.parse(harness.storage.get('mobile-checkin-reservation')!);
  assert.deepEqual(saved.payment, { amount: 100 }); assert.deepEqual(saved.deposit, { amount: 50 });
});

test('scanning over populated guest data asks before opening camera', () => {
  const harness = pageHarness('src/app/pms/mobile-checkin/guest-info/[resId]/page.tsx');
  const scan = nodes(harness.render()).find(n => n.type === 'button' && /Scan Passport|Rescan Passport/.test(text(n)));
  assert.ok(scan); scan.props.onClick();
  assert.equal(harness.clicks(), 0, 'camera must wait for overwrite confirmation');
  assert.ok(nodes(harness.render()).some(n => n.props?.role === 'dialog'));
});

test('failed MRZ guest scan retains its receipt without clearing typed fields', async () => {
  const harness = pageHarness('src/app/pms/mobile-checkin/guest-info/[resId]/page.tsx', {}, async () => ({ ok: true, json: async () => ({ success: true, data: { scan_id: 'failed-scan', mrz_failed: true, parsed: null } }) }));
  const input = nodes(harness.render()).find(n => n.type === 'input' && n.props?.type === 'file');
  assert.ok(input); await input.props.onChange({ target: { files: [new File(['image'], 'passport.jpg', { type: 'image/jpeg' })], value: '' } });
  nodes(harness.render()).find(n => n.type === 'button' && text(n).trim() === 'Next').props.onClick();
  const saved = JSON.parse(harness.storage.get('mobile-checkin-reservation')!);
  assert.equal(saved.scan_id, 'failed-scan'); assert.equal(saved.guest_info.full_name, 'Sample Person');
});

test('deleting first companion leaves survivor camera on its original slot', async () => {
  let uploadedSlot: unknown;
  const harness = pageHarness('src/app/pms/mobile-checkin/guest-info/[resId]/page.tsx', { accompanying: [{ full_name: 'First Person', passport_guest_index: 1 }, { full_name: 'Second Person', passport_guest_index: 2 }] }, async (_url: string, options: any) => { uploadedSlot = options.body.get('guest_index'); return { ok: true, json: async () => ({ success: true, data: { scan_id: 'scan', parsed } }) }; });
  const remove = nodes(harness.render()).find(n => n.type === 'button' && nodes(n).some(child => child.type === 'Trash2'));
  assert.ok(remove); remove.props.onClick();
  let dialog = nodes(harness.render()).find(n => n.props?.role === 'dialog');
  if (dialog) nodes(dialog).find(n => n.type === 'button' && /Delete|Confirm|ยืนยัน/.test(text(n))).props.onClick();
  const scans = nodes(harness.render()).filter(n => n.type === 'button' && /Scan Passport|Rescan Passport|^\s*Scan\s*$/.test(text(n)));
  scans.at(-1)!.props.onClick();
  dialog = nodes(harness.render()).find(n => n.props?.role === 'dialog');
  if (dialog) nodes(dialog).find(n => n.type === 'button' && /Scan again|Confirm|ยืนยัน/.test(text(n))).props.onClick();
  const fileInputs = nodes(harness.render()).filter(n => n.type === 'input' && n.props?.type === 'file');
  await fileInputs.at(-1)!.props.onChange({ target: { files: [new File(['image'], 'passport.jpg', { type: 'image/jpeg' })], value: '' } });
  assert.equal(uploadedSlot, '2');
});

test('failed companion profile resolution does not erase the existing party', async () => {
  const party = [{ guest_profile_id: 'old', display_order: 2 }];
  const client = { from: () => query({ data: null, error: null }, (kind) => { if (kind === 'delete') party.splice(0); }), rpc: async () => ({ error: null }) };
  const mod = load('src/lib/mobile-checkin.ts', { '@/lib/guest-resolution': { findExistingGuestProfileByDocument: async () => { throw new Error('profile unavailable'); } }, '@/lib/nationality-map': { normalizeNationalityCode: () => null } });
  await assert.rejects(mod.syncAccompanyingGuests({ supabase: client, reservationId: 'reservation', primaryGuestProfileId: 'main', accompanyingGuests: [{ full_name: 'New Person', passport_no: 'NEW' }] }), /profile unavailable/);
  assert.equal(party.length, 1, 'resolution failure must leave current companions intact');
});

test('companion sync preserves sparse scan slot and scan identity', async () => {
  let applied: any[] = [];
  const client = { from: () => query({ data: null, error: null }, (kind, payload) => { if (kind === 'insert') applied = payload; }), rpc: async (_name: string, args: any) => { applied = args.p_guests; return { error: null }; } };
  const mod = load('src/lib/mobile-checkin.ts', {
    '@/lib/guest-resolution': { findExistingGuestProfileByDocument: async () => ({ id: 'person' }) },
    '@/lib/guest-profile-persistence': { updateGuestProfileWithConflictHandling: async () => ({ profile: { id: 'person' } }) },
    '@/lib/nationality-map': { normalizeNationalityCode: () => null, getCountryByCode: () => null },
  });
  await mod.syncAccompanyingGuests({ supabase: client, reservationId: 'reservation', primaryGuestProfileId: 'main', accompanyingGuests: [{ full_name: 'Sample Person', passport_no: 'TEST123', passport_guest_index: 3, passport_scan_id: 'scan' }] });
  assert.equal(applied[0].display_order, 4); assert.equal(applied[0].passport_scan_id, 'scan');
});

for (const failure of ['party-read', 'profile-read', 'profile-missing']) {
  test(`Fill OCR aborts replacement after ${failure} failure`, async () => {
    let syncs = 0;
    const client = { from: (table: string) => query(table === 'reservations' ? { data: { id: 'reservation', status: 'active' }, error: null } : table === 'reservation_guests' ? { data: failure === 'party-read' ? null : [{ guest_profile_id: 'old', display_order: 3 }], error: failure === 'party-read' ? { message: 'read failed' } : null } : { data: null, error: failure === 'profile-read' ? { message: 'read failed' } : null }) };
    const { POST } = load('src/app/api/checkin/fill-ocr/route.ts', routeStubs(client, { syncAccompanyingGuests: async () => { syncs++; } }));
    const response = await POST(imageRequest({ reservation_id: 'reservation', target: 'accompanying', guest_index: '1' }));
    assert.notEqual(response.status, 200); assert.equal(syncs, 0, 'party reads must succeed before replacement');
  });
}

test('Fill OCR preserves existing sparse slots when adding to first free slot', async () => {
  let infos: any[] = [];
  const client = { from: (table: string) => query(table === 'reservations' ? { data: { id: 'reservation', status: 'active' }, error: null } : table === 'reservation_guests' ? { data: [{ guest_profile_id: 'old', display_order: 3 }], error: null } : { data: { first_name: 'Old', last_name: 'Person', passport_no: 'OLD' }, error: null }) };
  const { POST } = load('src/app/api/checkin/fill-ocr/route.ts', routeStubs(client, { syncAccompanyingGuests: async (args: any) => { infos = args.accompanyingGuests; } }));
  const response = await POST(imageRequest({ reservation_id: 'reservation', target: 'accompanying', guest_index: '1' }));
  assert.equal(response.status, 200); assert.equal(infos[0].passport_guest_index, 2); assert.equal(infos[1].passport_guest_index, 1);
});

test('Fill OCR loads party through supported booking-guests API', async () => {
  const requested: string[] = [];
  const harness = pageHarness('src/app/pms/mobile-checkin/fill-ocr/[resId]/page.tsx', {}, async (url: string) => { requested.push(url); return { ok: true, json: async () => ({ success: true, data: { rooms: [] }, guests: [] }) }; });
  for (const effect of harness.effects) effect();
  await new Promise(resolvePromise => setImmediate(resolvePromise));
  assert.ok(requested.includes('/api/bookings/reservation/guests')); assert.ok(!requested.some(url => url.startsWith('/api/reservation-guests')));
});

for (const endpoint of ['draft', 'save-draft-and-exit']) {
  test(`group ${endpoint} rejects a stale browser revision before writing`, async () => {
    let writes = 0;
    const mod = load(`src/app/api/booking-groups/[id]/checkin-wizard/${endpoint}/route.ts`, {
      '@/lib/supabase/server': { createServerSupabaseClient: () => ({}) },
      '@/lib/staff-auth': { requireStaffAuth: async () => ({}) },
      '@/lib/group-checkin-wizard': { ensureWizardStep: () => 2, pickBusinessDate: () => '2026-01-01', mergeDraftJson: (base: any, patch: any) => ({ ...base, ...patch }) },
      '@/lib/group-checkin-wizard-service': { getBusinessDate: async () => '2026-01-01', getWizardDraft: async () => ({ updated_at: 'current', current_step: 2, draft_json: { step2: { scanned_pool: ['new scan'] } } }), upsertWizardDraft: async () => { writes++; return {}; } },
    });
    const handler = mod[endpoint === 'draft' ? 'PUT' : 'POST'];
    const response = await handler({ json: async () => ({ draft_revision: 'stale', draft_json: { step2: { scanned_pool: [] } } }) }, { params: Promise.resolve({ id: 'group' }) });
    assert.equal(response.status, 409); assert.equal(writes, 0);
  });
}

for (const markFails of [false, true]) {
  test(`group OCR import ${markFails ? 'restores draft when scan marking fails' : 'retains exact selected scan identity'}`, async () => {
    const original = { step2: { scanned_pool: [] } };
    let stored = original;
    let revision = 1;
    const scan = { id: 'selected', guest_profile_id: 'person', pool_status: 'ready', ocr_raw: {}, created_at: '2026-01-01' };
    const client = { from: (table: string) => query((kind: string, payload: any) => table === 'booking_groups' ? { data: { id: 'group' }, error: null } : table === 'guest_profiles' ? { data: [{ id: 'person', first_name: 'Sample', last_name: 'Person' }], error: null } : kind === 'read' ? { data: [scan], error: null } : { data: markFails ? [] : [{ ...scan, pool_status: payload.pool_status }], error: markFails ? { message: 'scan marking unavailable' } : null }) };
    const save = async (args: any) => { stored = args.draftJson; revision++; return { updated_at: String(revision) }; };
    const { POST } = load('src/app/api/checkin/group-ocr-pool/[groupId]/import-to-wizard/route.ts', {
      zod: { z }, '@/lib/supabase/server': { createServerSupabaseClient: () => client },
      '@/lib/mobile-checkin': { MobileCheckinError: CheckinError },
      '@/lib/group-ocr': { requireDesktopGroupOcrAuth: async () => ({}), extractScanOrderFromOcrRaw: () => 1 },
      '@/lib/group-checkin-wizard': { ensureWizardStep: () => 2, pickBusinessDate: () => '2026-01-01', mergeDraftJson: (base: any, patch: any) => ({ ...base, step2: { ...base.step2, ...patch.step2 } }) },
      '@/lib/group-checkin-wizard-service': { getBusinessDate: async () => '2026-01-01', getWizardDraft: async () => ({ status: 'draft', updated_at: '1', draft_json: original }), upsertWizardDraft: save, updateWizardDraftAtRevision: save, WizardDraftRevisionConflictError: class extends Error {} },
    });
    const response = await POST({ json: async () => ({ scan_ids: ['selected'] }) }, { params: Promise.resolve({ groupId: 'group' }) });
    if (markFails) { assert.equal(response.status, 500); assert.deepEqual(stored, original, 'failed marking must not leave imported draft entries'); }
    else { assert.equal(response.status, 200); assert.equal((stored.step2.scanned_pool as any[])[0].scan_id, 'selected'); }
  });
}

test('query receipt wins over stale stored receipt while payment fields survive hydration', async () => {
  const harness = pageHarness('src/app/pms/mobile-checkin/guest-info/[resId]/page.tsx', { search: 'scan_id=fresh-scan' });
  harness.storage.set('mobile-checkin-reservation', JSON.stringify({ scan_id: 'old-scan', guest_info: { full_name: 'Stored Person', passport_no: '' }, payment_amount: 1200, deposit_amount: 500 }));
  harness.effects[0]();
  await new Promise(resolvePromise => setImmediate(resolvePromise));
  nodes(harness.render()).find(n => n.type === 'button' && text(n).trim() === 'Next').props.onClick();
  const saved = JSON.parse(harness.storage.get('mobile-checkin-reservation')!);
  assert.equal(saved.scan_id, 'fresh-scan', 'explicit current query receipt must override stored receipt');
  assert.equal(saved.payment_amount, 1200); assert.equal(saved.deposit_amount, 500);
});

test('group partial-import rollback restores ready linked scan using selected before-state', async () => {
  const scans = [
    { id: 'first', guest_profile_id: 'first-person', booking_group_id: 'group', pool_status: 'ready', reservation_id: 'room-one', matched_reservation_id: 'room-one', guest_index: 2, ocr_raw: {}, created_at: '2026-01-01' },
    { id: 'second', guest_profile_id: 'second-person', booking_group_id: 'group', pool_status: 'ready', reservation_id: 'room-two', matched_reservation_id: 'room-two', guest_index: 3, ocr_raw: {}, created_at: '2026-01-02' },
    { id: 'already-assigned', guest_profile_id: 'assigned-person', booking_group_id: 'group', pool_status: 'assigned', reservation_id: 'room-three', matched_reservation_id: 'room-three', guest_index: 1, ocr_raw: {}, created_at: '2026-01-03' },
  ];
  const before = structuredClone(scans);
  const original = { step2: { scanned_pool: [] } };
  let stored = original;
  let revision = 1;
  const client = { from: (table: string) => {
    if (table !== 'passport_scans') return query({ data: table === 'booking_groups' ? { id: 'group' } : scans.map(scan => ({ id: scan.guest_profile_id, first_name: 'Sample', last_name: 'Person' })), error: null });
    let projection: string[] | null = null; let update: any = null; const predicates: ((row: any) => boolean)[] = [];
    const chain: any = new Proxy({}, { get: (_target, key) => {
      if (key === 'then') return (resolvePromise: Function) => {
        let matching = scans.filter(row => predicates.every(predicate => predicate(row)));
        if (update?.pool_status === 'assigned') matching = matching.slice(0, 1); // Concurrently changed second row yields partial marking.
        if (update) matching.forEach(row => Object.assign(row, update));
        const data = matching.map(row => projection ? Object.fromEntries(projection.map(column => [column, (row as any)[column]])) : { ...row });
        resolvePromise({ data, error: null });
      };
      return (...args: any[]) => {
        if (key === 'select') projection = args[0].split(',').map((column: string) => column.trim());
        if (key === 'update') update = args[0];
        if (key === 'eq' || key === 'is') predicates.push(row => row[args[0]] === args[1]);
        if (key === 'in') predicates.push(row => args[1].includes(row[args[0]]));
        if (key === 'not') predicates.push(row => row[args[0]] !== args[2]);
        return chain;
      };
    } });
    return chain;
  } };
  const save = async (args: any) => { stored = args.draftJson; revision++; return { updated_at: String(revision) }; };
  const { POST } = load('src/app/api/checkin/group-ocr-pool/[groupId]/import-to-wizard/route.ts', {
    zod: { z }, '@/lib/supabase/server': { createServerSupabaseClient: () => client },
    '@/lib/mobile-checkin': { MobileCheckinError: CheckinError },
    '@/lib/group-ocr': { requireDesktopGroupOcrAuth: async () => ({}), extractScanOrderFromOcrRaw: () => 1 },
    '@/lib/group-checkin-wizard': { ensureWizardStep: () => 2, pickBusinessDate: () => '2026-01-01', mergeDraftJson: (base: any, patch: any) => ({ ...base, step2: { ...base.step2, ...patch.step2 } }) },
    '@/lib/group-checkin-wizard-service': { getBusinessDate: async () => '2026-01-01', getWizardDraft: async () => ({ status: 'draft', updated_at: '1', draft_json: original }), upsertWizardDraft: save, updateWizardDraftAtRevision: save, WizardDraftRevisionConflictError: class extends Error {} },
  });
  const response = await POST({ json: async () => ({ scan_ids: ['first', 'second'] }) }, { params: Promise.resolve({ groupId: 'group' }) });
  assert.equal(response.status, 409, 'partial marking must fail with conflict after successful restoration');
  assert.deepEqual(scans, before, 'rollback must restore ready linked row and preserve assigned/non-mutated rows');
  assert.deepEqual(stored, original);
});

for (const mrzFailed of [true, false]) {
  test(`pending ${mrzFailed ? 'failed' : 'successful'} companion scan cannot mutate survivor after target removal`, async () => {
    let finishScan: ((value: any) => void) | undefined;
    const harness = pageHarness('src/app/pms/mobile-checkin/guest-info/[resId]/page.tsx', { accompanying: [{ full_name: 'First Person', passport_guest_index: 1, passport_scan_id: null }, { full_name: 'Second Person', passport_guest_index: 2, passport_no: 'SURVIVOR', passport_scan_id: null }] }, () => new Promise(resolvePromise => { finishScan = resolvePromise; }));
    const scans = nodes(harness.render()).filter(n => n.type === 'button' && /^\s*Scan\s*$/.test(text(n)));
    scans[0].props.onClick();
    let dialog = nodes(harness.render()).find(n => n.props?.role === 'dialog');
    if (dialog) nodes(dialog).find(n => n.type === 'button' && /Scan again|Confirm|ยืนยัน/.test(text(n))).props.onClick();
    const input = nodes(harness.render()).filter(n => n.type === 'input' && n.props?.type === 'file').at(-1)!;
    const pending = input.props.onChange({ target: { files: [new File(['image'], 'passport.jpg', { type: 'image/jpeg' })], value: '' } });
    await new Promise(resolvePromise => setImmediate(resolvePromise));
    assert.ok(finishScan, 'scan request must reach deferred boundary');
    const remove = nodes(harness.render()).find(n => n.type === 'button' && nodes(n).some(child => child.type === 'Trash2'));
    remove.props.onClick();
    dialog = nodes(harness.render()).find(n => n.props?.role === 'dialog');
    if (dialog) nodes(dialog).find(n => n.type === 'button' && /Delete|Confirm|ยืนยัน/.test(text(n))).props.onClick();
    finishScan!({ ok: true, json: async () => ({ success: true, data: { scan_id: 'removed-target-scan', parsed: mrzFailed ? null : parsed, mrz_failed: mrzFailed } }) });
    await pending;
    nodes(harness.render()).find(n => n.type === 'button' && text(n).trim() === 'Next').props.onClick();
    const saved = JSON.parse(harness.storage.get('mobile-checkin-reservation')!);
    assert.equal(saved.accompanying_guests.length, 1, 'removed guest must not resurrect');
    assert.equal(saved.accompanying_guests[0].full_name, 'Second Person');
    assert.equal(saved.accompanying_guests[0].passport_no, 'SURVIVOR');
    assert.equal(saved.accompanying_guests[0].passport_scan_id, null, 'removed target receipt must not attach to survivor');
  });
}
