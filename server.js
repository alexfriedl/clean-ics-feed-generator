import express from "express";
import fetch from "node-fetch";
import ical from "ical";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

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
    const events = ical.parseICS(icsData);

    // Build new ICS with only busy blocks
    let busyIcs = "";
    busyIcs += "BEGIN:VCALENDAR\r\n";
    busyIcs += "VERSION:2.0\r\n";
    busyIcs += "PRODID:-//Busy ICS Proxy//EN\r\n";
    busyIcs += "CALSCALE:GREGORIAN\r\n";
    busyIcs += "METHOD:PUBLISH\r\n";
    busyIcs += "X-WR-CALNAME:Busy Calendar\r\n";
    busyIcs += "X-WR-TIMEZONE:Europe/Berlin\r\n";

    const now = new Date();
    const eightWeeksFromNow = new Date(now.getTime() + (8 * 7 * 24 * 60 * 60 * 1000));

    let eventCount = 0;
    for (const [key, event] of Object.entries(events)) {
      if (event.type === 'VEVENT' && event.start) {
        const startDate = new Date(event.start);
        const endDate = new Date(event.end || event.start);
        
        // Skip past events
        if (endDate < now) {
          continue;
        }
        
        // Skip events more than 8 weeks in the future
        if (startDate > eightWeeksFromNow) {
          continue;
        }

        // Format dates - if they already have Z, use them as is
        let dtStart, dtEnd;
        if (typeof event.start === 'string') {
          dtStart = event.start;
        } else {
          dtStart = startDate.toISOString();
        }
        if (typeof event.end === 'string') {
          dtEnd = event.end;
        } else {
          dtEnd = endDate.toISOString();
        }

        // Convert to ICS format
        dtStart = dtStart.replace(/[-:]/g, '').split('.')[0] + 'Z';
        dtEnd = dtEnd.replace(/[-:]/g, '').split('.')[0] + 'Z';

        busyIcs += "BEGIN:VEVENT\r\n";
        busyIcs += `UID:busy-${eventCount++}-${key}@busy-proxy\r\n`;
        busyIcs += `DTSTAMP:${new Date().toISOString().replace(/[-:]/g, '').split('.')[0]}Z\r\n`;
        busyIcs += `DTSTART:${dtStart}\r\n`;
        busyIcs += `DTEND:${dtEnd}\r\n`;
        busyIcs += "SUMMARY:Busy\r\n";
        busyIcs += "TRANSP:OPAQUE\r\n";
        busyIcs += "CLASS:PRIVATE\r\n";
        busyIcs += "STATUS:CONFIRMED\r\n";
        busyIcs += "END:VEVENT\r\n";
      }
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

// Debug endpoint
app.get("/debug", async (req, res) => {
  try {
    const sourceUrl = process.env.SOURCE_ICS_URL;
    const response = await fetch(sourceUrl);
    const icsData = await response.text();
    const events = ical.parseICS(icsData);
    
    const now = new Date();
    const eightWeeks = new Date(now.getTime() + (8 * 7 * 24 * 60 * 60 * 1000));
    
    let futureEvents = 0;
    let totalEvents = 0;
    
    for (const event of Object.values(events)) {
      if (event.type === 'VEVENT' && event.start) {
        totalEvents++;
        const endDate = new Date(event.end || event.start);
        if (endDate > now) {
          futureEvents++;
        }
      }
    }
    
    res.json({
      totalEvents,
      futureEvents,
      nowTime: now.toISOString(),
      eightWeeksTime: eightWeeks.toISOString()
    });
    
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`Busy ICS Proxy listening on port ${PORT}`);
});