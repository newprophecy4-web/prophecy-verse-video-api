import { AwsClient } from "aws4fetch";

export interface Env {
  R2_BUCKET: R2Bucket;

  R2_ACCOUNT_ID: string;
  R2_ACCESS_KEY_ID: string;
  R2_SECRET_ACCESS_KEY: string;

  ADMIN_TOKEN: string;

  ALLOWED_ORIGIN: string;

  R2_BUCKET_NAME: string;
}

type JsonRecord = Record<string, unknown>;

const jsonHeaders = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
};

function json(
  data: JsonRecord,
  status = 200,
  extraHeaders: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...jsonHeaders,
      ...extraHeaders,
    },
  });
}

function corsHeaders(request: Request, env: Env) {
  const origin = request.headers.get("Origin") || "";

  const allowed =
    env.ALLOWED_ORIGIN === "*" ||
    origin === env.ALLOWED_ORIGIN;

  return {
    "Access-Control-Allow-Origin":
      allowed && origin ? origin : env.ALLOWED_ORIGIN,
    "Access-Control-Allow-Methods":
      "GET,POST,PUT,DELETE,OPTIONS",
    "Access-Control-Allow-Headers":
      "Content-Type, Authorization, X-Admin-Token",
    "Access-Control-Expose-Headers":
      "ETag, Content-Length, UploadId",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function withCors(
  response: Response,
  request: Request,
  env: Env,
): Response {
  const headers = new Headers(response.headers);

  const cors = corsHeaders(request, env);

  for (const [key, value] of Object.entries(cors)) {
    headers.set(key, value);
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function getAdminToken(request: Request): string | null {
  const authorization = request.headers.get("Authorization");

  if (authorization?.startsWith("Bearer ")) {
    return authorization.substring(7).trim();
  }

  return request.headers.get("X-Admin-Token");
}

async function requireAdmin(
  request: Request,
  env: Env,
): Promise<Response | null> {
  const suppliedToken = getAdminToken(request);

  if (!suppliedToken) {
    return json(
      {
        success: false,
        error: "ADMIN_AUTH_REQUIRED",
        message: "Admin authentication is required.",
      },
      401,
    );
  }

  if (!env.ADMIN_TOKEN) {
    return json(
      {
        success: false,
        error: "SERVER_AUTH_NOT_CONFIGURED",
        message: "Admin authentication is not configured.",
      },
      500,
    );
  }

  if (suppliedToken !== env.ADMIN_TOKEN) {
    return json(
      {
        success: false,
        error: "INVALID_ADMIN_TOKEN",
        message: "Invalid admin token.",
      },
      403,
    );
  }

  return null;
}

function getS3Client(env: Env) {
  return new AwsClient({
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    service: "s3",
    region: "auto",
  });
}

function getS3Endpoint(env: Env) {
  return `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;
}

function encodePath(path: string) {
  return path
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
}

function normalizeKey(input: string): string {
  return input
    .replace(/^\/+/, "")
    .replace(/\.\./g, "")
    .trim();
}

function generateObjectKey(
  filename: string,
  folder = "videos",
): string {
  const cleanName =
    filename
      .replace(/[^a-zA-Z0-9._-]/g, "_")
      .replace(/_+/g, "_")
      .slice(0, 180) || "video";

  const id = crypto.randomUUID();

  return `${normalizeKey(folder)}/${Date.now()}-${id}-${cleanName}`;
}

/*
 * AWS SigV4 presigned request helper.
 */
async function presign(
  env: Env,
  method: string,
  path: string,
  query: Record<string, string>,
  expires = 3600,
) {
  const client = getS3Client(env);

  const url = new URL(
    `${getS3Endpoint(env)}${path}`,
  );

  for (const [key, value] of Object.entries(query)) {
    url.searchParams.set(key, value);
  }

  const signed = await client.sign(
    new Request(url.toString(), {
      method,
    }),
    {
      aws: {
        signQuery: true,
      },
      expires,
    },
  );

  return signed.url;
}

/*
 * Initiate multipart upload.
 *
 * POST /api/r2/multipart/init
 *
 * Body:
 * {
 *   filename: "episode-01.mkv",
 *   contentType: "video/x-matroska",
 *   size: 314572800,
 *   folder: "videos"
 * }
 */
async function initMultipart(
  request: Request,
  env: Env,
): Promise<Response> {
  let body: JsonRecord;

  try {
    body = await request.json();
  } catch {
    return json(
      {
        success: false,
        error: "INVALID_JSON",
      },
      400,
    );
  }

  const filename = String(body.filename || "");
  const contentType = String(
    body.contentType || "application/octet-stream",
  );
  const size = Number(body.size || 0);
  const folder = String(body.folder || "videos");

  if (!filename) {
    return json(
      {
        success: false,
        error: "FILENAME_REQUIRED",
      },
      400,
    );
  }

  if (!Number.isFinite(size) || size <= 0) {
    return json(
      {
        success: false,
        error: "INVALID_FILE_SIZE",
      },
      400,
    );
  }

  const key = generateObjectKey(filename, folder);

  const s3Path = `/${encodePath(env.R2_BUCKET_NAME)}/${encodePath(
    key,
  )}`;

  try {
    /*
     * S3 multipart initiation:
     *
     * POST /bucket/key?uploads
     */
    const url = new URL(
      `${getS3Endpoint(env)}${s3Path}`,
    );

    url.searchParams.set("uploads", "");

    const client = getS3Client(env);

    const response = await client.fetch(url.toString(), {
      method: "POST",
      headers: {
        "Content-Type": contentType,
      },
    });

    const text = await response.text();

    if (!response.ok) {
      console.error(
        "R2 multipart initiation failed:",
        response.status,
        text,
      );

      return json(
        {
          success: false,
          error: "R2_MULTIPART_INIT_FAILED",
          status: response.status,
          details: text,
        },
        502,
      );
    }

    /*
     * R2/S3 returns XML.
     */
    const uploadIdMatch =
      text.match(/<UploadId>(.*?)<\/UploadId>/);

    if (!uploadIdMatch) {
      return json(
        {
          success: false,
          error: "UPLOAD_ID_NOT_RETURNED",
          details: text,
        },
        502,
      );
    }

    const uploadId = uploadIdMatch[1];

    return json({
      success: true,
      uploadId,
      key,
      filename,
      contentType,
      size,
    });
  } catch (error) {
    console.error("R2 init exception:", error);

    return json(
      {
        success: false,
        error: "R2_CONNECTION_FAILED",
        message:
          error instanceof Error
            ? error.message
            : String(error),
      },
      502,
    );
  }
}

/*
 * Create presigned URL for ONE multipart part.
 *
 * POST /api/r2/multipart/part-url
 *
 * Body:
 * {
 *   key: "...",
 *   uploadId: "...",
 *   partNumber: 1
 * }
 */
async function createPartUrl(
  request: Request,
  env: Env,
): Promise<Response> {
  let body: JsonRecord;

  try {
    body = await request.json();
  } catch {
    return json(
      {
        success: false,
        error: "INVALID_JSON",
      },
      400,
    );
  }

  const key = normalizeKey(String(body.key || ""));
  const uploadId = String(body.uploadId || "");
  const partNumber = Number(body.partNumber || 0);

  if (!key || !uploadId) {
    return json(
      {
        success: false,
        error: "KEY_AND_UPLOAD_ID_REQUIRED",
      },
      400,
    );
  }

  if (
    !Number.isInteger(partNumber) ||
    partNumber < 1 ||
    partNumber > 10000
  ) {
    return json(
      {
        success: false,
        error: "INVALID_PART_NUMBER",
      },
      400,
    );
  }

  try {
    const path =
      `/${encodePath(env.R2_BUCKET_NAME)}/${encodePath(key)}`;

    const uploadUrl = await presign(
      env,
      "PUT",
      path,
      {
        partNumber: String(partNumber),
        uploadId,
      },
      3600,
    );

    return json({
      success: true,
      uploadUrl,
      partNumber,
      expiresIn: 3600,
    });
  } catch (error) {
    console.error("Part URL error:", error);

    return json(
      {
        success: false,
        error: "PART_URL_GENERATION_FAILED",
        message:
          error instanceof Error
            ? error.message
            : String(error),
      },
      500,
    );
  }
}

/*
 * Complete multipart upload.
 *
 * POST /api/r2/multipart/complete
 *
 * Body:
 * {
 *   key: "...",
 *   uploadId: "...",
 *   parts: [
 *     { partNumber: 1, etag: "\"abc\"" },
 *     { partNumber: 2, etag: "\"def\"" }
 *   ]
 * }
 */
async function completeMultipart(
  request: Request,
  env: Env,
): Promise<Response> {
  let body: JsonRecord;

  try {
    body = await request.json();
  } catch {
    return json(
      {
        success: false,
        error: "INVALID_JSON",
      },
      400,
    );
  }

  const key = normalizeKey(String(body.key || ""));
  const uploadId = String(body.uploadId || "");
  const parts = Array.isArray(body.parts)
    ? body.parts
    : [];

  if (!key || !uploadId) {
    return json(
      {
        success: false,
        error: "KEY_AND_UPLOAD_ID_REQUIRED",
      },
      400,
    );
  }

  if (!parts.length) {
    return json(
      {
        success: false,
        error: "PARTS_REQUIRED",
      },
      400,
    );
  }

  const normalizedParts = parts
    .map((part: any) => ({
      partNumber: Number(part.partNumber),
      etag: String(part.etag || ""),
    }))
    .filter(
      (part: {
        partNumber: number;
        etag: string;
      }) =>
        Number.isInteger(part.partNumber) &&
        part.partNumber > 0 &&
        part.etag,
    )
    .sort(
      (a, b) => a.partNumber - b.partNumber,
    );

  if (!normalizedParts.length) {
    return json(
      {
        success: false,
        error: "INVALID_PARTS",
      },
      400,
    );
  }

  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    "<CompleteMultipartUpload>",
    ...normalizedParts.map(
      (part) =>
        `<Part><PartNumber>${part.partNumber}</PartNumber><ETag>${escapeXml(
          part.etag,
        )}</ETag></Part>`,
    ),
    "</CompleteMultipartUpload>",
  ].join("");

  try {
    const path =
      `/${encodePath(env.R2_BUCKET_NAME)}/${encodePath(key)}`;

    const url = new URL(
      `${getS3Endpoint(env)}${path}`,
    );

    url.searchParams.set("uploadId", uploadId);

    const client = getS3Client(env);

    const response = await client.fetch(
      url.toString(),
      {
        method: "POST",
        headers: {
          "Content-Type": "application/xml",
        },
        body: xml,
      },
    );

    const responseText = await response.text();

    if (!response.ok) {
      console.error(
        "R2 complete failed:",
        response.status,
        responseText,
      );

      return json(
        {
          success: false,
          error: "R2_MULTIPART_COMPLETE_FAILED",
          status: response.status,
          details: responseText,
        },
        502,
      );
    }

    return json({
      success: true,
      key,
      uploadId,
      parts: normalizedParts.length,
      message: "R2 multipart upload completed.",
    });
  } catch (error) {
    console.error("Complete exception:", error);

    return json(
      {
        success: false,
        error: "R2_COMPLETE_CONNECTION_FAILED",
        message:
          error instanceof Error
            ? error.message
            : String(error),
      },
      502,
    );
  }
}

/*
 * Abort multipart upload.
 *
 * DELETE /api/r2/multipart/abort
 */
async function abortMultipart(
  request: Request,
  env: Env,
): Promise<Response> {
  let body: JsonRecord;

  try {
    body = await request.json();
  } catch {
    return json(
      {
        success: false,
        error: "INVALID_JSON",
      },
      400,
    );
  }

  const key = normalizeKey(String(body.key || ""));
  const uploadId = String(body.uploadId || "");

  if (!key || !uploadId) {
    return json(
      {
        success: false,
        error: "KEY_AND_UPLOAD_ID_REQUIRED",
      },
      400,
    );
  }

  try {
    const path =
      `/${encodePath(env.R2_BUCKET_NAME)}/${encodePath(key)}`;

    const url = new URL(
      `${getS3Endpoint(env)}${path}`,
    );

    url.searchParams.set("uploadId", uploadId);

    const client = getS3Client(env);

    const response = await client.fetch(
      url.toString(),
      {
        method: "DELETE",
      },
    );

    const text = await response.text();

    if (!response.ok) {
      return json(
        {
          success: false,
          error: "R2_ABORT_FAILED",
          status: response.status,
          details: text,
        },
        502,
      );
    }

    return json({
      success: true,
      key,
      uploadId,
      message: "Multipart upload aborted.",
    });
  } catch (error) {
    console.error("Abort exception:", error);

    return json(
      {
        success: false,
        error: "R2_ABORT_CONNECTION_FAILED",
        message:
          error instanceof Error
            ? error.message
            : String(error),
      },
      502,
    );
  }
}

/*
 * Check whether an R2 object exists.
 *
 * GET /api/r2/check?key=...
 */
async function checkObject(
  request: Request,
  env: Env,
): Promise<Response> {
  const url = new URL(request.url);

  const key = normalizeKey(
    url.searchParams.get("key") || "",
  );

  if (!key) {
    return json(
      {
        success: false,
        error: "KEY_REQUIRED",
      },
      400,
    );
  }

  try {
    const object = await env.R2_BUCKET.head(key);

    if (!object) {
      return json({
        success: true,
        exists: false,
        key,
      });
    }

    return json({
      success: true,
      exists: true,
      key,
      size: object.size,
      etag: object.etag,
      uploaded: object.uploaded,
      httpMetadata: object.httpMetadata,
    });
  } catch (error) {
    console.error("R2 head error:", error);

    return json(
      {
        success: false,
        error: "R2_CHECK_FAILED",
        message:
          error instanceof Error
            ? error.message
            : String(error),
      },
      502,
    );
  }
}

/*
 * Health check.
 *
 * GET /api/r2/health
 */
async function health(
  env: Env,
): Promise<Response> {
  const configured = Boolean(
    env.R2_ACCOUNT_ID &&
      env.R2_ACCESS_KEY_ID &&
      env.R2_SECRET_ACCESS_KEY &&
      env.R2_BUCKET_NAME &&
      env.ADMIN_TOKEN,
  );

  return json({
    success: true,
    service: "cloudflare-r2-upload",
    configured,
    timestamp: new Date().toISOString(),
  });
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

async function router(
  request: Request,
  env: Env,
): Promise<Response> {
  const url = new URL(request.url);

  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: corsHeaders(request, env),
    });
  }

  if (
    request.method === "GET" &&
    url.pathname === "/api/r2/health"
  ) {
    return health(env);
  }

  /*
   * Everything below this point requires admin authentication.
   */
  const authError = await requireAdmin(request, env);

  if (authError) {
    return authError;
  }

  if (
    request.method === "POST" &&
    url.pathname === "/api/r2/multipart/init"
  ) {
    return initMultipart(request, env);
  }

  if (
    request.method === "POST" &&
    url.pathname === "/api/r2/multipart/part-url"
  ) {
    return createPartUrl(request, env);
  }

  if (
    request.method === "POST" &&
    url.pathname === "/api/r2/multipart/complete"
  ) {
    return completeMultipart(request, env);
  }

  if (
    request.method === "DELETE" &&
    url.pathname === "/api/r2/multipart/abort"
  ) {
    return abortMultipart(request, env);
  }

  if (
    request.method === "GET" &&
    url.pathname === "/api/r2/check"
  ) {
    return checkObject(request, env);
  }

  return json(
    {
      success: false,
      error: "NOT_FOUND",
      message: "R2 upload endpoint not found.",
    },
    404,
  );
}

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    try {
      const response = await router(request, env);

      return withCors(
        response,
        request,
        env,
      );
    } catch (error) {
      console.error(
        "Unhandled upload backend error:",
        error,
      );

      const response = json(
        {
          success: false,
          error: "INTERNAL_SERVER_ERROR",
          message:
            error instanceof Error
              ? error.message
              : String(error),
        },
        500,
      );

      return withCors(
        response,
        request,
        env,
      );
    }
  },
};
