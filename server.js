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

// Helper: Convert date to ICS format
function toICSDate(date) {
  return date.toISOString().replace(/[-:]/g, "").replace(".000", "");
}

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
    busyIcs += "X-WR-TIMEZONE:UTC\r\n";

    const now = new Date();
    const stamp = toICSDate(now);

    let eventCount = 0;
    for (const event of Object.values(events)) {
      if (event.type === 'VEVENT' && event.start) {
        const startDate = new Date(event.start);
        const endDate = new Date(event.end || event.start);
        
        // Skip past events by default
        if (endDate < now) {
          continue;
        }

        busyIcs += "BEGIN:VEVENT\r\n";
        busyIcs += `UID:busy-${eventCount++}-${startDate.getTime()}@busy-proxy\r\n`;
        busyIcs += `DTSTAMP:${stamp}\r\n`;
        busyIcs += `DTSTART:${toICSDate(startDate)}\r\n`;
        busyIcs += `DTEND:${toICSDate(endDate)}\r\n`;
        busyIcs += "SUMMARY:Busy\r\n";
        busyIcs += "DESCRIPTION:Time blocked\r\n";
        busyIcs += "TRANSP:OPAQUE\r\n";
        busyIcs += "CLASS:PRIVATE\r\n";
        busyIcs += "END:VEVENT\r\n";
      }
    }

    busyIcs += "END:VCALENDAR\r\n";

    res.setHeader("Content-Type", "text/calendar; charset=utf-8");
    res.setHeader("Content-Disposition", 'inline; filename="busy.ics"');
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
  console.log(`Busy ICS Proxy (Simple) listening on port ${PORT}`);
  console.log(`Usage: GET /busy.ics?url=<encoded-ics-url>`);
});