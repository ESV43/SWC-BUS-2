/****************************************************
 * SWC IISER TVM – Weekend Night Bus Booking Backend
 * Thampanoor (9:00 PM) → IISER Thiruvananthapuram
 * Sat & Sun weekly | 32 seats | Waitlist + Cancellation
 * Sender name for all mails: SWC.IISER.TVM
 *
 * SHEETS REQUIRED (names must match exactly):
 *
 * 1) "Bookings"
 * | Booking ID | Service Date | Day | Name | Email | Phone | Status | Seat No | Waitlist Position | Created At | Updated At | Cancelled At | Notes |
 *   Status = CONFIRMED | WAITLIST | CANCELLED
 *
 * 2) "ServiceControl"  (ADMIN DISABLE SWITCH — rows AUTO-CREATED)
 * | Service Date | Day | Disabled | Disable Reason | Total Seats | Booking Opens At | Booking Closes At | Notes |
 *   Service Date format: YYYY-MM-DD (e.g. 2026-10-10)
 *   Disabled = TRUE / FALSE  (tick TRUE to disable that day's bus)
 *   Rows for the upcoming Saturdays & Sundays are AUTO-CREATED periodically
 *   (same-day 17:30 open → 21:00 departure). Admin only ticks Disabled/Reason.
 *   If a date has no row → treated as ENABLED with 32 seats.
 *
 * 3) "Trip-YYYY-MM-DD"  (AUTO-CREATED per upcoming trip, AUTO-DELETED)
 *   One sheet per upcoming Sat/Sun trip (plus specials), e.g. "Trip-2026-10-11".
 *   Holds the CONFIRMED-only passenger manifest in seat order (no waitlist).
 *   Created/refreshed automatically on every booking/cancel and by the hourly
 *   maintenance trigger.
 *   DELETED automatically after 01:00 AM the next day (departure 21:00 + 4h).
 *   Do not edit these by hand — they are rebuilt from "Bookings".
 *
 * 3) "SpecialServices"  (ADMIN: EVENT / EXTRA BUSES — any date, any seats)
 * | Service ID | Service Date | Service Name | From | To | Departure Time | Total Seats | Disabled | Disable Reason | Booking Opens At | Booking Closes At | Notes | Fare (Rs) | Cancel Refund (Rs) |
 *   Service Date format: YYYY-MM-DD. Service Name: e.g. "Onam Fest Shuttle".
 *   Fare (Rs): fare charged for THIS special (blank = Rs 100).
 *   Cancel Refund (Rs): refund given on user cancel for THIS special — the
 *   sheet is the source of truth, ANY value works (0 = no refund, 50, 90 …).
 *   Blank/invalid = falls back to the weekend default. Weekend Sat/Sun
 *   shuttles are NOT configurable here — they stay at the fixed Rs 70 refund.
 *   From/To default to Thampanoor Bus Stand / IISER TVM if left blank.
 *   Departure Time: HH:MM 24h (e.g. 14:30) or h:mm AM/PM (e.g. 2:30 PM). Blank = 21:00.
 *   Total Seats: blank = 32.
 *   Service ID: leave blank to auto-generate (EVT-<date>-<name>). Tip: fill a stable
 *     ID yourself (e.g. ONAM-1) and never rename it once bookings exist.
 *   Booking Opens At: blank = OPEN IMMEDIATELY (right after you add the row).
 *     Format: YYYY-MM-DD HH:MM (e.g. 2026-10-08 10:00).
 *   Booking Closes At: blank = closes at departure. Same format.
 *   Disabled = TRUE / FALSE — tick TRUE to take that special off the site.
 *   Just add a row → it appears on the website instantly. No timing rules.
 *
 * Bookings sheet also carries trailing columns (auto-added, don't reorder):
 *   ... | Notes | Service ID | Service Name |
 *   Weekend rows: Service ID = WEEKEND-YYYY-MM-DD. Special rows: EVT-… id.
 *
 * DEPLOY:
 *  1. Create Google Sheet → add the 3 tabs + header rows above (or just run setupSheets()).
 *  2. Extensions → Apps Script → paste this file → Save.
 *  3. Deploy → New deployment → Web app → Execute as: Me,
 *     Who has access: Anyone. Copy the /exec URL into config.js
 *  4. Run setupSheets() once from the editor to create headers.
 *  5. Run setupMaintenanceTrigger() once to install the hourly trigger that:
 *     auto-creates ServiceControl rows, refreshes Trip sheets, deletes
 *     expired Trip sheets (after 1 AM next day) and hides past services.
 *
 * BOOKING WINDOWS (IST) — new rule:
 *  Saturday 9 PM bus → opens SATURDAY 17:30, closes SATURDAY 21:00 (departure)
 *  Sunday   9 PM bus → opens SUNDAY   17:30, closes SUNDAY   21:00 (departure)
 * WEBPAGE VISIBILITY: a weekend service is listed only while its 21:00
 *  departure is still in the future — it vanishes automatically after 9 PM.
 * TRIP SHEETS: created for the upcoming trip(s); deleted after 01:00 next day.
 ****************************************************/

const SHEET_BOOKINGS = 'Bookings';
const SHEET_CONTROL  = 'ServiceControl';
const SHEET_SPECIALS = 'SpecialServices';
const TOTAL_SEATS_DEFAULT = 32;
const ALLOWED_DOMAIN = '@iisertvm.ac.in';
// Must match GOOGLE_CLIENT_ID in config.js. When set, every book /
// mybookings / cancel call must carry a fresh Google ID token (idToken)
// which is verified here — email can then ONLY come from Google login.
const GOOGLE_CLIENT_ID = '71909220285-647djv3jpier18p19htkd5ia6obp192n.apps.googleusercontent.com';
const SENDER_NAME = 'SWC.IISER.TVM';
const TIMEZONE = 'Asia/Kolkata';
const DEFAULT_FROM = 'Thampanoor Bus Stand';
const DEFAULT_TO = 'IISER Thiruvananthapuram';
/* Trip-sheet lifecycle (IST wall-clock, computed from the 21:00 departure):
 *  webpage removal ......... at departure (21:00 same day)
 *  trip-sheet deletion ..... at departure + 4h (= 01:00 next day) */
const TRIP_SHEET_PREFIX = 'Trip-';
const TRIP_SHEET_KEEP_HOURS = 4;
const CONTROL_LOOKAHEAD_DAYS = 21;
// Logo shown at the top of every mail. Gmail blocks relative paths, so the
// logo must be embedded. Pick ONE:
//   Option A (most reliable): upload SWCBUS-mail.png to Google Drive,
//     Share -> Anyone with link, copy the FILE ID from the Drive URL and paste below.
//     Example Drive URL: https://drive.google.com/file/d/FILE_ID_HERE/view
//   Option B (no setup): keep LOGO_URL as the public GitHub Pages png.
//     Requires Pages to be ON, otherwise logo is skipped and text is shown.
const LOGO_FILE_ID = '1DsSLh8D_VIBHk4iajd6T1I4EGf6Zhbjj';
const LOGO_URL = 'https://ESV43.github.io/SWC-BUS/SWCBUS-mail.png';

/* ---------- Razorpay payments ----------
 * Fare model (configurable, paise = INR x 100):
 *   Charge at booking (CONFIRMED or WAITLIST): FARE_TOTAL_PAISE (Rs 100)
 *   Cancel a CONFIRMED/WAITLIST ticket: refund CANCEL_REFUND_PAISE (Rs 70),
 *     Rs 30 kept as convenience fee.
 *   Waitlist never promoted by departure: auto-refund FULL amount paid.
 * Credentials (GitHub-safe):
 *   Frontend Key ID comes from GitHub Variables/Secrets at Pages build time
 *     (config.template.js → config.js). See .github/workflows/deploy-pages.yml.
 *   Backend keys live ONLY in Apps Script Script Properties (never in git):
 *     RAZORPAY_KEY_ID ......... public key (fallback: constant below)
 *     RAZORPAY_KEY_SECRET ..... secret — NEVER in code/repo/frontend.
 *     Set both via Apps Script editor -> Project Settings -> Script Properties.
 *     If you keep them in GitHub Secrets too, copy the SAME values to Script
 *     Properties by hand (or via clasp) — the Secret alone does NOT reach
 *     Apps Script automatically.
 *   Test mode: use rzp_test_* keys. Live mode: rzp_live_* keys.
 */
const RAZORPAY_KEY_ID = 'rzp_test_REPLACE_WITH_YOUR_KEY_ID'; // fallback if Script Property missing
const RAZORPAY_CURRENCY = 'INR';
const FARE_TOTAL_PAISE = 10000;   // Rs 100.00 charged for every booking attempt
const CANCEL_REFUND_PAISE = 7000; // Rs 70.00 refunded on user cancel (Rs 30 convenience fee kept)
// Bookings sheet payment columns (auto-added by setupSheets, do not reorder):
const COL_ORDER_ID = 16;    // P
const COL_PAYMENT_ID = 17;  // Q
const COL_AMOUNT_PAID = 18; // R (paise)
const COL_PAY_STATUS = 19;  // S: PAID | REFUNDED | PARTIAL_REFUND | REFUND_FAILED
const COL_REFUND_ID = 20;   // T
const COL_REFUND_AMT = 21;  // U (paise)
const COL_REFUND_STATUS = 22; // V
/* ---------- in-request sheet cache (avoids repeated getDataRange reads) ---------- */
var _SC = { bookings: null, specials: null, control: null };
function scBookings() {
    if (_SC.bookings) return _SC.bookings;
    const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_BOOKINGS);
    if (!sh || sh.getLastRow() < 2) { _SC.bookings = [[]]; return _SC.bookings; }
    _SC.bookings = sh.getDataRange().getValues();
    return _SC.bookings;
}
function scSpecials() {
    if (_SC.specials) return _SC.specials;
    const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_SPECIALS);
    if (!sh || sh.getLastRow() < 2) { _SC.specials = []; return _SC.specials; }
    _SC.specials = sh.getDataRange().getValues();
    return _SC.specials;
}
function scControl() {
    if (_SC.control) return _SC.control;
    const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_CONTROL);
    if (!sh || sh.getLastRow() < 2) { _SC.control = []; return _SC.control; }
    _SC.control = sh.getDataRange().getValues();
    return _SC.control;
}
function invalidateSheetCache() {
    _SC.bookings = null; _SC.specials = null; _SC.control = null;
}
function invalidateServicesCache() {
    try { CacheService.getScriptCache().remove('swc_services_json'); } catch(e) {}
}

function getRazorpaySecret() {
    try {
        const s = PropertiesService.getScriptProperties().getProperty('RAZORPAY_KEY_SECRET');
        return String(s || '').trim();
    } catch(e) { return ''; }
}
// Key ID: Script Property wins (so GitHub-managed values work if you mirror
// them there), constant is the fallback for quick setup.
function getRazorpayKeyId() {
    try {
        const s = PropertiesService.getScriptProperties().getProperty('RAZORPAY_KEY_ID');
        if (s && String(s).trim()) return String(s).trim();
    } catch(e) {}
    return String(typeof RAZORPAY_KEY_ID !== 'undefined' ? RAZORPAY_KEY_ID : '').trim();
}

/* ---------- one-time setup ---------- */
function setupSheets() {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    let b = ss.getSheetByName(SHEET_BOOKINGS);
    if (!b) b = ss.insertSheet(SHEET_BOOKINGS);
    let c = ss.getSheetByName(SHEET_CONTROL);
    if (!c) c = ss.insertSheet(SHEET_CONTROL);

    const bookingHeaders = ['Booking ID','Service Date','Day','Name','Email','Phone','Status','Seat No','Waitlist Position','Created At','Updated At','Cancelled At','Notes','Service ID','Service Name','Order ID','Payment ID','Amount Paid','Payment Status','Refund ID','Refund Amount','Refund Status'];
    const controlHeaders = ['Service Date','Day','Disabled','Disable Reason','Total Seats','Booking Opens At','Booking Closes At','Notes'];
    const specialHeaders = ['Service ID','Service Date','Service Name','From','To','Departure Time','Total Seats','Disabled','Disable Reason','Booking Opens At','Booking Closes At','Notes','Fare (Rs)','Cancel Refund (Rs)'];

    if (b.getLastRow() === 0) {
        b.getRange(1,1,1,bookingHeaders.length).setValues([bookingHeaders]);
    } else {
        // migrate older sheets: append missing headers (Service ID / Name / payment cols)
        const need = ['Service ID','Service Name','Order ID','Payment ID','Amount Paid','Payment Status','Refund ID','Refund Amount','Refund Status'];
        need.forEach(function(hdr){
            const h = b.getRange(1,1,1,b.getLastColumn()).getValues()[0].map(String);
            if (h.indexOf(hdr) < 0) b.getRange(1, b.getLastColumn() + 1).setValue(hdr);
        });
    }
    if (c.getLastRow() === 0) {
        c.getRange(1,1,1,controlHeaders.length).setValues([controlHeaders]);
        // Example rows (admin can edit/delete). New rule: same-day 17:30 → 21:00.
        c.getRange(2,1,1,8).setValues([['2026-10-10','Saturday', false, '', 32, '2026-10-10 17:30', '2026-10-10 21:00', 'Example – edit me']]);
    }
    // Auto-create rows for the upcoming Saturdays & Sundays right away.
    try { ensureWeekendControlRows(); } catch(e) {}
    let s = ss.getSheetByName(SHEET_SPECIALS);
    if (!s) s = ss.insertSheet(SHEET_SPECIALS);
    if (s.getLastRow() === 0) {
        s.getRange(1,1,1,specialHeaders.length).setValues([specialHeaders]);
        s.getRange(2,1,1,13).setValues([['','2026-10-14','Onam Fest Shuttle (example – edit or delete me)','Thampanoor Bus Stand','IISER Thiruvananthapuram','14:30',20,false,'','','','Blank open/close = bookable immediately till departure',100]]);
    } else {
        // migrate older special sheets: append any missing trailing headers so
        // the admin always has a Fare + Cancel Refund (Rs) column to type into.
        const sh = s.getRange(1,1,1,s.getLastColumn()).getValues()[0].map(String);
        if (sh.indexOf('Fare (Rs)') < 0) s.getRange(1, s.getLastColumn() + 1).setValue('Fare (Rs)');
        if (sh.indexOf('Cancel Refund (Rs)') < 0) s.getRange(1, s.getLastColumn() + 1).setValue('Cancel Refund (Rs)');
    }
    // Formatting
    b.setFrozenRows(1); c.setFrozenRows(1); s.setFrozenRows(1);
    try {
        const rule = SpreadsheetApp.newDataValidation().requireCheckbox().build();
        c.getRange(2, 3, 200, 1).setDataValidation(rule);
        s.getRange(2, 8, 200, 1).setDataValidation(rule);
    } catch(e) {}
}

/* ---------- HTTP entry points ---------- */
function doGet(e) {
    const params = (e && e.parameter) || {};
    const action = (params.action || 'services').toLowerCase();
    try {
        if (action === 'services') return jsonOut({ ok: true, services: getNextServices() });
        if (action === 'status') {
            const key = params.serviceId || params.serviceDate;
            if (!key) throw new Error('serviceId (or serviceDate YYYY-MM-DD) required');
            return jsonOut({ ok: true, status: getServiceStatus(key) });
        }
        if (action === 'mybookings') {
            // Token-bearing calls are POST-only: a query-string token would be
            // written into Apps Script / proxy access logs.
            throw new Error('Use POST for My bookings (keeps your sign-in token out of the URL).');
        }
        throw new Error('Unknown action: ' + action);
    } catch (err) {
        return jsonOut({ ok: false, error: String(err && err.message || err) });
    }
}

function doPost(e) {
    let body = {};
    try { body = JSON.parse((e && e.postData && e.postData.contents) || '{}'); }
    catch (err) { return jsonOut({ ok: false, error: 'Invalid JSON body' }); }
    const action = String(body.action || '').toLowerCase();
    const lock = LockService.getScriptLock();
    try {
        lock.waitLock(15000);
        if (action === 'createorder') return jsonOut(createPaymentOrder(body));
        if (action === 'verifypayment' || action === 'verify' || action === 'book')
            return jsonOut(verifyAndBook(body));
        if (action === 'cancel') return jsonOut(cancelBooking(body));
        if (action === 'mybookings') return jsonOut({ ok: true, bookings: getMyBookings(body.email, body.idToken) });
        if (action === 'status') return jsonOut({ ok: true, status: getServiceStatus(body.serviceId || body.serviceDate) });
        if (action === 'services') return jsonOut({ ok: true, services: getNextServices() });
        if (action === 'config') return jsonOut({ ok: true, farePaise: FARE_TOTAL_PAISE, cancelRefundPaise: CANCEL_REFUND_PAISE, currency: RAZORPAY_CURRENCY, keyId: getRazorpayKeyId() });
        return jsonOut({ ok: false, error: 'Unknown action: ' + action });
    } catch (err) {
        return jsonOut({ ok: false, error: String(err && err.message || err) });
    } finally {
        try { lock.releaseLock(); } catch(e) {}
    }
}

function doOptions() { return jsonOut({ ok: true }); }

function jsonOut(obj) {
    return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/* ---------- core logic ---------- */

// Next Saturday + Sunday 9PM services PLUS any upcoming special/event buses.
// Specials appear the moment the admin adds the row (no timing rules).
// Weekend visibility rule: listed ONLY while 21:00 departure is in the future —
// the service vanishes from the webpage automatically the minute 9 PM passes.
function getNextServices() {
    try {
        const cache = CacheService.getScriptCache();
        const cached = cache.get('swc_services_json');
        if (cached) return JSON.parse(cached);
    } catch(e) {}
    // Opportunistic housekeeping (throttled, never fails the listing).
    try { lightMaintenance(); } catch(e) {}
    const out = [];
    const today = new Date();
    // weekend: look ahead 14 days, pick Sat(6) & Sun(0), nearest 2 not-yet-departed
    const candidates = [];
    for (let i = 0; i < 14; i++) {
        const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() + i);
        const dow = d.getDay();
        if (dow === 6 || dow === 0) {
            const iso = toISODate(d);
            const dep = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 21, 0, 0);
            if (dep.getTime() > Date.now()) candidates.push(iso); // gone right after 9 PM
        }
    }
    candidates.slice(0, 2).forEach(function(iso){ out.push(getServiceStatus('WEEKEND-' + iso)); });
    // specials: every row whose departure is still in the future (kept till 1h after)
    getSpecialRows().forEach(function(sp){
        if (sp.depart.getTime() > Date.now() - 1000*60*60) {
            try { out.push(getServiceStatus(sp.serviceId)); } catch(e) {}
        }
    });
    out.sort(function(a,b){ return new Date(a.departISO) - new Date(b.departISO); });
    const result = out.slice(0, 10);
    try { CacheService.getScriptCache().put('swc_services_json', JSON.stringify(result), 3); } catch(e) {}
    return result;
}

// key = 'WEEKEND-YYYY-MM-DD' | 'EVT-…' service ID | plain 'YYYY-MM-DD' (weekend, legacy)
function getServiceStatus(key) {
    const svc = resolveService(key);
    const counts = countSeatsById(svc.serviceId);
    const now = new Date();
    const bookingOpen = !svc.disabled && now >= svc.opens && now <= svc.closes;
    let windowLabel = '';
    if (svc.disabled) windowLabel = 'disabled';
    else if (now < svc.opens) windowLabel = 'upcoming';
    else if (now > svc.closes) windowLabel = 'closed';
    else windowLabel = 'open';
    const farePaise = (svc.farePaise || FARE_TOTAL_PAISE);
    // 0 is a valid refund policy (no refund), so use an explicit null check.
    const cancelRefundPaise = (svc.cancelRefundPaise != null ? svc.cancelRefundPaise : CANCEL_REFUND_PAISE);
    return {
        serviceId: svc.serviceId,
        kind: svc.kind,
        serviceName: svc.serviceName,
        serviceDate: svc.serviceDate,
        day: svc.dayName,
        departure: svc.serviceDate + ' ' + svc.departTime,
        from: svc.from,
        to: svc.to,
        route: svc.from + ' → ' + svc.to,
        totalSeats: svc.totalSeats,
        confirmedCount: counts.confirmed,
        available: Math.max(0, svc.totalSeats - counts.confirmed),
        waitlistCount: counts.waitlist,
        disabled: svc.disabled,
        disableReason: svc.reason,
        bookingOpen: bookingOpen,
        window: windowLabel,
        opensAt: fmtDT(svc.opens),
        closesAt: fmtDT(svc.closes),
        opensISO: isoOut(svc.opens),
        closesISO: isoOut(svc.closes),
        departISO: isoOut(svc.depart),
        farePaise: farePaise,
        fareDisplay: 'Rs ' + (farePaise / 100),
        cancelRefundPaise: cancelRefundPaise,
        cancelRefundDisplay: 'Rs ' + (cancelRefundPaise / 100)
    };
}

// Resolve any key into a full normalized service descriptor. Throws on unknown.
function resolveService(key) {
    key = String(key || '').trim();
    // 1) special by exact service ID
    const specials = getSpecialRows();
    for (let i = 0; i < specials.length; i++) {
        if (specials[i].serviceId === key) return specials[i];
    }
    // 2) weekend by 'WEEKEND-YYYY-MM-DD' or plain date
    let iso = null;
    if (/^WEEKEND-\d{4}-\d{2}-\d{2}$/.test(key)) iso = key.slice(8);
    else if (/^\d{4}-\d{2}-\d{2}$/.test(key)) iso = key;
    if (iso) {
        const parsed = parseServiceDate(iso);
        const control = getControlRow(iso);
        const totalSeats = control && control.totalSeats ? control.totalSeats : TOTAL_SEATS_DEFAULT;
        const defWindow = bookingWindowFor(parsed.date);
        // Admin can override windows via ServiceControl columns; otherwise same-day 17:30 → 21:00.
        const window = {
            opens: (control && control.opens) || defWindow.opens,
            closes: (control && control.closes) || defWindow.closes
        };
        return {
            kind: 'weekend',
            serviceId: 'WEEKEND-' + iso,
            serviceName: 'Weekend Night Bus',
            serviceDate: iso,
            dayName: parsed.dayName,
            from: DEFAULT_FROM,
            to: DEFAULT_TO,
            departTime: '21:00',
            depart: new Date(parsed.date.getFullYear(), parsed.date.getMonth(), parsed.date.getDate(), 21, 0, 0),
            totalSeats: totalSeats,
            disabled: control ? !!control.disabled : false,
            reason: control ? (control.reason || '') : '',
            opens: window.opens,
            closes: window.closes,
            farePaise: FARE_TOTAL_PAISE,
            cancelRefundPaise: CANCEL_REFUND_PAISE
        };
    }
    throw new Error('Unknown service: ' + key);
}

// Read + normalize every SpecialServices row (skips rows without date/name).
function getSpecialRows() {
    const vals = scSpecials();
    if (!vals || vals.length < 2) return [];
    const out = [];
    for (let r = 1; r < vals.length; r++) {
        let sid = String(vals[r][0] || '').trim();
        const rawDate = vals[r][1];
        const iso = (rawDate instanceof Date) ? toISODate(rawDate) : String(rawDate || '').slice(0, 10);
        const name = String(vals[r][2] || '').trim();
        if (!/^\d{4}-\d{2}-\d{2}$/.test(iso) || !name) continue;
        if (!sid) sid = 'EVT-' + iso + '-' + name.toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24);
        const parsed = parseServiceDate(iso);
        const depart = combineDateTime(parsed.date, vals[r][5], 21, 0);
        const opensRaw = parseSheetDateTime(vals[r][9]);
        const closesRaw = parseSheetDateTime(vals[r][10]);
        out.push({
            kind: 'special',
            serviceId: sid,
            serviceName: name,
            serviceDate: iso,
            dayName: parsed.dayName,
            from: String(vals[r][3] || '').trim() || DEFAULT_FROM,
                 to: String(vals[r][4] || '').trim() || DEFAULT_TO,
                 departTime: fmtTime(depart),
                 depart: depart,
                 totalSeats: parseInt(vals[r][6], 10) || TOTAL_SEATS_DEFAULT,
                 disabled: vals[r][7] === true || String(vals[r][7]).toUpperCase() === 'TRUE',
                 reason: String(vals[r][8] || ''),
                  // blank opens = open immediately; blank closes = closes at departure
                  opens: opensRaw || new Date(2000, 0, 1),
                  closes: closesRaw || depart,
                   farePaise: (function(){
                       const raw = (vals[r].length > 12) ? vals[r][12] : '';
                       const rs = parseFloat(raw);
                       return (isNaN(rs) || rs <= 0) ? FARE_TOTAL_PAISE : Math.round(rs * 100);
                   })(),
                   // Column N "Cancel Refund (Rs)" — the sheet is the source of
                   // truth: 0, 50, 90 … flow through exactly as typed. Only a
                   // truly empty/invalid cell falls back to the default.
                   cancelRefundPaise: (function(){
                       const raw = vals[r][13];
                       if (raw === '' || raw === null || raw === undefined) return CANCEL_REFUND_PAISE;
                       const rs = parseFloat(raw);
                       if (isNaN(rs) || rs < 0) return CANCEL_REFUND_PAISE;
                       return Math.round(rs * 100);
                   })()
          });
    }
    return out;
}

// Combine a date with a time cell (Date | "14:30" | "2:30 PM" | blank→defH:defM)
function combineDateTime(dateObj, timeCell, defH, defM) {
    let h = defH, m = defM;
    if (timeCell instanceof Date) { h = timeCell.getHours(); m = timeCell.getMinutes(); }
    else if (timeCell !== '' && timeCell !== null && timeCell !== undefined) {
        const t = String(timeCell).trim();
        let mm = t.match(/^(\d{1,2}):(\d{2})\s*([AaPp])\.?\s*[Mm]\.?$/);
        if (mm) {
            h = parseInt(mm[1], 10) % 12; m = parseInt(mm[2], 10);
            if (/p/i.test(mm[3])) h += 12;
        } else {
            mm = t.match(/^(\d{1,2}):(\d{2})$/);
            if (mm) { h = parseInt(mm[1], 10); m = parseInt(mm[2], 10); }
        }
    }
    return new Date(dateObj.getFullYear(), dateObj.getMonth(), dateObj.getDate(), h, m, 0);
}

// Parse optional sheet datetime ("YYYY-MM-DD HH:MM" | Date | blank→null)
function parseSheetDateTime(cell) {
    if (!cell) return null;
    if (cell instanceof Date) return isNaN(cell.getTime()) ? null : cell;
    const m = String(cell).trim().match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2}):(\d{2}))?/);
    if (!m) return null;
    return new Date(parseInt(m[1],10), parseInt(m[2],10)-1, parseInt(m[3],10), parseInt(m[4]||'0',10), parseInt(m[5]||'0',10), 0);
}

function fmtTime(d) { return pad2(d.getHours()) + ':' + pad2(d.getMinutes()); }
function pad2(n) { return String(n).padStart(2, '0'); }
function isoOut(d) {
    try { return Utilities.formatDate(new Date(d), TIMEZONE, "yyyy-MM-dd'T'HH:mm:ss"); }
    catch(e) { return ''; }
}

/* ---------- Google identity verification ----------
 * Email is NEVER trusted from the client alone. When GOOGLE_CLIENT_ID is
 * set, the frontend must send the Google ID token (idToken) and we verify
 * it against Google's tokeninfo endpoint: signature, audience, expiry,
 * verified flag and @iisertvm.ac.in domain. */
function verifyGoogleToken(idToken) {
    idToken = String(idToken || '').trim();
    if (!idToken) throw new Error('Google sign-in required. Please sign in with your @iisertvm.ac.in account.');
    var resp = UrlFetchApp.fetch(
        'https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(idToken),
        { muteHttpExceptions: true });
    if (resp.getResponseCode() !== 200)
        throw new Error('Google sign-in expired or invalid. Please sign in again.');
    var info = {};
    try { info = JSON.parse(resp.getContentText()); } catch(e) { throw new Error('Could not verify Google sign-in. Please try again.'); }
    if (String(info.aud || '') !== String(GOOGLE_CLIENT_ID || '').trim())
        throw new Error('Google sign-in mismatch. Please sign in again.');
    if (info.email_verified !== 'true' && info.email_verified !== true)
        throw new Error('Google email is not verified. Use a verified @iisertvm.ac.in ID.');
    var email = String(info.email || '').toLowerCase().trim();
    if (!email || email.slice(-ALLOWED_DOMAIN.length) !== ALLOWED_DOMAIN)
        throw new Error('Booking is only available for ' + ALLOWED_DOMAIN + ' mail IDs. Signed in as ' + (email || 'unknown') + '.');
    if (info.hd && String(info.hd).toLowerCase() !== 'iisertvm.ac.in')
        throw new Error('Only @iisertvm.ac.in Google accounts can book.');
    var exp = parseInt(info.exp || '0', 10);
    if (exp && exp * 1000 < Date.now())
        throw new Error('Google sign-in expired. Please sign in again.');
    return email;
}

// Authoritative email resolver: verified Google token wins; the claimed
// email (if any) must match it. Falls back to domain check only when
// GOOGLE_CLIENT_ID is deliberately left blank during setup.
function resolveBookingEmail(p) {
    p = p || {};
    var claimed = String(p.email || '').trim().toLowerCase();
    if (String(GOOGLE_CLIENT_ID || '').trim()) {
        var verified = verifyGoogleToken(p.idToken);
        if (claimed && claimed !== verified)
            throw new Error('Email mismatch: you are signed in as ' + verified + '. Email cannot be changed manually.');
        return verified;
    }
    if (!claimed || claimed.indexOf('@') < 0) throw new Error('Valid email required.');
    if (claimed.slice(-ALLOWED_DOMAIN.length) !== ALLOWED_DOMAIN)
        throw new Error('Booking is only available for ' + ALLOWED_DOMAIN + ' mail IDs. Please login with your IISER email.');
    return claimed;
}

/* ---------- Razorpay helpers ---------- */
function rzpAuthHeader() {
    const keyId = getRazorpayKeyId();
    const secret = getRazorpaySecret();
    if (!keyId || keyId.indexOf('REPLACE') >= 0 || keyId.indexOf('__') >= 0 || !/^rzp_(test|live)_/.test(keyId))
        throw new Error('Razorpay Key ID not configured. Set Script Property RAZORPAY_KEY_ID (or the Code.gs fallback) and GitHub RAZORPAY_KEY_ID.');
    if (!secret) throw new Error('Razorpay secret missing. Set Script Property RAZORPAY_KEY_SECRET first (Project Settings → Script Properties).');
    return 'Basic ' + Utilities.base64Encode(keyId + ':' + secret);
}
function rzpVerifySignature(orderId, paymentId, signature) {
    const secret = getRazorpaySecret();
    const payload = String(orderId || '') + '|' + String(paymentId || '');
    // Apps Script has no computeHmacSha256Hex; compute signature bytes then hex-encode.
    const bytes = Utilities.computeHmacSha256Signature(payload, secret, Utilities.Charset.UTF_8);
    const hex = (bytes || []).map(function(b){
        const v = (b < 0) ? (b + 256) : b;
        return (v < 16 ? '0' : '') + v.toString(16);
    }).join('');
    // Razorpay sends lowercase hex; compare case-insensitively
    return String(hex || '').toLowerCase() === String(signature || '').toLowerCase();
}
function rzpFetchPayment(paymentId) {
    const resp = UrlFetchApp.fetch('https://api.razorpay.com/v1/payments/' + encodeURIComponent(paymentId),
        { method: 'get', headers: { Authorization: rzpAuthHeader() }, muteHttpExceptions: true });
    if (resp.getResponseCode() !== 200) throw new Error('Could not verify payment with Razorpay (payment fetch failed).');
    return JSON.parse(resp.getContentText());
}
// Capture an authorised payment. Razorpay only allows refunds on captured
// payments, so we must capture here when the account uses manual capture.
function rzpCapturePayment(paymentId, amountPaise) {
    const resp = UrlFetchApp.fetch('https://api.razorpay.com/v1/payments/' + encodeURIComponent(paymentId) + '/capture', {
        method: 'post', contentType: 'application/json', muteHttpExceptions: true,
        headers: { Authorization: rzpAuthHeader() },
        payload: JSON.stringify({ amount: amountPaise, currency: RAZORPAY_CURRENCY })
    });
    const code = resp.getResponseCode();
    let data = {};
    try { data = JSON.parse(resp.getContentText()); } catch(e) {}
    if (code !== 200 && code !== 201) {
        const msg = (data && data.error && data.error.description) || resp.getContentText();
        throw new Error('Payment capture failed: ' + msg);
    }
    return data;
}
function rzpCreateRazorpayOrder(amountPaise, receipt, notes) {
    const resp = UrlFetchApp.fetch('https://api.razorpay.com/v1/orders', {
        method: 'post', contentType: 'application/json', muteHttpExceptions: true,
        headers: { Authorization: rzpAuthHeader() },
        payload: JSON.stringify({ amount: amountPaise, currency: RAZORPAY_CURRENCY, receipt: receipt, notes: notes || {} })
    });
    if (resp.getResponseCode() !== 200) {
        let msg = resp.getContentText();
        try { msg = JSON.parse(msg).error.description || msg; } catch(e) {}
        throw new Error('Razorpay order failed: ' + msg);
    }
    return JSON.parse(resp.getContentText());
}
function rzpRefundPayment(paymentId, amountPaise, notes) {
    const payload = {};
    if (amountPaise) payload.amount = amountPaise; // omit = full refund
    if (notes) payload.notes = notes;
    const resp = UrlFetchApp.fetch('https://api.razorpay.com/v1/payments/' + encodeURIComponent(paymentId) + '/refund', {
        method: 'post', contentType: 'application/json', muteHttpExceptions: true,
        headers: { Authorization: rzpAuthHeader() },
        payload: JSON.stringify(payload)
    });
    const code = resp.getResponseCode();
    const data = JSON.parse(resp.getContentText());
    if (code !== 200 && code !== 201) {
        const msg = (data && data.error && data.error.description) || resp.getContentText();
        throw new Error('Refund failed: ' + msg);
    }
    return data;
}
function findBookingByPaymentId(paymentId) {
    const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_BOOKINGS);
    if (!sh || sh.getLastRow() < 2 || !paymentId) return null;
    const vals = sh.getDataRange().getValues();
    for (let r = 1; r < vals.length; r++) {
        if (String(vals[r][COL_PAYMENT_ID - 1] || '').trim() === String(paymentId).trim())
            return { row: r + 1, bookingId: String(vals[r][0]) };
    }
    return null;
}
// Shared eligibility check (used by BOTH createOrder and verify, so the
// frontend can't bypass window/duplicate/disabled rules by calling verify directly).
function checkBookable(p) {
    const key = String(p.serviceId || p.serviceDate || '').trim();
    const name = String(p.name || '').trim();
    const email = resolveBookingEmail(p);
    const phone = String(p.phone || '').trim();
    if (!key) throw new Error('Please choose a bus service.');
    if (!name || name.length < 2) throw new Error('Please enter your full name.');
    if (!phone || !/^[0-9+\-\s]{8,15}$/.test(phone)) throw new Error('Please enter a valid phone number.');
    const st = getServiceStatus(key);
    const svc = resolveService(key);
    if (svc.kind === 'weekend' && svc.dayName !== 'Saturday' && svc.dayName !== 'Sunday')
        throw new Error('Weekend bus runs only on Saturdays & Sundays.');
    const label = svc.serviceName + ' (' + svc.serviceDate + ' ' + svc.departTime + ')';
    if (st.disabled) throw new Error('Sorry, "' + svc.serviceName + '" is NOT operating on ' + svc.serviceDate + (st.disableReason ? ' (' + st.disableReason + ')' : '') + '.');
    if (!st.bookingOpen) {
        if (st.window === 'upcoming') throw new Error('Booking for "' + svc.serviceName + '" opens at ' + st.opensAt + '. Please come back then.');
        throw new Error('Booking for "' + svc.serviceName + '" is closed (window: ' + st.opensAt + ' → ' + st.closesAt + ').');
    }
    const existing = findActiveBooking(svc.serviceId, email);
    if (existing) throw new Error('You already have a ' + existing.status + ' booking for ' + label + ' (ID: ' + existing.bookingId + '). Check "My bookings" to manage it.');
    return { key: key, name: name, email: email, phone: phone, st: st, svc: svc, label: label };
}

/* Step 1/2 — frontend calls this BEFORE opening Razorpay Checkout.
 * Validates eligibility, creates a Razorpay order for Rs 100, returns orderId. */
function createPaymentOrder(p) {
    const c = checkBookable(p);
    const farePaise = (c.svc.farePaise || FARE_TOTAL_PAISE);
    const receipt = 'rcpt_' + c.svc.serviceDate.replace(/-/g, '') + '_' + String(Date.now()).slice(-8);
    const order = rzpCreateRazorpayOrder(farePaise, receipt, {
        serviceId: c.svc.serviceId, serviceDate: c.svc.serviceDate, email: c.email, name: c.name
    });
    return {
        ok: true,
        orderId: order.id,
        amount: order.amount,
        currency: order.currency || RAZORPAY_CURRENCY,
        keyId: getRazorpayKeyId(),
        farePaise: farePaise,
        fareDisplay: 'Rs ' + (farePaise / 100),
        serviceLabel: c.label,
        email: c.email
    };
}

/* Step 2/2 — called AFTER successful Razorpay Checkout.
 * Verifies signature + payment status/amount, THEN creates the booking
 * (CONFIRMED or WAITLIST, same seat logic as before). */
function verifyAndBook(p) {
    const orderId = String(p.razorpay_order_id || p.orderId || '').trim();
    const paymentId = String(p.razorpay_payment_id || p.paymentId || '').trim();
    const signature = String(p.razorpay_signature || p.signature || '').trim();
    if (!orderId || !paymentId || !signature)
        throw new Error('Payment verification missing. Please complete Razorpay payment first.');
    if (!rzpVerifySignature(orderId, paymentId, signature))
        throw new Error('Payment signature invalid. Booking NOT created — contact SWC if money was deducted.');
    if (findBookingByPaymentId(paymentId))
        throw new Error('This payment was already used for a booking. Check "My bookings".');
    // Confirm with Razorpay that the payment is captured for the right amount.
    // If the account uses manual capture the payment is only "authorized";
    // capture it now, otherwise a later refund would be rejected by Razorpay.
    let pay = rzpFetchPayment(paymentId);
    if (pay.status === 'authorized') {
        try {
            pay = rzpCapturePayment(paymentId, parseInt(pay.amount, 10));
        } catch (e) {
            throw new Error(String(e && e.message || e) + ' Booking NOT created — contact SWC if money was deducted.');
        }
    }
    if (pay.status !== 'captured')
        throw new Error('Payment not captured (status: ' + pay.status + '). Booking NOT created.');
    const c = checkBookable(p);
    const farePaise = (c.svc.farePaise || FARE_TOTAL_PAISE);
    if (parseInt(pay.amount, 10) !== farePaise)
        throw new Error('Payment amount mismatch. Expected Rs ' + (farePaise / 100) + '. Booking NOT created.');
    if (pay.order_id && pay.order_id !== orderId)
        throw new Error('Payment/order mismatch. Booking NOT created.');
    if (pay.currency && String(pay.currency).toUpperCase() !== RAZORPAY_CURRENCY)
        throw new Error('Payment currency mismatch (' + pay.currency + '). Booking NOT created.');

    const counts = countSeatsById(c.svc.serviceId);
    const isConfirmed = counts.confirmed < c.st.totalSeats;
    const bookingId = (c.svc.kind === 'special' ? 'EVT-' : 'SWC-') + c.svc.serviceDate.replace(/-/g, '') + '-' + Utilities.getUuid().slice(0, 6).toUpperCase();
    const now = new Date();
    let seatNo = '', waitPos = '', status = '';
    if (isConfirmed) { status = 'CONFIRMED'; seatNo = String(counts.confirmed + 1); }
    else { status = 'WAITLIST'; waitPos = String(counts.waitlist + 1); }

    appendBookingRow({
        bookingId: bookingId, serviceDate: c.svc.serviceDate, day: c.svc.dayName,
        name: c.name, email: c.email, phone: c.phone,
        status: status, seatNo: seatNo, waitPos: waitPos,
        createdAt: now, updatedAt: now, cancelledAt: '', notes: status === 'WAITLIST' ? 'Paid Rs ' + (farePaise / 100) + ' — auto-refund if never promoted' : 'Paid Rs ' + (farePaise / 100),
        serviceId: c.svc.serviceId, serviceName: c.svc.serviceName,
        orderId: orderId, paymentId: paymentId, amountPaid: farePaise, payStatus: 'PAID'
    });
    invalidateSheetCache();
    invalidateServicesCache();
    try { colorBookingsByDate(); } catch(e) {}
    try { refreshTripSheet(c.svc.serviceId); } catch(e) {}
    try {
        if (status === 'CONFIRMED') {
            sendMail(c.email,
                'Bus Booking CONFIRMED – ' + c.label + ' | SWC.IISER.TVM',
                confirmedHtml(c.name, bookingId, c.svc.serviceDate, c.svc.dayName, seatNo, c.st) + kv('AMOUNT PAID', 'Rs ' + (farePaise / 100) + ' (Payment ' + paymentId + ')'));
        } else {
            sendMail(c.email,
                'You are on the WAITLIST #' + waitPos + ' – ' + c.label + ' | SWC.IISER.TVM',
                waitlistHtml(c.name, bookingId, c.svc.serviceDate, c.svc.dayName, waitPos, c.st) + kv('AMOUNT PAID', 'Rs ' + (farePaise / 100) + ' — full auto-refund if never promoted by departure'));
        }
    } catch(e) {}
    return {
        ok: true, status: status, bookingId: bookingId, seatNo: seatNo, waitlistPosition: waitPos,
        paymentId: paymentId, amountPaid: farePaise,
        cancelRefundPaise: (c.svc.cancelRefundPaise != null ? c.svc.cancelRefundPaise : CANCEL_REFUND_PAISE),
        message: status === 'CONFIRMED'
            ? 'Payment verified! Booking confirmed, mailed to ' + c.email
            : 'Payment verified! All ' + c.st.totalSeats + ' seats filled — waitlist #' + waitPos + '. Full auto-refund if never promoted.'
    };
}
// Legacy direct-book endpoint (kept so old clients get a clear error, not a free seat).
function bookSeat(p) {
    if (p && (p.razorpay_payment_id || p.paymentId))
        return verifyAndBook(p);
    throw new Error('Online payment required (Rs ' + (FARE_TOTAL_PAISE / 100) + '). Please pay via Razorpay to book.');
}

function cancelBooking(p) {
    const bookingId = String(p.bookingId || '').trim();
    const email = resolveBookingEmail(p); // verified Google identity only
    if (!bookingId) throw new Error('bookingId required.');

    const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_BOOKINGS);
    const vals = sh.getDataRange().getValues();
    let rowIdx = -1, row = null;
    for (let r = 1; r < vals.length; r++) {
        if (String(vals[r][0]).trim() === bookingId) { rowIdx = r + 1; row = vals[r]; break; }
    }
    if (rowIdx < 0) throw new Error('Booking ID not found. Check "My bookings".');
    const rowEmail = String(row[4]).trim().toLowerCase();
    if (rowEmail !== email) throw new Error('Email does not match this booking. Cancellation denied.');
    const curStatus = String(row[6]);
    if (curStatus === 'CANCELLED') throw new Error('This booking is already cancelled.');
    const serviceDate = String(row[1]);
    const serviceId = rowServiceId(row, serviceDate);

    const now = new Date();
    const payId = String(row[COL_PAYMENT_ID - 1] || '').trim();
    const payStatus = String(row[COL_PAY_STATUS - 1] || '').trim();
    const amtPaid = parseInt(row[COL_AMOUNT_PAID - 1], 10) || 0;
    // Service-specific cancel refund (may be 0 for special services).
    let svcRefundPaise = CANCEL_REFUND_PAISE;
    try { const rs = resolveService(serviceId); if (rs && rs.cancelRefundPaise != null) svcRefundPaise = rs.cancelRefundPaise; } catch(e) {}
    sh.getRange(rowIdx, 7).setValue('CANCELLED');   // Status
    sh.getRange(rowIdx, 11).setValue(now);          // Updated At
    sh.getRange(rowIdx, 12).setValue(now);          // Cancelled At

    // --- refund: service-specific amount (may be 0) ---
    let refundInfo = null, refundErr = '';
    if (payId && (payStatus === 'PAID' || payStatus === '')) {
        try {
            const refundAmt = (svcRefundPaise > 0) ? Math.min(svcRefundPaise, amtPaid || svcRefundPaise) : 0;
            if (refundAmt > 0) {
                const rf = rzpRefundPayment(payId, refundAmt, { reason: 'user_cancel', bookingId: bookingId });
                const rfId = rf.id || '';
                sh.getRange(rowIdx, COL_PAY_STATUS).setValue(amtPaid - refundAmt > 0 ? 'PARTIAL_REFUND' : 'REFUNDED');
                sh.getRange(rowIdx, COL_REFUND_ID).setValue(rfId);
                sh.getRange(rowIdx, COL_REFUND_AMT).setValue(refundAmt);
                sh.getRange(rowIdx, COL_REFUND_STATUS).setValue('Rs ' + (refundAmt / 100) + ' refunded on ' + fmtDT(now) + ' (service policy)');
                refundInfo = { refundId: rfId, amount: refundAmt };
            } else {
                sh.getRange(rowIdx, COL_PAY_STATUS).setValue('NO_REFUND');
                sh.getRange(rowIdx, COL_REFUND_AMT).setValue(0);
                sh.getRange(rowIdx, COL_REFUND_STATUS).setValue('No refund per service policy (Rs 0) on ' + fmtDT(now));
                refundInfo = { refundId: '', amount: 0 };
            }
        } catch (e) {
            refundErr = String(e && e.message || e);
            sh.getRange(rowIdx, COL_PAY_STATUS).setValue('REFUND_FAILED');
            sh.getRange(rowIdx, COL_REFUND_STATUS).setValue(safeCell('FAILED: ' + refundErr));
            try {
                const cur = String(sh.getRange(rowIdx, 13).getValue() || '');
                sh.getRange(rowIdx, 13).setValue(safeCell((cur ? cur + ' | ' : '') + 'Refund failed: ' + refundErr));
            } catch (ee) {}
        }
    }

    // Human-readable refund line used in both the mail and the API response.
    let refundPhrase = '';
    if (refundInfo) {
        refundPhrase = refundInfo.amount > 0
            ? 'Rs ' + (refundInfo.amount / 100) + ' refund initiated to source (5–7 days).'
            : 'No refund is due for this service (Rs 0 policy).';
    } else if (refundErr) {
        refundPhrase = 'Auto-refund failed — SWC will refund you manually. ' + refundErr;
    } else if (!payId) {
        refundPhrase = 'No online payment was linked to this booking.';
    } else {
        refundPhrase = 'No fresh refund was due.';
    }

    // mail the canceller
    let svcLabel = serviceDate;
    try { const rs = resolveService(serviceId); svcLabel = rs.serviceName + ' (' + rs.serviceDate + ' ' + rs.departTime + ')'; } catch(e) {}
    try {
        let extra = '';
        if (refundInfo) {
            extra = refundInfo.amount > 0
                ? kv('REFUND', 'Rs ' + (refundInfo.amount / 100) + ' to source account in 5–7 days' + (refundInfo.amount < amtPaid ? ' (convenience fee kept)' : '') + '. Refund ID ' + (refundInfo.refundId || '—'))
                : kv('REFUND', 'No refund for this booking as per the service policy.');
        } else if (refundErr) {
            extra = slipNote('We cancelled your seat, but the automatic refund failed: ' + esc(refundErr) + '. SWC will refund you manually — reply to this mail.');
        } else if (!payId) {
            extra = slipNote('No online payment was linked to this booking, so no refund was due.');
        }
        sendMail(email,
                 'Booking CANCELLED – ' + svcLabel + ' | SWC.IISER.TVM',
                 cancelledHtml(String(row[3]), bookingId, serviceDate, svcLabel) + extra);
    } catch(e) {}

    // promote first WAITLIST of the SAME service (FIFO by Created At)
    // (waitlisted users already paid the full fare — promotion costs nothing extra)
    const promoted = promoteNextWaitlist(serviceId);
    invalidateSheetCache();
    invalidateServicesCache();
    try { refreshTripSheet(serviceId); } catch(e) {} // manifest reflects cancel/promotion
    return {
        ok: true,
        cancelled: bookingId,
        promoted: promoted ? promoted.bookingId : null,
        refund: refundInfo,
        refundError: refundErr,
        message: promoted
            ? 'Booking cancelled. ' + refundPhrase + ' Waitlist #' + promoted.oldPosition + ' (' + promoted.email + ') auto-confirmed & emailed.'
            : 'Booking cancelled. ' + refundPhrase + ' Mail sent.'
    };
}
/* Auto-refund WAITLIST bookings whose bus already departed without promotion.
 * Full amount paid back — nothing kept. Called by runMaintenance() hourly. */
function refundStaleWaitlists() {
    const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_BOOKINGS);
    if (!sh || sh.getLastRow() < 2) return { ok: true, refunded: [] };
    const vals = sh.getDataRange().getValues();
    const out = [];
    const nowMs = Date.now();
    for (let r = 1; r < vals.length; r++) {
        if (String(vals[r][6]) !== 'WAITLIST') continue;
        const payId = String(vals[r][COL_PAYMENT_ID - 1] || '').trim();
        const payStatus = String(vals[r][COL_PAY_STATUS - 1] || '').trim();
        if (!payId || payStatus === 'REFUNDED' || payStatus === 'PARTIAL_REFUND') continue;
        const amtPaid = parseInt(vals[r][COL_AMOUNT_PAID - 1], 10) || FARE_TOTAL_PAISE;
        const sid = rowServiceId(vals[r], String(vals[r][1]));
        let departMs = 0;
        try { departMs = resolveService(sid).depart.getTime(); } catch(e) { continue; }
        if (nowMs <= departMs + 30 * 60 * 1000) continue; // grace: depart + 30 min
        const rowIdx = r + 1;
        try {
            const rf = rzpRefundPayment(payId, amtPaid, { reason: 'waitlist_expired', bookingId: String(vals[r][0]) });
            sh.getRange(rowIdx, 7).setValue('CANCELLED');
            sh.getRange(rowIdx, 11).setValue(new Date());
            sh.getRange(rowIdx, 12).setValue(new Date());
            sh.getRange(rowIdx, 13).setValue('Auto-refund: waitlist never promoted, bus departed ' + fmtDT(new Date(departMs)));
            sh.getRange(rowIdx, COL_PAY_STATUS).setValue('REFUNDED');
            sh.getRange(rowIdx, COL_REFUND_ID).setValue(rf.id || '');
            sh.getRange(rowIdx, COL_REFUND_AMT).setValue(amtPaid);
            sh.getRange(rowIdx, COL_REFUND_STATUS).setValue('Auto-refund Rs ' + (amtPaid / 100) + ' on ' + fmtDT(new Date()));
            try {
                sendMail(String(vals[r][4]),
                    'Waitlist auto-refund – Rs ' + (amtPaid / 100) + ' | SWC.IISER.TVM',
                    slipHead('Waitlist expired', 'REFUNDED', '#9a6200')
                    + slipRow('BOOKING ID', String(vals[r][0]))
                    + slipRow('SERVICE', sid)
                    + kv('REFUND', 'Rs ' + (amtPaid / 100) + ' to source in 5–7 days. Refund ID ' + (rf.id || ''))
                    + slipNote('Your waitlist never got promoted before departure, so the full fare was refunded automatically.'));
            } catch(e) {}
            out.push({ bookingId: String(vals[r][0]), refundId: rf.id || '' });
        } catch (e) {
            try { sh.getRange(rowIdx, COL_REFUND_STATUS).setValue('AUTO-REFUND FAILED: ' + String(e && e.message || e)); } catch(ee) {}
        }
    }
    return { ok: true, refunded: out };
}

function promoteNextWaitlist(serviceId) {
    const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_BOOKINGS);
    const vals = sh.getDataRange().getValues();
    // collect WAITLIST rows for this service, earliest first
    const cands = [];
    for (let r = 1; r < vals.length; r++) {
        if (rowServiceId(vals[r], String(vals[r][1])) === serviceId && String(vals[r][6]) === 'WAITLIST')
            cands.push({ row: r + 1, created: vals[r][9], vals: vals[r] });
    }
    if (!cands.length) return null;
    cands.sort(function(a,b){ return new Date(a.created) - new Date(b.created); });
    const first = cands[0];
    const st = getServiceStatus(serviceId);
    const counts = countSeatsById(serviceId);
    // new seat number = confirmed count (after cancellation) + 1
    const newSeat = String(counts.confirmed + 1);
    const oldPos = String(first.vals[8] || '1');
    const now = new Date();
    sh.getRange(first.row, 7).setValue('CONFIRMED');
    sh.getRange(first.row, 8).setValue(newSeat);
    sh.getRange(first.row, 9).setValue('');
    sh.getRange(first.row, 11).setValue(now);
    sh.getRange(first.row, 13).setValue('Auto-promoted from waitlist #' + oldPos + ' on ' + fmtDT(now));

    // re-number remaining waitlist positions 1..n
    renumberWaitlist(serviceId);

    const pEmail = String(first.vals[4]);
    const pName = String(first.vals[3]);
    const pId = String(first.vals[0]);
    const svcDate = String(first.vals[1]);
    try {
        sendMail(pEmail,
                 'Good news! Your waitlist booking is now CONFIRMED – ' + svcDate + ' | SWC.IISER.TVM',
                 promotedHtml(pName, pId, svcDate, newSeat, st));
    } catch(e) {}
    invalidateSheetCache();
    invalidateServicesCache();
    return { bookingId: pId, email: pEmail, oldPosition: oldPos, newSeat: newSeat };
}

function renumberWaitlist(serviceId) {
    const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_BOOKINGS);
    const vals = sh.getDataRange().getValues();
    const cands = [];
    for (let r = 1; r < vals.length; r++) {
        if (rowServiceId(vals[r], String(vals[r][1])) === serviceId && String(vals[r][6]) === 'WAITLIST')
            cands.push({ row: r + 1, created: vals[r][9] });
    }
    cands.sort(function(a,b){ return new Date(a.created) - new Date(b.created); });
    cands.forEach(function(c, i){ sh.getRange(c.row, 9).setValue(i + 1); sh.getRange(c.row, 11).setValue(new Date()); });
}

// Service ID of a Bookings row: col N (Service ID) if present, else legacy WEEKEND-<date>
function rowServiceId(rowArr, serviceDate) {
    const sid = String(rowArr[13] || '').trim();
    if (sid) return sid;
    return 'WEEKEND-' + String(serviceDate || '').slice(0, 10);
}

function getMyBookings(email, idToken) {
    email = resolveBookingEmail({ email: email, idToken: idToken });
    const vals = scBookings();
    if (!vals || vals.length < 1) return [];
    const out = [];
    for (let r = vals.length - 1; r >= 1; r--) {
        if (String(vals[r][4]).trim().toLowerCase() === email) {
            const sid = rowServiceId(vals[r], String(vals[r][1]));
            let sName = String(vals[r][14] || '');
            let depart = '';
            let cancelRefundPaise = CANCEL_REFUND_PAISE;
            try { const rs = resolveService(sid); if (!sName) sName = rs.serviceName; depart = rs.serviceDate + ' ' + rs.departTime; if (rs && rs.cancelRefundPaise != null) cancelRefundPaise = rs.cancelRefundPaise; } catch(e) {}
            out.push({
                bookingId: String(vals[r][0]), serviceDate: String(vals[r][1]),
                     day: String(vals[r][2]), name: String(vals[r][3]), email: String(vals[r][4]),
                     phone: String(vals[r][5]), status: String(vals[r][6]),
                     seatNo: String(vals[r][7] || ''), waitlistPosition: String(vals[r][8] || ''),
                     createdAt: fmtDT(vals[r][9]),
                     serviceId: sid, serviceName: sName, departure: depart,
                     orderId: String(vals[r][COL_ORDER_ID - 1] || ''),
                      paymentId: String(vals[r][COL_PAYMENT_ID - 1] || ''),
                      amountPaid: parseInt(vals[r][COL_AMOUNT_PAID - 1], 10) || 0,
                      cancelRefundPaise: cancelRefundPaise,
                     paymentStatus: String(vals[r][COL_PAY_STATUS - 1] || ''),
                     refundId: String(vals[r][COL_REFUND_ID - 1] || ''),
                     refundAmount: parseInt(vals[r][COL_REFUND_AMT - 1], 10) || 0,
                     refundStatus: String(vals[r][COL_REFUND_STATUS - 1] || '')
            });
        }
    }
    return out;
}

/* ---------- helpers ---------- */
function findActiveBooking(serviceId, email) {
    const vals = scBookings();
    if (!vals || vals.length < 2) return null;
    for (let r = 1; r < vals.length; r++) {
        if (rowServiceId(vals[r], String(vals[r][1])) === serviceId &&
            String(vals[r][4]).trim().toLowerCase() === email &&
            (String(vals[r][6]) === 'CONFIRMED' || String(vals[r][6]) === 'WAITLIST'))
            return { bookingId: String(vals[r][0]), status: String(vals[r][6]) };
    }
    return null;
}

function countSeatsById(serviceId) {
    const vals = scBookings();
    if (!vals || vals.length < 2) return { confirmed: 0, waitlist: 0 };
    let c = 0, w = 0;
    for (let r = 1; r < vals.length; r++) {
        if (rowServiceId(vals[r], String(vals[r][1])) === serviceId) {
            if (String(vals[r][6]) === 'CONFIRMED') c++;
            if (String(vals[r][6]) === 'WAITLIST') w++;
        }
    }
    return { confirmed: c, waitlist: w };
}

function getControlRow(serviceDate) {
    const vals = scControl();
    if (!vals || vals.length < 2) return null;
    for (let r = 1; r < vals.length; r++) {
        const d = vals[r][0];
        const iso = (d instanceof Date) ? toISODate(d) : String(d).slice(0,10);
        if (iso === serviceDate) {
            return {
                disabled: vals[r][2] === true || String(vals[r][2]).toUpperCase() === 'TRUE',
                reason: String(vals[r][3] || ''),
                totalSeats: parseInt(vals[r][4], 10) || TOTAL_SEATS_DEFAULT,
                opens: parseSheetDateTime(vals[r][5]),
                closes: parseSheetDateTime(vals[r][6])
            };
        }
    }
    return null;
}

function parseServiceDate(s) {
    const parts = s.split('-').map(Number);
    const d = new Date(parts[0], parts[1]-1, parts[2]);
    const names = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
    return { date: d, dayName: names[d.getDay()] };
}

/* ---------- date colours: one pastel colour per Service Date ---------- */
// Palette cycles if there are more distinct dates than colours.
const DATE_COLORS = [
    '#FFF2CC', // warm yellow
'#D9EAD3', // mint green
'#CFE2F3', // sky blue
'#F4CCCC', // soft red
'#EAD1DC', // rose
'#D9D2E9', // lavender
'#FCE5CD', // peach
'#D0E0E3', // teal grey
'#FFFACD', // lemon
'#DDEBF7'  // pale blue
];

// Paint every Bookings row by its Service Date so each day stands out.
// Safe to run anytime: header untouched, blank dates stay white.
function colorBookingsByDate() {
    const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_BOOKINGS);
    if (!sh || sh.getLastRow() < 2) return { ok: true, colored: 0 };
    const lastRow = sh.getLastRow();
    const lastCol = sh.getLastColumn();
    const dates = sh.getRange(2, 2, lastRow - 1, 1).getValues().map(function(r){
        const d = r[0];
        return (d instanceof Date) ? toISODate(d) : String(d || '').slice(0, 10);
    });
    const uniq = [];
    dates.forEach(function(d){ if (d && uniq.indexOf(d) < 0) uniq.push(d); });
    uniq.sort(); // chronological → stable colours
    const map = {};
    uniq.forEach(function(d, i){ map[d] = DATE_COLORS[i % DATE_COLORS.length]; });
    for (let i = 0; i < dates.length; i++) {
        const color = map[dates[i]] || '#FFFFFF';
        sh.getRange(i + 2, 1, 1, lastCol).setBackground(color);
    }
    return { ok: true, colored: dates.length, dates: uniq.length };
}

// Adds a one-click menu to the spreadsheet: 🚌 SWC Bus → maintenance actions
function onOpen() {
    try {
        SpreadsheetApp.getUi().createMenu('🚌 SWC Bus')
        .addItem('🔁 Run maintenance now (control rows + trip sheets + cleanup)', 'runMaintenance')
        .addItem('📋 Ensure weekend control rows', 'ensureWeekendControlRows')
        .addItem('🧹 Delete expired trip sheets', 'cleanupTripSheets')
        .addItem('🎨 Color bookings by date', 'colorBookingsByDate')
        .addToUi();
    } catch(e) {}
}

// Booking windows (IST) — NEW RULE, same-day opening till departure 9 PM:
//  Saturday 9 PM bus → opens SATURDAY 17:30, closes SATURDAY 21:00
//  Sunday   9 PM bus → opens SUNDAY   17:30, closes SUNDAY   21:00
function bookingWindowFor(serviceDateObj) {
    const opens = new Date(serviceDateObj.getFullYear(), serviceDateObj.getMonth(), serviceDateObj.getDate(), 17, 30, 0);
    const closes = new Date(serviceDateObj.getFullYear(), serviceDateObj.getMonth(), serviceDateObj.getDate(), 21, 0, 0);
    return { opens: opens, closes: closes };
}

/* ---------- weekend automation: control rows + trip sheets + cleanup ----------
 * 1) ensureWeekendControlRows(): periodically adds a ServiceControl row for
 *    every Sat/Sun in the next CONTROL_LOOKAHEAD_DAYS, with same-day
 *    17:30 → 21:00 windows. Never overwrites admin edits — only inserts
 *    dates that have no row yet.
 * 2) Trip sheets "Trip-YYYY-MM-DD": CONFIRMED-only passenger manifest per
 *    upcoming trip, rebuilt from Bookings in seat order. Refreshed on every
 *    book/cancel/promote + hourly trigger.
 * 3) Deletion rule: trip sheet lives until departure + TRIP_SHEET_KEEP_HOURS
 *    (21:00 + 4h = 01:00 next day), then it is deleted automatically.
 * 4) Webpage removal is separate and instant: getNextServices() lists a
 *    weekend service only while its 21:00 departure is still ahead.
 * Run setupMaintenanceTrigger() ONCE to install the hourly trigger. */

function weekendDatesAhead(days) {
    var out = [];
    var today = new Date();
    var look = days || CONTROL_LOOKAHEAD_DAYS;
    for (var i = 0; i < look; i++) {
        var d = new Date(today.getFullYear(), today.getMonth(), today.getDate() + i);
        var dow = d.getDay();
        if (dow === 6 || dow === 0) out.push(new Date(d.getFullYear(), d.getMonth(), d.getDate()));
    }
    return out;
}

function fmtSheetDateTime(d) {
    try { return Utilities.formatDate(new Date(d), TIMEZONE, 'yyyy-MM-dd HH:mm'); }
    catch(e) {
        return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) +
            ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
    }
}

// Insert missing ServiceControl rows for upcoming Saturdays & Sundays.
// Idempotent: existing dates are left untouched (admin edits preserved).
function ensureWeekendControlRows() {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sh = ss.getSheetByName(SHEET_CONTROL);
    if (!sh) { setupSheets(); sh = ss.getSheetByName(SHEET_CONTROL); }
    if (!sh) return { ok: false, error: 'no control sheet' };
    var have = {};
    if (sh.getLastRow() >= 2) {
        var vals = sh.getRange(2, 1, sh.getLastRow() - 1, 1).getValues();
        for (var r = 0; r < vals.length; r++) {
            var cell = vals[r][0];
            var iso = (cell instanceof Date) ? toISODate(cell) : String(cell || '').slice(0, 10);
            if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) have[iso] = true;
        }
    }
    var names = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
    var added = 0;
    weekendDatesAhead(CONTROL_LOOKAHEAD_DAYS).forEach(function(d) {
        var iso = toISODate(d);
        if (have[iso]) return;
        var w = bookingWindowFor(d); // same-day 17:30 → 21:00
        sh.appendRow([iso, names[d.getDay()], false, '', TOTAL_SEATS_DEFAULT,
            fmtSheetDateTime(w.opens), fmtSheetDateTime(w.closes), 'Auto-created']);
        have[iso] = true;
        added++;
    });
    try {
        var rule = SpreadsheetApp.newDataValidation().requireCheckbox().build();
        if (sh.getLastRow() >= 2) sh.getRange(2, 3, sh.getLastRow() - 1, 1).setDataValidation(rule);
    } catch(e) {}
    invalidateSheetCache();
    if (added > 0) invalidateServicesCache();
    return { ok: true, added: added };
}

function tripSheetName(serviceDateIso) {
    return TRIP_SHEET_PREFIX + String(serviceDateIso || '').slice(0, 10);
}

// Per-service sheet name: weekends use the date form the admin expects
// ("Trip-YYYY-MM-DD"); specials use their stable service ID so a special
// on the same date never collides with / mixes into the weekend manifest.
function tripSheetNameForSvc(svc) {
    if (svc && svc.kind === 'special') {
        var sid = String(svc.serviceId || '').replace(/[\\/?*\[\]]/g, '-').slice(0, 80) || String(svc.serviceDate || '');
        return TRIP_SHEET_PREFIX + sid;
    }
    return tripSheetName(svc.serviceDate);
}

function tripSheetExpiry(departDate) {
    return new Date(departDate.getTime() + TRIP_SHEET_KEEP_HOURS * 60 * 60 * 1000);
}

// Rebuild one trip manifest from Bookings. Safe to call any time.
function refreshTripSheet(serviceId) {
    var svc;
    try { svc = resolveService(serviceId); }
    catch(e) { return { ok: false, error: String(e && e.message || e) }; }
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var name = tripSheetNameForSvc(svc);
    // Expired trips must not be (re)created — delete instead.
    if (Date.now() > tripSheetExpiry(svc.depart).getTime()) {
        var old = ss.getSheetByName(name);
        if (old) ss.deleteSheet(old);
        return { ok: true, deleted: true, sheet: name };
    }
    var bsh = ss.getSheetByName(SHEET_BOOKINGS);
    var rows = [];
    if (bsh && bsh.getLastRow() >= 2) {
        var vals = bsh.getDataRange().getValues();
        for (var r = 1; r < vals.length; r++) {
            if (rowServiceId(vals[r], String(vals[r][1])) !== svc.serviceId) continue;
            if (String(vals[r][6]) !== 'CONFIRMED') continue; // trip sheet: confirmed only
            rows.push({
                seat: parseInt(vals[r][7], 10) || 9999,
                name: String(vals[r][3] || ''),
                email: String(vals[r][4] || ''),
                phone: String(vals[r][5] || ''),
                bookingId: String(vals[r][0] || ''),
                createdAt: vals[r][9]
            });
        }
    }
    rows.sort(function(a, b) {
        return (a.seat - b.seat) || (new Date(a.createdAt) - new Date(b.createdAt));
    });
    var sh = ss.getSheetByName(name);
    if (!sh) sh = ss.insertSheet(name);
    sh.clearContents();
    sh.getRange(1, 1, 1, 7).setValues([[
        svc.serviceName + ' — ' + svc.serviceDate + ' (' + svc.dayName + ') ' +
        svc.departTime + ' · ' + svc.from + ' → ' + svc.to +
        ' · CONFIRMED ' + rows.length + '/' + svc.totalSeats +
        ' · auto-deleted after 01:00 next day']]);
    sh.getRange(2, 1, 1, 7).setValues([['Seat', 'Name', 'Email', 'Phone', 'Status', 'Booking ID', 'Booked At']]);
    if (rows.length) {
        var data = rows.map(function(x) {
            return [x.seat,
                safeCell(x.name), safeCell(x.email), safeCell(x.phone), 'CONFIRMED', safeCell(x.bookingId), fmtDT(x.createdAt)];
        });
        sh.getRange(3, 1, data.length, 7).setValues(data);
    }
    try {
        sh.setFrozenRows(2);
        sh.autoResizeColumns(1, 7);
    } catch(e) {}
    return { ok: true, sheet: name, rows: rows.length };
}

// Delete trip sheets whose 01:00-next-day expiry has passed.
// Weekend sheets ("Trip-YYYY-MM-DD") expire at date 21:00 + 4h.
// Special sheets ("Trip-<serviceId>") expire at their own departure + 4h.
// Sheets we cannot attribute to a service are left alone (admin deletes).
function cleanupTripSheets() {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var deleted = [];
    var now = Date.now();
    ss.getSheets().forEach(function(sh) {
        var n = sh.getName();
        if (n.indexOf(TRIP_SHEET_PREFIX) !== 0) return;
        var rest = n.slice(TRIP_SHEET_PREFIX.length);
        var depart = null;
        if (/^\d{4}-\d{2}-\d{2}$/.test(rest)) {
            try {
                var p = parseServiceDate(rest);
                depart = new Date(p.date.getFullYear(), p.date.getMonth(), p.date.getDate(), 21, 0, 0);
            } catch(e) { depart = null; }
        } else {
            try {
                var rs = resolveService(rest);
                depart = rs.depart;
            } catch(e) { depart = null; }
        }
        if (!depart) return; // unrecognised/orphan — keep for admin
        if (now > tripSheetExpiry(depart).getTime()) {
            ss.deleteSheet(sh);
            deleted.push(n);
        }
    });
    return { ok: true, deleted: deleted };
}

// Full pass: control rows → refresh manifests for live services → cleanup.
function runMaintenance() {
    var res = { control: null, trips: [], cleanup: null, refunds: null };
    try { res.control = ensureWeekendControlRows(); } catch(e) { res.control = { ok: false, error: String(e && e.message || e) }; }
    var live = [];
    try { live = getNextServicesLive(); } catch(e) { live = []; }
    live.forEach(function(svc) {
        try { res.trips.push(refreshTripSheet(svc.serviceId)); } catch(e) {}
    });
    try { res.cleanup = cleanupTripSheets(); } catch(e) { res.cleanup = { ok: false, error: String(e && e.message || e) }; }
    // Auto-refund waitlists whose bus departed without promotion (full amount paid)
    try { res.refunds = refundStaleWaitlists(); } catch(e) { res.refunds = { ok: false, error: String(e && e.message || e) }; }
    return res;
}

// Live services WITHOUT triggering another maintenance pass (no recursion).
function getNextServicesLive() {
    var out = [];
    var today = new Date();
    for (var i = 0; i < 14; i++) {
        var d = new Date(today.getFullYear(), today.getMonth(), today.getDate() + i);
        var dow = d.getDay();
        if (dow === 6 || dow === 0) {
            var iso = toISODate(d);
            var dep = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 21, 0, 0);
            if (dep.getTime() > Date.now()) {
                try { out.push(resolveService('WEEKEND-' + iso)); } catch(e) {}
            }
        }
    }
    try {
        getSpecialRows().forEach(function(sp) {
            if (sp.depart.getTime() > Date.now() - 1000 * 60 * 60) out.push(sp);
        });
    } catch(e) {}
    return out;
}

// Throttled pass for high-traffic read endpoints (page loads poll these).
// Control-row inserts run every call (cheap + idempotent); the heavier
// trip-sheet rebuild is at most once per 15 min here — writes (book/cancel)
// always refresh immediately, and the hourly trigger covers the rest.
function lightMaintenance() {
    try { ensureWeekendControlRows(); } catch(e) {}
    var run = true;
    try {
        var cache = CacheService.getScriptCache();
        if (cache && cache.get('swc_maint_ts')) run = false;
        else if (cache) cache.put('swc_maint_ts', '1', 900);
    } catch(e) { run = true; }
    if (!run) return;
    try {
        var live = getNextServicesLive();
        live.forEach(function(svc) { try { refreshTripSheet(svc.serviceId); } catch(e) {} });
        cleanupTripSheets();
    } catch(e) {}
}

// Install once: hourly automation. Safe to re-run (old trigger replaced).
function setupMaintenanceTrigger() {
    var triggers = ScriptApp.getProjectTriggers();
    for (var i = 0; i < triggers.length; i++) {
        if (triggers[i].getHandlerFunction() === 'runMaintenance') ScriptApp.deleteTrigger(triggers[i]);
    }
    ScriptApp.newTrigger('runMaintenance').timeBased().everyHours(1).create();
    runMaintenance();
    return 'Hourly maintenance installed: ServiceControl auto-add + trip sheets + 1 AM cleanup.';
}

// Google Sheets evaluates a leading = + - @ in a cell as a formula. Prefix an
// apostrophe so booker-supplied text (name/email/phone/notes) can never be
// interpreted as a formula (CSV/formula injection).
function safeCell(v) {
    const s = (v === null || v === undefined) ? '' : String(v);
    return /^[=+\-@\t\r]/.test(s) ? "'" + s : s;
}

function appendBookingRow(o) {
    const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_BOOKINGS);
    sh.appendRow([safeCell(o.bookingId), safeCell(o.serviceDate), safeCell(o.day), safeCell(o.name), safeCell(o.email), safeCell(o.phone), o.status, o.seatNo, o.waitPos, o.createdAt, o.updatedAt, o.cancelledAt, safeCell(o.notes), safeCell(o.serviceId || ''), safeCell(o.serviceName || ''),
        o.orderId || '', o.paymentId || '', o.amountPaid || '', o.payStatus || '', o.refundId || '', o.refundAmt || '', safeCell(o.refundStatus || '')]);
    invalidateSheetCache();
    invalidateServicesCache();
}

function toISODate(d) {
    return Utilities.formatDate(d, TIMEZONE, 'yyyy-MM-dd');
}
function fmtDT(d) {
    try {
        if (!d) return '';
        return Utilities.formatDate(new Date(d), TIMEZONE, 'dd MMM yyyy, hh:mm a');
    } catch(e) { return String(d); }
}

/* ---------- mail (ASCII only - no emojis, some mail apps break them) ---------- */
// Header-injection guard for mail: service names / notes are sheet-supplied
// and must never introduce CR/LF (or stray control chars) into a header.
function safeHeader(s) {
    return String(s == null ? '' : s).replace(/[\r\n\t]+/g, ' ').replace(/[\x00-\x1f\x7f]/g, '').trim();
}

function sendMail(to, subject, html) {
    to = safeHeader(to);
    subject = safeHeader(subject);
    var brand = '<span style="font-size:15px;font-weight:bold;letter-spacing:.5px">SWC &middot; IISER TVM</span>';
    var inlineImages = null;
    // 1) Drive file (most reliable - embedded, always shows)
    var driveId = String(typeof LOGO_FILE_ID !== 'undefined' ? LOGO_FILE_ID : '').trim();
    if (driveId) {
        try {
            var blob = DriveApp.getFileById(driveId).getBlob();
            inlineImages = { swc_logo: blob };
            brand = '<img src="cid:swc_logo" alt="SWC" width="40" height="40" style="display:block;width:40px;height:40px;border:0;outline:none;text-decoration:none;background:#ffffff;border-radius:8px;padding:2px">';
        } catch (e) {}
    }
    // 2) Fetch LOGO_URL server-side and embed as attachment (avoids Gmail image-proxy / Pages issues)
    if (!inlineImages) {
        var logoSrc = String(typeof LOGO_URL !== 'undefined' ? LOGO_URL : '').trim();
        if (logoSrc) {
            try {
                var resp = UrlFetchApp.fetch(logoSrc, { muteHttpExceptions: true });
                if (resp.getResponseCode() === 200) {
                    inlineImages = { swc_logo: resp.getBlob() };
                    brand = '<img src="cid:swc_logo" alt="SWC" width="40" height="40" style="display:block;width:40px;height:40px;border:0;outline:none;text-decoration:none;background:#ffffff;border-radius:8px;padding:2px">';
                } else {
                    // 3) Fallback to remote <img> (may be blocked, but try)
                    brand = '<img src="' + logoSrc + '" alt="SWC" width="40" height="40" style="display:block;width:40px;height:40px;border:0;background:#ffffff;border-radius:8px;padding:2px">';
                }
            } catch (e) {
                brand = '<img src="' + logoSrc + '" alt="SWC" width="40" height="40" style="display:block;width:40px;height:40px;border:0;background:#ffffff;border-radius:8px;padding:2px">';
            }
        }
    }
    var opts = {
        name: SENDER_NAME,
        htmlBody: htmlWrapper(subject, html, brand),
        replyTo: Session.getActiveUser().getEmail()
    };
    if (inlineImages) opts.inlineImages = inlineImages;
    GmailApp.sendEmail(to, subject, stripTags(html), opts);
}
function stripTags(h){ return String(h).replace(/<[^>]*>/g, ' ').replace(/&rarr;/g, '->').replace(/&middot;/g, '-').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim(); }
// Paper-slip look, same as the website. All inline CSS for mail-app safety.
function htmlWrapper(subject, inner, brandHtml) {
    var brand = brandHtml || '<span style="font-size:15px;font-weight:bold;letter-spacing:.5px">SWC &middot; IISER TVM</span>';
    return '<div style="background:#f5f1e6;padding:16px;font-family:Arial,Helvetica,sans-serif">'
    + '<div style="max-width:520px;margin:auto;background:#fffdf6;border:2px solid #191712;border-radius:14px;overflow:hidden">'
    + '<div style="background:#191712;color:#f5f1e6;padding:10px 18px">'
    + '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:0"><tr>'
    + '<td align="left" style="vertical-align:middle">' + brand + '</td>'
    + '<td align="left" style="vertical-align:middle;font-size:13px;font-weight:bold;letter-spacing:.5px;color:#f5f1e6;padding-left:10px">SWC &middot; IISER TVM</td>'
    + '<td align="right" style="vertical-align:middle;font-family:monospace;font-size:10px;letter-spacing:2px;color:#e8dfc8">BUS SLIP</td>'
    + '</tr></table>'
    + '</div>'
    + '<div style="padding:16px 18px">' + inner + '</div>'
    + '<div style="border-top:2px dashed #191712;padding:10px 18px;font-family:monospace;font-size:10px;letter-spacing:1px;color:#6d675c">SWC.IISER.TVM &middot; AUTOMATED MAIL &middot; DO NOT REPLY</div>'
    + '</div></div>';
}
function slipHead(title, stampText, stampColor) {
    return '<div style="margin-bottom:12px">'
    + '<span style="font-size:20px;font-weight:900;color:#191712">' + esc(title) + '</span> '
    + '<span style="display:inline-block;font-family:monospace;font-size:11px;font-weight:bold;letter-spacing:1px;color:' + stampColor + ';border:2px solid ' + stampColor + ';border-radius:7px;padding:2px 8px">' + esc(stampText) + '</span>'
    + '</div>';
}
function slipRoute(st) {
    const timeOnly = esc(String(st.departure).split(' ').pop());
    const busTime = esc(st.day) + ', ' + esc(st.serviceDate) + ' &middot; ' + timeOnly;
    const bookingTime = esc(st.opensAt || '') + ' &rarr; ' + esc(st.closesAt || '');
    return '<div style="border:2px solid #191712;border-radius:10px;padding:10px 12px;margin-bottom:12px">'
    + '<div style="font-size:16px;font-weight:900;color:#191712">' + esc(st.serviceName) + '</div>'
    + '<div style="margin-top:8px;font-size:13px;line-height:1.7;color:#191712">'
    + '<div><span style="font-family:monospace;font-size:10px;letter-spacing:1.5px;color:#6d675c">BUS TIME:</span> <strong>' + busTime + '</strong></div>'
    + '<div><span style="font-family:monospace;font-size:10px;letter-spacing:1.5px;color:#6d675c">ROUTE:</span> <strong>' + esc(st.from) + ' &rarr; ' + esc(st.to) + '</strong></div>'
    + '<div><span style="font-family:monospace;font-size:10px;letter-spacing:1.5px;color:#6d675c">BOOKING TIME:</span> <strong>' + bookingTime + '</strong></div>'
    + '</div>'
    + '</div>';
}
function slipRow(k, v) {
    return '<div style="border-bottom:1px dashed #d8d2c0;padding:7px 0">'
    + '<span style="font-family:monospace;font-size:10px;letter-spacing:1.5px;color:#6d675c">' + esc(k) + '</span><br>'
    + '<span style="font-size:14px;font-weight:bold;color:#191712">' + esc(String(v)) + '</span>'
    + '</div>';
}
function slipNote(t) {
    return '<p style="font-size:12.5px;line-height:1.6;color:#4a463d">' + t + '</p>';
}
function confirmedHtml(name, id, date, day, seat, st) {
    return slipHead('Seat booked', 'CONFIRMED', '#12784a')
    + slipRoute(st)
    + slipRow('BOOKING ID', id)
    + slipRow('NAME', name)
    + slipRow('SEAT (NO CHOICE)', seat + ' / ' + st.totalSeats)
    + slipNote('Cancel: website &rarr; My bookings. Seat goes to the waitlist.');
}
function waitlistHtml(name, id, date, day, pos, st) {
    return slipHead('Waitlist', '#' + pos, '#9a6200')
    + slipRoute(st)
    + slipRow('BOOKING ID', id)
    + slipRow('NAME', name)
    + slipRow('POSITION', '#' + pos + ' of ' + st.totalSeats + ' seats filled')
    + slipNote('Auto-confirmed + mailed if someone cancels. Cancel anytime on the website.');
}
function cancelledHtml(name, id, date, label) {
    return slipHead('Booking cancelled', 'CANCELLED', '#6d675c')
    + slipRow('BOOKING ID', id)
    + slipRow('NAME', name)
    + slipRow('SERVICE', label || date)
    + slipNote('Seat released to the waitlist. See you on the next bus.');
}
function promotedHtml(name, id, date, seat, st) {
    return slipHead('Seat confirmed', 'CONFIRMED', '#12784a')
    + slipRoute(st)
    + slipRow('BOOKING ID', id)
    + slipRow('NAME', name)
    + slipRow('SEAT (NO CHOICE)', seat + ' / ' + st.totalSeats)
    + slipNote('See you on the bus. Cancel anytime on the website.');
}
function kv(k,v){ return slipRow(k, v); }
function esc(s){ return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
