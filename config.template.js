// ── SWC Bus Booking – Frontend Config TEMPLATE ──
// Only the Razorpay Key ID comes from GitHub Secrets/Variables.
// Everything else stays hardcoded here as before.
//
// CI (.github/workflows/deploy-pages.yml) copies this file to config.js
// and replaces __RAZORPAY_KEY_ID__ at build time.
//
// Local dev: copy to config.js and fill the placeholder manually:
//   cp config.template.js config.js
//
// GitHub setup (repo → Settings → Secrets and variables → Actions):
//   EITHER Variables tab → New variable → Name: RAZORPAY_KEY_ID
//   OR     Secrets tab   → New secret   → Name: RAZORPAY_KEY_ID
//   Value: rzp_test_... / rzp_live_...  (PUBLIC key only)
//   Secret wins if both are set.
//   RAZORPAY_KEY_SECRET (the secret) is BACKEND ONLY — never put it here.
//   Set it in Apps Script → Project Settings → Script Properties →
//   RAZORPAY_KEY_SECRET.

window.SWC_CONFIG = {
  APPS_SCRIPT_URL: "https://script.google.com/macros/s/AKfycbxQNqkYf_IH1tETGFSDZNSOR816qA5XnLS_ro70FE1ha0Y8Ds9A-B-vl7645mjOkr63/exec",
  GOOGLE_CLIENT_ID: "71909220285-647djv3jpier18p19htkd5ia6obp192n.apps.googleusercontent.com",
  RAZORPAY_KEY_ID: "__RAZORPAY_KEY_ID__", // public key only — secret never goes here
  // Use rzp_live_... for real UPI/card payments. rzp_test_... only accepts
  // Razorpay test instruments (success@razorpay / test cards); real UPI apps fail.
  FARE_TOTAL: 100,
  CANCEL_REFUND: 70,
  CURRENCY: "INR",
  TOTAL_SEATS: 32,
  ALLOWED_DOMAIN: "@iisertvm.ac.in",
  ROUTE_FROM: "Thampanoor Bus Stand",
  ROUTE_TO: "IISER Thiruvananthapuram",
  DEPARTURE_TIME: "9:00 PM",
};
