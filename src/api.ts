import { requestUrl, RequestUrlResponse } from "obsidian";

/**
 * Error with a user-facing message that maps backend failures to the
 * copy defined in the spec (Section 8).
 */
export class ApiError extends Error {
  userMessage: string;
  status: number | null;

  constructor(userMessage: string, status: number | null = null) {
    super(userMessage);
    this.userMessage = userMessage;
    this.status = status;
  }
}

export interface PenseedProject {
  id: number;
  title: string;
  [key: string]: unknown;
}

export interface PenseedChapter {
  id: number;
  title: string;
  chapter_number: number | null;
  [key: string]: unknown;
}

export interface ReanalyzeResult {
  chapter_id: number;
  entity_count: number;
  foreshadowing_count: number;
  affected_downstream_chapters: number[];
  deleted_foreshadowings: number;
  added_foreshadowings: number;
  semantic_changed_count: number;
  orphan_entities_deleted: number;
  foreshadowings_resolved: number;
  estimated_replay_credits: number;
}

export interface ForeshadowingCandidate {
  text: string;
  context?: string;
  confidence: number;
  start_position?: number;
  end_position?: number;
  is_foreshadowing?: boolean;
  foreshadowing_type?: string | null;
  target_elements?: string[] | null;
  emotional_tone?: string | null;
  narrative_function?: string | null;
  analysis?: string | null;
  improvement_suggestions?: string[] | null;
  foreshadowing_text_preview?: string | null;
  [key: string]: unknown;
}

export interface ForeshadowingListResult {
  items: Array<{ foreshadowing_text_preview?: string; [key: string]: unknown }>;
  [key: string]: unknown;
}

export interface ForeshadowingSavePayload {
  project_id: number;
  chapter_id: number;
  foreshadowing_text_preview: string;
  confidence: number;
  start_position: number;
  end_position: number;
  is_foreshadowing: boolean;
  foreshadowing_type?: string | null;
  target_elements?: string[] | null;
  emotional_tone?: string | null;
  narrative_function?: string | null;
  analysis?: string | null;
  improvement_suggestions?: string[] | null;
}

export interface EntitySavePayload {
  project_id: number;
  chapter_id: number;
  chapter_number: number | null;
  entities: Array<{ name: string; type?: string; [key: string]: unknown }>;
}

export interface ForeshadowingExtractResult {
  candidates: ForeshadowingCandidate[];
  processing_time: number;
  [key: string]: unknown;
}

export interface EntityExtractResult {
  entities: Array<{ name: string; type: string; [key: string]: unknown }>;
  entity_count: number;
  processing_time: number;
}

async function requestRaw(
  apiUrl: string,
  token: string,
  path: string,
  method: "GET" | "POST",
  body?: unknown
): Promise<{ status: number; json: unknown }> {
  const url = `${apiUrl.replace(/\/+$/, "")}${path}`;

  let response: RequestUrlResponse;
  try {
    response = await requestUrl({
      url,
      method,
      headers: { Authorization: `Bearer ${token}` },
      body: body ? JSON.stringify(body) : undefined,
      contentType: "application/json",
      throw: false,
    });
  } catch {
    // Network-level failure (DNS, connection refused, etc.)
    throw new ApiError("Unable to connect to Penseed.");
  }

  const status = response.status;

  if (status === 401 || status === 403) {
    throw new ApiError(
      "Penseed authentication failed. Please reconnect to Penseed in Settings.",
      status
    );
  }
  if (status === 402) {
    throw new ApiError(
      "Your Penseed AI quota is exhausted. Upgrade your plan or wait for it to reset.",
      status
    );
  }
  if (status === 429) {
    throw new ApiError(
      "Penseed usage limit reached. Please try again later.",
      status
    );
  }
  if (status >= 500) {
    throw new ApiError(
      "Penseed server error. Please try again later.",
      status
    );
  }
  if (status < 200 || status >= 300) {
    throw new ApiError("Penseed analysis failed.", status);
  }

  try {
    return { status, json: response.json };
  } catch {
    throw new ApiError("Penseed analysis failed.");
  }
}

async function request<T>(
  apiUrl: string,
  token: string,
  path: string,
  method: "GET" | "POST",
  body?: unknown
): Promise<T> {
  const { json } = await requestRaw(apiUrl, token, path, method, body);
  return json as T;
}

export async function listProjects(
  apiUrl: string,
  token: string
): Promise<PenseedProject[]> {
  return request<PenseedProject[]>(apiUrl, token, "/api/projects/", "GET");
}

export async function listChapters(
  apiUrl: string,
  token: string,
  projectId: number
): Promise<PenseedChapter[]> {
  const params = new URLSearchParams();
  params.set("project_id", String(projectId));
  params.set("limit", "1000");
  params.set("order_by", "chapter_number");
  params.set("order_desc", "false");
  return request<PenseedChapter[]>(
    apiUrl,
    token,
    `/api/chapters/?${params.toString()}`,
    "GET"
  );
}

/**
 * Phase 0.11 in-place reanalysis: recompute a chapter's entities, foreshadowing
 * diff, resolution, vectors, baseline and conflict detection from the new text.
 * Returns the downstream chapters that were marked stale as a result.
 */
export async function reanalyzeChapter(
  apiUrl: string,
  token: string,
  chapterId: number,
  content: string
): Promise<ReanalyzeResult> {
  return request<ReanalyzeResult>(
    apiUrl,
    token,
    `/api/chapters/${chapterId}/reanalyze`,
    "POST",
    { content }
  );
}

export async function createChapter(
  apiUrl: string,
  token: string,
  projectId: number,
  title: string,
  chapterNumber: number | null,
  wordCount: number
): Promise<{ chapter: PenseedChapter; isNew: boolean }> {
  // get_or_create returns 201 for a newly created chapter, 200 for an existing
  // one. The status distinguishes first-time analysis from in-place reanalysis.
  const { status, json } = await requestRaw(apiUrl, token, "/api/chapters/", "POST", {
    title,
    chapter_number: chapterNumber,
    project_id: projectId,
    word_count: wordCount,
  });
  return { chapter: json as PenseedChapter, isNew: status === 201 };
}

/**
 * Foreshadowing extraction. The backend also exposes an SSE streaming
 * endpoint (/extract-stream), but `fetch`-based SSE is blocked by the
 * backend CORS allowlist from Obsidian's `app://obsidian.md` origin.
 * We use the synchronous endpoint via `requestUrl`, which bypasses CORS.
 */
export async function extractForeshadowing(
  apiUrl: string,
  token: string,
  projectId: number,
  chapterId: number,
  content: string
): Promise<ForeshadowingExtractResult> {
  return request<ForeshadowingExtractResult>(
    apiUrl,
    token,
    "/api/foreshadowing/extract",
    "POST",
    {
      content,
      chapter_id: chapterId,
      project_id: projectId,
    }
  );
}

export async function extractEntities(
  apiUrl: string,
  token: string,
  projectId: number,
  content: string
): Promise<EntityExtractResult> {
  return request<EntityExtractResult>(apiUrl, token, "/api/entities/extract", "POST", {
    content,
    project_id: projectId,
  });
}

export async function listForeshadowings(
  apiUrl: string,
  token: string,
  chapterId: number,
  projectId: number
): Promise<ForeshadowingListResult> {
  const params = new URLSearchParams();
  params.set("chapter_id", String(chapterId));
  params.set("project_id", String(projectId));
  params.set("limit", "1000");
  return request<ForeshadowingListResult>(
    apiUrl,
    token,
    `/api/foreshadowing/?${params.toString()}`,
    "GET"
  );
}

export async function saveForeshadowing(
  apiUrl: string,
  token: string,
  payload: ForeshadowingSavePayload
): Promise<unknown> {
  return request<unknown>(apiUrl, token, "/api/foreshadowing/", "POST", payload);
}

export async function saveEntities(
  apiUrl: string,
  token: string,
  payload: EntitySavePayload
): Promise<{ saved_count: number }> {
  return request<{ saved_count: number }>(
    apiUrl,
    token,
    "/api/entities/save",
    "POST",
    payload
  );
}

export interface ResolutionAnalysisResult {
  success: boolean;
  data?: {
    chapter_summary: Record<string, unknown>;
    resolved_foreshadowings: Array<Record<string, unknown>>;
    stats?: {
      candidates_recalled?: number;
      foreshadowings_resolved?: number;
      [key: string]: unknown;
    };
  };
  error?: { code: string; message: string };
}

/**
 * Run foreshadowing resolution analysis for a chapter. Passing `chapter_id`
 * makes the backend persist the structured summary (revelations, resolutions,
 * plot advances, world mechanics, key entities) onto the chapter row — no
 * separate save-chapter-summary call is needed.
 */
export async function analyzeChapterResolution(
  apiUrl: string,
  token: string,
  projectId: number,
  chapterId: number,
  content: string
): Promise<ResolutionAnalysisResult> {
  return request<ResolutionAnalysisResult>(
    apiUrl,
    token,
    "/api/foreshadowing/analyze-resolution",
    "POST",
    {
      chapter_content: content,
      project_id: projectId,
      chapter_id: chapterId,
    }
  );
}
