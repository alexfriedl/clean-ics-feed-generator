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
    const sourceUrl = req.query.url || process.env.SOURCE_ICS_URL;

    if (!sourceUrl) {
      return res.status(400).send("Missing source ICS URL");
    }

    // Fetch the source ICS
    const response = await fetch(sourceUrl);
    if (!response.ok) {
      throw new Error(`Failed to fetch ICS: ${response.status}`);
    }

    const icsData = await response.text();

    // Parse with ical.js - handles timezones correctly
    const jcalData = ICAL.parse(icsData);
    const vcalendar = new ICAL.Component(jcalData);
    const vevents = vcalendar.getAllSubcomponents('vevent');

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
    const formatBerlinTime = (date) => {
      return date.toLocaleTimeString('en-US', {
        timeZone: 'Europe/Berlin',
        hour: 'numeric',
        minute: '2-digit',
        hour12: true
      });
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
