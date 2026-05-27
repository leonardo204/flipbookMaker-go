/**
 * workspace.ts 단위 테스트
 *
 * 테스트 대상: slugifyForPath, deriveWorkspaceSlug (순수 함수)
 * fs 의존 함수(getWorkspaceDir, ensureWorkspaceDir 등)는 이 파일 하단의
 * Manual Test Checklist 참고.
 *
 * 실행: npx vitest run src/services/workspace.test.ts
 */

import { describe, it, expect } from 'vitest';
import { slugifyForPath, deriveWorkspaceSlug } from './workspace';

// ---------------------------------------------------------------------------
// slugifyForPath
// ---------------------------------------------------------------------------

describe('slugifyForPath', () => {
  it('영문 공백을 하이픈으로 변환하고 소문자로 정규화한다', () => {
    expect(slugifyForPath('Viettel Media AI Service')).toBe(
      'viettel-media-ai-service',
    );
  });

  it('한글을 보존하고 공백을 하이픈으로 변환한다', () => {
    expect(slugifyForPath('한글 폴더 이름')).toBe('한글-폴더-이름');
  });

  it('허용되지 않는 특수문자를 제거한다', () => {
    expect(slugifyForPath('abc!@#$%^&*()xyz')).toBe('abcxyz');
  });

  it('빈 문자열 입력 시 "workspace" 를 반환한다', () => {
    expect(slugifyForPath('')).toBe('workspace');
  });

  it('공백만 있는 문자열을 "workspace" 로 폴백한다', () => {
    expect(slugifyForPath('   ')).toBe('workspace');
  });

  it('연속 공백을 단일 하이픈으로 collapse 한다', () => {
    expect(slugifyForPath('a  b  c')).toBe('a-b-c');
  });

  it('연속 하이픈을 단일 하이픈으로 collapse 한다', () => {
    expect(slugifyForPath('a--b--c')).toBe('a-b-c');
  });

  it('끝의 trailing dash 를 제거한다', () => {
    expect(slugifyForPath('hello-')).toBe('hello');
  });

  it('앞의 leading dash 를 제거한다', () => {
    expect(slugifyForPath('-hello')).toBe('hello');
  });

  it('언더스코어를 하이픈으로 변환한다', () => {
    expect(slugifyForPath('my_project_name')).toBe('my-project-name');
  });

  it('언더스코어로 시작하는 문자열에 "w-" prefix 를 붙인다', () => {
    const result = slugifyForPath('_privateFolder');
    expect(result).toMatch(/^w-/);
  });

  it('꺽쇠(< >)를 하이픈으로 변환한다', () => {
    expect(slugifyForPath('a<b>c')).toBe('a-b-c');
  });

  it('결과는 항상 소문자이다', () => {
    expect(slugifyForPath('ABC DEF')).toBe('abc-def');
  });
});

// ---------------------------------------------------------------------------
// deriveWorkspaceSlug
// ---------------------------------------------------------------------------

describe('deriveWorkspaceSlug', () => {
  const FIGMA_URL =
    'https://www.figma.com/design/8S2BLI1LvDzWW48ZfDM1OG/Viettel-Media-AI-Service';
  const FILE_KEY = '8S2BLI1LvDzWW48ZfDM1OG';

  it('Figma — documentName + fileKey 앞 6자로 슬러그를 생성한다', () => {
    const slug = deriveWorkspaceSlug({
      sourceType: 'figma',
      url: FIGMA_URL,
      documentName: 'Viettel Media AI Service',
      fileKey: FILE_KEY,
    });
    expect(slug).toBe('viettel-media-ai-service-8s2bli');
  });

  it('Figma — fileKey 는 소문자 6자를 사용한다', () => {
    const slug = deriveWorkspaceSlug({
      sourceType: 'figma',
      url: FIGMA_URL,
      documentName: 'My Design',
      fileKey: 'ABCDEF123456',
    });
    expect(slug).toMatch(/-abcdef$/);
  });

  it('Figma — documentName 누락 시 host + fileKey 앞 8자를 사용한다', () => {
    const slug = deriveWorkspaceSlug({
      sourceType: 'figma',
      url: 'https://www.figma.com/design/8S2BLI1LvDzWW48ZfDM1OG/X',
      fileKey: FILE_KEY,
    });
    // host 슬러그 포함 + fileKey 8자 suffix
    expect(slug).toContain('figma-com');
    expect(slug).toEndWith('-8s2bli1l');
  });

  it('Axshare — host + 마지막 path segment 로 슬러그를 생성한다', () => {
    const slug = deriveWorkspaceSlug({
      sourceType: 'axshare',
      url: 'https://abc123.axshare.com/projectname/',
    });
    // 예: "abc123-axshare-com-projectname"
    expect(slug).toContain('abc123');
    expect(slug).toContain('axshare');
    expect(slug).toContain('projectname');
  });

  it('Axshare — path segment 가 없으면 "root" 를 사용한다', () => {
    const slug = deriveWorkspaceSlug({
      sourceType: 'axshare',
      url: 'https://abc123.axshare.com/',
    });
    expect(slug).toMatch(/root$/);
  });

  it('같은 입력은 항상 같은 출력을 반환한다 (idempotent)', () => {
    const input = {
      sourceType: 'figma' as const,
      url: FIGMA_URL,
      documentName: 'Stable Doc',
      fileKey: FILE_KEY,
    };
    expect(deriveWorkspaceSlug(input)).toBe(deriveWorkspaceSlug(input));
  });

  it('슬러그에 허용되지 않는 문자가 포함되지 않는다', () => {
    const slug = deriveWorkspaceSlug({
      sourceType: 'figma',
      url: FIGMA_URL,
      documentName: 'Doc with !@# special chars',
      fileKey: FILE_KEY,
    });
    // 영숫자, 한글, 하이픈만 허용
    expect(slug).toMatch(/^[\wㄱ-힝-]+$/);
  });
});
