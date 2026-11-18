# Cloudflare Worker + Hugging Face Image CDN

A zero-dependency, single-file Cloudflare Worker that turns a Hugging Face Dataset repository into a fast, edge-cached image CDN with a built-in web uploader, client-side WebP optimizer, and JSON folder manifest API.

## Features

- **Edge-Cached Image Delivery:** Proxies `.webp`, `.jpg`, `.jpeg`, `.png`, `.avif`, and `.gif` files from Hugging Face Datasets with CORS headers and `public, max-age=31536000, immutable` caching via Cloudflare's Cache API.
- **JSON Folder Manifests:** Requesting any folder path (e.g., `GET /gallery/album-01`) returns a naturally sorted JSON list of all image URLs inside that directory, cached at the edge (`max-age=3600`) and automatically invalidated upon new uploads.
- **Client-Side WebP Conversion & Resizing:** Converts images to WebP directly in the browser before upload with configurable quality (`75%`–`90%`) and optional max-width downscaling (`Original`, `2000px`, `1600px`, `1200px`). Automatically keeps the original file if the converted WebP is not smaller.
- **Hybrid Drag-and-Drop Uploader (`/upload`):**
  - Automatically detects nested folder structures and applies an optional Root Folder prefix.
  - Leaves the target path blank for loose individual files (supports uploading to subfolders or directly to `/` root).
  - Checks existing folders on Hugging Face before uploading and warns before overwriting.
  - Two-stage persistent progress bars (WebP conversion savings + batched upload progress with automatic retry).
- **Private Repository Support:** Authenticates upstream requests using your Hugging Face token, allowing you to keep your dataset repository private while serving images publicly through your custom domain.

## How It Works

1. **Upload Flow:** The `/upload` UI processes images in the browser, sends them in batches of 5 to `/api/upload`, hashes each file (`SHA-256`), negotiates upload URLs via the Hugging Face Git LFS Batch API, and commits all files in a single atomic NDJSON commit to `main`.
2. **Delivery Flow:** Public `GET` requests to `/<path>/<image>.<ext>` check Cloudflare's edge cache first. On a cache miss, the Worker fetches the file from Hugging Face (`resolve/main/...`), streams it to the client, and stores it at the edge.
3. **Protection:** Visiting `/` or non-existent paths returns a custom `404` page without exposing your repository index.

## Setup & Deployment

### 1. Create a Hugging Face Dataset & Token

1. Create a new **Dataset** repository on [Hugging Face](https://huggingface.co/new-dataset) (e.g., `username/my-image-cdn`).
2. Go to **Settings → Access Tokens** and generate a token with **Write** permissions.

### 2. Deploy to Cloudflare Workers

1. Create a new Worker in the **Cloudflare Dashboard** (or via Wrangler CLI) and paste the Worker script into `worker.js` / `index.js`.
2. Attach a Custom Domain or Route to the Worker (e.g., `img.example.com/*`).

### 3. Configure Environment Variables

In your Worker's **Settings → Variables and Secrets**, add the following variables (encrypt all values as Secrets):

| Variable | Description | Example |
| :--- | :--- | :--- |
| `HF_REPO` | Target Hugging Face dataset (`owner/repo-name`) | `johndoe/cdn-assets` |
| `HF_TOKEN` | Hugging Face User Access Token with `write` access | `hf_xxxxxxxxxxxxxxxxxxxx` |
| `ADMIN_PASSWORD` | Password required to check folders and upload files | `your-strong-password` |

## Usage

### Web Uploader

Navigate to `https://your-domain.com/upload`, enter your `ADMIN_PASSWORD`, configure your WebP/resize preferences, and drop folders or individual files into the dropzone.

- **Folders:** Automatically mapped to `<root-folder>/<subfolder-name>`.
- **Loose Files:** Enter any target path (e.g., `banners/2026` or `/` for root) before clicking **Upload**.

### Image URLs

Once uploaded, files are accessible directly via your Worker domain:

```text
[https://your-domain.com/banners/2026/hero.webp](https://your-domain.com/banners/2026/hero.webp)
