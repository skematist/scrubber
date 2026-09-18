# Frame Scrubber

Browse a movie as thumbnails and export full-resolution, frame-accurate stills — no more scrubbing an FLV player. Optionally index a movie with **Azure AI Video Indexer** to unlock semantic navigation: browse by camera shot and scene, filter by who's on screen, and search dialog/objects/on-screen text.

## Run it

```
npm install
npm start
```

Open http://localhost:3020. ffmpeg/ffprobe are bundled via npm — nothing else to install.

## Basic use (no Azure needed)

1. Enter or **Browse…** to a movie file (local or UNC path) and press **Load**.
2. Top grid shows a thumbnail every 5 s (configurable). Click one.
3. Bottom panel fills with **every frame** in that window. Click a frame for a large preview (←/→ steps a frame at a time).
4. **Export full-res** saves a lossless PNG (or max-quality JPG) of that exact frame to your export folder (default `Pictures\frame-exports`). The export always decodes from the original file at original resolution.

Thumbnails and frame strips are cached in `%LOCALAPPDATA%\FrameScrubber\cache`, so revisiting a movie is instant.

## Semantic navigation (Azure Video Indexer)

After indexing, the app switches to **Shots** mode:

- **Shot grid** — one card per camera shot, grouped by scene, with editorial badges (wide, close-up, two-shot, indoor/outdoor). Clicking a shot loads exactly that shot's frames below.
- **Cast rail** — every detected face as a chip with screen time. Check two people to see only shots where they appear **together** — the leftmost result is their first meeting. Double-click to rename ("Person 1" → "Obi-Wan").
- **Search box** — filters shots live by transcript dialog, visual labels, on-screen text (OCR), keywords, and named entities. Matching shots show the matched line under the card.

All filtering runs locally against a cached insights file — the movie is uploaded and billed **once**.

### Azure setup (one time)

1. You need an Azure subscription and a **paid (ARM-based) Video Indexer account** — the free trial cannot be used via API. In the Azure portal: **Create a resource → "Azure AI Video Indexer"**. The wizard creates/links a storage account and a managed identity — accept the defaults.
2. Give yourself **Contributor** on the Video Indexer resource (Access control (IAM) → Add role assignment). This is what authorizes token generation.
3. Sign in on this machine: `az login` (Azure CLI). Alternatively paste a temporary access token in the app's settings (expires hourly).
4. In the app, click **⚙️** and fill in: Subscription ID, Resource group, Account name, **Account ID** (GUID on the VI resource's Overview page), and Location (e.g. `eastus`). **Save & test** tells you exactly what's wrong if anything fails.

### Indexing a movie

Click **✨ Index with Azure**. The app:

1. Encodes a 720p proxy locally (insight quality is equivalent to full-res per Microsoft's guidance; required because direct uploads cap at 2 GB).
2. Uploads it (private, `NoStreaming` — no encoding charges) and polls until Azure finishes.
3. Downloads face thumbnails and builds a compact local index (`insights.json`).

**Cost**: Standard preset ≈ $0.114 per movie-minute → **roughly $10 for a 90-minute film**, billed once. **Time**: typically tens of minutes; progress is shown on the button, and an interrupted index resumes without re-uploading or re-billing.

**Names**: celebrity naming is an Azure *Limited Access* feature requiring [registration](https://learn.microsoft.com/azure/azure-video-indexer/limited-access-features). Without it, faces arrive as unnamed groups — rename them once in the cast rail. Minor characters with under ~4 s of screen time may not get a face group.

To remove a movie's index (locally and from the cloud account): `DELETE /api/vi/index?file=<path>&cloud=1`.

## Architecture

- [server.js](server.js) — Express API: ffmpeg thumbnails (`/api/thumb`), every-frame extraction jobs (`/api/range`), frame-accurate export (`/api/export`), file browser, and the `/api/vi/*` routes.
- [vi.js](vi.js) — Video Indexer plumbing: config, ARM → VI token chain (`DefaultAzureCredential`), 720p proxy encode, multipart upload, poll-until-processed state machine with restart-resume, face thumbnail cache.
- [vi-normalize.js](vi-normalize.js) — raw VI insights JSON → compact client model with per-shot links precomputed, so all UI filtering is instant set intersection.
- [public/index.html](public/index.html) — the whole UI.
