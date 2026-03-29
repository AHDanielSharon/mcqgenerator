# QuizGenius — PDF to Quiz (Free, powered by Google Gemini)

## Get your FREE Gemini API Key
1. Go to https://aistudio.google.com/apikey
2. Sign in with your Google account
3. Click "Create API Key" → Copy it
No credit card needed. Free forever.

## Deploy to Render (3 steps)

### 1. Push to GitHub
- Create a new repo on github.com
- Upload all files (server.js, package.json, public/ folder)

### 2. Create Web Service on Render
- render.com → New → Web Service → connect your repo
- Build Command: `npm install`
- Start Command:  `node server.js`
- Instance Type: Free

### 3. Add Environment Variable
| Key | Value |
|---|---|
| `GEMINI_API_KEY` | your key from aistudio.google.com |

Click Create Web Service → live in 2 minutes!

## Local Dev
```bash
npm install
GEMINI_API_KEY=your_key node server.js
```
