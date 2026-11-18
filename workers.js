const MIME_TYPES = {
  webp: "image/webp",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  avif: "image/avif",
  gif: "image/gif",
};

async function sha256Hex(buffer) {
  const hashBuffer = await crypto.subtle.digest("SHA-256", buffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

function sanitizePath(rawPath) {
  const trimmed = String(rawPath || "").trim();
  if (trimmed === "/") return "/";
  return trimmed
    .replace(/\\/g, "/")
    .split("/")
    .map((seg) => seg.trim())
    .filter((seg) => seg && seg !== "." && seg !== "..")
    .join("/");
}

function jsonCors(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-store",
    },
  });
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, HEAD, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, X-Admin-Password",
          "Access-Control-Max-Age": "86400",
        },
      });
    }

    const url = new URL(request.url);
    const pathname = url.pathname.replace(/\/+$/, "") || "/";

    if (pathname === "/" && (request.method === "GET" || request.method === "HEAD")) {
      return new Response(request.method === "HEAD" ? null : render404Page(), {
        status: 404,
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
        },
      });
    }

    if (pathname === "/upload" && request.method === "GET") {
      return new Response(renderUploadPage(), {
        status: 200,
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
        },
      });
    }

    if (pathname === "/api/check" && request.method === "POST") {
      return handleCheckFolders(request, env);
    }

    if (pathname === "/api/upload" && request.method === "POST") {
      return handleUpload(request, env, url.origin);
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method Not Allowed", { status: 405 });
    }

    const cleanPath = sanitizePath(pathname);
    if (!cleanPath || cleanPath === "/" || cleanPath.startsWith("api/")) {
      return new Response(request.method === "HEAD" ? null : render404Page(), {
        status: 404,
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
        },
      });
    }

    const lastSegment = cleanPath.split("/").pop() || "";
    const ext = lastSegment.includes(".")
      ? lastSegment.split(".").pop().toLowerCase()
      : "";

    if (MIME_TYPES[ext]) {
      return handleImageProxy(request, env, ctx, url, cleanPath, ext);
    }

    return handleFolderManifest(request, env, ctx, url, cleanPath);
  },
};

async function handleCheckFolders(request, env) {
  const password = request.headers.get("X-Admin-Password") || "";
  if (!env.ADMIN_PASSWORD || password !== env.ADMIN_PASSWORD) {
    return jsonCors({ error: "Invalid password." }, 401);
  }

  try {
    const body = await request.json();
    const rawFolders = Array.isArray(body.folders) ? body.folders : [];
    const results = {};

    await Promise.all(
      rawFolders.map(async (rawFolder) => {
        const folderPath = sanitizePath(rawFolder);
        if (!folderPath) return;

        const hfTreeUrl =
          folderPath === "/"
            ? `https://huggingface.co/api/datasets/${env.HF_REPO}/tree/main`
            : `https://huggingface.co/api/datasets/${env.HF_REPO}/tree/main/${folderPath}`;

        const hfRes = await fetch(hfTreeUrl, {
          headers: { Authorization: `Bearer ${env.HF_TOKEN}` },
        });

        if (!hfRes.ok) {
          results[folderPath] = { exists: false, count: 0 };
          return;
        }

        const items = await hfRes.json();
        const imageFiles = (Array.isArray(items) ? items : []).filter((item) => {
          if (item.type !== "file" || !item.path) return false;
          const ext = item.path.split(".").pop()?.toLowerCase() || "";
          return Boolean(MIME_TYPES[ext]);
        });

        results[folderPath] = {
          exists: imageFiles.length > 0,
          count: imageFiles.length,
        };
      })
    );

    return jsonCors({ results });
  } catch (err) {
    return jsonCors({ error: err.message || "Check failed." }, 500);
  }
}

async function handleImageProxy(request, env, ctx, url, filePath, ext) {
  const cache = caches.default;
  const cacheKey = new Request(url.toString(), { method: "GET" });
  let response = await cache.match(cacheKey);

  if (!response) {
    const hfUrl = `https://huggingface.co/datasets/${env.HF_REPO}/resolve/main/${filePath}`;
    const hfResponse = await fetch(hfUrl, {
      headers: { Authorization: `Bearer ${env.HF_TOKEN}` },
      redirect: "follow",
    });

    if (!hfResponse.ok) {
      return new Response(request.method === "HEAD" ? null : render404Page(), {
        status: hfResponse.status,
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
        },
      });
    }

    const headers = new Headers();
    headers.set("Content-Type", MIME_TYPES[ext]);
    headers.set("Content-Disposition", "inline");
    headers.set("Cache-Control", "public, max-age=31536000, immutable");
    headers.set("Access-Control-Allow-Origin", "*");

    response = new Response(hfResponse.body, { status: 200, headers });
    ctx.waitUntil(cache.put(cacheKey, response.clone()));
  }

  if (request.method === "HEAD") {
    return new Response(null, { status: response.status, headers: response.headers });
  }

  return response;
}

async function handleFolderManifest(request, env, ctx, url, folderPath) {
  const cache = caches.default;
  const normalizedUrl = `${url.origin}/${folderPath}`;
  const cacheKey = new Request(normalizedUrl, { method: "GET" });
  let response = await cache.match(cacheKey);

  if (!response) {
    const hfTreeUrl = `https://huggingface.co/api/datasets/${env.HF_REPO}/tree/main/${folderPath}`;
    const hfRes = await fetch(hfTreeUrl, {
      headers: { Authorization: `Bearer ${env.HF_TOKEN}` },
    });

    if (!hfRes.ok) {
      return jsonCors({ error: "Folder not found." }, hfRes.status);
    }

    const items = await hfRes.json();
    const imageUrls = (Array.isArray(items) ? items : [])
      .filter((item) => {
        if (item.type !== "file" || !item.path) return false;
        const ext = item.path.split(".").pop()?.toLowerCase() || "";
        return Boolean(MIME_TYPES[ext]);
      })
      .sort((a, b) =>
        a.path.localeCompare(b.path, undefined, { numeric: true, sensitivity: "base" })
      )
      .map((item) => `${url.origin}/${item.path}`);

    const payload = JSON.stringify({
      folder: folderPath,
      count: imageUrls.length,
      images: imageUrls,
    });

    response = new Response(payload, {
      status: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "public, max-age=3600",
        "Access-Control-Allow-Origin": "*",
      },
    });

    ctx.waitUntil(cache.put(cacheKey, response.clone()));
  }

  if (request.method === "HEAD") {
    return new Response(null, { status: response.status, headers: response.headers });
  }

  return response;
}

async function handleUpload(request, env, origin) {
  const password = request.headers.get("X-Admin-Password") || "";
  if (!env.ADMIN_PASSWORD || password !== env.ADMIN_PASSWORD) {
    return jsonCors({ error: "Invalid password." }, 401);
  }

  try {
    const formData = await request.formData();
    const folder = sanitizePath(formData.get("folder"));
    const files = formData.getAll("files");

    if (!folder) {
      return jsonCors({ error: "Folder path required." }, 400);
    }
    if (!files || files.length === 0) {
      return jsonCors({ error: "No files received." }, 400);
    }

    const isRoot = folder === "/";
    const preparedFiles = [];
    const uniqueObjectsMap = new Map();
    const fileUrls = [];

    for (const file of files) {
      if (typeof file === "string") continue;
      const safeName = sanitizePath(file.name).split("/").pop();
      if (!safeName || safeName === "/") continue;

      const buffer = await file.arrayBuffer();
      const oid = await sha256Hex(buffer);
      const size = buffer.byteLength;
      const repoFilePath = isRoot ? safeName : `${folder}/${safeName}`;

      preparedFiles.push({ repoFilePath, buffer, oid, size });
      fileUrls.push(`${origin}/${repoFilePath}`);

      if (!uniqueObjectsMap.has(oid)) {
        uniqueObjectsMap.set(oid, { oid, size });
      }
    }

    const lfsBatchUrl = `https://huggingface.co/datasets/${env.HF_REPO}.git/info/lfs/objects/batch`;
    const basicAuth = `Basic ${btoa(`hf:${env.HF_TOKEN}`)}`;

    const batchRes = await fetch(lfsBatchUrl, {
      method: "POST",
      headers: {
        Authorization: basicAuth,
        Accept: "application/vnd.git-lfs+json",
        "Content-Type": "application/vnd.git-lfs+json",
      },
      body: JSON.stringify({
        operation: "upload",
        transfers: ["basic"],
        objects: Array.from(uniqueObjectsMap.values()),
      }),
    });

    if (!batchRes.ok) {
      const errText = await batchRes.text();
      return jsonCors({ error: `LFS Batch Error (${batchRes.status}): ${errText}` }, 502);
    }

    const batchData = await batchRes.json();

    for (const obj of batchData.objects || []) {
      if (obj.error) {
        return jsonCors(
          { error: `LFS Object Error: ${obj.error.message || JSON.stringify(obj.error)}` },
          502
        );
      }

      const fileItem = preparedFiles.find((f) => f.oid === obj.oid);
      if (!fileItem) continue;

      if (obj.actions && obj.actions.upload) {
        const uploadAction = obj.actions.upload;
        const putRes = await fetch(uploadAction.href, {
          method: "PUT",
          headers: new Headers(uploadAction.header || {}),
          body: fileItem.buffer,
        });

        if (!putRes.ok) {
          const errText = await putRes.text();
          return jsonCors({ error: `LFS Upload Error (${putRes.status}): ${errText}` }, 502);
        }
      }

      if (obj.actions && obj.actions.verify) {
        const verifyAction = obj.actions.verify;
        const verifyHeaders = new Headers(verifyAction.header || {});
        if (!verifyHeaders.has("Content-Type")) {
          verifyHeaders.set("Content-Type", "application/vnd.git-lfs+json");
        }
        const verifyRes = await fetch(verifyAction.href, {
          method: "POST",
          headers: verifyHeaders,
          body: JSON.stringify({ oid: obj.oid, size: obj.size }),
        });

        if (!verifyRes.ok) {
          const errText = await verifyRes.text();
          return jsonCors({ error: `LFS Verify Error (${verifyRes.status}): ${errText}` }, 502);
        }
      }
    }

    const ndjsonLines = [
      JSON.stringify({
        key: "header",
        value: {
          summary: `Upload ${preparedFiles.length} image(s) to ${folder}`,
          description: "",
        },
      }),
    ];

    for (const item of preparedFiles) {
      ndjsonLines.push(
        JSON.stringify({
          key: "lfsFile",
          value: {
            path: item.repoFilePath,
            algo: "sha256",
            oid: item.oid,
            size: item.size,
          },
        })
      );
    }

    const hfCommitUrl = `https://huggingface.co/api/datasets/${env.HF_REPO}/commit/main`;
    const hfRes = await fetch(hfCommitUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.HF_TOKEN}`,
        "Content-Type": "application/x-ndjson",
      },
      body: ndjsonLines.join("\n"),
    });

    if (!hfRes.ok) {
      const errText = await hfRes.text();
      return jsonCors({ error: `Commit Error (${hfRes.status}): ${errText}` }, 502);
    }

    const folderUrl = isRoot ? `${origin}/` : `${origin}/${folder}`;
    if (!isRoot) {
      await caches.default.delete(new Request(folderUrl, { method: "GET" }));
    }

    return jsonCors({
      folderUrl,
      fileUrls,
      uploadedCount: preparedFiles.length,
    });
  } catch (err) {
    return jsonCors({ error: err.message || "Upload failed." }, 500);
  }
}

function render404Page() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Error 404 - Object not found</title>
  <style>
    @import url('https://fonts.googleapis.com/css?family=Cabin+Sketch');

    * {
      box-sizing: border-box;
    }

    html {
      height: 100%;
    }

    body {
      min-height: 100%;
      margin: 0;
      display: flex;
      background: #09090b;
      color: #f4f4f5;
    }

    .message {
      text-align: center;
      order: 1;
      max-width: 440px;
      padding: 0 20px;
    }

    h1 {
      font-family: 'Cabin Sketch', cursive;
      font-size: 3.1em;
      margin: 0 0 12px;
      color: #f4f4f5;
      letter-spacing: 0.02em;
    }

    h1 small {
      display: block;
      font-size: 0.62em;
      color: #f97316;
      margin-top: 2px;
    }

    .message p {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      font-size: 14px;
      line-height: 1.65;
      color: #a1a1aa;
      margin: 0;
    }

    .site {
      display: -webkit-box;
      display: -webkit-flex;
      display: -ms-flexbox;
      display: flex;
      -webkit-box-align: center;
      -webkit-align-items: center;
      -ms-flex-align: center;
      align-items: center;
      flex-direction: column;
      margin: 0 auto;
      -webkit-box-pack: center;
      -webkit-justify-content: center;
      -ms-flex-pack: center;
      justify-content: center;
      padding: 24px 0;
    }

    .sketch {
      position: relative;
      height: 400px;
      min-width: 400px;
      margin: 0;
      overflow: visible;
      order: 2;
      filter: brightness(1.35) contrast(1.1);
    }

    @media only screen and (max-width: 430px) {
      .sketch {
        height: 300px;
        min-width: 300px;
      }
      .bee-sketch {
        background-size: contain !important;
      }
    }

    .bee-sketch {
      height: 100%;
      width: 100%;
      position: absolute;
      top: 0;
      left: 0;
    }

    .red {
      background: url(https://s3-us-west-2.amazonaws.com/s.cdpn.io/198554/red-1.png) no-repeat center center;
      opacity: 1;
      animation: red 3s linear infinite, opacityRed 5s linear alternate infinite;
    }

    .blue {
      background: url(https://s3-us-west-2.amazonaws.com/s.cdpn.io/198554/blue-1.png) no-repeat center center;
      opacity: 0;
      animation: blue 3s linear infinite, opacityBlue 5s linear alternate infinite;
    }

    @media only screen and (min-width: 780px) {
      .site {
        flex-direction: row;
        padding: 1em 3em 1em 0em;
      }

      .message {
        text-align: right;
        order: 2;
        padding-bottom: 2em;
        padding-left: 2em;
      }

      .sketch {
        order: 1;
      }
    }

    @keyframes blue {
      0% { background-image: url(https://s3-us-west-2.amazonaws.com/s.cdpn.io/198554/blue-1.png); }
      9.09% { background-image: url(https://s3-us-west-2.amazonaws.com/s.cdpn.io/198554/blue-2.png); }
      27.27% { background-image: url(https://s3-us-west-2.amazonaws.com/s.cdpn.io/198554/blue-3.png); }
      36.36% { background-image: url(https://s3-us-west-2.amazonaws.com/s.cdpn.io/198554/blue-4.png); }
      45.45% { background-image: url(https://s3-us-west-2.amazonaws.com/s.cdpn.io/198554/blue-5.png); }
      54.54% { background-image: url(https://s3-us-west-2.amazonaws.com/s.cdpn.io/198554/blue-6.png); }
      63.63% { background-image: url(https://s3-us-west-2.amazonaws.com/s.cdpn.io/198554/blue-7.png); }
      72.72% { background-image: url(https://s3-us-west-2.amazonaws.com/s.cdpn.io/198554/blue-8.png); }
      81.81% { background-image: url(https://s3-us-west-2.amazonaws.com/s.cdpn.io/198554/blue-9.png); }
      100% { background-image: url(https://s3-us-west-2.amazonaws.com/s.cdpn.io/198554/blue-1.png); }
    }

    @keyframes red {
      0% { background-image: url(https://s3-us-west-2.amazonaws.com/s.cdpn.io/198554/red-1.png); }
      9.09% { background-image: url(https://s3-us-west-2.amazonaws.com/s.cdpn.io/198554/red-2.png); }
      27.27% { background-image: url(https://s3-us-west-2.amazonaws.com/s.cdpn.io/198554/red-3.png); }
      36.36% { background-image: url(https://s3-us-west-2.amazonaws.com/s.cdpn.io/198554/red-4.png); }
      45.45% { background-image: url(https://s3-us-west-2.amazonaws.com/s.cdpn.io/198554/red-5.png); }
      54.54% { background-image: url(https://s3-us-west-2.amazonaws.com/s.cdpn.io/198554/red-6.png); }
      63.63% { background-image: url(https://s3-us-west-2.amazonaws.com/s.cdpn.io/198554/red-7.png); }
      72.72% { background-image: url(https://s3-us-west-2.amazonaws.com/s.cdpn.io/198554/red-8.png); }
      81.81% { background-image: url(https://s3-us-west-2.amazonaws.com/s.cdpn.io/198554/red-9.png); }
      100% { background-image: url(https://s3-us-west-2.amazonaws.com/s.cdpn.io/198554/red-1.png); }
    }

    @keyframes opacityBlue {
      from { opacity: 0; }
      25% { opacity: 0; }
      75% { opacity: 1; }
      to { opacity: 1; }
    }

    @keyframes opacityRed {
      from { opacity: 1; }
      25% { opacity: 1; }
      75% { opacity: .35; }
      to { opacity: .35; }
    }
  </style>
</head>
<body>
  <div class="site">
    <div class="sketch">
      <div class="bee-sketch red"></div>
      <div class="bee-sketch blue"></div>
    </div>

    <div class="message">
      <h1>Error 404:
        <small>Object not found</small>
      </h1>
      <p>This object does not exist or is not publicly accessible at this URL. Check the URL of the object that you're looking for or contact the owner to enable Public access.</p>
    </div>
  </div>
</body>
</html>`;
}

function renderUploadPage() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Image Uploader</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600;700&family=Lexend+Deca:wght@400;500;600;700&display=swap" rel="stylesheet" />
  <style>
    :root {
      --bg: #09090b;
      --surface: #121215;
      --surface-2: #18181d;
      --border: #27272f;
      --border-strong: #3f3f4a;
      --accent: #f97316;
      --accent-hover: #fb923c;
      --text: #f4f4f5;
      --muted: #9ca3af;
      --ok: #22c55e;
      --warn: #eab308;
      --err: #ef4444;
      --radius: 4px;
    }

    * { box-sizing: border-box; }
    body {
      background-color: var(--bg);
      background-image: radial-gradient(#1f1f26 1px, transparent 1px);
      background-size: 20px 20px;
      color: var(--text);
      font-family: 'Lexend Deca', system-ui, sans-serif;
      margin: 0;
      padding: 28px 16px 60px;
      display: flex;
      justify-content: center;
    }

    .container { width: 100%; max-width: 820px; }

    .topbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      background: var(--surface);
      border: 2px solid var(--border);
      border-radius: var(--radius);
      padding: 14px 18px;
      margin-bottom: 16px;
      box-shadow: 4px 4px 0px #000000;
    }
    .brand { display: flex; align-items: center; gap: 10px; }
    .brand-tag {
      background: var(--accent);
      color: #09090b;
      font-weight: 700;
      font-size: 11px;
      padding: 4px 8px;
      border-radius: var(--radius);
      letter-spacing: 0.08em;
    }
    .brand h1 {
      margin: 0;
      font-size: 16px;
      font-weight: 700;
      letter-spacing: 0.04em;
      text-transform: uppercase;
    }
    .host-pill {
      font-family: 'JetBrains Mono', monospace;
      font-size: 11px;
      color: var(--muted);
      background: var(--bg);
      border: 1px solid var(--border);
      padding: 5px 9px;
      border-radius: var(--radius);
    }

    .card {
      background: var(--surface);
      border: 2px solid var(--border);
      border-radius: var(--radius);
      padding: 20px;
      box-shadow: 4px 4px 0px #000000;
      margin-bottom: 16px;
    }

    .grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; margin-bottom: 14px; }
    @media (max-width: 620px) { .grid-2 { grid-template-columns: 1fr; } }

    .field label {
      display: block;
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--muted);
      margin-bottom: 7px;
    }

    .input-wrap { position: relative; display: flex; }
    input[type="text"], input[type="password"], select {
      width: 100%;
      background: var(--bg);
      border: 1px solid var(--border-strong);
      color: var(--text);
      padding: 10px 12px;
      border-radius: var(--radius);
      font-size: 13px;
      font-family: 'JetBrains Mono', monospace;
      transition: border-color 0.15s;
    }
    input:focus, select:focus { outline: none; border-color: var(--accent); }

    .toggle-pwd {
      position: absolute;
      right: 6px;
      top: 50%;
      transform: translateY(-50%);
      background: var(--surface-2);
      border: 1px solid var(--border);
      color: var(--muted);
      font-size: 10px;
      font-family: 'Lexend Deca', sans-serif;
      font-weight: 600;
      padding: 4px 7px;
      border-radius: var(--radius);
      cursor: pointer;
    }
    .toggle-pwd:hover { color: var(--text); border-color: var(--border-strong); }

    .options-bar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      flex-wrap: wrap;
      gap: 12px;
      background: var(--surface-2);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 10px 14px;
      margin-bottom: 16px;
    }
    .chk-label {
      display: inline-flex;
      align-items: center;
      gap: 9px;
      cursor: pointer;
      font-size: 12px;
      font-weight: 600;
      color: var(--text);
      user-select: none;
    }
    .chk-label input[type="checkbox"] {
      width: 16px;
      height: 16px;
      accent-color: var(--accent);
      cursor: pointer;
    }
    .select-group {
      display: flex;
      align-items: center;
      gap: 12px;
      flex-wrap: wrap;
    }
    .quality-wrap {
      display: flex;
      align-items: center;
      gap: 6px;
      font-family: 'JetBrains Mono', monospace;
      font-size: 11px;
      color: var(--muted);
    }
    .quality-wrap select {
      width: auto;
      padding: 5px 8px;
      font-size: 11px;
    }

    .dropzone {
      border: 2px dashed var(--border-strong);
      background: var(--bg);
      border-radius: var(--radius);
      padding: 28px 16px;
      text-align: center;
      transition: all 0.15s ease;
      margin-bottom: 16px;
    }
    .dropzone.dragover {
      border-color: var(--accent);
      background: rgba(249, 115, 22, 0.07);
    }
    .dropzone-icon {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 38px;
      height: 38px;
      background: var(--surface-2);
      border: 1px solid var(--border-strong);
      border-radius: var(--radius);
      color: var(--accent);
      margin-bottom: 10px;
    }
    .dropzone-title { font-size: 14px; font-weight: 600; margin-bottom: 14px; }
    .pick-btns { display: flex; justify-content: center; gap: 10px; flex-wrap: wrap; }

    .btn-pick {
      background: var(--surface-2);
      border: 1px solid var(--border-strong);
      color: var(--text);
      font-family: 'Lexend Deca', sans-serif;
      font-size: 12px;
      font-weight: 600;
      padding: 8px 14px;
      border-radius: var(--radius);
      cursor: pointer;
    }
    .btn-pick:hover { border-color: var(--accent); color: var(--accent); }

    .groups-wrap { display: none; margin-bottom: 16px; }
    .groups-wrap.show { display: block; }
    .groups-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      flex-wrap: wrap;
      gap: 8px;
      margin-bottom: 8px;
    }
    .groups-title {
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--muted);
    }
    .groups-actions { display: flex; gap: 6px; }
    .btn-mini {
      background: var(--bg);
      border: 1px solid var(--border-strong);
      color: var(--muted);
      font-family: 'Lexend Deca', sans-serif;
      font-size: 11px;
      font-weight: 600;
      padding: 4px 8px;
      border-radius: var(--radius);
      cursor: pointer;
      text-transform: uppercase;
    }
    .btn-mini:hover { border-color: var(--accent); color: var(--text); }
    .btn-mini.danger:hover { border-color: var(--err); color: var(--err); }

    .warn-banner {
      display: none;
      background: rgba(234, 179, 8, 0.1);
      border: 1px solid var(--warn);
      color: #fef08a;
      padding: 9px 12px;
      border-radius: var(--radius);
      font-size: 12px;
      margin-bottom: 10px;
    }
    .warn-banner.show { display: block; }

    .group-list {
      display: flex;
      flex-direction: column;
      gap: 6px;
      max-height: 290px;
      overflow-y: auto;
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 8px;
    }

    .group-item {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 8px 10px;
      font-family: 'JetBrains Mono', monospace;
      font-size: 12px;
    }
    .group-item.exists { border-color: rgba(234, 179, 8, 0.45); }
    .group-item.uploading { border-color: var(--accent); background: rgba(249, 115, 22, 0.06); }
    .group-item.missing-path { border-color: rgba(249, 115, 22, 0.55); }

    .group-left { display: flex; align-items: center; gap: 10px; min-width: 0; flex: 1; }
    .group-left input[type="checkbox"] {
      width: 16px;
      height: 16px;
      accent-color: var(--accent);
      cursor: pointer;
      flex-shrink: 0;
    }
    .group-path-input {
      background: var(--bg) !important;
      border: 1px solid var(--border-strong) !important;
      padding: 5px 8px !important;
      font-size: 12px !important;
      max-width: 280px;
    }
    .group-right { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }
    .badge {
      font-size: 10px;
      font-weight: 600;
      padding: 3px 7px;
      border-radius: var(--radius);
      text-transform: uppercase;
    }
    .badge.new { background: rgba(34, 197, 94, 0.14); color: #86efac; border: 1px solid rgba(34, 197, 94, 0.4); }
    .badge.exists { background: rgba(234, 179, 8, 0.15); color: #fde047; border: 1px solid rgba(234, 179, 8, 0.45); }
    .badge.uploading { background: rgba(249, 115, 22, 0.18); color: #fdba74; border: 1px solid var(--accent); }
    .badge.checking { background: var(--surface-2); color: var(--muted); border: 1px solid var(--border); }
    .file-count { color: var(--muted); font-size: 11px; }

    .btn-primary {
      width: 100%;
      background: var(--accent);
      color: #09090b;
      border: 2px solid var(--accent);
      padding: 12px 18px;
      font-family: 'Lexend Deca', sans-serif;
      font-weight: 700;
      font-size: 13px;
      letter-spacing: 0.05em;
      text-transform: uppercase;
      border-radius: var(--radius);
      cursor: pointer;
      box-shadow: 3px 3px 0px #000000;
      transition: transform 0.1s, background 0.15s;
    }
    .btn-primary:hover:not(:disabled) { background: var(--accent-hover); border-color: var(--accent-hover); }
    .btn-primary:active:not(:disabled) { transform: translate(2px, 2px); box-shadow: 1px 1px 0px #000000; }
    .btn-primary:disabled { opacity: 0.45; cursor: not-allowed; box-shadow: none; }

    .progress-panel {
      display: none;
      margin-top: 14px;
      background: var(--bg);
      border: 1px solid var(--border-strong);
      border-radius: var(--radius);
      padding: 12px;
    }
    .progress-panel.show { display: block; }

    .progress-stage { display: none; }
    .progress-stage.show { display: block; }
    .progress-stage + .progress-stage.show {
      margin-top: 14px;
      padding-top: 14px;
      border-top: 1px solid var(--border);
    }

    .progress-top {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 10px;
      margin-bottom: 8px;
      font-family: 'JetBrains Mono', monospace;
      font-size: 12px;
    }
    .progress-label {
      color: var(--text);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .progress-pct {
      color: var(--accent);
      font-weight: 700;
      font-size: 13px;
      flex-shrink: 0;
    }
    .progress-pct.done { color: var(--ok); }
    .progress-track {
      width: 100%;
      height: 16px;
      background: var(--surface-2);
      border: 1px solid var(--border-strong);
      border-radius: var(--radius);
      overflow: hidden;
      padding: 2px;
    }
    .progress-fill {
      height: 100%;
      width: 0%;
      background-color: var(--accent);
      background-image: linear-gradient(
        45deg,
        rgba(255, 255, 255, 0.18) 25%,
        transparent 25%,
        transparent 50%,
        rgba(255, 255, 255, 0.18) 50%,
        rgba(255, 255, 255, 0.18) 75%,
        transparent 75%,
        transparent
      );
      background-size: 20px 20px;
      border-radius: 2px;
      transition: width 0.15s ease, background-color 0.25s ease;
      animation: stripeMove 0.9s linear infinite;
    }
    .progress-fill.done {
      background-color: var(--ok);
      background-image: none;
      animation: none;
    }
    .progress-fill.error {
      background-color: var(--err);
      background-image: none;
      animation: none;
    }
    @keyframes stripeMove {
      0% { background-position: 0 0; }
      100% { background-position: 20px 0; }
    }
    .progress-sub {
      display: flex;
      justify-content: space-between;
      flex-wrap: wrap;
      gap: 8px;
      margin-top: 6px;
      font-family: 'JetBrains Mono', monospace;
      font-size: 11px;
      color: var(--muted);
    }

    .status {
      display: none;
      margin-top: 12px;
      padding: 10px 12px;
      border-radius: var(--radius);
      font-size: 12px;
      font-family: 'JetBrains Mono', monospace;
      background: var(--bg);
      border: 1px solid var(--border-strong);
    }
    .status.show { display: block; }
    .status.error { border-color: var(--err); color: #fca5a5; }
    .status.ok { border-color: var(--ok); color: #86efac; }

    .result-card { display: none; }
    .result-card.show { display: block; }
    .result-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 10px;
    }
    .result-title {
      font-size: 12px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--ok);
    }
    .result-list { display: flex; flex-direction: column; gap: 8px; }
    .url-group { display: flex; gap: 8px; }
    @media (max-width: 540px) { .url-group { flex-direction: column; } }
    .url-group input {
      color: #86efac;
      border-color: var(--ok);
      font-weight: 600;
    }
    .btn-sec {
      background: var(--surface-2);
      color: var(--text);
      border: 1px solid var(--border-strong);
      padding: 9px 12px;
      font-family: 'Lexend Deca', sans-serif;
      font-weight: 600;
      font-size: 11px;
      text-transform: uppercase;
      border-radius: var(--radius);
      cursor: pointer;
      white-space: nowrap;
      text-decoration: none;
      display: inline-flex;
      align-items: center;
      justify-content: center;
    }
    .btn-sec:hover { border-color: var(--accent); color: var(--accent); }
  </style>
</head>
<body>
  <div class="container">
    <div class="topbar">
      <div class="brand">
        <span class="brand-tag">REGIONAL</span>
        <h1>Image Uploader</h1>
      </div>
      <div class="host-pill" id="hostPill"></div>
    </div>

    <div class="card">
      <div class="grid-2">
        <div class="field">
          <label>Admin Password</label>
          <div class="input-wrap">
            <input type="password" id="password" placeholder="••••••••••••" />
            <button type="button" class="toggle-pwd" id="togglePwdBtn">SHOW</button>
          </div>
        </div>
        <div class="field">
          <label>Root Folder</label>
          <input type="text" id="rootPrefix" placeholder="optional" />
        </div>
      </div>

      <div class="options-bar">
        <label class="chk-label">
          <input type="checkbox" id="convertWebpChk" checked />
          <span>Convert to WebP</span>
        </label>
        <div class="select-group" id="qualityWrap">
          <div class="quality-wrap">
            <span>MAX WIDTH</span>
            <select id="maxWidthSel">
              <option value="0" selected>Original</option>
              <option value="2000">2000px</option>
              <option value="1600">1600px</option>
              <option value="1200">1200px</option>
            </select>
          </div>
          <div class="quality-wrap">
            <span>QUALITY</span>
            <select id="webpQuality">
              <option value="0.90">90% (High)</option>
              <option value="0.85">85% (Good)</option>
              <option value="0.80" selected>80% (Normal)</option>
              <option value="0.75">75% (Small)</option>
            </select>
          </div>
        </div>
      </div>

      <input type="file" id="folderInput" webkitdirectory directory multiple hidden />
      <input type="file" id="fileInput" multiple accept="image/*" hidden />

      <div class="dropzone" id="dropzone">
        <div class="dropzone-icon">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="square">
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
          </svg>
        </div>
        <div class="dropzone-title">Drop your files or folders here</div>
        <div class="pick-btns">
          <button type="button" class="btn-pick" id="pickFolderBtn">Select Folder</button>
          <button type="button" class="btn-pick" id="pickFileBtn">Select Files</button>
        </div>
      </div>

      <div class="groups-wrap" id="groupsWrap">
        <div class="groups-header">
          <span class="groups-title" id="groupsSummary">Queue</span>
          <div class="groups-actions">
            <button type="button" class="btn-mini" id="btnRecheck">Re-check</button>
            <button type="button" class="btn-mini" id="btnCheckAll">Select All</button>
            <button type="button" class="btn-mini danger" id="btnReset">Reset</button>
          </div>
        </div>

        <div class="warn-banner" id="warnBanner"></div>
        <div class="group-list" id="groupList"></div>
      </div>

      <button type="button" class="btn-primary" id="uploadBtn">Upload</button>

      <div class="progress-panel" id="progressPanel">
        <div class="progress-stage" id="convStage">
          <div class="progress-top">
            <span class="progress-label" id="convLabel">Converting to WebP...</span>
            <span class="progress-pct" id="convPct">0%</span>
          </div>
          <div class="progress-track">
            <div class="progress-fill" id="convFill"></div>
          </div>
          <div class="progress-sub">
            <span id="convCount">0 / 0 files</span>
            <span id="convSaved">Saved 0.00 MB</span>
          </div>
        </div>

        <div class="progress-stage" id="upStage">
          <div class="progress-top">
            <span class="progress-label" id="upLabel">Uploading...</span>
            <span class="progress-pct" id="upPct">0%</span>
          </div>
          <div class="progress-track">
            <div class="progress-fill" id="upFill"></div>
          </div>
          <div class="progress-sub">
            <span id="upCount">0 / 0 files</span>
            <span id="upBytes">0.00 / 0.00 MB</span>
          </div>
        </div>
      </div>

      <div class="status" id="status"></div>
    </div>

    <div class="card result-card" id="resultCard">
      <div class="result-header">
        <span class="result-title">Uploaded URLs</span>
        <button type="button" class="btn-mini" id="copyAllBtn">Copy All</button>
      </div>
      <div class="result-list" id="resultList"></div>
    </div>
  </div>

  <script>
    var uploadGroups = [];
    var isUploading = false;
    var imgExtRegex = /[.](webp|jpe?g|png|avif|gif)$/i;
    var stripExtRegex = /[.][^.]+$/;

    var pwdInput = document.getElementById("password");
    var rootInput = document.getElementById("rootPrefix");
    var convertWebpChk = document.getElementById("convertWebpChk");
    var maxWidthSel = document.getElementById("maxWidthSel");
    var webpQualitySel = document.getElementById("webpQuality");
    var qualityWrap = document.getElementById("qualityWrap");
    var folderInput = document.getElementById("folderInput");
    var fileInput = document.getElementById("fileInput");
    var dropzone = document.getElementById("dropzone");
    var groupsWrap = document.getElementById("groupsWrap");
    var groupsSummary = document.getElementById("groupsSummary");
    var warnBanner = document.getElementById("warnBanner");
    var groupList = document.getElementById("groupList");
    var uploadBtn = document.getElementById("uploadBtn");

    var progressPanel = document.getElementById("progressPanel");
    var convStage = document.getElementById("convStage");
    var convLabel = document.getElementById("convLabel");
    var convPct = document.getElementById("convPct");
    var convFill = document.getElementById("convFill");
    var convCount = document.getElementById("convCount");
    var convSaved = document.getElementById("convSaved");

    var upStage = document.getElementById("upStage");
    var upLabel = document.getElementById("upLabel");
    var upPct = document.getElementById("upPct");
    var upFill = document.getElementById("upFill");
    var upCount = document.getElementById("upCount");
    var upBytes = document.getElementById("upBytes");

    var statusEl = document.getElementById("status");
    var resultCard = document.getElementById("resultCard");
    var resultList = document.getElementById("resultList");

    document.getElementById("hostPill").textContent = window.location.host;
    pwdInput.value = localStorage.getItem("cdn_admin_pwd") || "";

    var savedWebp = localStorage.getItem("cdn_convert_webp");
    if (savedWebp !== null) convertWebpChk.checked = savedWebp === "1";
    var savedQuality = localStorage.getItem("cdn_webp_quality");
    if (savedQuality) webpQualitySel.value = savedQuality;
    var savedMaxWidth = localStorage.getItem("cdn_webp_max_width");
    if (savedMaxWidth) maxWidthSel.value = savedMaxWidth;

    function syncWebpOptionsUI() {
      var enabled = convertWebpChk.checked;
      qualityWrap.style.opacity = enabled ? "1" : "0.4";
      webpQualitySel.disabled = !enabled;
      maxWidthSel.disabled = !enabled;
    }
    syncWebpOptionsUI();

    convertWebpChk.addEventListener("change", function () {
      localStorage.setItem("cdn_convert_webp", this.checked ? "1" : "0");
      syncWebpOptionsUI();
    });

    webpQualitySel.addEventListener("change", function () {
      localStorage.setItem("cdn_webp_quality", this.value);
    });

    maxWidthSel.addEventListener("change", function () {
      localStorage.setItem("cdn_webp_max_width", this.value);
    });

    document.getElementById("togglePwdBtn").addEventListener("click", function () {
      var isPwd = pwdInput.type === "password";
      pwdInput.type = isPwd ? "text" : "password";
      this.textContent = isPwd ? "HIDE" : "SHOW";
    });

    document.getElementById("pickFolderBtn").addEventListener("click", function () {
      if (!isUploading) folderInput.click();
    });
    document.getElementById("pickFileBtn").addEventListener("click", function () {
      if (!isUploading) fileInput.click();
    });

    rootInput.addEventListener("input", function () {
      var prefix = sanitizePathSlug(this.value);
      uploadGroups.forEach(function (g) {
        if (!g.isLoose) {
          g.targetPath = prefix ? prefix + "/" + g.folderSlug : g.folderSlug;
          g.status = "unchecked";
          g.existingCount = 0;
        }
      });
      renderGroups();
    });

    dropzone.addEventListener("dragover", function (e) {
      e.preventDefault();
      if (!isUploading) dropzone.classList.add("dragover");
    });

    dropzone.addEventListener("dragleave", function () {
      dropzone.classList.remove("dragover");
    });

    dropzone.addEventListener("drop", async function (e) {
      e.preventDefault();
      dropzone.classList.remove("dragover");
      if (isUploading) return;

      var items = e.dataTransfer && e.dataTransfer.items ? Array.from(e.dataTransfer.items) : [];
      var entries = items
        .map(function (item) { return item.webkitGetAsEntry ? item.webkitGetAsEntry() : null; })
        .filter(Boolean);

      if (entries.length > 0) {
        var collected = [];
        for (var i = 0; i < entries.length; i++) {
          await traverseEntry(entries[i], "", collected);
        }
        await buildUploadGroups(collected);
      } else if (e.dataTransfer && e.dataTransfer.files) {
        var fallback = Array.from(e.dataTransfer.files).map(function (f) {
          return { file: f, relPath: f.webkitRelativePath || f.name };
        });
        await buildUploadGroups(fallback);
      }
    });

    folderInput.addEventListener("change", async function (e) {
      if (!e.target.files || e.target.files.length === 0) return;
      var list = Array.from(e.target.files).map(function (f) {
        return { file: f, relPath: f.webkitRelativePath || f.name };
      });
      folderInput.value = "";
      await buildUploadGroups(list);
    });

    fileInput.addEventListener("change", async function (e) {
      if (!e.target.files || e.target.files.length === 0) return;
      var list = Array.from(e.target.files).map(function (f) {
        return { file: f, relPath: f.name };
      });
      fileInput.value = "";
      await buildUploadGroups(list);
    });

    document.getElementById("btnRecheck").addEventListener("click", function () {
      if (!isUploading && uploadGroups.length > 0) checkExistingFolders();
    });

    document.getElementById("btnCheckAll").addEventListener("click", function () {
      if (isUploading) return;
      uploadGroups.forEach(function (g) { g.selected = true; });
      renderGroups();
    });

    document.getElementById("btnReset").addEventListener("click", function () {
      if (isUploading) return;
      uploadGroups = [];
      rootInput.value = "";
      groupsWrap.classList.remove("show");
      warnBanner.classList.remove("show");
      statusEl.classList.remove("show");
      progressPanel.classList.remove("show");
    });

    function isValidImage(file) {
      if (!file || file.name.indexOf(".") === 0) return false;
      if (file.type && file.type.indexOf("image/") === 0) return true;
      return imgExtRegex.test(file.name);
    }

    function formatMB(bytes) {
      return (bytes / 1048576).toFixed(2) + " MB";
    }

    function slugifySegment(str) {
      return String(str || "")
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9._-]+/g, "-")
        .replace(/^-+|-+$/g, "");
    }

    function sanitizePathSlug(str) {
      var trimmed = String(str || "").trim();
      if (trimmed === "/") return "/";
      return trimmed
        .split("/")
        .map(slugifySegment)
        .filter(Boolean)
        .join("/");
    }

    function sleep(ms) {
      return new Promise(function (resolve) { setTimeout(resolve, ms); });
    }

    function nextFrame() {
      return new Promise(function (resolve) { requestAnimationFrame(resolve); });
    }

    function convertFileToWebP(file, quality, maxWidth) {
      return new Promise(function (resolve) {
        var lowerName = file.name.toLowerCase();
        var isGif = lowerName.endsWith(".gif") || file.type === "image/gif";
        var isAlreadyWebp = lowerName.endsWith(".webp") || file.type === "image/webp";

        if (isGif || (isAlreadyWebp && !maxWidth)) {
          resolve({ file: file, converted: false });
          return;
        }

        var objUrl = URL.createObjectURL(file);
        var img = new Image();

        img.onload = function () {
          try {
            var srcW = img.naturalWidth || img.width;
            var srcH = img.naturalHeight || img.height;
            var targetW = srcW;
            var targetH = srcH;

            if (maxWidth > 0 && srcW > maxWidth) {
              targetW = maxWidth;
              targetH = Math.round((srcH * maxWidth) / srcW);
            }

            if (isAlreadyWebp && targetW === srcW) {
              URL.revokeObjectURL(objUrl);
              resolve({ file: file, converted: false });
              return;
            }

            var canvas = document.createElement("canvas");
            canvas.width = targetW;
            canvas.height = targetH;
            var ctx = canvas.getContext("2d");
            ctx.drawImage(img, 0, 0, targetW, targetH);

            canvas.toBlob(function (blob) {
              URL.revokeObjectURL(objUrl);
              if (!blob || blob.size >= file.size) {
                resolve({ file: file, converted: false });
                return;
              }
              var newName = file.name.replace(stripExtRegex, ".webp");
              var convertedFile = new File([blob], newName, {
                type: "image/webp",
                lastModified: Date.now(),
              });
              resolve({ file: convertedFile, converted: true });
            }, "image/webp", quality);
          } catch (e) {
            URL.revokeObjectURL(objUrl);
            resolve({ file: file, converted: false });
          }
        };

        img.onerror = function () {
          URL.revokeObjectURL(objUrl);
          resolve({ file: file, converted: false });
        };

        img.src = objUrl;
      });
    }

    function traverseEntry(entry, parentPath, out) {
      return new Promise(function (resolve) {
        if (entry.isFile) {
          entry.file(function (file) {
            var rel = parentPath ? parentPath + "/" + file.name : file.name;
            out.push({ file: file, relPath: rel });
            resolve();
          }, function () { resolve(); });
        } else if (entry.isDirectory) {
          var dirReader = entry.createReader();
          var nextParent = parentPath ? parentPath + "/" + entry.name : entry.name;
          var readAll = function () {
            dirReader.readEntries(async function (batch) {
              if (!batch || batch.length === 0) {
                resolve();
                return;
              }
              for (var i = 0; i < batch.length; i++) {
                await traverseEntry(batch[i], nextParent, out);
              }
              readAll();
            }, function () { resolve(); });
          };
          readAll();
        } else {
          resolve();
        }
      });
    }

    async function buildUploadGroups(items) {
      var validItems = items.filter(function (it) { return isValidImage(it.file); });
      if (validItems.length === 0) {
        setStatus("No valid image files found.", "error");
        return;
      }

      statusEl.classList.remove("show");
      var detectedRoot = "";
      var folderMap = {};
      var looseFiles = [];

      validItems.forEach(function (it) {
        var normalizedRel = String(it.relPath || "").split(String.fromCharCode(92)).join("/");
        var parts = normalizedRel.split("/").filter(Boolean);
        parts.pop();

        if (parts.length === 0) {
          looseFiles.push(it.file);
        } else if (parts.length === 1) {
          var singleFolder = slugifySegment(parts[0]) || "uploads";
          if (!folderMap[singleFolder]) {
            folderMap[singleFolder] = { folderSlug: singleFolder, files: [] };
          }
          folderMap[singleFolder].files.push(it.file);
        } else {
          var rootSeg = slugifySegment(parts[0]);
          var subPath = parts.slice(1).map(slugifySegment).filter(Boolean).join("/");
          if (rootSeg) detectedRoot = rootSeg;
          if (!folderMap[subPath]) {
            folderMap[subPath] = { folderSlug: subPath, files: [] };
          }
          folderMap[subPath].files.push(it.file);
        }
      });

      if (detectedRoot) {
        rootInput.value = detectedRoot;
      } else if (Object.keys(folderMap).length > 0) {
        rootInput.value = "";
      }

      var activeRoot = sanitizePathSlug(rootInput.value);
      var builtGroups = [];

      Object.keys(folderMap)
        .sort(function (a, b) {
          return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
        })
        .forEach(function (key) {
          var grp = folderMap[key];
          grp.files.sort(function (a, b) {
            return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
          });
          builtGroups.push({
            isLoose: false,
            folderSlug: grp.folderSlug,
            targetPath: activeRoot && activeRoot !== "/" ? activeRoot + "/" + grp.folderSlug : grp.folderSlug,
            files: grp.files,
            selected: true,
            status: "unchecked",
            existingCount: 0,
            uploadPct: 0,
          });
        });

      if (looseFiles.length > 0) {
        looseFiles.sort(function (a, b) {
          return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
        });
        builtGroups.push({
          isLoose: true,
          folderSlug: "",
          targetPath: "",
          files: looseFiles,
          selected: true,
          status: "unchecked",
          existingCount: 0,
          uploadPct: 0,
        });
      }

      uploadGroups = builtGroups;
      renderGroups();

      if (looseFiles.length > 0) {
        var emptyInp = groupList.querySelector(".group-path-input[data-empty='1']");
        if (emptyInp) emptyInp.focus();
      }

      if (uploadGroups.some(function (g) { return Boolean(g.targetPath); })) {
        await checkExistingFolders();
      }
    }

    async function checkExistingFolders() {
      var password = pwdInput.value.trim();
      var checkTargets = uploadGroups.filter(function (g) { return Boolean(g.targetPath); });
      if (!password || checkTargets.length === 0) return;

      checkTargets.forEach(function (g) { g.status = "checking"; });
      renderGroups();

      try {
        var res = await fetch("/api/check", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Admin-Password": password,
          },
          body: JSON.stringify({
            folders: checkTargets.map(function (g) { return g.targetPath; }),
          }),
        });

        if (!res.ok) {
          checkTargets.forEach(function (g) { g.status = "unchecked"; });
          renderGroups();
          return;
        }

        var data = await res.json();
        var results = data.results || {};

        checkTargets.forEach(function (g) {
          var info = results[g.targetPath];
          if (info && info.exists) {
            g.status = "exists";
            g.existingCount = info.count;
            if (uploadGroups.length > 1) {
              g.selected = false;
            }
          } else {
            g.status = "new";
            g.existingCount = 0;
            g.selected = true;
          }
        });

        renderGroups();
      } catch (e) {
        checkTargets.forEach(function (g) { g.status = "unchecked"; });
        renderGroups();
      }
    }

    function renderGroups() {
      if (uploadGroups.length === 0) {
        groupsWrap.classList.remove("show");
        return;
      }

      groupsWrap.classList.add("show");
      groupList.innerHTML = "";

      var existingFolders = uploadGroups.filter(function (g) { return g.status === "exists"; });
      var totalFiles = uploadGroups.reduce(function (s, g) { return s + g.files.length; }, 0);
      groupsSummary.textContent = uploadGroups.length + " Target(s) • " + totalFiles + " File(s)";

      if (existingFolders.length > 0 && !isUploading) {
        var names = existingFolders.map(function (g) {
          return "<b>" + g.targetPath + "</b> (" + g.existingCount + ")";
        }).join(", ");
        warnBanner.innerHTML = "Existing folder: " + names;
        warnBanner.classList.add("show");
      } else {
        warnBanner.classList.remove("show");
      }

      uploadGroups.forEach(function (grp) {
        var row = document.createElement("div");
        var extraClass = "";
        if (grp.status === "uploading") extraClass = " uploading";
        else if (grp.status === "exists") extraClass = " exists";
        else if (!grp.targetPath) extraClass = " missing-path";
        row.className = "group-item" + extraClass;

        var badgeHtml = "";
        if (grp.status === "uploading") {
          badgeHtml = '<span class="badge uploading">' + grp.uploadPct + '%</span>';
        } else if (grp.status === "checking") {
          badgeHtml = '<span class="badge checking">Checking</span>';
        } else if (grp.status === "exists") {
          badgeHtml = '<span class="badge exists">Exists (' + grp.existingCount + ')</span>';
        } else if (grp.status === "new") {
          badgeHtml = '<span class="badge new">New</span>';
        }

        var isEmpty = !grp.targetPath ? ' data-empty="1"' : "";

        row.innerHTML =
          '<div class="group-left">' +
            '<input type="checkbox" ' + (grp.selected ? "checked" : "") + (isUploading ? " disabled" : "") + ' />' +
            '<input type="text" class="group-path-input" placeholder="folder/path or /" value="' + grp.targetPath + '"' + isEmpty + (isUploading ? " disabled" : "") + ' />' +
          '</div>' +
          '<div class="group-right">' +
            badgeHtml +
            '<span class="file-count">' + grp.files.length + (grp.files.length === 1 ? ' file' : ' files') + '</span>' +
          '</div>';

        var chk = row.querySelector('input[type="checkbox"]');
        chk.addEventListener("change", function () {
          grp.selected = this.checked;
        });

        var pathInp = row.querySelector(".group-path-input");
        pathInp.addEventListener("input", function () {
          grp.targetPath = sanitizePathSlug(this.value);
          if (grp.targetPath) {
            row.classList.remove("missing-path");
          } else {
            row.classList.add("missing-path");
          }
        });
        pathInp.addEventListener("change", function () {
          grp.targetPath = sanitizePathSlug(this.value);
          this.value = grp.targetPath;
          if (grp.targetPath) {
            checkExistingFolders();
          } else {
            grp.status = "unchecked";
            renderGroups();
          }
        });

        groupList.appendChild(row);
      });
    }

    function setStatus(msg, type) {
      statusEl.textContent = msg;
      statusEl.className = "status show" + (type ? " " + type : "");
    }

    function updateConvUI(label, pct, doneFiles, totalFiles, savedBytes, state) {
      var clamped = Math.max(0, Math.min(100, Math.round(pct)));
      convLabel.textContent = label;
      convPct.textContent = clamped + "%";
      convFill.style.width = clamped + "%";
      convCount.textContent = doneFiles + " / " + totalFiles + " files";
      convSaved.textContent = "Saved " + formatMB(savedBytes);

      convFill.className = "progress-fill" + (state ? " " + state : "");
      convPct.className = "progress-pct" + (state === "done" ? " done" : "");
    }

    function updateUploadUI(label, pct, doneFiles, totalFiles, doneBytes, totalBytes, state) {
      var clamped = Math.max(0, Math.min(100, Math.round(pct)));
      upLabel.textContent = label;
      upPct.textContent = clamped + "%";
      upFill.style.width = clamped + "%";
      upCount.textContent = doneFiles + " / " + totalFiles + " files";
      upBytes.textContent = formatMB(doneBytes) + " / " + formatMB(totalBytes);

      upFill.className = "progress-fill" + (state ? " " + state : "");
      upPct.className = "progress-pct" + (state === "done" ? " done" : "");
    }

    function uploadBatchXHR(url, password, formData, onProgress) {
      return new Promise(function (resolve, reject) {
        var xhr = new XMLHttpRequest();
        xhr.open("POST", url, true);
        xhr.setRequestHeader("X-Admin-Password", password);

        xhr.upload.onprogress = function (e) {
          if (e.lengthComputable && typeof onProgress === "function") {
            onProgress(e.loaded, e.total);
          }
        };

        xhr.onload = function () {
          var data = {};
          try {
            data = JSON.parse(xhr.responseText || "{}");
          } catch (e) {
            var parseErr = new Error("Invalid response (" + xhr.status + ")");
            parseErr.status = xhr.status;
            reject(parseErr);
            return;
          }
          if (xhr.status >= 200 && xhr.status < 300) {
            resolve(data);
          } else {
            var httpErr = new Error(data.error || "Upload failed (" + xhr.status + ")");
            httpErr.status = xhr.status;
            reject(httpErr);
          }
        };

        xhr.onerror = function () {
          var netErr = new Error("Network error.");
          netErr.status = 0;
          reject(netErr);
        };

        xhr.send(formData);
      });
    }

    async function uploadBatchWithRetry(url, password, folderPath, filesBatch, onProgress, onRetry) {
      var MAX_RETRIES = 3;
      var attempt = 0;

      while (true) {
        attempt++;
        try {
          var fd = new FormData();
          fd.append("folder", folderPath);
          filesBatch.forEach(function (f) { fd.append("files", f); });
          return await uploadBatchXHR(url, password, fd, onProgress);
        } catch (err) {
          if (err.status === 401 || err.status === 400 || attempt >= MAX_RETRIES) {
            throw err;
          }
          if (typeof onRetry === "function") {
            onRetry(attempt + 1, MAX_RETRIES);
          }
          await sleep(2000 * attempt);
        }
      }
    }

    uploadBtn.addEventListener("click", async function () {
      var password = pwdInput.value.trim();
      if (!password) {
        setStatus("Password required.", "error");
        pwdInput.focus();
        return;
      }
      localStorage.setItem("cdn_admin_pwd", password);

      if (uploadGroups.length === 0) {
        setStatus("No files selected.", "error");
        return;
      }

      var missingPathGroup = uploadGroups.find(function (g) { return g.selected && !g.targetPath; });
      if (missingPathGroup) {
        setStatus("Enter target folder path.", "error");
        var emptyInp = groupList.querySelector(".group-path-input[data-empty='1']");
        if (emptyInp) emptyInp.focus();
        return;
      }

      if (uploadGroups.some(function (g) { return g.selected && g.status === "unchecked"; })) {
        await checkExistingFolders();
      }

      var toUpload = uploadGroups.filter(function (g) { return g.selected && g.targetPath; });
      if (toUpload.length === 0) {
        setStatus("No targets selected.", "error");
        return;
      }

      var overwriteList = toUpload.filter(function (g) { return g.status === "exists"; });
      if (overwriteList.length > 0) {
        var msg = overwriteList.length === 1
          ? 'Folder "' + overwriteList[0].targetPath + '" already exists. Overwrite?'
          : overwriteList.length + " folders already exist. Overwrite?";
        if (!window.confirm(msg)) {
          return;
        }
      }

      var useWebP = convertWebpChk.checked;
      var webpQuality = parseFloat(webpQualitySel.value) || 0.80;
      var maxWidth = parseInt(maxWidthSel.value, 10) || 0;

      isUploading = true;
      uploadBtn.disabled = true;
      convertWebpChk.disabled = true;
      webpQualitySel.disabled = true;
      maxWidthSel.disabled = true;
      statusEl.classList.remove("show");
      resultCard.classList.remove("show");
      resultList.innerHTML = "";

      progressPanel.classList.add("show");
      convStage.classList.remove("show");
      upStage.classList.remove("show");

      var totalFilesAll = toUpload.reduce(function (s, g) { return s + g.files.length; }, 0);
      var preparedGroups = [];
      var savedBytesTotal = 0;
      var actualConvertedCount = 0;

      try {
        if (useWebP) {
          convStage.classList.add("show");
          var processedCount = 0;
          updateConvUI("Converting to WebP...", 0, 0, totalFilesAll, 0, "");

          for (var cGrpIdx = 0; cGrpIdx < toUpload.length; cGrpIdx++) {
            var srcGrp = toUpload[cGrpIdx];
            var convFiles = [];

            for (var fIdx = 0; fIdx < srcGrp.files.length; fIdx++) {
              var origFile = srcGrp.files[fIdx];
              var result = await convertFileToWebP(origFile, webpQuality, maxWidth);
              if (result.converted) {
                actualConvertedCount++;
                savedBytesTotal += (origFile.size - result.file.size);
              }
              convFiles.push(result.file);
              processedCount++;

              updateConvUI(
                "Converting to WebP...",
                (processedCount / totalFilesAll) * 100,
                processedCount,
                totalFilesAll,
                savedBytesTotal,
                ""
              );
              await nextFrame();
            }

            preparedGroups.push({
              groupRef: srcGrp,
              targetPath: srcGrp.targetPath,
              files: convFiles,
            });
          }

          var doneConvLabel =
            actualConvertedCount > 0
              ? "WebP conversion complete (" + actualConvertedCount + "/" + totalFilesAll + " converted)"
              : "Kept original (already optimal)";

          updateConvUI(
            doneConvLabel,
            100,
            totalFilesAll,
            totalFilesAll,
            savedBytesTotal,
            "done"
          );
        } else {
          preparedGroups = toUpload.map(function (g) {
            return {
              groupRef: g,
              targetPath: g.targetPath,
              files: g.files,
            };
          });
        }

        upStage.classList.add("show");

        var totalBytesAll = preparedGroups.reduce(function (s, g) {
          return s + g.files.reduce(function (fs, f) { return fs + f.size; }, 0);
        }, 0);

        var uploadedFilesAll = 0;
        var uploadedBytesAll = 0;
        var completedResults = [];
        var BATCH_SIZE = 5;

        updateUploadUI("Uploading...", 0, 0, totalFilesAll, 0, totalBytesAll, "");

        for (var gIdx = 0; gIdx < preparedGroups.length; gIdx++) {
          var itemGrp = preparedGroups[gIdx];
          var origGrp = itemGrp.groupRef;
          var totalInGrp = itemGrp.files.length;
          var uploadedInGrp = 0;
          var folderUrl = "";
          var collectedFileUrls = [];

          origGrp.status = "uploading";
          origGrp.uploadPct = 0;
          renderGroups();

          for (var i = 0; i < totalInGrp; i += BATCH_SIZE) {
            var batch = itemGrp.files.slice(i, i + BATCH_SIZE);
            var endIdx = Math.min(i + BATCH_SIZE, totalInGrp);
            var batchBytes = batch.reduce(function (s, f) { return s + f.size; }, 0);
            var labelText = itemGrp.targetPath + " (" + (i + 1) + "-" + endIdx + "/" + totalInGrp + ")";

            var data = await uploadBatchWithRetry(
              "/api/upload",
              password,
              itemGrp.targetPath,
              batch,
              function (loaded, total) {
                var ratio = total > 0 ? Math.min(loaded / total, 1) : 0;
                var weightedRatio = ratio * 0.85;
                var currentBytes = uploadedBytesAll + Math.round(batchBytes * ratio);
                var currentFiles = uploadedFilesAll + (batch.length * weightedRatio);
                var overallPct = Math.min(99, (currentFiles / totalFilesAll) * 100);

                var grpFilesNow = uploadedInGrp + (batch.length * weightedRatio);
                origGrp.uploadPct = Math.min(99, Math.round((grpFilesNow / totalInGrp) * 100));

                var badgeEl = groupList.querySelector(".group-item.uploading .badge");
                if (badgeEl) badgeEl.textContent = origGrp.uploadPct + "%";

                updateUploadUI(
                  ratio >= 1 ? labelText + " • Committing..." : labelText,
                  overallPct,
                  uploadedFilesAll,
                  totalFilesAll,
                  currentBytes,
                  totalBytesAll,
                  ""
                );
              },
              function (nextAttempt, maxRetries) {
                updateUploadUI(
                  "Retrying (" + nextAttempt + "/" + maxRetries + ")...",
                  (uploadedFilesAll / totalFilesAll) * 100,
                  uploadedFilesAll,
                  totalFilesAll,
                  uploadedBytesAll,
                  totalBytesAll,
                  ""
                );
              }
            );

            uploadedInGrp += data.uploadedCount || batch.length;
            uploadedFilesAll += data.uploadedCount || batch.length;
            uploadedBytesAll += batchBytes;
            folderUrl = data.folderUrl;
            if (Array.isArray(data.fileUrls)) {
              collectedFileUrls = collectedFileUrls.concat(data.fileUrls);
            }

            origGrp.uploadPct = Math.round((uploadedInGrp / totalInGrp) * 100);
            updateUploadUI(
              labelText,
              (uploadedFilesAll / totalFilesAll) * 100,
              uploadedFilesAll,
              totalFilesAll,
              uploadedBytesAll,
              totalBytesAll,
              ""
            );
          }

          origGrp.status = "exists";
          origGrp.existingCount = totalInGrp;
          origGrp.selected = false;

          completedResults.push({
            folderUrl: folderUrl,
            fileUrls: collectedFileUrls,
          });
          renderGroups();
        }

        updateUploadUI(
          "Upload complete",
          100,
          totalFilesAll,
          totalFilesAll,
          totalBytesAll,
          totalBytesAll,
          "done"
        );
        renderResultUrls(completedResults);
      } catch (err) {
        upStage.classList.add("show");
        updateUploadUI(
          err.message,
          (uploadedFilesAll / Math.max(totalFilesAll, 1)) * 100,
          uploadedFilesAll,
          totalFilesAll,
          uploadedBytesAll,
          uploadedBytesAll,
          "error"
        );
        setStatus(err.message, "error");
      } finally {
        isUploading = false;
        uploadBtn.disabled = false;
        convertWebpChk.disabled = false;
        syncWebpOptionsUI();
        renderGroups();
      }
    });

    function renderResultUrls(results) {
      resultList.innerHTML = "";
      results.forEach(function (resItem) {
        var displayUrl = resItem.fileUrls.length === 1 ? resItem.fileUrls[0] : resItem.folderUrl;
        var openLabel = resItem.fileUrls.length === 1 ? "Open" : "JSON";

        var row = document.createElement("div");
        row.className = "url-group";
        row.innerHTML =
          '<input type="text" readonly value="' + displayUrl + '" />' +
          '<button type="button" class="btn-sec copy-one-btn">Copy</button>' +
          '<a class="btn-sec" href="' + displayUrl + '" target="_blank" rel="noopener">' + openLabel + '</a>';

        row.querySelector(".copy-one-btn").addEventListener("click", function () {
          navigator.clipboard.writeText(displayUrl);
          var btn = this;
          btn.textContent = "Copied";
          setTimeout(function () { btn.textContent = "Copy"; }, 1400);
        });
        resultList.appendChild(row);
      });
      resultCard.classList.add("show");
    }

    document.getElementById("copyAllBtn").addEventListener("click", function () {
      var inputs = resultList.querySelectorAll("input");
      if (!inputs.length) return;
      var allText = Array.from(inputs).map(function (i) { return i.value; }).join(String.fromCharCode(10));
      navigator.clipboard.writeText(allText);
      var btn = this;
      btn.textContent = "Copied";
      setTimeout(function () { btn.textContent = "Copy All"; }, 1400);
    });
  </script>
</body>
</html>`;
}
