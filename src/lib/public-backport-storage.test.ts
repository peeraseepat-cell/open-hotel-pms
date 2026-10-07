import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
import { createRequire } from 'node:module';
import { AsyncLocalStorage } from 'node:async_hooks';
const req = createRequire(import.meta.url);
const which = process.argv[2];
async function draft() {
  const path = 'src/components/maid/lf-report-sheet.tsx';
  const text = fs.readFileSync(path, 'utf8');
  const root = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const fn = root.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'LfReportSheet') as ts.FunctionDeclaration;
  assert.ok(fn?.body);
  const body = fn.body.getText(root).slice(1);
  const prefix = body.slice(0, body.indexOf('  const handlePhotoChange'));
  const effects: (() => unknown)[] = []; const states: unknown[] = [];
  const store = new Map([['maid:lf-report:draft', JSON.stringify({ open: true, savedAt: Date.now(), roomId: 'room', description: 'Saved wallet', locationDetail: 'bed', category: 'valuables' })]]);
  const codecs = text.includes('lf-report-draft') ? req('../components/maid/lf-report-draft') : {};
  let reopened = false;
  const env = { ...codecs, isOpen: false, onClose() {}, onSuccess() {}, onReopen() { reopened = true; }, useState(initial: unknown) { const i = states.length; states.push(initial); return [initial, (v: unknown) => { states[i] = v; }]; }, useRef() { return { current: null }; }, useEffect(f: () => unknown) { effects.push(f); }, window: { localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string,v: string) => store.set(k,v), removeItem: (k: string) => store.delete(k) } }, URL, fetch: () => { throw new Error('closed mount must not fetch'); } };
  const js = ts.transpile(prefix + '\nreturn { handleClose };', { target: ts.ScriptTarget.ES2022 });
  const handlers = new Function(...Object.keys(env), js)(...Object.values(env));
  effects.forEach(f => f());
  assert.ok(states.includes('Saved wallet'), 'actual sheet mount restores saved report text');
  assert.equal(reopened, true, 'actual sheet mount reopens its parent');
  handlers.handleClose(); assert.equal(store.size, 0, 'explicit close clears saved draft');
}
async function cache() {
  const text = fs.readFileSync('src/app/api/admin/corrections/history/route.ts','utf8');
  const match = text.match(/export const fetchCache = ["']([^"']+)/);
  const filename = req.resolve('next/dist/server/lib/patch-fetch');
  const Module = req('node:module');
  const instrumented = new Module(filename, module);
  instrumented.filename = filename; instrumented.paths = Module._nodeModulePaths(req('node:path').dirname(filename));
  instrumented._compile(fs.readFileSync(filename, 'utf8') + '\nexports.createPatchedFetcher = createPatchedFetcher;', filename);
  const { createPatchedFetcher } = instrumented.exports;
  const storage = new AsyncLocalStorage(); const entries = new Map();
  let value = ''; let reads = 0;
  const patched = createPatchedFetcher(async () => { reads++; return new Response(value,{status:200}); }, { staticGenerationAsyncStorage: storage, serverHooks: { DynamicServerError: Error } });
  const incrementalCache = { fetchCacheKey: async (u: string,i: {body: string}) => u+i.body, lock: async () => async () => {}, get: async (k: string) => entries.has(k) ? {value:entries.get(k),isStale:false} : null, set: async (k: string,v: unknown) => { entries.set(k,v); } };
  for (const nextValue of ['A','B','A']) {
    value = nextValue;
    await storage.run({ isStaticGeneration: false, forceDynamic: true, revalidate: false, fetchCache: match?.[1], pagePath:'/api/admin/corrections/history/route', urlPathname:'/api/admin/corrections/history', incrementalCache }, async () => {
      const response = await patched('http://local.test/rest/v1/audit_logs',{method:'GET',headers:{authorization:'local-test'}}); assert.equal(await response.text(),nextValue,'real Next patched fetch must observe a changed correction history');
    });
  }
  assert.equal(reads,3);
}
async function r2() {
  const p='src/lib/r2.ts'; const text=fs.readFileSync(p,'utf8'); const root=ts.createSourceFile(p,text,ts.ScriptTarget.Latest,true);
  const fn=root.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='deleteR2Objects') as ts.FunctionDeclaration;
  assert.ok(fn); const js=ts.transpile(fn.getText(root).replace('export ',''),{target:ts.ScriptTarget.ES2022});
  const env={ getR2Client:()=>({send:async()=>({Errors:[{Key:'test-key',Code:'AccessDenied'}]})}),getR2Bucket:()=> 'test',DeleteObjectsCommand:class { constructor(public input: unknown) {} } };
  const consumer=new Function(...Object.keys(env),js+'\nreturn deleteR2Objects;')(...Object.values(env));
  await assert.rejects(()=>consumer(['test-key']),/Failed to delete/, 'per-object failure must retain database photo references');
}
const cases: Record<string,()=>Promise<void>>={ '1255623e':draft,'cdee2996':cache,'97c3bfc6':r2 };
async function main(){if(which){assert.ok(cases[which]);await cases[which]();}else{for(const fn of Object.values(cases))await fn();} console.log('storage consumer assertions passed');}
main().catch(e=>{console.error(e);process.exitCode=1;});
