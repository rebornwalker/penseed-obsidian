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

export interface ForeshadowingCandidate {
  text: string;
  confidence: number;
  [key: string]: unknown;
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

async function request<T>(
  apiUrl: string,
  token: string,
  path: string,
  method: "GET" | "POST",
  body?: unknown
): Promise<T> {
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
  } catch (e) {
    // Network-level failure (DNS, connection refused, etc.)
    throw new ApiError("Unable to connect to Penseed.");
  }

  const status = response.status;

  if (status === 401 || status === 403) {
    throw new ApiError(
      "Penseed authentication failed. Please check your token in Settings.",
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
    return response.json as T;
  } catch (e) {
    throw new ApiError("Penseed analysis failed.");
  }
}

export async function listProjects(
  apiUrl: string,
  token: string
): Promise<PenseedProject[]> {
  return request<PenseedProject[]>(apiUrl, token, "/api/projects/", "GET");
}

export async function createChapter(
  apiUrl: string,
  token: string,
  projectId: number,
  title: string,
  chapterNumber: number | null,
  wordCount: number
): Promise<PenseedChapter> {
  return request<PenseedChapter>(apiUrl, token, "/api/chapters/", "POST", {
    title,
    chapter_number: chapterNumber,
    project_id: projectId,
    word_count: wordCount,
  });
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
