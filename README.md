# Hostex Availability Portal

A read-only availability dashboard for your rental agents. Shows all your Hostex properties with 6-month rolling calendars. No login required for agents — your API token stays securely on the server.

---

## Deploy to Vercel (5 minutes)

### Step 1 — Create a free Vercel account
Go to [vercel.com](https://vercel.com) and sign up (free, no credit card needed). 

### Step 2 — Install the Vercel CLI
Open your terminal and run:
```
npm install -g vercel
```

### Step 3 — Deploy the project
In your terminal, navigate to this folder and run:
```
vercel
```
Follow the prompts:
- Set up and deploy? → **Y**
- Which scope? → select your account
- Link to existing project? → **N**
- Project name? → `hostex-portal` (or anything you like)
- In which directory is your code? → **.** (just press Enter)
- Want to override settings? → **N**

Vercel will give you a preview URL like `https://hostex-portal-xxx.vercel.app`

### Step 4 — Add your Hostex API token
1. Go to [vercel.com/dashboard](https://vercel.com/dashboard)
2. Click your project → **Settings** → **Environment Variables**
3. Add a new variable:
   - **Name:** `HOSTEX_TOKEN`
   - **Value:** your Hostex API token (from Hostex → Workplace → OpenAPI Settings)
   - **Environment:** Production, Preview, Development (tick all three)
4. Click **Save**

### Step 5 — Redeploy
Back in your terminal, run:
```
vercel --prod
```
Your portal is now live! Share the URL with your agents — they just open it and see live availability. No login, no token, nothing to manage.

---

## File structure
```
hostex-portal/
├── api/
│   ├── properties.js   ← proxy: fetches your property list
│   └── calendar.js     ← proxy: fetches availability per property
├── public/
│   └── index.html      ← the agent-facing UI
├── vercel.json         ← routing config
└── README.md
```

## Updating your token
If you ever regenerate your Hostex API token, just update the `HOSTEX_TOKEN` environment variable in Vercel and redeploy.

## Custom domain (optional)
In Vercel → Settings → Domains, you can attach your own domain (e.g. `availability.yourdomain.com`) for free.
