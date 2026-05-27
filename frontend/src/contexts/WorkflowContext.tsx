import { createContext, useContext, useState, useCallback, useMemo, type ReactNode } from "react";

export interface SitemapNode {
  id: string;
  pageName: string;
  type: string;
  url: string;
  isEmpty?: boolean; // 변환할 콘텐츠가 거의 없는 섹션 (단일 이미지 등). 체크는 유지하되 UI에 표시
  children: SitemapNode[];
}

export type PageStatus = "pending" | "capturing" | "converting" | "done" | "error";
export type SourceType = "axshare" | "figma";
export type WorkflowPhase =
  | "idle"
  | "crawling"
  | "capturing"
  | "converting"
  | "uploading"
  | "done";

export interface PageEntry {
  name: string;
  slug: string;       // 파일명용 slug (예: scenario-architecture)
  sectionDir: string; // 섹션 디렉토리명 (예: 1-scenario-architecture). 최상위 페이지는 빈 문자열
  path: string;
  status: PageStatus;
  substatus?: string; // 변환 중 세부 단계 표시 (예: "이미지 다운로드 5/32")
  selected: boolean;  // 일괄 변환 대상 여부 (AnalyzePage 체크박스 기준)
}

export interface WorkflowState {
  url: string;
  outputDir: string;
  sourceType: SourceType;
  documentName: string; // 원본 문서명 (Figma 파일명 등) — 각 마크다운 상단에 표기
  sitemap: SitemapNode[];
  totalPages: number;
  pages: PageEntry[];
  currentPhase: WorkflowPhase;
  error: string | null;
  // workspace 정보
  workspaceDir: string;
  workspaceSlug: string;
  fileKey: string;
}

interface WorkflowContextValue {
  workflow: WorkflowState;
  setUrl: (url: string) => void;
  setOutputDir: (dir: string) => void;
  setSourceType: (sourceType: SourceType) => void;
  setDocumentName: (name: string) => void;
  setSitemap: (sitemap: SitemapNode[]) => void;
  setPages: (pages: PageEntry[]) => void;
  updatePageStatus: (name: string, status: PageStatus) => void;
  updatePageSubstatus: (name: string, substatus: string | undefined) => void;
  updatePageSelected: (name: string, selected: boolean) => void;
  setAllPagesSelected: (selected: boolean) => void;
  setPhase: (phase: WorkflowPhase) => void;
  setError: (error: string | null) => void;
  reset: () => void;
  // workspace 정보 setter
  setWorkspaceDir: (dir: string) => void;
  setWorkspaceSlug: (slug: string) => void;
  setFileKey: (fileKey: string) => void;
}

const defaultState: WorkflowState = {
  url: "",
  outputDir: "",
  sourceType: "axshare",
  documentName: "",
  sitemap: [],
  totalPages: 0,
  pages: [],
  currentPhase: "idle",
  error: null,
  workspaceDir: "",
  workspaceSlug: "",
  fileKey: "",
};

const WorkflowContext = createContext<WorkflowContextValue>({
  workflow: defaultState,
  setUrl: () => {},
  setOutputDir: () => {},
  setSourceType: () => {},
  setDocumentName: () => {},
  setSitemap: () => {},
  setPages: () => {},
  updatePageStatus: () => {},
  updatePageSubstatus: () => {},
  updatePageSelected: () => {},
  setAllPagesSelected: () => {},
  setPhase: () => {},
  setError: () => {},
  reset: () => {},
  setWorkspaceDir: () => {},
  setWorkspaceSlug: () => {},
  setFileKey: () => {},
});

export function WorkflowProvider({ children }: { children: ReactNode }) {
  const [workflow, setWorkflow] = useState<WorkflowState>(defaultState);

  const setUrl = useCallback((url: string) => {
    setWorkflow((prev) => ({ ...prev, url }));
  }, []);

  const setOutputDir = useCallback((outputDir: string) => {
    setWorkflow((prev) => ({ ...prev, outputDir }));
  }, []);

  const setSourceType = useCallback((sourceType: SourceType) => {
    setWorkflow((prev) => ({ ...prev, sourceType }));
  }, []);

  const setDocumentName = useCallback((documentName: string) => {
    setWorkflow((prev) => ({ ...prev, documentName }));
  }, []);

  const setSitemap = useCallback((sitemap: SitemapNode[]) => {
    setWorkflow((prev) => ({
      ...prev,
      sitemap,
      totalPages: sitemap.length,
    }));
  }, []);

  const setPages = useCallback((pages: PageEntry[]) => {
    setWorkflow((prev) => ({ ...prev, pages, totalPages: pages.length }));
  }, []);

  const updatePageStatus = useCallback((name: string, status: PageStatus) => {
    setWorkflow((prev) => ({
      ...prev,
      pages: prev.pages.map((p) =>
        p.name === name ? { ...p, status, substatus: undefined } : p
      ),
    }));
  }, []);

  const updatePageSubstatus = useCallback((name: string, substatus: string | undefined) => {
    setWorkflow((prev) => ({
      ...prev,
      pages: prev.pages.map((p) =>
        p.name === name ? { ...p, substatus } : p
      ),
    }));
  }, []);

  const updatePageSelected = useCallback((name: string, selected: boolean) => {
    setWorkflow((prev) => ({
      ...prev,
      pages: prev.pages.map((p) =>
        p.name === name ? { ...p, selected } : p
      ),
    }));
  }, []);

  const setAllPagesSelected = useCallback((selected: boolean) => {
    setWorkflow((prev) => ({
      ...prev,
      pages: prev.pages.map((p) => ({ ...p, selected })),
    }));
  }, []);

  const setPhase = useCallback((currentPhase: WorkflowPhase) => {
    setWorkflow((prev) => ({ ...prev, currentPhase }));
  }, []);

  const setError = useCallback((error: string | null) => {
    setWorkflow((prev) => ({ ...prev, error }));
  }, []);

  const reset = useCallback(() => {
    setWorkflow(defaultState);
  }, []);

  const setWorkspaceDir = useCallback((workspaceDir: string) => {
    setWorkflow((prev) => ({ ...prev, workspaceDir }));
  }, []);

  const setWorkspaceSlug = useCallback((workspaceSlug: string) => {
    setWorkflow((prev) => ({ ...prev, workspaceSlug }));
  }, []);

  const setFileKey = useCallback((fileKey: string) => {
    setWorkflow((prev) => ({ ...prev, fileKey }));
  }, []);

  // useMemo로 context value 메모이제이션 — 불필요한 리렌더 방지
  const value = useMemo<WorkflowContextValue>(
    () => ({
      workflow,
      setUrl,
      setOutputDir,
      setSourceType,
      setDocumentName,
      setSitemap,
      setPages,
      updatePageStatus,
      updatePageSubstatus,
      updatePageSelected,
      setAllPagesSelected,
      setPhase,
      setError,
      reset,
      setWorkspaceDir,
      setWorkspaceSlug,
      setFileKey,
    }),
    [workflow, setUrl, setOutputDir, setSourceType, setDocumentName, setSitemap, setPages, updatePageStatus, updatePageSubstatus, updatePageSelected, setAllPagesSelected, setPhase, setError, reset, setWorkspaceDir, setWorkspaceSlug, setFileKey]
  );

  return (
    <WorkflowContext.Provider value={value}>
      {children}
    </WorkflowContext.Provider>
  );
}

export function useWorkflow() {
  return useContext(WorkflowContext);
}
