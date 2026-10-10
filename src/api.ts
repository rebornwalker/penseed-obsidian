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
  partially_resolved: number;
  progressed: number;
  estimated_replay_credits: number;
  noop?: boolean;
  noop_reason?: string | null;
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

export interface EntityItem {
  name: string;
  type?: string;
  aliases?: string[];
  attributes?: Record<string, unknown>;
  description?: string;
  [key: string]: unknown;
}

export interface EntitySavePayload {
  project_id: number;
  chapter_id: number;
  chapter_number: number | null;
  entities: EntityItem[];
}

export interface ForeshadowingExtractResult {
  candidates: ForeshadowingCandidate[];
  processing_time: number;
  [key: string]: unknown;
}

export interface EntityExtractResult {
  entities: EntityItem[];
  entity_count: number;
  processing_time: number;
}

async function requestRaw(
  apiUrl: string,
  token: string,
  path: string,
  method: "GET" | "POST" | "PUT",
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
  method: "GET" | "POST" | "PUT",
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
  content: string,
  previousContent?: string
): Promise<ReanalyzeResult> {
  return request<ReanalyzeResult>(
    apiUrl,
    token,
    `/api/chapters/${chapterId}/reanalyze`,
    "POST",
    { content, previous_content: previousContent || null }
  );
}

export interface StartSingleReanalysisResult {
  task_id: string;
  status: string;
  total: number;
}

/**
 * Phase 0.20: submit a single-chapter reanalysis as a background task. Returns
 * 202 with a task_id; poll `getSingleReanalysisStatus` until completed, then
 * read the full diff from `result`.
 */
export async function startSingleReanalysis(
  apiUrl: string,
  token: string,
  chapterId: number,
  content: string,
  previousContent?: string
): Promise<StartSingleReanalysisResult> {
  return request<StartSingleReanalysisResult>(
    apiUrl,
    token,
    `/api/chapters/${chapterId}/reanalyze-async`,
    "POST",
    { content, previous_content: previousContent || null }
  );
}

export interface SingleReanalysisStatus {
  task_id: string;
  status: string;
  total: number;
  completed: number;
  failed: number;
  current_chapter: number | null;
  error: string | null;
  result?: ReanalyzeResult | null;
  [key: string]: unknown;
}

/**
 * Phase 0.20: poll a single-chapter reanalysis task. Shares the backend status
 * endpoint with the batch task (the registry is generic); only the result shape
 * differs (full reanalyze diff vs. wave result).
 */
export async function getSingleReanalysisStatus(
  apiUrl: string,
  token: string,
  taskId: string
): Promise<SingleReanalysisStatus> {
  return request<SingleReanalysisStatus>(
    apiUrl,
    token,
    `/api/chapters/reanalysis-batch/${taskId}/status`,
    "GET"
  );
}

export interface StartWaveResult {
  wave_id: number;
  wave_seq: number;
  frozen_chapter_ids: number[];
  frozen_count: number;
}

export interface EndWaveResult {
  converged: boolean;
  new_stale_chapter_ids: number[];
  wave_seq: number | null;
  max_waves_reached: boolean;
}

/**
 * Phase 0.16-08: start a reanalysis wave. Freezes the current stale chapters and
 * returns the frozen list (already ordered by chapter_number ascending).
 *
 * Pass `chapterIds` to freeze only those chapters (the current reanalysis's
 * downstream set) instead of every stale chapter in the project.
 */
export async function startReanalysisWave(
  apiUrl: string,
  token: string,
  projectId: number,
  chapterIds?: number[]
): Promise<StartWaveResult> {
  return request<StartWaveResult>(
    apiUrl,
    token,
    "/api/chapters/reanalysis-wave/start",
    "POST",
    { project_id: projectId, chapter_ids: chapterIds ?? null }
  );
}

/**
 * Phase 0.16-08: end the wave (consolidation). Returns whether the cascade
 * converged and any NEW stale chapters outside the frozen set.
 */
export async function endReanalysisWave(
  apiUrl: string,
  token: string,
  projectId: number
): Promise<EndWaveResult> {
  return request<EndWaveResult>(
    apiUrl,
    token,
    "/api/chapters/reanalysis-wave/end",
    "POST",
    { project_id: projectId }
  );
}

export interface ReanalysisBatchChapter {
  chapter_id: number;
  content: string;
  previous_content?: string;
}

export interface StartReanalysisBatchResult {
  task_id: string;
  status: string;
  total: number;
}

export interface ReanalysisBatchStatus {
  task_id: string;
  status: string;
  total: number;
  completed: number;
  failed: number;
  current_chapter: number | null;
  error: string | null;
  result?: {
    converged: boolean;
    new_stale_chapter_ids: number[];
    wave_seq: number | null;
    max_waves_reached: boolean;
  } | null;
  [key: string]: unknown;
}

/**
 * Phase 0.18: start a backend batch-reanalysis task. The plugin submits every
 * downstream chapter's text once, then polls status — no client-side for-loop.
 */
export async function startReanalysisBatch(
  apiUrl: string,
  token: string,
  projectId: number,
  chapters: ReanalysisBatchChapter[]
): Promise<StartReanalysisBatchResult> {
  return request<StartReanalysisBatchResult>(
    apiUrl,
    token,
    "/api/chapters/reanalysis-batch",
    "POST",
    { project_id: projectId, chapters }
  );
}

/**
 * Phase 0.18: poll a batch-reanalysis task's structural progress.
 */
export async function getReanalysisBatchStatus(
  apiUrl: string,
  token: string,
  taskId: string
): Promise<ReanalysisBatchStatus> {
  return request<ReanalysisBatchStatus>(
    apiUrl,
    token,
    `/api/chapters/reanalysis-batch/${taskId}/status`,
    "GET"
  );
}

/**
 * Phase 0.18: request cancellation of a batch-reanalysis task.
 */
export async function cancelReanalysisBatch(
  apiUrl: string,
  token: string,
  taskId: string
): Promise<{ success: boolean; task_id: string }> {
  return request<{ success: boolean; task_id: string }>(
    apiUrl,
    token,
    `/api/chapters/reanalysis-batch/${taskId}/cancel`,
    "POST"
  );
}

export async function createChapter(
  apiUrl: string,
  token: string,
  projectId: number,
  title: string,
  chapterNumber: number | null,
  wordCount: number,
  content: string
): Promise<{ chapter: PenseedChapter; isNew: boolean }> {
  // get_or_create returns 201 for a newly created chapter, 200 for an existing
  // one. The status distinguishes first-time analysis from in-place reanalysis.
  // `content` is passed through so the backend can persist the original text
  // (content retention), which the web reanalyze modal later reads back.
  const { status, json } = await requestRaw(apiUrl, token, "/api/chapters/", "POST", {
    title,
    chapter_number: chapterNumber,
    project_id: projectId,
    word_count: wordCount,
    content,
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

export interface EntityListItem {
  id: number;
  canonical_name: string;
  aliases?: string[];
  display_name?: string | null;
  entity_type: string;
  description?: string;
  [key: string]: unknown;
}

/**
 * List entities, optionally scoped to a single chapter (via entity_facts).
 * Used by the reanalysis result modal to show what a chapter extracted.
 */
export async function listEntities(
  apiUrl: string,
  token: string,
  projectId: number,
  chapterId?: number
): Promise<EntityListItem[]> {
  const params = new URLSearchParams();
  params.set("project_id", String(projectId));
  if (chapterId !== undefined) {
    params.set("chapter_id", String(chapterId));
  }
  return request<EntityListItem[]>(
    apiUrl,
    token,
    `/api/entities?${params.toString()}`,
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

export interface ForeshadowingBatchCreateResult {
  created: Array<{ [key: string]: unknown }>;
  skipped: Array<{ [key: string]: unknown }>;
  created_count: number;
  skipped_count: number;
  failed_count: number;
  errors: string[];
}

/**
 * Phase 0.17: save every foreshadowing candidate in a single request. The
 * backend batches dedup + create + embedding + Qdrant upsert + snapshot so 17
 * candidates no longer become 17 slow sequential/parallel round-trips.
 */
export async function saveForeshadowingsBatch(
  apiUrl: string,
  token: string,
  items: ForeshadowingSavePayload[]
): Promise<ForeshadowingBatchCreateResult> {
  return request<ForeshadowingBatchCreateResult>(
    apiUrl,
    token,
    "/api/foreshadowing/batch-create",
    "POST",
    { items }
  );
}

export interface ForeshadowingItem {
  id: number;
  status: string | null;
  foreshadowing_text_preview: string | null;
  priority: number | null;
  chapter_title?: string | null;
  chapter_id?: number | null;
  chapter?: {
    chapter_number?: number | null;
    [key: string]: unknown;
  } | null;
  start_position?: number | null;
  end_position?: number | null;
  [key: string]: unknown;
}

export interface ForeshadowingListByProjectResult {
  items: ForeshadowingItem[];
  stats?: Record<string, unknown>;
  pagination?: Record<string, unknown>;
}

/**
 * Phase 0.13: list every foreshadowing in a project (no chapter filter) for the
 * plugin-side kanban board. Mirrors the web board's `GET /api/foreshadowing/?project_id=`.
 */
export async function listForeshadowingsByProject(
  apiUrl: string,
  token: string,
  projectId: number
): Promise<ForeshadowingListByProjectResult> {
  const params = new URLSearchParams();
  params.set("project_id", String(projectId));
  params.set("limit", "1000");
  return request<ForeshadowingListByProjectResult>(
    apiUrl,
    token,
    `/api/foreshadowing/?${params.toString()}`,
    "GET"
  );
}

/**
 * Phase 0.13: move a foreshadowing between kanban columns. The backend treats
 * this exactly like the web board's drag-and-drop, so both ends share one
 * source of truth (the `status` field) and stay in sync automatically.
 */
export async function updateForeshadowingStatus(
  apiUrl: string,
  token: string,
  id: number,
  status: string
): Promise<unknown> {
  return request<unknown>(
    apiUrl,
    token,
    `/api/foreshadowing/${id}`,
    "PUT",
    { status }
  );
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
