import express from "express";
import fetch from "node-fetch";
import ICAL from "ical.js";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from 'url';

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

// Helper: fetch and parse all calendar events
async function fetchAllEvents() {
  const sourceUrlsRaw = process.env.SOURCE_ICS_URL;
  if (!sourceUrlsRaw) throw new Error("Missing SOURCE_ICS_URL");

  const sourceUrls = sourceUrlsRaw.split(',').map(u => u.trim()).filter(u => u.length > 0);
  console.log(`[DEBUG] Fetching ${sourceUrls.length} calendar sources`);

  const fetchResults = await Promise.all(
    sourceUrls.map(async (url, i) => {
      try {
        const response = await fetch(url);
        console.log(`[DEBUG] Source ${i}: status=${response.status} url=${url.substring(0, 60)}...`);
        if (!response.ok) return null;
        const text = await response.text();
        console.log(`[DEBUG] Source ${i}: ${text.length} bytes, contains ${(text.match(/BEGIN:VEVENT/g) || []).length} VEVENTs`);
        return text;
      } catch (err) {
        console.error(`[DEBUG] Source ${i} error:`, err.message);
        return null;
      }
    })
  );

  const icsDataList = fetchResults.filter(d => d !== null);
  if (icsDataList.length === 0) throw new Error("Failed to fetch any calendar data");

  let allVevents = [];
  for (const icsData of icsDataList) {
    const jcalData = ICAL.parse(icsData);
    const vcalendar = new ICAL.Component(jcalData);
    const vevents = vcalendar.getAllSubcomponents('vevent');
    allVevents = allVevents.concat(vevents);
  }
  console.log(`[DEBUG] Total parsed vevents: ${allVevents.length}`);
  return allVevents;
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

// Helper: expand events into occurrences within a time range
function expandEvents(vevents, start, end) {
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
          uid: `${event.uid}-${occStart.getTime()}`
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
          uid: event.uid
        });
      }
    }
  }
  events.sort((a, b) => a.start.getTime() - b.start.getTime());
  return events;
}

// API: original events (with details) as JSON
app.get('/api/original', async (req, res) => {
  try {
    const FEED_KEY = process.env.FEED_KEY;
    if (FEED_KEY && req.query.key !== FEED_KEY) return res.status(403).json({ error: 'Forbidden' });

    const vevents = await fetchAllEvents();
    const { start, end } = getTimeRange(req.query.range);
    const events = expandEvents(vevents, start, end);

    console.log(`[DEBUG] /api/original range=${req.query.range} start=${start.toISOString()} end=${end.toISOString()} events=${events.length}`);
    events.slice(0, 5).forEach((e, i) => {
      console.log(`[DEBUG]   event[${i}]: start=${e.start.toISOString()} end=${e.end.toISOString()} summary="${e.summary}"`);
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

    const vevents = await fetchAllEvents();
    const { start, end } = getTimeRange(req.query.range);
    const events = expandEvents(vevents, start, end);

    const formatBerlinTime = (date) => {
      const options = { timeZone: 'Europe/Berlin', hour: 'numeric', minute: '2-digit', hour12: true };
      return date.toLocaleTimeString('en-US', options).replace(':00', '');
    };

    console.log(`[DEBUG] /api/busy range=${req.query.range} start=${start.toISOString()} end=${end.toISOString()} events=${events.length}`);
    events.slice(0, 5).forEach((e, i) => {
      console.log(`[DEBUG]   busy[${i}]: start=${e.start.toISOString()} berlin=${formatBerlinTime(e.start)} end=${e.end.toISOString()} berlin=${formatBerlinTime(e.end)}`);
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
    // Support multiple comma-separated ICS URLs
    const sourceUrlsRaw = req.query.url || process.env.SOURCE_ICS_URL;

    if (!sourceUrlsRaw) {
      return res.status(400).send("Missing source ICS URL");
    }

    const sourceUrls = sourceUrlsRaw
      .split(',')
      .map(url => url.trim())
      .filter(url => url.length > 0);

    // Fetch all calendars in parallel
    const fetchResults = await Promise.all(
      sourceUrls.map(async (url) => {
        try {
          const response = await fetch(url);
          if (!response.ok) {
            console.error(`Failed to fetch ICS from ${url}: ${response.status}`);
            return null;
          }
          return await response.text();
        } catch (err) {
          console.error(`Error fetching ${url}:`, err.message);
          return null;
        }
      })
    );

    // Filter out failed fetches
    const icsDataList = fetchResults.filter(data => data !== null);

    if (icsDataList.length === 0) {
      throw new Error("Failed to fetch any calendar data");
    }

    // Collect all events from all calendars
    let allVevents = [];
    for (const icsData of icsDataList) {
      const jcalData = ICAL.parse(icsData);
      const vcalendar = new ICAL.Component(jcalData);
      const vevents = vcalendar.getAllSubcomponents('vevent');
      allVevents = allVevents.concat(vevents);
    }

    const vevents = allVevents;

    // Time window
    const now = new Date();
    const startOfWeek = new Date(now);
    const daysSinceMonday = (now.getDay() + 6) % 7;
    startOfWeek.setDate(now.getDate() - daysSinceMonday);
    startOfWeek.setHours(0, 0, 0, 0);

    const eightWeeksFromNow = new Date(now.getTime() + (8 * 7 * 24 * 60 * 60 * 1000));

    let busyBlocks = [];

    for (const vevent of vevents) {
      const event = new ICAL.Event(vevent);

      // Check for recurring events
      if (event.isRecurring()) {
        const expand = event.iterator();
        let next;
        let count = 0;
        const maxOccurrences = 100; // Safety limit

        while ((next = expand.next()) && count < maxOccurrences) {
          const occurrenceStart = next.toJSDate();

          if (occurrenceStart > eightWeeksFromNow) break;
          if (occurrenceStart < startOfWeek) {
            count++;
            continue;
          }

          const duration = event.duration;
          const durationMs = duration ?
            (duration.days * 86400000 + duration.hours * 3600000 + duration.minutes * 60000 + duration.seconds * 1000) :
            3600000;

          const occurrenceEnd = new Date(occurrenceStart.getTime() + durationMs);

          busyBlocks.push({
            start: occurrenceStart,
            end: occurrenceEnd,
            uid: `${event.uid}-${occurrenceStart.getTime()}`
          });

          count++;
        }
      } else {
        // Single event
        const startDate = event.startDate.toJSDate();
        const endDate = event.endDate ? event.endDate.toJSDate() : startDate;

        if (endDate >= startOfWeek && startDate < eightWeeksFromNow) {
          busyBlocks.push({
            start: startDate,
            end: endDate,
            uid: event.uid
          });
        }
      }
    }

    // Sort by start time
    busyBlocks.sort((a, b) => a.start.getTime() - b.start.getTime());

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

// Health check
app.get("/health", (req, res) => {
  res.send("OK");
});

// Start server
app.listen(PORT, () => {
  console.log(`Busy ICS Proxy listening on port ${PORT}`);
});
