import ical from 'node-ical';

const icsContent = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Test//Test//EN
BEGIN:VTIMEZONE
TZID:Europe/Berlin
BEGIN:STANDARD
DTSTART:19701025T030000
RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU
TZOFFSETFROM:+0200
TZOFFSETTO:+0100
END:STANDARD
BEGIN:DAYLIGHT
DTSTART:19700329T020000
RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU
TZOFFSETFROM:+0100
TZOFFSETTO:+0200
END:DAYLIGHT
END:VTIMEZONE
BEGIN:VEVENT
DTSTART;TZID=Europe/Berlin:20250807T080000
DTEND;TZID=Europe/Berlin:20250807T090000
RRULE:FREQ=WEEKLY
UID:TEST123
SUMMARY:Test Event
END:VEVENT
END:VCALENDAR`;

async function test() {
  // Test with UTC timezone (like Heroku)
  process.env.TZ = 'UTC';
  console.log('Testing with TZ=UTC');
  console.log('Server timezone offset:', new Date().getTimezoneOffset());
  
  const events = await ical.async.parseICS(icsContent);
  const event = events['TEST123'];
  
  console.log('\nOriginal event:');
  console.log('Event start:', event.start);
  console.log('Event start ISO:', event.start.toISOString());
  console.log('Event timezone:', event.start.tz);
  
  const now = new Date('2025-09-24T00:00:00Z');
  const later = new Date('2025-09-26T00:00:00Z');
  
  console.log('\nRRULE expansion for Sep 24-26:');
  const dates = event.rrule.between(now, later, true);
  dates.forEach(d => {
    console.log('\n- Expanded date object:', d);
    console.log('  Type:', typeof d, d.constructor.name);
    console.log('  ISO:', d.toISOString());
    console.log('  toString:', d.toString());
    console.log('  getTime:', d.getTime());
    
    // What we expect: Sep 25 08:00 Berlin = 06:00 UTC
    const expected = new Date('2025-09-25T06:00:00Z');
    console.log('  Expected ISO:', expected.toISOString());
    console.log('  Difference (ms):', d.getTime() - expected.getTime());
    console.log('  Difference (hours):', (d.getTime() - expected.getTime()) / 3600000);
  });
}

test().catch(console.error);