// 진단 출력 (stderr) — 사용자가 release .app에서 spawn fail 시 환경 추적용
process.stderr.write(`[crawl.mjs] node=${process.version} cwd=${process.cwd()}\n`);
process.stderr.write(`[crawl.mjs] PLAYWRIGHT_MODULE_PATH=${process.env.PLAYWRIGHT_MODULE_PATH || '(unset)'}\n`);
process.stderr.write(`[crawl.mjs] NODE_PATH=${process.env.NODE_PATH || '(unset)'}\n`);

// Playwright는 글로벌 또는 환경변수 PLAYWRIGHT_MODULE_PATH 경로에서 dynamic import.
// release .app은 자체 node_modules 없음 → 사용자 환경(글로벌 npm install)에 의존.
// ESM에서 디렉토리 import는 unsupported → index.mjs (또는 index.js) 명시 필요.
const baseSpec = process.env.PLAYWRIGHT_MODULE_PATH;
const playwrightSpec = baseSpec ? `${baseSpec}/index.mjs` : 'playwright';
process.stderr.write(`[crawl.mjs] importing playwright from: ${playwrightSpec}\n`);

let chromium;
try {
  ({ chromium } = await import(playwrightSpec));
  process.stderr.write(`[crawl.mjs] playwright import OK\n`);
} catch (e) {
  process.stderr.write(`[crawl.mjs] playwright import FAILED: ${e.message}\n`);
  if (e.code) process.stderr.write(`[crawl.mjs] error code: ${e.code}\n`);
  if (e.stack) process.stderr.write(`[crawl.mjs] stack:\n${e.stack}\n`);
  process.exit(1);
}
import fs from 'fs/promises';
import path from 'path';

// slug 생성 — lib/slug.mjs / 프론트엔드 slugify와 동일 알고리즘.
// crawl.mjs는 릴리즈 .app에서 단독 embed되므로(lib 미동봉 가능) 외부 의존 없이 인라인한다.
// ConvertPage(Axshare 분기)가 `${outputDir}/${slugify(pageName)}.txt`를 읽으므로 반드시 일치해야 한다.
function slugify(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[>_\s]+/g, '-')
    .replace(/[^\w가-힣\-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

// CLI 인자 파싱 (외부 라이브러리 없이 process.argv 직접 파싱)
function parseArgs(argv) {
  const args = argv.slice(2);
  const result = { url: null, output: './raw', help: false };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--url' && args[i + 1]) {
      result.url = args[++i];
    } else if (args[i] === '--output' && args[i + 1]) {
      result.output = args[++i];
    } else if (args[i] === '--help' || args[i] === '-h') {
      result.help = true;
    }
  }
  return result;
}

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

const opts = parseArgs(process.argv);

if (opts.help) {
  process.stderr.write('Usage: node crawl.mjs --url <axshareUrl> [--output <dir>]\n');
  process.stderr.write('  --url <axshareUrl>   (required) Axure Share URL\n');
  process.stderr.write('  --output <dir>       Output directory (default: ./raw)\n');
  process.exit(0);
}

if (!opts.url) {
  process.stderr.write('Error: --url is required\n');
  process.stderr.write('Usage: node crawl.mjs --url <axshareUrl> [--output <dir>]\n');
  process.exit(1);
}

const BASE_URL = opts.url;
const OUTPUT_DIR = opts.output;
const OUTPUT = path.join(OUTPUT_DIR, 'sitemap.json');

async function main() {
  emit({ event: 'start', type: 'crawl' });

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();

  process.stderr.write(`Navigating to ${BASE_URL}...\n`);
  await page.goto(BASE_URL, { waitUntil: 'networkidle' });

  process.stderr.write('Waiting for $axure.document.sitemap...\n');
  await page.waitForFunction(() => window.$axure?.document?.sitemap, { timeout: 30000 });

  const axureFields = await page.evaluate(() => {
    const doc = window.$axure?.document;
    if (!doc) return null;
    return {
      topLevelKeys: Object.keys(doc),
      sitemapKeys: doc.sitemap ? Object.keys(doc.sitemap) : [],
      rootNodesType: doc.sitemap?.rootNodes ? typeof doc.sitemap.rootNodes : 'undefined',
      rootNodesLength: doc.sitemap?.rootNodes?.length ?? 0,
      firstNodeKeys: doc.sitemap?.rootNodes?.[0] ? Object.keys(doc.sitemap.rootNodes[0]) : [],
    };
  });
  process.stderr.write('$axure.document fields: ' + JSON.stringify(axureFields, null, 2) + '\n');

  const sitemap = await page.evaluate(() => {
    function serialize(node) {
      return {
        id: node.id,
        pageName: node.pageName,
        type: node.type,
        url: node.url,
        children: (node.children || []).map(serialize),
      };
    }
    return window.$axure.document.sitemap.rootNodes.map(serialize);
  });

  function countNodes(nodes) {
    return nodes.reduce((acc, n) => acc + 1 + countNodes(n.children || []), 0);
  }

  const total = countNodes(sitemap);

  await fs.mkdir(path.dirname(OUTPUT), { recursive: true });
  await fs.writeFile(OUTPUT, JSON.stringify(sitemap, null, 2));

  process.stderr.write(`Sitemap saved to ${OUTPUT}\n`);
  process.stderr.write(`Total nodes: ${total}\n`);

  // ── 섹션별 텍스트 추출 ────────────────────────────────────────────
  // 각 Wireframe 페이지(`<page>.html`)를 직접 열어 본문 innerText를 뽑아
  // `${OUTPUT_DIR}/${slug}.txt`로 저장한다. ConvertPage의 Axshare 분기가 이 파일을
  // 읽어 Claude에 전달한다. 이 단계가 없으면 변환 결과물이 비어버린다.
  function flattenWireframes(nodes, acc = []) {
    for (const n of nodes) {
      if (n.url) acc.push({ pageName: n.pageName, url: n.url });
      if (n.children && n.children.length) flattenWireframes(n.children, acc);
    }
    return acc;
  }

  const origin = new URL(BASE_URL).origin;
  const pages = flattenWireframes(sitemap);
  process.stderr.write(`Extracting text from ${pages.length} wireframe page(s)...\n`);

  let extracted = 0;
  for (let i = 0; i < pages.length; i++) {
    const { pageName, url } = pages[i];
    const slug = slugify(pageName);
    const target = `${origin}/${url}`;
    emit({ event: 'progress', current: i + 1, total: pages.length, page: pageName });

    try {
      await page.goto(target, { waitUntil: 'networkidle', timeout: 45000 });
      // Axure 페이지를 직접 열면 본문이 최상위 문서에 렌더된다. 다만 일부는
      // 하위 프레임(mainFrame)에 담기므로, 프레임 중 innerText가 가장 긴 것을 채택.
      let best = '';
      for (const f of page.frames()) {
        const txt = await f
          .evaluate(() => (document.body ? document.body.innerText : ''))
          .catch(() => '');
        if (txt && txt.length > best.length) best = txt;
      }
      // 과도한 빈 줄 정리 (3줄 이상 → 2줄)
      const cleaned = best.replace(/\n{3,}/g, '\n\n').trim();
      await fs.writeFile(path.join(OUTPUT_DIR, `${slug}.txt`), cleaned);
      extracted++;
      process.stderr.write(`  [${i + 1}/${pages.length}] ${slug}.txt (${cleaned.length} chars)\n`);
    } catch (e) {
      // 한 페이지 실패가 전체 크롤을 막지 않도록 방어. 빈 파일은 남기지 않음
      // (ConvertPage가 "텍스트 파일 없음"으로 인지 → 해당 섹션만 메타 없이 진행).
      process.stderr.write(`  [${i + 1}/${pages.length}] ${slug} FAILED: ${e.message}\n`);
    }
  }
  process.stderr.write(`Text extraction done: ${extracted}/${pages.length} pages\n`);

  await browser.close();

  emit({ event: 'done', type: 'crawl', sitemapPath: OUTPUT });
}

main().catch((err) => { process.stderr.write(String(err) + '\n'); process.exit(1); });
