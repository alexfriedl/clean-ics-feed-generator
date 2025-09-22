# Busy ICS Proxy

Converts any private Google Calendar into a public feed showing only busy/free times without event details.

## Quick Start

1. **Get your private calendar URL:**
   - Open Google Calendar → Settings → Your calendar
   - Find "Secret address in iCal format"
   - Copy the URL

2. **Setup:**
   ```bash
   cp .env.sample .env
   # Add your calendar URL and secret key to .env
   
   npm install
   npm start
   ```

3. **Access your busy feed:**
   ```
   http://localhost:3000/busy.ics?key=your-secret-key
   ```

## Deploy to Production

### Railway (Recommended)
1. Push to GitHub
2. Connect Railway to your repo
3. Add environment variables
4. Deploy automatically

### Heroku
```bash
heroku create your-app-name
heroku config:set SOURCE_ICS_URL="your-calendar-url" FEED_KEY="your-secret"
git push heroku main
```

## Features
- Shows only busy/free blocks
- No event titles or details
- Optional security key
- Works with any ICS calendar

## Usage
After deployment, share your busy feed URL:
```
https://your-app.railway.app/busy.ics?key=your-secret-key
```

Others can subscribe to see when you're available without seeing private details.