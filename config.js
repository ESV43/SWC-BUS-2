// ── SWC Bus Booking – Frontend Config ──
// NOTE: RAZORPAY_KEY_ID below is a placeholder in git.
// It is filled at Pages build time from GitHub Secrets/Variables
// (see config.template.js + .github/workflows/deploy-pages.yml).
// Local dev: replace __RAZORPAY_KEY_ID__ with your rzp_test_... key.

window.SWC_CONFIG = {
  APPS_SCRIPT_URL: "https://script.google.com/macros/s/AKfycbwYtx6fV7Y1wnVCWOEr6LTIGh3UJ3zEJ6x2iRqA0fR9wEG2SD8r0L3TRpYbq6b73O2m/exec",
  GOOGLE_CLIENT_ID: "71909220285-647djv3jpier18p19htkd5ia6obp192n.apps.googleusercontent.com",
  RAZORPAY_KEY_ID: "__RAZORPAY_KEY_ID__", // public key only — RAZORPAY_KEY_SECRET never goes in frontend
  // Use rzp_live_... for real payments. rzp_test_... only accepts Razorpay test
  // instruments (success@razorpay / test cards); real UPI apps will fail.
  FARE_TOTAL: 100,
  CANCEL_REFUND: 70,
  CURRENCY: "INR",
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
