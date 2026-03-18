import express from "express";
import fetch from "node-fetch";
import ICAL from "ical.js";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from 'url';
import nodemailer from "nodemailer";
import { google } from "googleapis";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// Debug: log all incoming requests
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path} query=${JSON.stringify(req.query)}`);
  next();
});

// Helper: Google Calendar API client
function getGoogleCalendarClient() {
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const key = process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n');
  const calendarId = process.env.GOOGLE_CALENDAR_ID;

  if (!email || !key || !calendarId) return null;

  const auth = new google.auth.GoogleAuth({
    credentials: { client_email: email, private_key: key },
    scopes: ['https://www.googleapis.com/auth/calendar.readonly'],
  });

  return { calendar: google.calendar({ version: 'v3', auth }), calendarId };
}

// Helper: fetch events from Google Calendar API (includes forwarded events)
async function fetchGoogleApiEvents(start, end) {
  const client = getGoogleCalendarClient();
  if (!client) {
    console.log('[DEBUG] Google Calendar API not configured, skipping');
    return [];
  }

  try {
    const events = [];
    let pageToken;

    do {
      const response = await client.calendar.events.list({
        calendarId: client.calendarId,
        timeMin: start.toISOString(),
        timeMax: end.toISOString(),
        singleEvents: true, // expands recurring events
        orderBy: 'startTime',
        maxResults: 2500,
        pageToken,
      });

      for (const item of (response.data.items || [])) {
        // Skip cancelled events
        if (item.status === 'cancelled') continue;
        // Skip declined events
        const selfAttendee = item.attendees?.find(a => a.self);
        if (selfAttendee?.responseStatus === 'declined') continue;

        const eventStart = item.start?.dateTime
          ? new Date(item.start.dateTime)
          : item.start?.date ? new Date(item.start.date) : null;
        const eventEnd = item.end?.dateTime
          ? new Date(item.end.dateTime)
          : item.end?.date ? new Date(item.end.date) : null;

        if (!eventStart || !eventEnd) continue;

        events.push({
          start: eventStart,
          end: eventEnd,
          summary: item.summary || '',
          uid: `gapi-${item.id}`,
          source: 'google-api',
        });
      }

      pageToken = response.data.nextPageToken;
    } while (pageToken);

    console.log(`[DEBUG] Google Calendar API returned ${events.length} events`);
    return events;
  } catch (err) {
    console.error('[DEBUG] Google Calendar API error:', err.message);
    return [];
  }
}

// Helper: fetch and parse all calendar events from ICS sources
async function fetchIcsVevents() {
  const sourceUrlsRaw = process.env.SOURCE_ICS_URL;
  if (!sourceUrlsRaw) return [];

  const sourceUrls = sourceUrlsRaw.split(',').map(u => u.trim()).filter(u => u.length > 0);
  console.log(`[DEBUG] Fetching ${sourceUrls.length} ICS sources`);

  const fetchResults = await Promise.all(
    sourceUrls.map(async (url, i) => {
      try {
        const response = await fetch(url);
        console.log(`[DEBUG] ICS Source ${i}: status=${response.status} url=${url.substring(0, 60)}...`);
        if (!response.ok) return null;
        const text = await response.text();
        console.log(`[DEBUG] ICS Source ${i}: ${text.length} bytes, contains ${(text.match(/BEGIN:VEVENT/g) || []).length} VEVENTs`);
        return text;
      } catch (err) {
        console.error(`[DEBUG] ICS Source ${i} error:`, err.message);
        return null;
      }
    })
  );

  const icsDataList = fetchResults.filter(d => d !== null);
  let allVevents = [];
  for (const icsData of icsDataList) {
    const jcalData = ICAL.parse(icsData);
    const vcalendar = new ICAL.Component(jcalData);
    const vevents = vcalendar.getAllSubcomponents('vevent');
    allVevents = allVevents.concat(vevents);
  }
  console.log(`[DEBUG] Total parsed ICS vevents: ${allVevents.length}`);
  return allVevents;
}

// Helper: deduplicate events by overlapping time (same start+end = duplicate)
function deduplicateEvents(events) {
  const seen = new Map();
  for (const event of events) {
    const key = `${event.start.getTime()}-${event.end.getTime()}`;
    // Prefer google-api source (has forwarded events)
    if (!seen.has(key) || event.source === 'google-api') {
      seen.set(key, event);
    }
  }
  return Array.from(seen.values());
}

// Helper: fetch and parse all calendar events (ICS + Google API)
async function fetchAllEvents() {
  const vevents = await fetchIcsVevents();
  if (vevents.length === 0 && !getGoogleCalendarClient()) {
    throw new Error("No calendar sources configured");
  }
  return vevents;
}

// Helper: get time range from query param
function getTimeRange(range) {
  const now = new Date();
  const startOfDay = new Date(now);
  startOfDay.setHours(0, 0, 0, 0);

  const daysSinceMonday = (now.getDay() + 6) % 7;
  const startOfWeek = new Date(startOfDay);
  startOfWeek.setDate(startOfDay.getDate() - daysSinceMonday);

  let start, end;
  switch (range) {
    case 'today':
      start = startOfDay;
      end = new Date(startOfDay);
      end.setDate(end.getDate() + 1);
      break;
    case 'week':
      start = startOfWeek;
      end = new Date(startOfWeek);
      end.setDate(end.getDate() + 7);
      break;
    case 'month':
      start = new Date(now.getFullYear(), now.getMonth(), 1);
      end = new Date(now.getFullYear(), now.getMonth() + 1, 1);
      break;
    case 'nextmonth':
      start = new Date(now.getFullYear(), now.getMonth() + 1, 1);
      end = new Date(now.getFullYear(), now.getMonth() + 2, 1);
      break;
    case '8weeks':
    default:
      start = startOfWeek;
      end = new Date(now.getTime() + 8 * 7 * 24 * 60 * 60 * 1000);
      break;
  }
  return { start, end };
}

// Helper: expand ICS events into occurrences within a time range
function expandIcsEvents(vevents, start, end) {
  const events = [];
  for (const vevent of vevents) {
    const event = new ICAL.Event(vevent);

    if (event.isRecurring()) {
      const expand = event.iterator();
      let next;
      let count = 0;
      while ((next = expand.next()) && count < 200) {
        const occStart = next.toJSDate();
        if (occStart > end) break;
        if (occStart < start) { count++; continue; }

        const duration = event.duration;
        const durationMs = duration
          ? (duration.days * 86400000 + duration.hours * 3600000 + duration.minutes * 60000 + duration.seconds * 1000)
          : 3600000;
        const occEnd = new Date(occStart.getTime() + durationMs);

        events.push({
          start: occStart,
          end: occEnd,
          summary: event.summary || '',
          uid: `${event.uid}-${occStart.getTime()}`,
          source: 'ics',
        });
        count++;
      }
    } else {
      const startDate = event.startDate.toJSDate();
      const endDate = event.endDate ? event.endDate.toJSDate() : startDate;

      if (endDate >= start && startDate < end) {
        events.push({
          start: startDate,
          end: endDate,
          summary: event.summary || '',
          uid: event.uid,
          source: 'ics',
        });
      }
    }
  }
  return events;
}

// Helper: get all events from all sources, expanded and deduplicated
async function getAllExpandedEvents(start, end) {
  const vevents = await fetchIcsVevents();
  const icsEvents = expandIcsEvents(vevents, start, end);
  const googleEvents = await fetchGoogleApiEvents(start, end);

  const allEvents = [...icsEvents, ...googleEvents];
  const deduplicated = deduplicateEvents(allEvents);
  deduplicated.sort((a, b) => a.start.getTime() - b.start.getTime());

  console.log(`[DEBUG] Combined: ${icsEvents.length} ICS + ${googleEvents.length} Google API = ${allEvents.length} total, ${deduplicated.length} after dedup`);
  return deduplicated;
}

// API: original events (with details) as JSON
app.get('/api/original', async (req, res) => {
  try {
    const FEED_KEY = process.env.FEED_KEY;
    if (FEED_KEY && req.query.key !== FEED_KEY) return res.status(403).json({ error: 'Forbidden' });

    const { start, end } = getTimeRange(req.query.range);
    const events = await getAllExpandedEvents(start, end);

    console.log(`[DEBUG] /api/original range=${req.query.range} start=${start.toISOString()} end=${end.toISOString()} events=${events.length}`);
    events.slice(0, 5).forEach((e, i) => {
      console.log(`[DEBUG]   event[${i}]: start=${e.start.toISOString()} end=${e.end.toISOString()} summary="${e.summary}" source=${e.source}`);
    });

    res.json({
      range: { start: start.toISOString(), end: end.toISOString() },
      events: events.map(e => ({
        start: e.start.toISOString(),
        end: e.end.toISOString(),
        summary: e.summary,
        uid: e.uid
      }))
    });
  } catch (error) {
    console.error('[ERROR] /api/original:', error);
    res.status(500).json({ error: error.message });
  }
});

// API: busy events (anonymized) as JSON
app.get('/api/busy', async (req, res) => {
  try {
    const FEED_KEY = process.env.FEED_KEY;
    if (FEED_KEY && req.query.key !== FEED_KEY) return res.status(403).json({ error: 'Forbidden' });

    const { start, end } = getTimeRange(req.query.range);
    const events = await getAllExpandedEvents(start, end);

    const formatBerlinTime = (date) => {
      const options = { timeZone: 'Europe/Berlin', hour: 'numeric', minute: '2-digit', hour12: true };
      return date.toLocaleTimeString('en-US', options).replace(':00', '');
    };

    console.log(`[DEBUG] /api/busy range=${req.query.range} start=${start.toISOString()} end=${end.toISOString()} events=${events.length}`);
    events.slice(0, 5).forEach((e, i) => {
      console.log(`[DEBUG]   busy[${i}]: start=${e.start.toISOString()} berlin=${formatBerlinTime(e.start)} end=${e.end.toISOString()} berlin=${formatBerlinTime(e.end)} source=${e.source}`);
    });

    res.json({
      range: { start: start.toISOString(), end: end.toISOString() },
      events: events.map(e => ({
        start: e.start.toISOString(),
        end: e.end.toISOString(),
        summary: `Busy ${formatBerlinTime(e.start)} - ${formatBerlinTime(e.end)}`,
        uid: e.uid
      }))
    });
  } catch (error) {
    console.error('[ERROR] /api/busy:', error);
    res.status(500).json({ error: error.message });
  }
});

// Protected route for test UI
app.get('/', (req, res) => {
  const UI_KEY = process.env.UI_KEY || 'test-ui-2025';

  if (req.query.key !== UI_KEY) {
    return res.status(403).send('Access denied. Add ?key=YOUR_UI_KEY to URL');
  }

  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Middleware für optional security key
app.use((req, res, next) => {
  const FEED_KEY = process.env.FEED_KEY;
  if (!FEED_KEY) return next();
  if (req.path.endsWith(".ics") && req.query.key !== FEED_KEY) {
    return res.status(403).send("Forbidden");
  }
  next();
});

// Main endpoint - parse external ICS and return only busy blocks
app.get("/busy.ics", async (req, res) => {
  try {
    // Time window
    const now = new Date();
    const startOfWeek = new Date(now);
    const daysSinceMonday = (now.getDay() + 6) % 7;
    startOfWeek.setDate(now.getDate() - daysSinceMonday);
    startOfWeek.setHours(0, 0, 0, 0);

    const eightWeeksFromNow = new Date(now.getTime() + (8 * 7 * 24 * 60 * 60 * 1000));

    // Use combined sources (ICS + Google API)
    const busyBlocks = await getAllExpandedEvents(startOfWeek, eightWeeksFromNow);

    // Build ICS output
    let busyIcs = "";
    busyIcs += "BEGIN:VCALENDAR\r\n";
    busyIcs += "VERSION:2.0\r\n";
    busyIcs += "PRODID:-//Busy ICS Proxy//EN\r\n";
    busyIcs += "CALSCALE:GREGORIAN\r\n";
    busyIcs += "METHOD:PUBLISH\r\n";
    busyIcs += "X-WR-CALNAME:Busy Calendar\r\n";
    busyIcs += "X-WR-TIMEZONE:Europe/Berlin\r\n";

    let eventCount = 0;

    // Helper to format time in Berlin timezone with AM/PM
    // e.g., "9 AM", "10 AM", "9:15 AM", "3:50 PM"
    const formatBerlinTime = (date) => {
      const options = { timeZone: 'Europe/Berlin', hour: 'numeric', minute: '2-digit', hour12: true };
      const timeStr = date.toLocaleTimeString('en-US', options);
      // Remove :00 for whole hours (e.g., "9:00 AM" -> "9 AM")
      return timeStr.replace(':00', '');
    };

    for (const block of busyBlocks) {
      // Output in UTC with Z suffix - this is the clearest format
      const dtStart = block.start.toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
      const dtEnd = block.end.toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';

      // Format times for summary (e.g., "9:15 - 10:00 AM")
      const startTime = formatBerlinTime(block.start);
      const endTime = formatBerlinTime(block.end);
      const summary = `Busy ${startTime} - ${endTime}`;

      busyIcs += "BEGIN:VEVENT\r\n";
      busyIcs += `UID:busy-${eventCount++}-${block.uid}@busy-proxy\r\n`;
      busyIcs += `DTSTAMP:${new Date().toISOString().replace(/[-:]/g, '').split('.')[0]}Z\r\n`;
      busyIcs += `DTSTART:${dtStart}\r\n`;
      busyIcs += `DTEND:${dtEnd}\r\n`;
      busyIcs += `SUMMARY:${summary}\r\n`;
      busyIcs += "TRANSP:OPAQUE\r\n";
      busyIcs += "CLASS:PRIVATE\r\n";
      busyIcs += "STATUS:CONFIRMED\r\n";
      busyIcs += "END:VEVENT\r\n";
    }

    busyIcs += "END:VCALENDAR\r\n";

    res.setHeader("Content-Type", "text/calendar; charset=utf-8");
    res.setHeader("Content-Disposition", 'inline; filename="busy.ics"');
    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    res.send(busyIcs);

  } catch (error) {
    console.error("Error:", error);
    res.status(500).send("Error generating busy calendar");
  }
});

// JSON body parsing for mail endpoint
app.use(express.json());

// Mail relay endpoint
app.post("/api/send-mail", async (req, res) => {
  try {
    const MAIL_KEY = process.env.MAIL_KEY;
    if (!MAIL_KEY || req.headers["x-mail-key"] !== MAIL_KEY) {
      console.error("[MAIL] Unauthorized request");
      return res.status(403).json({ error: "Forbidden" });
    }

    const { to, subject, html } = req.body;

    if (!to || !subject || !html) {
      return res.status(400).json({ error: "Missing required fields: to, subject, html" });
    }

    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: parseInt(process.env.SMTP_PORT || "587", 10),
      secure: process.env.SMTP_SECURE === "true",
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASSWORD,
      },
    });

    const result = await transporter.sendMail({
      from: process.env.SMTP_FROM || "bookings@alexfriedl.com",
      to,
      subject,
      html,
    });

    console.log(`[MAIL] Sent to=${to} subject="${subject}" messageId=${result.messageId}`);
    res.json({ success: true, messageId: result.messageId });
  } catch (error) {
    console.error("[MAIL] Error:", error.message);
    res.status(500).json({ error: error.message });
  }
});

// Health check
app.get("/health", (req, res) => {
  res.send("OK");
});

// Start server
app.listen(PORT, () => {
  console.log(`Busy ICS Proxy listening on port ${PORT}`);
});
