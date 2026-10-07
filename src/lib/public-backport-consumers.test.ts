import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
import { createRequire } from 'node:module';
const req = createRequire(import.meta.url);
const source = (p: string) => ts.createSourceFile(p, fs.readFileSync(p, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function find(root: ts.Node, predicate: (n: ts.Node) => boolean): ts.Node {
  let hit: ts.Node | undefined;
  function visit(n: ts.Node) { if (!hit && predicate(n)) hit = n; if (!hit) ts.forEachChild(n, visit); }
  visit(root); assert.ok(hit, 'real consumer expression must exist'); return hit;
}
function initializer(p: string, name: string) {
  const root = source(p);
  return (find(root, n => ts.isVariableDeclaration(n) && n.name.getText(root) === name) as ts.VariableDeclaration).initializer!.getText(root);
}
function evaluate(expression: string, env: Record<string, unknown>) {
  const js = ts.transpile(`const result = (${expression});`, { target: ts.ScriptTarget.ES2022 });
  return new Function(...Object.keys(env), js + '\nreturn result;')(...Object.values(env));
}
const loadIfUsed = (expression: string, name: string, p: string) => expression.includes(name) ? req(p)[name] : undefined;
const detail = 'src/components/reservation-detail-page.tsx';
const folio = 'src/components/reservation-folio-modal.tsx';
const cases: Record<string, () => void> = {
  f98f6a26() {
    const e = initializer(folio, 'canEditPaymentMethod');
    const fn = evaluate(e, { useCallback: (f: unknown) => f, isReadonly: false, reservationId: 'r', businessDate: '2026-10-07', voidedRowIds: new Set(), isOperatorPaymentMethod: (m: string) => ['cash','transfer','credit_card'].includes(m), allowPaymentMethodEdit: false, canEditFolioPaymentMethod: loadIfUsed(e, 'canEditFolioPaymentMethod', './folio-payment-method-edit') });
    assert.equal(fn({ id: 'tx', type: 'charge', tx_type: 'payment', method: 'cash', paid_date: '2026-10-07' }), true, 'actual payment transaction remains editable despite display category');
  },
  '636e1338'() {
    const e = initializer(folio, 'canEditPaymentMethod');
    const env = { useCallback: (f: unknown) => f, isReadonly: true, reservationId: 'r', businessDate: '2026-10-07', voidedRowIds: new Set(), isOperatorPaymentMethod: (m: string) => ['cash','transfer','credit_card'].includes(m), allowPaymentMethodEdit: true, canEditFolioPaymentMethod: loadIfUsed(e, 'canEditFolioPaymentMethod', './folio-payment-method-edit') };
    const fn = evaluate(e, env);
    assert.equal(fn({ id: 'tx', type: 'payment', tx_type: 'payment', method: 'transfer', paid_date: '2026-10-07' }), true, 'Day Use permits method repair while charge editing stays locked');
    assert.equal(fn({ id: 'tx', type: 'payment', tx_type: 'payment', method: 'transfer', paid_date: '2026-10-06' }), false);
    assert.equal(fn({ id: 'tx', type: 'payment', tx_type: 'payment', method: 'transfer', paid_date: '2026-10-07', is_record_only: true }), false);
    const root = source(detail);
    const flag = find(root, n => ts.isJsxAttribute(n) && n.name.getText(root) === 'allowPaymentMethodEdit') as ts.JsxAttribute;
    const expression = (flag.initializer as ts.JsxExpression).expression!.getText(root);
    assert.equal(evaluate(expression, { dayUseAmountOnlyMode: true, readonlyClosedReservation: true }), false, 'closed Day Use keeps its readonly protection');
    assert.equal(evaluate(expression, { dayUseAmountOnlyMode: true, readonlyClosedReservation: false }), true);

  },
  b3eaaa19() {
    const root = source(detail);
    const call = find(root, n => ts.isCallExpression(n) && n.expression.getText(root) === 'openPassportOcr' && n.arguments[0]?.getText(root) === '"accompany"') as ts.CallExpression;
    const block = call.parent.parent as ts.Block;
    const decl = find(block, n => ts.isVariableDeclaration(n) && n.name.getText(root) === 'gi') as ts.VariableDeclaration;
    const e = decl.initializer!.getText(root);
    const env = { member: null, accompanyingGuests: [{ display_order: 2 }], passportOcrGuestIndex: loadIfUsed(e, 'passportOcrGuestIndex', './checkin/passport-ocr-guest-index') };
    assert.equal(evaluate(e, env), 2, 'second accompanying guest must select its own scan');
    assert.equal(evaluate(e, { ...env, accompanyingGuests: [{ display_order: 3 }] }), 1, 'free slot after deletion is reused');
  },
  '09e6a6eb'() {
    const root = source(detail);
    const call = find(root, n => ts.isCallExpression(n) && n.expression.getText(root) === 'fetch' && n.arguments[0]?.getText(root).includes('/api/dayuse/') && n.arguments[0]?.getText(root).includes('/extend')) as ts.CallExpression;
    const options = call.arguments[1] as ts.ObjectLiteralExpression;
    const body = options.properties.find(n => ts.isPropertyAssignment(n) && n.name.getText(root) === 'body') as ts.PropertyAssignment;
    const e = body.initializer.getText(root);
    let extendRequest: unknown;
    if (e.includes('extendRequest')) extendRequest = req('./dayuse-extend-confirm').buildDayUseExtendRequest({ paymentMethod: 'transfer', paymentAmount: 120 });
    assert.deepEqual(JSON.parse(evaluate(e, { parsedAmount: 120, extendRequest })), { payment_method: 'transfer', payment_amount: 120 }, 'selected transfer method must survive the actual request body');
  },
  '8f35ab2c'() {
    const root = source(detail);
    const decl = find(root, n => ts.isVariableDeclaration(n) && ['shouldForkSharedProfile','forkSharedProfile'].includes(n.name.getText(root))) as ts.VariableDeclaration;
    const e = decl.initializer!.getText(root);
    const names = req('./guest-name-match');
    assert.equal(evaluate(e, { profileId: 'p', reservationId: 'r', linkedProfileActiveReservationCount: 2, linkedProfileName: 'Alice Example', guestName: 'Travel Alias', profileBookingNames: ['Travel Alias'], classifyGuestNameMatch: names.classifyGuestNameMatch, shouldForkSharedProfile: loadIfUsed(e, 'shouldForkSharedProfile(', './guest-booking-names') ?? (e.includes('shouldForkSharedProfile(') ? req('./guest-booking-names').shouldForkSharedProfile : undefined) }), false, 'known booking alias must not fork a shared profile');
  },
  '0b9bc819'() {
    const e = initializer('src/app/pms/receipt/preview/[id]/page.tsx', 'seller');
    assert.equal(evaluate(e, { sellerResult: { data: {}, seller_snapshot: { hotel_name: 'Example Hotel' } } }).hotel_name, 'Example Hotel', 'receipt letterhead reads the actual sibling snapshot');
  },
};
const selected = process.argv[2];
if (selected) { assert.ok(cases[selected], 'known regression case'); cases[selected](); }
else { for (const fn of Object.values(cases)) fn(); }
console.log('actual consumer assertions passed');
