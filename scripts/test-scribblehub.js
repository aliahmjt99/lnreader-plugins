// Run with: node --test scripts/test-scribblehub.js
// Exercise the ES5 plugin with the same module surface as LNReader 2.1.4.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const code = ts.transpileModule(
  readFileSync(
    new URL('../plugins/english/scribblehub.ts', import.meta.url),
    'utf8',
  ),
  {
    compilerOptions: {
      target: ts.ScriptTarget.ES5,
      module: ts.ModuleKind.CommonJS,
      esModuleInterop: true,
    },
  },
).outputText;

function loadPlugin(fetchApi) {
  const exports = {};
  const stubs = {
    '@libs/fetch': { fetchApi },
    '@libs/filterInputs': { FilterTypes: {} },
    '@libs/novelStatus': { NovelStatus: {} },
  };
  runInNewContext(code, {
    exports,
    require: name => stubs[name] || require(name),
    URLSearchParams,
  });
  return exports.default;
}

const response = (html, status = 200, headers = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: new Headers(headers),
  text: async () => html,
});
const list = `<div class="search_main_box mb">
  <div class="search_title mb"><a href="https://www.scribblehub.com/series/123/example/"> Example </a></div>
  <div class="search_img mb"><img src="https://cdn.scribblehub.com/example.jpg"></div>
</div>`;

test('search requests HTML, preserves the app User-Agent and encodes the query', async () => {
  const plugin = loadPlugin(async (url, init) => {
    const parsed = new URL(url);
    assert.equal(parsed.searchParams.get('sh'), 'magic & swords');
    assert.equal(parsed.searchParams.get('pg'), '2');
    assert.match(init.headers.Accept, /text\/html/);
    assert.equal(init.headers['Sec-Fetch-Mode'], 'navigate');
    assert.equal(init.headers['User-Agent'], undefined);
    return response(list);
  });
  const novels = await plugin.searchNovels('magic & swords', 2);
  assert.equal(novels.length, 1);
  assert.equal(novels[0].name, 'Example');
  assert.equal(novels[0].path, 'series/123/example/');
});

for (const [label, makeResponse] of [
  ['HTTP 403', () => response('Forbidden', 403)],
  ['HTTP 503', () => response('Unavailable', 503)],
  ['HTTP 200 challenge', () => response('<title>Just a moment...</title>')],
  [
    'challenge header',
    () => response('Check', 200, { 'cf-mitigated': 'challenge' }),
  ],
]) {
  test(`${label} is an error, not an empty search or blank chapter`, async () => {
    const plugin = loadPlugin(async () => makeResponse());
    for (const action of [
      () => plugin.searchNovels('magic', 1),
      () => plugin.popularNovels(1, {}),
      () => plugin.parseNovel('series/123/example/'),
      () => plugin.parseChapter('read/123/chapter/456/'),
    ]) {
      await assert.rejects(action, /Scribble Hub blocked the request/);
    }
  });
}

test('homepage redirects are reported while genuine empty searches remain empty', async () => {
  const plugin = loadPlugin(async () =>
    response('<title>Scribble Hub</title>'),
  );
  await assert.rejects(
    () => plugin.searchNovels('magic', 1),
    /unexpected page/,
  );
  const emptyPlugin = loadPlugin(async () =>
    response('<form id="rankfilter"></form>'),
  );
  assert.equal((await emptyPlugin.searchNovels('no match', 1)).length, 0);
});

test('HTTP errors retain status for the live checker', async () => {
  const plugin = loadPlugin(async () => response('Failed', 500));
  await assert.rejects(
    () => plugin.searchNovels('magic', 1),
    error => {
      assert.equal(error.response.status, 500);
      assert.match(error.message, /HTTP 500/);
      return true;
    },
  );
});
