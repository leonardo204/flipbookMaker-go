import { invoke } from "@tauri-apps/api/core";
import { claudeSession } from "./claudeSession";

export interface MarkdownResult {
  pageName: string;
  outputPath: string;
  success: boolean;
  error?: string;
}

interface ClaudePrintResult {
  success: boolean;
  stdout: string;
  stderr: string;
  exit_code: number | null;
  elapsed_ms: number;
}

/**
 * 외부에서 재사용 가능한 에러 분류 (claudeSession에서도 호출).
 */
export function classifyClaudeErrorPublic(
  result: { stdout: string; stderr: string; exit_code: number | null; elapsed_ms: number },
  context: string = "",
): string {
  return classifyClaudeError(result as ClaudePrintResult, context);
}

/**
 * Claude CLI 실패 결과를 사용자 친화적 한국어 메시지로 분류.
 *
 * Claude Code CLI는 API 호출이 거부돼도 stdout에 JSON 응답을 남기고 exit 1로 끝나는 경우가 많음.
 * stderr는 비어있을 수 있으니 stdout JSON을 우선 파싱해서 의미 있는 사유를 추출한다.
 *
 * 주요 패턴:
 * - tokens=0 + iterations=[] + modelUsage={} → API 호출 자체가 안 됨 (rate limit / 인증 / quota)
 * - terminal_reason: "image_error" → 이미지 합산 크기 한도 초과
 * - terminal_reason: "context_window_exceeded" → 입력이 컨텍스트 한도 초과
 * - terminal_reason: "max_tokens" → 출력 길이 한도 초과
 * - terminal_reason: "permission_denied" → 권한 문제
 */
function classifyClaudeError(result: ClaudePrintResult, pageName: string): string {
  const elapsed = result.elapsed_ms;
  const stdout = result.stdout || "";
  const stderr = result.stderr || "";

  // stdout 끝의 JSON 객체 추출 시도
  let parsed: Record<string, any> | null = null;
  try {
    const trimmed = stdout.trim();
    const lastNewline = trimmed.lastIndexOf("\n");
    const lastLine = lastNewline >= 0 ? trimmed.slice(lastNewline + 1) : trimmed;
    parsed = JSON.parse(lastLine);
  } catch {
    // 그냥 stdout 전체 파싱 시도
    try {
      parsed = JSON.parse(stdout.trim());
    } catch {
      parsed = null;
    }
  }

  if (parsed) {
    const terminalReason = parsed.terminal_reason as string | undefined;
    const usage = parsed.usage as Record<string, number> | undefined;
    const iterations = parsed.iterations as unknown[] | undefined;
    const modelUsage = parsed.modelUsage as Record<string, unknown> | undefined;
    const errField = (parsed.error as string | undefined) || (parsed.message as string | undefined);

    // 1. API 호출 자체가 거부된 경우 — input/output tokens 모두 0 + iterations 0 + modelUsage 비어있음
    const tokensZero =
      usage &&
      (usage.input_tokens ?? 0) === 0 &&
      (usage.output_tokens ?? 0) === 0;
    const noWork =
      (!iterations || iterations.length === 0) &&
      (!modelUsage || Object.keys(modelUsage).length === 0);

    if (tokensZero && noWork) {
      const elapsedSec = (elapsed / 1000).toFixed(1);
      return (
        `Anthropic API 호출 거부 — 토큰 0건, 실제 분석 0회 (${elapsedSec}초 만에 종료).\n` +
        `가능한 원인:\n` +
        `  • 조직 단위 rate limit 또는 분당 요청 한도 초과 (잠시 후 재시도 필요)\n` +
        `  • 입력 토큰 한도 초과 (이번 prompt: ${formatBytes(stdout.length + parsed?.uuid?.length || 0)} ≈ ${pageName} 메타+이미지 합산)\n` +
        `  • Claude API 인증 만료 (claude login 재시도)\n` +
        `  • 결제/크레딧 문제\n` +
        `해결: 1-2분 대기 후 [재시도] 또는 다른 섹션부터 처리`
      );
    }

    // 2. terminal_reason 기반 분류
    if (terminalReason === "image_error") {
      return (
        `이미지 처리 실패 — Anthropic API가 이미지를 처리할 수 없음.\n` +
        `가능한 원인: 이미지 합산 크기 한도(~20MB) 초과, 손상된 PNG, 지원되지 않는 포맷.\n` +
        `해결: settings에서 scale 더 낮추거나, 큰 섹션은 frame 일부만 선택해 변환`
      );
    }
    if (terminalReason === "context_window_exceeded" || terminalReason === "input_too_long") {
      return (
        `컨텍스트 한도 초과 — 입력이 너무 큼.\n` +
        `prompt 크기: ${formatBytes(stdout.length)}, 이미지 다수 포함 시 위험.\n` +
        `해결: 섹션을 더 작게 나누거나, 이미지 일부 제외 후 [재시도]`
      );
    }
    if (terminalReason === "max_tokens") {
      return (
        `출력 길이 한도 초과 — Claude가 응답 도중 잘림.\n` +
        `해결: 섹션이 너무 큼. 더 작은 단위로 나눠서 변환`
      );
    }
    if (terminalReason === "permission_denied") {
      return (
        `권한 거부 — Claude가 도구(Read/Write/Bash) 사용 권한 없음.\n` +
        `해결: --dangerously-skip-permissions 플래그 확인, claude 재로그인`
      );
    }
    if (errField) {
      return `Claude 에러: ${errField} (terminal_reason=${terminalReason ?? "unknown"})`;
    }

    if (terminalReason && terminalReason !== "completed") {
      return `Claude 비정상 종료 — terminal_reason: ${terminalReason}`;
    }
  }

  // 3. JSON 파싱 실패 시 stderr/stdout 끝부분으로 fallback
  if (stderr.trim()) {
    return `Claude stderr: ${stderr.trim().slice(0, 500)}`;
  }
  if (stdout.trim()) {
    return `Claude 비정상 종료 (exit ${result.exit_code}, ${(elapsed / 1000).toFixed(1)}초)\n출력 끝부분: ${stdout.trim().slice(-300)}`;
  }
  return `Claude exit ${result.exit_code} — 출력 없음 (${(elapsed / 1000).toFixed(1)}초)`;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / 1024 / 1024).toFixed(2)}MB`;
}

function buildPrompt(
  pageUrl: string,
  pageName: string,
  textContent: string,
  outputPath: string,
  sourceType: string,
  documentName: string,
  imagePaths: string[],
): string {
  const hasDocName = documentName.trim().length > 0;
  const hasImages = imagePaths.length > 0;

  const headerTemplate = hasDocName
    ? `# ${documentName}\n\n> 섹션: ${pageName}\n\n> ⚠️ 이 문서는 원본 플립북의 참조용 변환 문서입니다.\n> 원본: [${pageName}](${pageUrl})`
    : `# ${pageName}\n\n> ⚠️ 이 문서는 원본 플립북의 참조용 변환 문서입니다.\n> 원본: [${pageName}](${pageUrl})`;

  const imageInstructions = hasImages
    ? `## 이미지 입력 (필수 — 시각 정보의 1차 소스)

다음 PNG 파일들이 이 섹션의 각 프레임을 **시각 배치 순서(상→하, 좌→우)** 로 렌더링한 결과입니다.

${imagePaths.map((p, i) => `${i + 1}. ${p}`).join("\n")}

**필수 작업 순서**:
1. **먼저 \`Read\` 도구로 모든 이미지를 한 장씩 다 읽으세요.** 한 장도 빼먹지 말 것. (${imagePaths.length}장)
2. 각 이미지의 핵심 내용(기능/플로우/UI 화면/정책/표 등)을 머릿속으로 분류하면서 읽기.
3. 모든 이미지를 다 읽은 뒤, **전체 맥락**을 한 줄로 요약: "이 섹션은 X 도메인을 다루며, 하위 그룹은 A/B/C/...".
4. **그 다음에야** 마크다운 작성 시작.

이미지에서 읽은 내용 활용 가이드:
- 화면에 보이는 라벨/버튼/카드 텍스트 → 마크다운에 그대로 옮김
- 시각적 레이아웃 (상/하/좌/우 배치, 그리드, 카드 그룹핑) → 텍스트 또는 Mermaid로 표현
- 색상/이미지/아이콘 자체는 묘사 금지 (라벨이나 상태를 의미하면 그 의미만 적기)
`
    : "";

  return `Figma 플립북 섹션을 구조화된 Markdown 스펙 문서로 변환하세요.

${hasDocName ? `원본 문서: ${documentName}\n` : ""}섹션: ${pageName}
원본 URL: ${pageUrl}
소스 타입: ${sourceType}
${hasImages ? `프레임 이미지: ${imagePaths.length}개 (아래 경로 참조)` : "프레임 이미지: 없음 (메타데이터만)"}

${imageInstructions}
## 메타데이터 (Figma 노드 트리)

\`characters\`(TEXT), \`bbox\`(위치/크기), \`type\`, \`name\`, \`children\` 필드 포함. 이미지를 읽은 후 이 메타로 노드 ID와 매칭하세요.

\`\`\`json
${textContent}
\`\`\`

## 절대 원칙 (위반 시 변환 실패로 간주)

1. **추론 금지**: 이미지에 보이거나 메타에 명시된 것만 출력. 인터랙션/플로우/상태/사용자 시나리오를 추측해서 만들지 마세요.
2. **이모지 금지**: 본문에 이모지(👤🤖📱✅❌ 등)를 절대 넣지 마세요.
3. **메타 누설 금지**: \`visible=false\`, raw 노드 ID(\`7566:22102\` 패턴), 내부 frame 번호(\`1171277309\` 같은 9자리 숫자)는 본문에 노출하지 마세요. 필요하면 각주에만.
4. **창작 다이어그램 금지**: \`sequenceDiagram\`, \`stateDiagram-v2\`, \`flowchart\`는 **이미지나 메타에 명시적 흐름/상태/시퀀스 화살표가 있을 때만** 작성. 의미상 그럴듯해서가 아니라 실제 그렇게 그려져 있을 때만.
5. **출처 인용 강제**: 모든 본문 문장은 (a) 직접 인용 \`>\`, (b) 메타 \`characters\` 값 옮기기, (c) 이미지에서 명백히 보이는 라벨 셋 중 하나여야 함. "지원합니다", "유도합니다", "구성됩니다" 같은 해설형 추론 문장 금지.
6. **한국어 출력 (필수)**: 출력 마크다운의 본문은 모두 **한국어**로 작성하세요.
   - **소제목/설명/표 헤더/주석**: 영문이라도 한국어로 번역해서 작성 (예: "Daily Chat Policy" → "Daily Chat 정책"; "Utterance Examples" → "발화 예시").
   - **원문 인용 블록(\`>\`)**: 영문 원문은 그대로 보존(번역하지 않음). 단, 인용 블록 바로 아래에 \`*(번역)* ...\` 형식으로 한국어 번역을 짧게 부기.
   - **표 본문 셀**: 화면에 표시되는 텍스트(라벨/카피/UI 문구)는 영문 원문 + 줄바꿈 + 한국어 번역 병기 (예: \`What time is it now?<br/>지금 몇 시야?\`). 영문이 짧고 의미가 명백한 표(예: STT/TTS 같은 약어, 날짜)는 번역 생략 가능.
   - **고유명사/제품명**: "Daily Chat", "Media QA" 같은 기능명은 한국어로 무리하게 번역하지 말고 영문 그대로 사용.
   - **명령어/코드/JSON 키**: 절대 번역하지 말 것 (\`status\`, \`onClick\` 등).

## Mermaid 작성 규칙 (Confluence 호환 — 위반 시 다이어그램 깨짐)

프로젝트 컨벤션 \`Ref-docs/claude/conventions.md\`의 Mermaid 섹션을 그대로 적용합니다:

1. **노드 라벨 \`["..."]\` 안에 마크다운 문법 금지**: \`#\`, \`**\`, \`\\\`\` 같은 기호를 라벨 텍스트로 넣지 말 것 — 파서가 노드를 깨뜨림.
2. **줄바꿈은 \`\\n\` 대신 \`<br>\`** — Mermaid는 \`\\n\`을 줄바꿈으로 인식하지 않음.
3. **노드 라벨 안에 소괄호 \`(\` \`)\` 절대 금지** — Mermaid가 노드 모양 정의 문법으로 오해석함. 보조 설명은 em-dash(\`—\`) 또는 쉼표로 대체.
4. **리스트 넘버링은 숫자(\`1.\`) 대신 문자(\`A.\`)** — Mermaid 파서가 숫자 리스트를 마크다운 ordered-list로 오해석.
5. **노드 ID에는 ASCII만** — 한국어/공백/특수문자는 라벨에만, 노드 식별자는 \`F1\`, \`Header\`, \`StateA\` 같은 영문/숫자.

\`\`\`
%% 잘못된 예 (모두 깨짐)
A["# 제목\\n설명"]
B["Action Engine (자동 조치)"]
C["1. 데이터 풀링"]

%% 올바른 예
A["제목<br>설명"]
B["Action Engine — 자동 조치"]
C["A. 데이터 풀링"]
\`\`\`

## 출력 구조 (의미 그룹 단위로 재구성 — 프레임 1대1 매핑 금지)

**핵심 원칙**: 프레임이 36개라도 본문 H2 섹션은 **6~8개의 기능/주제 그룹**으로 통합하세요. 같은 하위 카테고리/기능에 속한 프레임들은 하나의 H2 안으로 묶어 자연스러운 흐름으로 서술합니다. **개별 프레임을 H2로 만드는 1대1 매핑은 절대 금지**합니다.

그룹핑 단서:
- 프레임명 prefix 패턴 (예: \`02_1_Youtube_*\`, \`02_2_Spotify_*\`) → 같은 prefix는 한 그룹
- (Cover) 표시된 프레임 → 그 그룹의 시작점 (자기 그룹의 도입/요약 슬라이드 역할)
- 화면 안에 표시된 카테고리 헤더/브레드크럼 (예: \`02. Media > YouTube\`)
- 같은 정책 → 여러 플로우 → 변형 케이스 패턴은 한 그룹으로

각 그룹 H2 안은 다음 sub-section을 자연스러운 순서로 (필요한 것만 — 입력에 있는 것만):
- **개요**: 이 그룹이 무엇을 다루는지 1-2줄
- **정책 / 규칙**: 정책 페이지에서 추출한 텍스트 (원문 인용 \`>\` + \`*(번역)*\` 한국어 부기)
- **사용자 흐름**: 여러 플로우 페이지를 종합한 **단일 통합 다이어그램** 1개 (\`stateDiagram-v2\` 또는 \`flowchart TD\`). 각 플로우 페이지마다 따로 만들지 말고 하나로 합치세요.
- **발화 예시 / 표 데이터**: 이미지에 보이는 표 그대로 옮김
- **변형 / 예외 / 에러 케이스**: 변형 화면이 있으면 묶어서

\`\`\`markdown
${headerTemplate}

## 개요

(3-5줄. 전체 섹션의 큰 그림 — 어떤 도메인이고 하위 그룹은 무엇이며 사용자가 보게 될 시나리오의 큰 흐름.)

| 그룹 | 역할 | 프레임 수 |
|------|------|-----------|
| YouTube | 비디오 재생 발화 + 검색 플로우 | 3 |
| Spotify | 음악 재생 발화 + 외부 앱 진입 | 3 |
| ... |

---

## 1. {그룹 1 이름 — 영문 고유명사는 그대로}

### 개요
...

### 정책 / 규칙
> (영문 원문 인용)
>
*(번역)* ...

### 사용자 흐름
\\\`\\\`\\\`mermaid
stateDiagram-v2
    [*] --> Standby
    Standby --> Listening: 발화 시작
\\\`\\\`\\\`

(주의: 위 Mermaid 작성 규칙 5개 항목 준수 — 괄호 금지, \`<br>\` 사용, 숫자 리스트 금지 등)

### 발화 예시
| Main Utterance | 한국어 부기 |
|----------------|-------------|

### 변형 / 예외
...

---

## 2. {그룹 2}
...

---

## 부록 — 화면 인덱스

| 프레임 이름 | 그룹 | 역할 |
|-------------|------|------|
| 02_1_Youtube_1 | YouTube | 정책 페이지 |
| 02_1_Youtube_2 | YouTube | 사용자 플로우 |
| ... | (전체 N개 모두) | ... |

(이 표만이 frame 단위로 1대1 매핑됨 — 본문 H2는 의미 그룹 단위라는 점 재확인)
\`\`\`

## 작성 시 점검 (출력 직전 — 위반 시 수정 후 재출력)

- [ ] H2 섹션 수가 프레임 수와 같지 않은가? (같으면 그룹핑 실패 — 반드시 다시 묶기)
- [ ] 같은 기능/카테고리의 프레임들이 한 H2 안에 통합됐는가?
- [ ] 사용자 흐름 다이어그램이 그룹별로 1개씩만 있는가? (프레임마다 만들지 않음)
- [ ] 부록 화면 인덱스 표에 모든 프레임이 들어있는가?
- [ ] H2 제목에 \`(Cover)\`, \`_1\`, \`_2\` 같은 프레임 후미가 들어가지 않았는가? (들어가면 그룹화 실패 신호)

## 빈약 섹션 처리

만약 이 섹션이 단일 이미지(텍스트 0개 + RECTANGLE 1-2개)뿐이라면 위 템플릿 대신 다음만 출력:

\`\`\`markdown
${headerTemplate}

## 개요

이 섹션은 단일 이미지 컴포넌트로 구성되어 있어 추출 가능한 텍스트나 구조 정보가 없습니다. 자세한 시각 자료는 원본 Figma에서 확인하세요.

## 노드 구조

| Type | Name |
|------|------|
| (메타에 있는 노드만 한 줄씩) |
\`\`\`

이 경우 시퀀스/상태/플로우/사용자 플로우 다이어그램 추가 금지.

## 저장

결과를 **${outputPath}** 에 저장하세요.`;
}

/**
 * 이미지 수에 비례한 동적 timeout 계산 (밀리초).
 * 기본 5분 + 이미지당 20초 추가. 메타만 있는 경우 5분.
 * 32 images → 5분 + 640초 ≈ 약 16분.
 * 36 images → 5분 + 720초 ≈ 약 17분.
 */
function calculateTimeout(imageCount: number): number {
  const baseMs = 300_000;
  const perImageMs = 20_000;
  return baseMs + imageCount * perImageMs;
}

export async function generateMarkdown(
  claudePath: string,
  pageUrl: string,
  pageSlug: string,
  pageName: string,
  textContent: string,
  outputDir: string,
  sourceType: string,
  documentName: string = "",
  imagePaths: string[] = [],
): Promise<MarkdownResult> {
  const outputPath = `${outputDir}/${pageSlug}.md`;
  const timeoutMs = calculateTimeout(imagePaths.length);

  const sessionConnected = claudeSession.isConnected();
  console.log(
    `[claudeService] session=${sessionConnected ? "connected" : claudeSession.getStatus()}, ` +
    `page=${pageName}, doc="${documentName}", images=${imagePaths.length}, timeout=${Math.round(timeoutMs / 1000)}s`,
  );

  if (sessionConnected) {
    const prompt = buildPrompt(
      pageUrl,
      pageName,
      textContent,
      outputPath,
      sourceType,
      documentName,
      imagePaths,
    );
    try {
      const response = await claudeSession.sendPrompt(prompt, timeoutMs);
      console.log(`[claudeService] session response for ${pageName}:`, response.slice(0, 200));
      return { pageName, outputPath, success: true };
    } catch (e) {
      console.error(`[claudeService] session error for ${pageName}:`, e);
      return {
        pageName,
        outputPath: "",
        success: false,
        error: e instanceof Error ? e.message : String(e),
      };
    }
  }

  console.log(`[claudeService] using fallback (Rust claude_print) for ${pageName}`);
  return generateMarkdownFallback(
    claudePath,
    pageUrl,
    pageSlug,
    pageName,
    textContent,
    outputDir,
    sourceType,
    documentName,
    imagePaths,
  );
}

/**
 * Rust 측 claude_print 명령으로 직접 호출 (stdin 기반).
 * argv overflow 회피 — 큰 프롬프트도 안전하게 처리.
 */
async function generateMarkdownFallback(
  claudePath: string,
  pageUrl: string,
  pageSlug: string,
  pageName: string,
  textContent: string,
  outputDir: string,
  sourceType: string,
  documentName: string,
  imagePaths: string[],
): Promise<MarkdownResult> {
  const outputPath = `${outputDir}/${pageSlug}.md`;
  const prompt = buildPrompt(
    pageUrl,
    pageName,
    textContent,
    outputPath,
    sourceType,
    documentName,
    imagePaths,
  );

  const timeoutSecs = Math.ceil(calculateTimeout(imagePaths.length) / 1000);
  console.log(
    `[claudeService] fallback prompt size: ${prompt.length} bytes, timeout=${timeoutSecs}s for ${pageName}`,
  );

  try {
    const result = await invoke<ClaudePrintResult>("claude_print", {
      request: {
        prompt,
        claude_path: claudePath || null,
        timeout_secs: timeoutSecs,
      },
    });

    if (result.success) {
      console.log(
        `[claudeService] fallback success for ${pageName} (${result.elapsed_ms}ms, exit ${result.exit_code})`,
      );
      return { pageName, outputPath, success: true };
    }

    // 실패 시 stdout/stderr 둘 다 풀 로깅 (진단용)
    console.error(
      `[claudeService] fallback FAILED for ${pageName} (${result.elapsed_ms}ms, exit ${result.exit_code})`,
    );
    console.error(`[claudeService] stderr (${result.stderr.length} bytes):`, result.stderr || "(empty)");
    console.error(`[claudeService] stdout tail:`, result.stdout.slice(-500) || "(empty)");

    const detailMsg = classifyClaudeError(result, pageName);

    return {
      pageName,
      outputPath: "",
      success: false,
      error: detailMsg,
    };
  } catch (e) {
    return {
      pageName,
      outputPath: "",
      success: false,
      error: `claude_print 호출 실패 (Tauri/Rust 단계): ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}
