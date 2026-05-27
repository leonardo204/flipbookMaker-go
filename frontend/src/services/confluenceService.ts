import { invoke } from "@tauri-apps/api/core";

export interface ConfluenceConfig {
  baseUrl: string;
  email: string;
  token: string;
  spaceKey: string;     // 부모 페이지 URL에서 추출한 값
  parentPageId: string; // 필수 — 모든 페이지는 이 부모 아래 생성
}

/**
 * Confluence 부모 페이지 URL 또는 ID에서 spaceKey + pageId 추출.
 * - 순수 숫자: pageId만 (spaceKey 추출 불가 → null)
 * - URL 패턴: `/spaces/{KEY}/pages/{ID}/...` → 둘 다 추출
 * - URL에 /pages/{ID}만 있고 /spaces/가 없는 경우: pageId만, spaceKey null
 */
export function parseConfluenceParentUrl(input: string): {
  spaceKey: string | null;
  pageId: string | null;
} {
  const trimmed = input.trim();
  if (!trimmed) return { spaceKey: null, pageId: null };

  // 순수 숫자 → pageId만
  if (/^\d+$/.test(trimmed)) {
    return { spaceKey: null, pageId: trimmed };
  }

  // /spaces/KEY/pages/ID 패턴 (가장 일반적인 Confluence Cloud URL)
  const m = trimmed.match(/\/spaces\/([^/]+)\/pages\/(\d+)/);
  if (m) {
    return { spaceKey: m[1], pageId: m[2] };
  }

  // /pages/ID 만 있는 경우 (구 URL 형식 등)
  const m2 = trimmed.match(/\/pages\/(\d+)/);
  if (m2) {
    return { spaceKey: null, pageId: m2[1] };
  }

  return { spaceKey: null, pageId: null };
}

export interface UploadResult {
  success: boolean;
  page_id: string | null;
  page_url: string | null;
  message: string;
}

export interface MdFile {
  title: string;
  content: string;
  imagePaths: string[];
}

/**
 * XML/HTML 특수문자 escape (텍스트 컨텍스트용).
 * `<`, `>`, `&`, `"`만 처리 — Confluence Storage는 XHTML 기반이라 미escape 시 파싱 에러.
 */
function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Macro Pack (Warsaw Dynamics) Forge 앱의 mermaid 매크로 키.
 * altimedia.atlassian.net 사이트에서 추출한 값. 다른 사이트에서 사용 시 재추출 필요.
 *
 * 형식: {appId}/{moduleId}/static/macro-pack
 */
const MACROPACK_MERMAID_EXTENSION_KEY =
  "1ef074bf-c90d-4af8-9ea9-32d2e6ae9a90/2256cafd-362d-4b27-a796-139875a465b5/static/macro-pack";

/**
 * 간단한 UUID v4 생성 (crypto.randomUUID 미가용 환경 대비).
 */
function makeUuid(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  // fallback
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/**
 * Mermaid 코드를 Macro Pack의 Forge `ac:adf-extension` 매크로로 감싼다.
 * 결과 매크로는 Confluence에서 렌더링 시 자동으로 mermaid 다이어그램으로 그려진다.
 *
 * 참고: 페이지 컨텍스트(embedded-macro-context, extension-data)는 생략 — 페이지 생성 시
 *       Confluence가 자동으로 채워준다. local-id는 매크로마다 고유해야 충돌 안 남.
 */
function buildMermaidMacro(code: string): string {
  const localId = makeUuid();
  const escapedCode = escapeXml(code);
  return [
    `<ac:adf-extension>`,
    `<ac:adf-node type="extension">`,
    `<ac:adf-attribute key="extension-key">${MACROPACK_MERMAID_EXTENSION_KEY}</ac:adf-attribute>`,
    `<ac:adf-attribute key="extension-type">com.atlassian.ecosystem</ac:adf-attribute>`,
    `<ac:adf-attribute key="parameters">`,
    `<ac:adf-parameter key="layout">extension</ac:adf-parameter>`,
    `<ac:adf-parameter key="guest-params">`,
    `<ac:adf-parameter key="input">mermaid</ac:adf-parameter>`,
    `<ac:adf-parameter key="source">`,
    `<ac:adf-parameter key="text">${escapedCode}</ac:adf-parameter>`,
    `<ac:adf-parameter key="type">text</ac:adf-parameter>`,
    `</ac:adf-parameter>`,
    `<ac:adf-parameter key="version" type="integer">1</ac:adf-parameter>`,
    `</ac:adf-parameter>`,
    `<ac:adf-parameter key="forge-environment">PRODUCTION</ac:adf-parameter>`,
    `</ac:adf-attribute>`,
    `<ac:adf-attribute key="text">Macro Pack</ac:adf-attribute>`,
    `<ac:adf-attribute key="layout">default</ac:adf-attribute>`,
    `<ac:adf-attribute key="local-id">${localId}</ac:adf-attribute>`,
    `</ac:adf-node>`,
    `</ac:adf-extension>`,
  ].join("");
}

/**
 * 인라인 마크다운 → HTML 변환.
 * 순서 중요: 코드(`x`) 먼저 추출 → escape → 굵게/이탤릭 → 링크/이미지.
 */
function renderInline(text: string): string {
  // 0. 사용자가 마크다운에 직접 쓴 <br>, <br/>, <br /> 태그를 placeholder로 보호.
  //    이 단계가 없으면 5번 escape에서 &lt;br/&gt;로 변환되어 화면에 raw text로 노출됨.
  let placeholdered = text.replace(/<br\s*\/?>/gi, " BR_TAG ");

  // 1. 인라인 코드를 placeholder로 분리해 escape 영향에서 보호
  const codeChunks: string[] = [];
  placeholdered = placeholdered.replace(/`([^`]+)`/g, (_, code) => {
    const idx = codeChunks.length;
    codeChunks.push(code);
    return ` CODE${idx} `;
  });

  // 2. 이미지 ![alt](filename) → ac:image (첨부 파일명만 사용)
  let result = placeholdered.replace(
    /!\[([^\]]*)\]\(([^)]+)\)/g,
    (_, _alt, src) => {
      // 경로는 파일명만 추출 (Confluence는 attachment 이름으로 매칭)
      const filename = src.split("/").pop()?.split("?")[0] ?? src;
      return `<ac:image><ri:attachment ri:filename="${escapeXml(filename)}" /></ac:image>`;
    },
  );

  // 3. 일반 링크 [text](url)
  result = result.replace(
    /\[([^\]]+)\]\(([^)]+)\)/g,
    (_, label, href) => `<a href="${escapeXml(href)}">${escapeXml(label)}</a>`,
  );

  // 4. 본문 escape (이미지/링크 변환 결과 안의 < > 보존을 위해 수동으로)
  // 이미지/링크 placeholder를 다시 분리
  const tagChunks: string[] = [];
  result = result.replace(/<(ac:image|a)[^>]*>.*?<\/\1>|<ac:image[^/]*\/>/g, (m) => {
    const idx = tagChunks.length;
    tagChunks.push(m);
    return ` TAG${idx} `;
  });

  // 5. 일반 텍스트 escape
  result = escapeXml(result);

  // 6. 굵게/이탤릭 (escape 이후 적용 — 마크다운 문법은 < > 포함 안 함)
  result = result
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/(?<!\*)\*(?!\s)([^*]+?)\*(?!\*)/g, "<em>$1</em>");

  // 7. 태그 placeholder 복원
  result = result.replace(/ TAG(\d+) /g, (_, n) => tagChunks[Number(n)]);

  // 8. 코드 placeholder를 <code>로 복원
  result = result.replace(
    / CODE(\d+) /g,
    (_, n) => `<code>${escapeXml(codeChunks[Number(n)])}</code>`,
  );

  // 9. BR placeholder를 표준 self-closing <br />로 복원 (Confluence Storage 호환 줄바꿈)
  result = result.replace(/ BR_TAG /g, "<br />");

  return result;
}

/**
 * 테이블 행 라인을 셀 배열로 분해.
 * `| a | b | c |` → ['a', 'b', 'c']
 * 양 끝의 `|`는 trim, 셀 안의 `\|` 이스케이프 처리.
 */
function parseTableRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\||\|$/g, "");
  // 단순 split — 셀 안 escape는 거의 사용 안 되므로 미지원
  return trimmed.split("|").map((c) => c.trim());
}

/**
 * 구분선 행인지 (`|---|---|` 형태) 판별.
 */
function isTableSeparator(line: string): boolean {
  return /^\s*\|?[\s:|-]+\|?\s*$/.test(line) && line.includes("-");
}

/**
 * Markdown을 Confluence Storage Format(XHTML)으로 변환.
 *
 * 지원 요소:
 * - 헤더 (h1-h4)
 * - 단락 (빈 줄 기준)
 * - 굵게/이탤릭/인라인 코드
 * - 코드 블록 (```...```) — language="mermaid" 등 명시
 * - 인용 (> ...)
 * - 순서 없는 리스트 (-, *)
 * - 순서 있는 리스트 (1., 2., ...)
 * - 테이블 (| ... | ... |)
 * - 수평선 (---)
 * - 링크/이미지
 *
 * 미지원: 중첩 리스트, 작업 목록 ([x]), HTML 직접 임베드.
 */
export function mdToConfluenceStorage(md: string): string {
  const lines = md.split("\n");
  const out: string[] = [];
  let i = 0;

  // 단락 누적용
  let paraBuf: string[] = [];
  const flushPara = () => {
    if (paraBuf.length === 0) return;
    const text = paraBuf.join(" ").trim();
    if (text) out.push(`<p>${renderInline(text)}</p>`);
    paraBuf = [];
  };

  while (i < lines.length) {
    const line = lines[i];

    // 1. 빈 줄 → 단락 끊기
    if (line.trim() === "") {
      flushPara();
      i++;
      continue;
    }

    // 2. 코드 블록 (``` 시작 ~ ``` 끝)
    const fenceMatch = line.match(/^```(\w*)\s*$/);
    if (fenceMatch) {
      flushPara();
      const lang = fenceMatch[1] || "";
      i++;
      const codeLines: string[] = [];
      while (i < lines.length && !lines[i].trim().startsWith("```")) {
        codeLines.push(lines[i]);
        i++;
      }
      i++; // 닫는 ``` 건너뜀
      const code = codeLines.join("\n");

      // mermaid 전용 분기: Macro Pack adf-extension 사용 → 자동 다이어그램 렌더링
      if (lang.toLowerCase() === "mermaid") {
        out.push(buildMermaidMacro(code));
        continue;
      }

      // 그 외 언어: Confluence Code 매크로 (syntax highlight)
      const langAttr = lang
        ? `<ac:parameter ac:name="language">${escapeXml(lang)}</ac:parameter>`
        : "";
      out.push(
        `<ac:structured-macro ac:name="code">${langAttr}<ac:plain-text-body><![CDATA[${code}]]></ac:plain-text-body></ac:structured-macro>`,
      );
      continue;
    }

    // 3. 헤더 (#, ##, ###, ####)
    const hMatch = line.match(/^(#{1,4})\s+(.+)$/);
    if (hMatch) {
      flushPara();
      const level = hMatch[1].length;
      out.push(`<h${level}>${renderInline(hMatch[2].trim())}</h${level}>`);
      i++;
      continue;
    }

    // 4. 수평선 (---, ***, ___)
    if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      flushPara();
      out.push("<hr/>");
      i++;
      continue;
    }

    // 5. 인용 (> ...)
    if (/^>\s?/.test(line)) {
      flushPara();
      const quoteLines: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        quoteLines.push(lines[i].replace(/^>\s?/, ""));
        i++;
      }
      const inner = quoteLines.join(" ").trim();
      out.push(`<blockquote><p>${renderInline(inner)}</p></blockquote>`);
      continue;
    }

    // 6. 테이블 (| ... | ... |)
    // 다음 줄이 구분선이어야 진짜 테이블
    if (line.trim().startsWith("|") && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      flushPara();
      const headers = parseTableRow(line);
      i += 2; // 헤더 + 구분선 건너뜀
      const rows: string[][] = [];
      while (i < lines.length && lines[i].trim().startsWith("|")) {
        rows.push(parseTableRow(lines[i]));
        i++;
      }
      const thead = `<thead><tr>${headers
        .map((h) => `<th>${renderInline(h)}</th>`)
        .join("")}</tr></thead>`;
      const tbody = `<tbody>${rows
        .map(
          (r) =>
            `<tr>${r
              .map((c) => `<td>${renderInline(c)}</td>`)
              .join("")}</tr>`,
        )
        .join("")}</tbody>`;
      out.push(`<table>${thead}${tbody}</table>`);
      continue;
    }

    // 7. 순서 없는 리스트 (-, *, +)
    if (/^\s*[-*+]\s+/.test(line)) {
      flushPara();
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*+]\s+/, ""));
        i++;
      }
      out.push(
        `<ul>${items.map((it) => `<li>${renderInline(it)}</li>`).join("")}</ul>`,
      );
      continue;
    }

    // 8. 순서 있는 리스트 (1. 2. 3.)
    if (/^\s*\d+\.\s+/.test(line)) {
      flushPara();
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+\.\s+/, ""));
        i++;
      }
      out.push(
        `<ol>${items.map((it) => `<li>${renderInline(it)}</li>`).join("")}</ol>`,
      );
      continue;
    }

    // 9. 일반 텍스트 → 단락 누적
    paraBuf.push(line.trim());
    i++;
  }

  flushPara();
  return out.join("\n");
}

/**
 * 부모 페이지 URL 또는 ID 문자열에서 실제 Confluence page ID를 추출한다.
 * - 순수 숫자: ID로 간주
 * - URL: /pages/{id} 패턴에서 추출
 * - 나머지: null 반환 (space root에 생성)
 */
export async function resolveParentPageId(
  baseUrl: string,
  email: string,
  token: string,
  pageUrlOrTitle: string,
): Promise<string | null> {
  return invoke<string | null>("resolve_parent_page_id", {
    baseUrl,
    email,
    token,
    pageUrlOrTitle,
  });
}

export interface UploadStopSignal {
  /** 호출자가 true로 설정하면 다음 페이지부터 처리 안 함 (현재 진행 중인 페이지는 끝까지) */
  stopped: boolean;
}

/**
 * stopSignal 즉시 반응을 위한 polling sleep.
 * 100ms 단위로 stopped 체크 → 사용자 [중단] 클릭 시 최대 100ms 안에 빠져나옴.
 */
async function abortableSleep(totalMs: number, stopSignal?: UploadStopSignal): Promise<void> {
  const step = 100;
  let elapsed = 0;
  while (elapsed < totalMs) {
    if (stopSignal?.stopped) return;
    const wait = Math.min(step, totalMs - elapsed);
    await new Promise<void>((r) => setTimeout(r, wait));
    elapsed += wait;
  }
}

/**
 * Confluence에 Markdown 파일 목록을 순차 업로드한다.
 *
 * @param config     Confluence 접속 설정
 * @param files      업로드할 파일 목록
 * @param onProgress 진행 콜백 (current, total, 현재 제목, 결과?)
 * @param delayMs    페이지 간 Rate-limit 방어 대기 시간 (기본 4000ms)
 * @param stopSignal 외부에서 중단 신호를 전달하는 객체 — stopped=true가 되면 다음 페이지 진행 안 함
 * @param skipTitles 이미 업로드 완료된 제목 집합 — 재시작 시 건너뛰기용
 */
export async function uploadToConfluence(
  config: ConfluenceConfig,
  files: MdFile[],
  onProgress: (
    current: number,
    total: number,
    title: string,
    result?: UploadResult,
  ) => void,
  delayMs = 4000,
  stopSignal?: UploadStopSignal,
  skipTitles?: Set<string>,
): Promise<UploadResult[]> {
  const results: UploadResult[] = [];

  for (let i = 0; i < files.length; i++) {
    if (stopSignal?.stopped) {
      console.log("[uploadToConfluence] 중단 신호 감지 — 진행 중단");
      break;
    }

    const file = files[i];

    if (skipTitles?.has(file.title)) {
      console.log(`[uploadToConfluence] 스킵: "${file.title}" (이미 완료)`);
      onProgress(i + 1, files.length, file.title, {
        success: true,
        page_id: null,
        page_url: null,
        message: "이미 업로드 완료 — 스킵",
      });
      continue;
    }

    onProgress(i, files.length, file.title);

    const content = mdToConfluenceStorage(file.content);

    let attempt = 0;
    let result: UploadResult | null = null;
    const errorTrail: string[] = [];

    while (attempt < 3) {
      if (stopSignal?.stopped) break;
      attempt++;

      try {
        result = await invoke<UploadResult>("confluence_upload_page", {
          request: {
            base_url: config.baseUrl,
            email: config.email,
            token: config.token,
            space_key: config.spaceKey,
            parent_page_id: config.parentPageId ?? null,
            title: file.title,
            content,
            image_paths: file.imagePaths,
          },
        });

        if (result.success) break;

        // success=false인 응답은 message에 사유 포함됨
        errorTrail.push(`시도 ${attempt}: ${result.message}`);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        errorTrail.push(`시도 ${attempt}: ${msg}`);
        result = {
          success: false,
          page_id: null,
          page_url: null,
          message: msg,
        };
      }

      // 재시도 전 대기 (마지막 시도면 생략) — abortable
      if (attempt < 3 && !stopSignal?.stopped) {
        await abortableSleep(delayMs * 2, stopSignal);
      }
    }

    // 실패 결과의 message에는 모든 시도 trail 포함
    if (result && !result.success && errorTrail.length > 0) {
      result = {
        ...result,
        message: errorTrail.join("\n---\n"),
      };
    }

    results.push(result!);
    onProgress(i + 1, files.length, file.title, result!);

    // 페이지 간 대기 (중단 신호 시 즉시 break) — abortable
    if (i < files.length - 1 && !stopSignal?.stopped) {
      await abortableSleep(delayMs, stopSignal);
    }
  }

  return results;
}
