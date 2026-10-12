// ── SWC Bus Booking – Frontend Config (LIVE ONLY) ──
// 1. Deploy Code.gs as Web App (Execute as: Me, Who has access: Anyone)
//    and paste the /exec URL below.
// 2. Create a Google OAuth Client ID (Web) and paste below for Google Login.
//    Authorised JavaScript origin: https://YOUR-USERNAME.github.io (+ http://localhost:8000 for testing)

window.SWC_CONFIG = {
  APPS_SCRIPT_URL: "https://script.google.com/macros/s/AKfycbxQNqkYf_IH1tETGFSDZNSOR816qA5XnLS_ro70FE1ha0Y8Ds9A-B-vl7645mjOkr63/exec", // e.g. "https://script.google.com/macros/s/AKfyc.../exec"
  GOOGLE_CLIENT_ID: "71909220285-647djv3jpier18p19htkd5ia6obp192n.apps.googleusercontent.com", // e.g. "123456789-abc.apps.googleusercontent.com"
  TOTAL_SEATS: 32,
  ALLOWED_DOMAIN: "@iisertvm.ac.in",
  ROUTE_FROM: "Thampanoor Bus Stand",
  ROUTE_TO: "IISER Thiruvananthapuram",
  DEPARTURE_TIME: "9:00 PM",
  // Booking windows (IST): same-day opening till 9 PM departure.
  //  Saturday 9 PM bus → opens SATURDAY 5:30 PM, closes SATURDAY 9:00 PM
  //  Sunday   9 PM bus → opens SUNDAY   5:30 PM, closes SUNDAY   9:00 PM
  // Services vanish from the page right after 9 PM. Trip sheets
  // ("Trip-YYYY-MM-DD") auto-create for upcoming trips and auto-delete after 1 AM next day.
  // Event shuttles (SpecialServices sheet) open immediately when added.
};
