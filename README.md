# ResumeCheck, local setup

This runs the same tool on your laptop. You need two things running at once: the backend and the frontend.

## 1. Get an API key

Go to console.anthropic.com. Sign up or log in. Create an API key. This is different from your claude.ai login. It costs money per use, based on how many resumes you score. Check current pricing on the console before you launch this to paying users.

## 2. Set up the backend

Open a terminal in the `server` folder.

```
cd server
npm install
cp .env.example .env
```

Open `.env` and paste your API key after `ANTHROPIC_API_KEY=`. Save it.

Start the backend:

```
npm start
```

You should see: `ResumeCheck backend running on http://localhost:3001`

Leave this terminal open.

## 3. Set up the frontend

Open a second terminal in the project's root folder, not the `server` folder.

```
npm install
npm run dev
```

You should see a local address, usually `http://localhost:5173`. Open that in your browser.

## 4. Test it

- Unlock with the code: `CLARITY2026`
- Change this code before you sell access. It's in `src/App.jsx`, near the top, on the line `const ACCESS_CODE = "CLARITY2026";`
- Upload your own resume PDF and confirm the score comes back correctly.

## 5. Requirements on your laptop

- Node.js version 18 or higher. Check with `node -v` in your terminal. If it's missing, install it from nodejs.org.
- Both terminals need to stay open while you use the tool. Closing either one stops it.

## 6. Selling this to other people

Right now this only runs on your laptop. Other people can't reach it unless you host it somewhere public, like Vercel or Railway. For this week, keep using the version inside Claude with a shared link. Come back to this local version when you're ready to build your own branded site.
# Resume-checker
