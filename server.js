import express from "express";
import fetch from "node-fetch";
import ical from "node-ical";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

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
    
    // Parse with node-ical to handle recurring events
    const events = await ical.async.parseICS(icsData);

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
    let busyBlocks = [];

    // Process all events including recurring ones
    for (const [key, event] of Object.entries(events)) {
      if (event.type === 'VEVENT') {
        // Handle recurring events
        if (event.rrule) {
          try {
            const dates = event.rrule.between(now, eightWeeksFromNow, true);
            
            for (const date of dates) {
              const duration = event.end ? event.end.getTime() - event.start.getTime() : 3600000; // 1 hour default
              const startDate = new Date(date);
              const endDate = new Date(date.getTime() + duration);
              
              busyBlocks.push({
                start: startDate,
                end: endDate,
                uid: `${key}-${startDate.getTime()}`
              });
            }
          } catch (e) {
            console.error('Error processing recurring event:', e);
          }
        } else if (event.start) {
          // Regular single event
          const startDate = new Date(event.start);
          const endDate = new Date(event.end || event.start);
          
          // Only include if within our time window
          if (endDate > now && startDate < eightWeeksFromNow) {
            busyBlocks.push({
              start: startDate,
              end: endDate,
              uid: key
            });
          }
        }
      }
    }

    // Sort by start time
    busyBlocks.sort((a, b) => a.start.getTime() - b.start.getTime());

    // Generate VEVENT entries
    for (const block of busyBlocks) {
      const dtStart = block.start.toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
      const dtEnd = block.end.toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';

      busyIcs += "BEGIN:VEVENT\r\n";
      busyIcs += `UID:busy-${eventCount++}-${block.uid}@busy-proxy\r\n`;
      busyIcs += `DTSTAMP:${new Date().toISOString().replace(/[-:]/g, '').split('.')[0]}Z\r\n`;
      busyIcs += `DTSTART:${dtStart}\r\n`;
      busyIcs += `DTEND:${dtEnd}\r\n`;
      busyIcs += "SUMMARY:Busy\r\n";
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

// Debug endpoint
app.get("/debug", async (req, res) => {
  try {
    const sourceUrl = process.env.SOURCE_ICS_URL;
    const response = await fetch(sourceUrl);
    const icsData = await response.text();
    const events = await ical.async.parseICS(icsData);
    
    const now = new Date();
    const eightWeeks = new Date(now.getTime() + (8 * 7 * 24 * 60 * 60 * 1000));
    
    let recurringCount = 0;
    let singleCount = 0;
    let expandedCount = 0;
    
    for (const event of Object.values(events)) {
      if (event.type === 'VEVENT') {
        if (event.rrule) {
          recurringCount++;
          try {
            const dates = event.rrule.between(now, eightWeeks, true);
            expandedCount += dates.length;
          } catch (e) {
            // ignore
          }
        } else if (event.start) {
          const endDate = new Date(event.end || event.start);
          if (endDate > now) {
            singleCount++;
          }
        }
      }
    }
    
    res.json({
      recurringEvents: recurringCount,
      singleFutureEvents: singleCount,
      expandedRecurringInstances: expandedCount,
      totalFutureEvents: singleCount + expandedCount,
      timeWindow: {
        start: now.toISOString(),
        end: eightWeeks.toISOString()
      }
    });
    
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// API endpoint for original calendar events
app.get("/api/original", async (req, res) => {
  try {
    const sourceUrl = process.env.SOURCE_ICS_URL;
    const response = await fetch(sourceUrl);
    const icsData = await response.text();
    const events = await ical.async.parseICS(icsData);
    
    const now = new Date();
    let endDate;
    
    switch(req.query.range) {
      case 'today':
        endDate = new Date(now);
        endDate.setHours(23, 59, 59, 999);
        break;
      case 'week':
        endDate = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
        break;
      default:
        endDate = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
    }
    
    let eventList = [];
    
    for (const [key, event] of Object.entries(events)) {
      if (event.type === 'VEVENT') {
        if (event.rrule) {
          try {
            const dates = event.rrule.between(now, endDate, true);
            for (const date of dates) {
              const duration = event.end ? event.end.getTime() - event.start.getTime() : 3600000;
              eventList.push({
                summary: event.summary || 'No title',
                start: date,
                end: new Date(date.getTime() + duration),
                type: 'recurring'
              });
            }
          } catch (e) {
            console.error('Recurring event error:', e);
          }
        } else if (event.start) {
          const startDate = new Date(event.start);
          const eventEnd = new Date(event.end || event.start);
          
          if (eventEnd >= now && startDate <= endDate) {
            eventList.push({
              summary: event.summary || 'No title',
              start: event.start,
              end: event.end || event.start,
              type: 'single'
            });
          }
        }
      }
    }
    
    eventList.sort((a, b) => new Date(a.start) - new Date(b.start));
    
    res.json({
      events: eventList,
      range: { start: now, end: endDate }
    });
    
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// API endpoint for busy feed events
app.get("/api/busy", async (req, res) => {
  try {
    const sourceUrl = process.env.SOURCE_ICS_URL;
    const response = await fetch(sourceUrl);
    const icsData = await response.text();
    const events = await ical.async.parseICS(icsData);
    
    const now = new Date();
    let endDate;
    
    switch(req.query.range) {
      case 'today':
        endDate = new Date(now);
        endDate.setHours(23, 59, 59, 999);
        break;
      case 'week':
        endDate = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
        break;
      default:
        endDate = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
    }
    
    let eventList = [];
    
    for (const [key, event] of Object.entries(events)) {
      if (event.type === 'VEVENT') {
        if (event.rrule) {
          try {
            const dates = event.rrule.between(now, endDate, true);
            for (const date of dates) {
              const duration = event.end ? event.end.getTime() - event.start.getTime() : 3600000;
              eventList.push({
                summary: 'Busy',
                start: date,
                end: new Date(date.getTime() + duration),
                type: 'recurring'
              });
            }
          } catch (e) {
            console.error('Recurring event error:', e);
          }
        } else if (event.start) {
          const startDate = new Date(event.start);
          const eventEnd = new Date(event.end || event.start);
          
          if (eventEnd >= now && startDate <= endDate) {
            eventList.push({
              summary: 'Busy',
              start: event.start,
              end: event.end || event.start,
              type: 'single'
            });
          }
        }
      }
    }
    
    eventList.sort((a, b) => new Date(a.start) - new Date(b.start));
    
    res.json({
      events: eventList,
      range: { start: now, end: endDate }
    });
    
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`Busy ICS Proxy listening on port ${PORT}`);
});