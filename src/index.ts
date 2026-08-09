interface Env {
  VIDEOS: R2Bucket;
  ADMIN_TOKEN?: string;
}

const CONFIG = {
  CORS_ORIGIN: "*",

  VIDEO_PREFIX: "/video/",
  UPLOAD_PREFIX: "/admin/upload/",
  DELETE_PREFIX: "/admin/delete/",
  HEAD_PREFIX: "/video-head/",
} as const;

export default {
  async fetch(
    request: Request,
    env: Env,
  ): Promise<Response> {
    try {
      const url = new URL(request.url);

      // ==========================================
      // CORS PREFLIGHT
      // ==========================================

      if (request.method === "OPTIONS") {
        return new Response(null, {
          status: 204,
          headers: corsHeaders(),
        });
      }

      // ==========================================
      // HEALTH CHECK
      // ==========================================

      if (
        url.pathname === "/" ||
        url.pathname === "/health"
      ) {
        return jsonResponse({
          success: true,
          service: "Anime Video API",
          storage: "Cloudflare R2",
          bucket: "anime-videos",
          status: "online",
        });
      }

      // ==========================================
      // VIDEO GET / STREAM
      // ==========================================

      if (
        request.method === "GET" &&
        url.pathname.startsWith(
          CONFIG.VIDEO_PREFIX,
        )
      ) {
        return await streamVideo(
          request,
          env,
          url,
        );
      }

      // ==========================================
      // VIDEO HEAD
      // ==========================================

      if (
        request.method === "HEAD" &&
        (
          url.pathname.startsWith(
            CONFIG.VIDEO_PREFIX,
          ) ||
          url.pathname.startsWith(
            CONFIG.HEAD_PREFIX,
          )
        )
      ) {
        const prefix =
          url.pathname.startsWith(
            CONFIG.HEAD_PREFIX,
          )
            ? CONFIG.HEAD_PREFIX
            : CONFIG.VIDEO_PREFIX;

        return await headVideo(
          env,
          url,
          prefix,
        );
      }

      // ==========================================
      // ADMIN UPLOAD
      // ==========================================

      if (
        request.method === "PUT" &&
        url.pathname.startsWith(
          CONFIG.UPLOAD_PREFIX,
        )
      ) {
        return await uploadVideo(
          request,
          env,
          url,
        );
      }

      // ==========================================
      // ADMIN DELETE
      // ==========================================

      if (
        request.method === "DELETE" &&
        url.pathname.startsWith(
          CONFIG.DELETE_PREFIX,
        )
      ) {
        return await deleteVideo(
          request,
          env,
          url,
        );
      }

      // ==========================================
      // METHOD NOT ALLOWED
      // ==========================================

      if (
        url.pathname.startsWith(
          CONFIG.VIDEO_PREFIX,
        )
      ) {
        return jsonResponse(
          {
            success: false,
            error: "Method not allowed",
          },
          405,
          {
            Allow: "GET, HEAD, OPTIONS",
          },
        );
      }

      return jsonResponse(
        {
          success: false,
          error: "Route not found",
        },
        404,
      );
    } catch (error) {
      console.error(
        "Worker execution error:",
        error,
      );

      return jsonResponse(
        {
          success: false,
          error: "Internal server error",
          message:
            error instanceof Error
              ? error.message
              : "Unknown error",
        },
        500,
      );
    }
  },
} satisfies ExportedHandler<Env>;


// ==================================================
// VIDEO STREAMING
// ==================================================

async function streamVideo(
  request: Request,
  env: Env,
  url: URL,
): Promise<Response> {
  const key = getObjectKey(
    url.pathname,
    CONFIG.VIDEO_PREFIX,
  );

  if (!key) {
    return jsonResponse(
      {
        success: false,
        error: "Invalid or missing video key",
      },
      400,
    );
  }

  /*
   * IMPORTANT:
   *
   * Cloudflare R2 supports:
   *
   * - Range requests
   * - Conditional requests
   *
   * Passing request.headers lets R2 handle
   * Range and supported conditional headers.
   */

  const object =
    await env.VIDEOS.get(key, {
      range: request.headers,
      onlyIf: request.headers,
    });

  // ==========================================
  // OBJECT NOT FOUND
  // ==========================================

  if (!object) {
    return jsonResponse(
      {
        success: false,
        error: "Video not found",
        key,
      },
      404,
    );
  }

  // ==========================================
  // CONDITIONAL REQUEST FAILED
  // ==========================================

  /*
   * When R2 preconditions fail, the returned
   * object does not contain a body.
   *
   * For normal cache validation:
   * 304 is appropriate for If-None-Match /
   * If-Modified-Since.
   *
   * For If-Match / If-Unmodified-Since,
   * 412 is appropriate.
   */

  if (!("body" in object) || !object.body) {
    const hasIfMatch =
      request.headers.has("If-Match") ||
      request.headers.has(
        "If-Unmodified-Since",
      );

    const status =
      hasIfMatch ? 412 : 304;

    const headers =
      buildObjectHeaders(
        object,
        key,
      );

    return new Response(null, {
      status,
      headers,
    });
  }

  // ==========================================
  // RESPONSE HEADERS
  // ==========================================

  const headers =
    buildObjectHeaders(
      object,
      key,
    );

  // ==========================================
  // RANGE RESPONSE
  // ==========================================

  if (object.range) {
    const offset =
      object.range.offset ?? 0;

    const length =
      object.range.length ??
      Math.max(
        0,
        object.size - offset,
      );

    const end =
      offset + length - 1;

    headers.set(
      "Content-Range",
      `bytes ${offset}-${end}/${object.size}`,
    );

    headers.set(
      "Content-Length",
      String(length),
    );

    return new Response(
      object.body,
      {
        status: 206,
        headers,
      },
    );
  }

  // ==========================================
  // NORMAL FULL RESPONSE
  // ==========================================

  headers.set(
    "Content-Length",
    String(object.size),
  );

  return new Response(
    object.body,
    {
      status: 200,
      headers,
    },
  );
}


// ==================================================
// HEAD VIDEO
// ==================================================

async function headVideo(
  env: Env,
  url: URL,
  prefix: string,
): Promise<Response> {
  const key =
    getObjectKey(
      url.pathname,
      prefix,
    );

  if (!key) {
    return jsonResponse(
      {
        success: false,
        error: "Invalid or missing video key",
      },
      400,
    );
  }

  const object =
    await env.VIDEOS.head(key);

  if (!object) {
    return jsonResponse(
      {
        success: false,
        error: "Video not found",
        key,
      },
      404,
    );
  }

  const headers =
    buildObjectHeaders(
      object,
      key,
    );

  headers.set(
    "Content-Length",
    String(object.size),
  );

  return new Response(null, {
    status: 200,
    headers,
  });
}


// ==================================================
// ADMIN UPLOAD
// ==================================================

async function uploadVideo(
  request: Request,
  env: Env,
  url: URL,
): Promise<Response> {
  const authError =
    checkAdmin(
      request,
      env,
    );

  if (authError) {
    return authError;
  }

  const key =
    getObjectKey(
      url.pathname,
      CONFIG.UPLOAD_PREFIX,
    );

  if (!key) {
    return jsonResponse(
      {
        success: false,
        error: "Upload object key is missing",
      },
      400,
    );
  }

  if (!request.body) {
    return jsonResponse(
      {
        success: false,
        error: "Request body is empty",
      },
      400,
    );
  }

  const contentType =
    request.headers.get(
      "Content-Type",
    ) ||
    detectContentType(key);

  /*
   * request.body is passed directly to R2.
   * The Worker does not intentionally load
   * the entire video into an ArrayBuffer.
   */

  const object =
    await env.VIDEOS.put(
      key,
      request.body,
      {
        httpMetadata: {
          contentType,
          cacheControl:
            "public, max-age=31536000, immutable",
        },
      },
    );

  if (!object) {
    return jsonResponse(
      {
        success: false,
        error: "Upload failed",
      },
      500,
    );
  }

  return jsonResponse({
    success: true,
    message:
      "Video uploaded successfully",
    key: object.key,
    size: object.size,
    etag: object.httpEtag,
  });
}


// ==================================================
// ADMIN DELETE
// ==================================================

async function deleteVideo(
  request: Request,
  env: Env,
  url: URL,
): Promise<Response> {
  const authError =
    checkAdmin(
      request,
      env,
    );

  if (authError) {
    return authError;
  }

  const key =
    getObjectKey(
      url.pathname,
      CONFIG.DELETE_PREFIX,
    );

  if (!key) {
    return jsonResponse(
      {
        success: false,
        error: "Delete object key is missing",
      },
      400,
    );
  }

  const existing =
    await env.VIDEOS.head(key);

  if (!existing) {
    return jsonResponse(
      {
        success: false,
        error: "Video not found",
        key,
      },
      404,
    );
  }

  await env.VIDEOS.delete(key);

  return jsonResponse({
    success: true,
    message:
      "Video deleted successfully",
    key,
  });
}


// ==================================================
// ADMIN AUTHENTICATION
// ==================================================

function checkAdmin(
  request: Request,
  env: Env,
): Response | null {
  if (!env.ADMIN_TOKEN) {
    return jsonResponse(
      {
        success: false,
        error:
          "ADMIN_TOKEN is not configured",
      },
      503,
    );
  }

  const authorization =
    request.headers.get(
      "Authorization",
    );

  if (
    !authorization ||
    !authorization.startsWith(
      "Bearer ",
    )
  ) {
    return jsonResponse(
      {
        success: false,
        error:
          "Unauthorized",
      },
      401,
    );
  }

  const token =
    authorization
      .slice(7)
      .trim();

  if (!token) {
    return jsonResponse(
      {
        success: false,
        error:
          "Unauthorized",
      },
      401,
    );
  }

  if (
    token !== env.ADMIN_TOKEN
  ) {
    return jsonResponse(
      {
        success: false,
        error:
          "Unauthorized",
      },
      401,
    );
  }

  return null;
}


// ==================================================
// OBJECT KEY SECURITY
// ==================================================

function getObjectKey(
  pathname: string,
  prefix: string,
): string | null {
  if (
    !pathname.startsWith(prefix)
  ) {
    return null;
  }

  const rawKey =
    pathname.slice(
      prefix.length,
    );

  if (!rawKey) {
    return null;
  }

  try {
    const decoded =
      decodeURIComponent(
        rawKey,
      );

    if (!decoded) {
      return null;
    }

    /*
     * R2 object keys can contain folders,
     * but we reject traversal-style segments.
     */

    const normalized =
      decoded
        .replace(/\\/g, "/")
        .replace(/^\/+/g, "")
        .replace(/\/+/g, "/");

    if (!normalized) {
      return null;
    }

    const parts =
      normalized.split("/");

    for (const part of parts) {
      if (
        part === "." ||
        part === ".."
      ) {
        return null;
      }
    }

    /*
     * Prevent control characters.
     */

    for (const char of normalized) {
      if (
        char.charCodeAt(0) < 32
      ) {
        return null;
      }
    }

    return normalized;
  } catch {
    return null;
  }
}


// ==================================================
// HTTP HEADERS
// ==================================================

function buildObjectHeaders(
  object: R2Object,
  key: string,
): Headers {
  const headers =
    new Headers();

  object.writeHttpMetadata(
    headers,
  );

  /*
   * Fallback MIME type if the R2 object
   * does not have Content-Type metadata.
   */

  if (
    !headers.get(
      "Content-Type",
    )
  ) {
    headers.set(
      "Content-Type",
      detectContentType(key),
    );
  }

  /*
   * Cloudflare recommends httpEtag
   * for HTTP ETag headers.
   */

  if (object.httpEtag) {
    headers.set(
      "ETag",
      object.httpEtag,
    );
  }

  headers.set(
    "Accept-Ranges",
    "bytes",
  );

  headers.set(
    "Access-Control-Allow-Origin",
    CONFIG.CORS_ORIGIN,
  );

  headers.set(
    "Access-Control-Allow-Methods",
    "GET, HEAD, OPTIONS, PUT, DELETE",
  );

  headers.set(
    "Access-Control-Allow-Headers",
    "Range, Content-Type, Authorization",
  );

  headers.set(
    "Access-Control-Expose-Headers",
    "Accept-Ranges, Content-Length, Content-Range, ETag, Content-Type",
  );

  /*
   * Helps browsers keep video connections
   * alive where supported.
   */

  headers.set(
    "Connection",
    "keep-alive",
  );

  return headers;
}


// ==================================================
// CORS
// ==================================================

function corsHeaders():
  Record<string, string> {
  return {
    "Access-Control-Allow-Origin":
      CONFIG.CORS_ORIGIN,

    "Access-Control-Allow-Methods":
      "GET, HEAD, OPTIONS, PUT, DELETE",

    "Access-Control-Allow-Headers":
      "Range, Content-Type, Authorization",

    "Access-Control-Expose-Headers":
      "Accept-Ranges, Content-Length, Content-Range, ETag, Content-Type",

    "Access-Control-Max-Age":
      "86400",
  };
}


// ==================================================
// JSON RESPONSE
// ==================================================

function jsonResponse(
  data: unknown,
  status = 200,
  extraHeaders?: Record<string, string>,
): Response {
  const headers =
    new Headers({
      "Content-Type":
        "application/json; charset=utf-8",

      "Cache-Control":
        "no-store",

      ...corsHeaders(),

      ...extraHeaders,
    });

  return new Response(
    JSON.stringify(
      data,
      null,
      2,
    ),
    {
      status,
      headers,
    },
  );
}


// ==================================================
// MIME TYPES
// ==================================================

function detectContentType(
  key: string,
): string {
  const extension =
    key
      .split("?")[0]
      .split(".")
      .pop()
      ?.toLowerCase();

  const types:
    Record<string, string> = {
    mp4: "video/mp4",
    webm: "video/webm",
    mov: "video/quicktime",
    m4v: "video/x-m4v",

    /*
     * MKV is included for storage detection,
     * but browser playback support is not universal.
     */

    mkv: "video/x-matroska",

    mp3: "audio/mpeg",
    m4a: "audio/mp4",
    aac: "audio/aac",

    vtt: "text/vtt",
    webvtt: "text/vtt",
    srt: "application/x-subrip",
  };

  return (
    types[
      extension || ""
    ] ||
    "application/octet-stream"
  );
    }
