# Hosting the live SPHEREx search on Render (free)

The Vercel site only holds the 100 pre-processed targets. Any other RA/Dec is processed on demand by
`pipeline/server.py`. Vercel cannot run that, so it runs on Render's free plan and the site calls it
(`LIVE_SERVER` at the top of `public/js/data-source.js`).

## One-time setup (about 10 minutes, no credit card)

1. Make sure the `spherex-real-data` branch (with `render.yaml` at the repo root) is pushed to GitHub.
2. Go to https://render.com and click **Get Started**, then **GitHub** to sign up with your GitHub account.
3. In the Render dashboard click **New +** (top right), then **Blueprint**.
4. Under **Connect a repository**, click **Configure account / GitHub**, give Render access to the
   `NasaTesting` repository, then click **Connect** next to it.
5. Render reads `render.yaml` and shows one web service, **skyblink-spherex-live** (Free).
   Give the Blueprint any name, then click **Apply** (or **Deploy Blueprint**).
6. Click the service. The first build installs numpy/scipy/astropy and takes about 3 to 6 minutes.
   When the status says **Live**, its address is at the top, normally
   `https://skyblink-spherex-live.onrender.com`.
7. Check it: open `https://<that address>/api/health`. You should see `{"ok": true, "jobs_running": 0}`.
8. If the address is different (the name was taken), change `LIVE_SERVER` in
   `public/js/data-source.js` to it, commit and push. Vercel redeploys by itself.

Every later push to `spherex-real-data` redeploys Render automatically too.

## What to expect on the free plan

- **Cold start.** After about 15 minutes with no visitors the server goes to sleep. The next search
  shows "Waking up the live SPHEREx server…" for up to a minute, then the normal steps
  (Step 1 of 4 … Step 4 of 4), usually 30 to 50 seconds more. Later searches skip the wake-up.
- **Repeat searches** of the same spot are instant until the server restarts.
- **The cache is temporary.** Render's free disk is wiped on every restart or deploy, and the server
  keeps at most 200 MB of results anyway (least recently viewed are dropped first). Nothing builds up.
- **One search at a time.** With 512 MB of memory the server processes one new spot at a time
  (about 180 MB peak in tests); a second visitor's new spot shows "Waiting for another search on this
  server to finish" and then runs.
- 750 free instance hours a month covers one service running all month.

## Settings (render.yaml)

| Setting | Value | Why |
|---|---|---|
| `--max 30` | images per new spot | faster first load, less memory |
| `--live-max-mb 200` | cache cap | small, temporary disk |
| `LIVE_MAX_JOBS=1` | searches at once | stay under 512 MB |
| `LIVE_THREADS=8` | parallel downloads | |
| `ALLOWED_ORIGINS=https://nasatesting.vercel.app` | who may call it | only the Vercel site may call the server from a browser. Separate several sites with commas; to also allow every `vercel.app` subdomain (preview deployments), add `*.vercel.app` (no `https://`, which is how `server.py` matches wildcards). `*` allows any site. |
