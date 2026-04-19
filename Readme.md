# ☢️ NukeNER VIZ — Full Deployment Guide

Zero-backend stack: **Supabase** (database + API + auth) + **Netlify** (static hosting).
No server to manage. No Railway bill. One config file to edit.

---

## Stack Overview

```
Browser (Vanilla HTML/CSS/JS)
    │
    ├── Netlify  ← hosts index.html, style.css, app.js  [FREE]
    │
    └── Supabase ← Postgres DB + REST API + Realtime     [FREE tier]
```

---

## Step 1 — Create a Supabase Project

1. Go to https://supabase.com → **New project**
2. Give it a name (e.g. `nukenerviz`), choose a region close to you
3. Save your **database password** somewhere safe
4. Wait ~2 min for the project to spin up

From your project dashboard grab:
- **Project URL** → looks like `https://xxxxxxxxxxxx.supabase.co`
- **anon public key** → under Settings → API → `anon` `public`

---

## Step 2 — Run the Database Schema

1. In Supabase dashboard → **SQL Editor** → **New query**
2. Paste the entire contents of `supabase/schema.sql`
3. Click **Run**

That creates all 4 tables: `projects`, `sentences`, `entities`, `annotations`.

---

## Step 3 — Configure the Frontend

Open `frontend/index.html` and fill in your two Supabase values at the top:

```js
const SUPABASE_URL = "https://xxxxxxxxxxxx.supabase.co";   // ← your URL
const SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsIn...";          // ← your anon key
```

That's the only config change needed.

---

## Step 4 — Deploy to Netlify

**Option A — Drag & Drop (easiest, 30 seconds):**
1. Go to https://app.netlify.com/drop
2. Drag the entire `frontend/` folder onto the page
3. You get a live URL like `https://funny-name-123.netlify.app`
4. (Optional) Add a custom domain in Site Settings

**Option B — Git-connected (auto-deploys on push):**
```bash
# Push frontend/ folder to a GitHub repo, then:
# Netlify → New site → Import from Git → select repo
# Build command: (leave empty)
# Publish directory: frontend
```

---

## File Structure

```
nukenerviz/
├── README.md                  ← you are here
├── frontend/
│   ├── index.html             ← EDIT: add your Supabase URL + KEY
│   ├── style.css              ← unchanged from original
│   └── app.js                 ← rewritten to use Supabase directly
└── supabase/
    └── schema.sql             ← run this once in Supabase SQL editor
```

---

## How It Works (No Backend)

| Old (Railway API)                    | New (Supabase direct)                        |
|--------------------------------------|----------------------------------------------|
| `POST /api/project/upload`           | Insert rows directly into `projects` table   |
| `GET  /api/projects`                 | `supabase.from('projects').select()`         |
| `GET  /api/project/:id/data`         | `supabase.from('sentences').select()`        |
| `POST /api/project/:id/annotate`     | `supabase.from('annotations').upsert()`      |
| `GET  /api/project/:id/metrics`      | Computed in JS from annotation rows          |
| `GET  /api/project/:id/all_annotations` | Supabase Realtime subscription            |

Realtime collaboration (the 5s polling) is replaced by Supabase Realtime — 
changes from other users appear instantly with no polling.

---

## Supabase Free Tier Limits (plenty for this app)

- 500 MB database
- 2 GB bandwidth/month  
- Unlimited API requests
- Realtime included
