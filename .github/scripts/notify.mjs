// Load Tracker push notifications.
// Runs on a schedule in GitHub Actions (see .github/workflows/notify.yml), reads the
// owner's data from Firestore, works out what's due today (America/Chicago time) and
// sends Web Push notifications to every device the owner turned notifications on for.
//
// No secrets live in this repo: the app generates its own push key pair in the browser
// and stores it under users/{uid}/settings/pushKeys, which only the owner (and this
// server job, via Google sign-in) can read.
//
// MODE (env):
//   auto  — normal scheduled run; sends whatever is due right now
//   test  — sends one test notification to every device
//   check — prints a summary (counts only) and sends nothing
//   all   — sends every enabled message as if it were due today (for previewing)
import admin from 'firebase-admin';
import webpush from 'web-push';

const PROJECT_ID = 'load-tracker-18ce6';
const TZ = 'America/Chicago';
const APP_URL = 'https://load-tracker-18ce6.web.app/';
const MODE = (process.env.MODE || 'auto').trim();
const SLOT_OVERRIDE = (process.env.SLOT || '').trim(); // 'morning' | 'evening' (optional)

export const NOTIFY_DEFAULTS = {
  paycheckPreview: true,  // Monday: what you'll be paid this Friday
  advanceComing: true,    // Monday: an advance comes out of this Friday's check
  payday: true,           // Friday: payday — what should have hit your account
  weeklyRecap: true,      // Sunday: last week's loads, miles, gross/net
  settlementReminder: true, // Saturday: no settlement uploaded for yesterday's check
  logLoadsReminder: false,  // Evenings Mon–Sat: no load logged today
};

/* ---------- date helpers (all on YYYY-MM-DD strings, timezone-free) ---------- */
function toDateStr(d){ return d.toISOString().slice(0, 10); }
function addDays(s, n){ const d = new Date(s + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return toDateStr(d); }
function dow(s){ return new Date(s + 'T00:00:00Z').getUTCDay(); } // 0=Sun
function getWeekStart(s){ return addDays(s, -dow(s)); }
function computePayDate(ws){ return addDays(ws, 5 + 14); }
function fmtDate(s){ return new Date(s + 'T00:00:00Z').toLocaleDateString('en-US', {timeZone:'UTC', weekday:'short', month:'short', day:'numeric'}); }
function fmtShort(s){ return new Date(s + 'T00:00:00Z').toLocaleDateString('en-US', {timeZone:'UTC', month:'short', day:'numeric'}); }
function money(n){ return '$' + (Number(n) || 0).toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2}); }
function nowInChicago(){
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date()).map(p => [p.type, p.value]));
  return {date: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour)};
}

/* ---------- pay math (mirrors index.html) ---------- */
function normalizePaySettings(d){
  const out = {versions: [{effective: '2000-01-01', items: [
    {name: 'Deductions', type: 'percent', value: 8},
    {name: 'Personal', type: 'percent', value: 2},
  ]}], advanceWeeks: 2};
  if(d && Array.isArray(d.versions) && d.versions.length){
    const v = d.versions.filter(x => x && typeof x.effective === 'string' && Array.isArray(x.items))
      .map(x => ({effective: x.effective, items: x.items.filter(i => i && Number(i.value) > 0)
        .map(i => ({name: String(i.name || 'Deduction'), type: i.type === 'flat' ? 'flat' : 'percent', value: Number(i.value)}))}))
      .sort((a, b) => a.effective.localeCompare(b.effective));
    if(v.length) out.versions = v;
  }
  return out;
}
function makePayCalc(loads, advances, paySettings){
  function itemsFor(payDate){
    let chosen = paySettings.versions[0];
    paySettings.versions.forEach(v => { if(v.effective <= payDate) chosen = v; });
    return chosen ? chosen.items : [];
  }
  return function weekPay(ws){
    const wLoads = loads.filter(l => l.date && getWeekStart(l.date) === ws);
    const gross = wLoads.reduce((s, l) => s + (Number(l.pay) || 0), 0);
    const miles = wLoads.reduce((s, l) => s + (Number(l.miles) || 0), 0);
    const payDate = computePayDate(ws);
    const dedTotal = gross > 0
      ? itemsFor(payDate).reduce((s, i) => s + (i.type === 'flat' ? i.value : gross * i.value / 100), 0)
      : 0;
    const advAmt = advances.filter(a => a.weekStart === ws).reduce((s, a) => s + (Number(a.amount) || 0), 0);
    return {ws, payDate, count: wLoads.length, miles, gross, dedTotal, advAmt, net: gross - dedTotal - advAmt};
  };
}

/* ---------- message builders ---------- */
function buildMessages(ctx, prefs, slot, forceAll){
  const {today, weekPay, loads, settlementWeeks} = ctx;
  const d = dow(today);
  const out = [];
  const want = (key, cond) => prefs[key] && (forceAll || cond);

  // Monday morning — this Friday's paycheck
  if(slot === 'morning' || forceAll){
    const friday = addDays(today, (5 - d + 7) % 7);
    const p = weekPay(addDays(friday, -19));
    if(want('paycheckPreview', d === 1)){
      const lines = [`Gross ${money(p.gross)}`];
      if(p.dedTotal > 0) lines.push(`deductions -${money(p.dedTotal)}`);
      if(p.advAmt > 0) lines.push(`advance -${money(p.advAmt)}`);
      out.push({tag: 'paycheck-' + p.payDate, title: `💵 Friday's paycheck: ${money(p.net)}`,
        body: p.count
          ? `Pay on ${fmtDate(p.payDate)} for ${fmtShort(p.ws)}–${fmtShort(addDays(p.ws, 6))} (${p.count} load${p.count === 1 ? '' : 's'}). ${lines.join(' · ')}.`
          : `No loads logged for ${fmtShort(p.ws)}–${fmtShort(addDays(p.ws, 6))}, the week paid ${fmtDate(p.payDate)}.${p.advAmt > 0 ? ` An advance of ${money(p.advAmt)} comes out of it.` : ''}`});
    }
    // The Monday paycheck message already lists the advance, so only send this one on its own
    // when the paycheck message is turned off.
    if(want('advanceComing', d === 1) && p.advAmt > 0 && (!prefs.paycheckPreview || forceAll)){
      out.push({tag: 'advance-' + p.payDate, title: `💳 Advance coming out Friday`,
        body: `${money(p.advAmt)} in advances comes out of your ${fmtDate(p.payDate)} check.`});
    }
    // Friday — payday
    if(want('payday', d === 5)){
      const pd = weekPay(addDays(today, -19));
      if(pd.count || pd.advAmt || forceAll){
        out.push({tag: 'payday-' + pd.payDate, title: `🎉 Payday — ${money(pd.net)}`,
          body: `You should be getting ${money(pd.net)} net today (gross ${money(pd.gross)}${pd.dedTotal > 0 ? `, deductions -${money(pd.dedTotal)}` : ''}${pd.advAmt > 0 ? `, advance -${money(pd.advAmt)}` : ''}).`});
      }
    }
    // Saturday — settlement reminder for yesterday's check
    if(want('settlementReminder', d === 6)){
      const ws = addDays(today, -20);
      const pd = weekPay(ws);
      if((pd.count && !settlementWeeks.has(ws)) || forceAll){
        out.push({tag: 'settlement-' + ws, title: `📄 Upload your settlement`,
          body: `No settlement or check stub yet for the ${fmtShort(ws)}–${fmtShort(addDays(ws, 6))} check (paid ${fmtDate(pd.payDate)}). Tap to add it.`});
      }
    }
    // Sunday — last week's recap
    if(want('weeklyRecap', d === 0)){
      const ws = addDays(today, -7);
      const r = weekPay(ws);
      out.push({tag: 'recap-' + ws, title: `📊 Last week: ${money(r.gross)} gross`,
        body: r.count
          ? `${fmtShort(ws)}–${fmtShort(addDays(ws, 6))}: ${r.count} load${r.count === 1 ? '' : 's'}, ${Math.round(r.miles).toLocaleString('en-US')} mi, about ${money(r.gross - r.dedTotal)} after deductions. Paid ${fmtDate(r.payDate)}.`
          : `No loads logged for ${fmtShort(ws)}–${fmtShort(addDays(ws, 6))}. Tap to add any you missed.`});
    }
  }
  // Evening, Mon–Sat — log today's loads
  if(slot === 'evening' || forceAll){
    if(want('logLoadsReminder', d >= 1 && d <= 6)){
      const loggedToday = loads.some(l => l.date === today);
      if(!loggedToday || forceAll){
        out.push({tag: 'log-' + today, title: `🚚 Log today's loads`,
          body: `Nothing logged for ${fmtDate(today)} yet. Tap to add your loads while they're fresh.`});
      }
    }
  }
  return out;
}

/* ---------- main ---------- */
async function main(){
  admin.initializeApp({projectId: PROJECT_ID, credential: admin.credential.applicationDefault()});
  const db = admin.firestore();
  const now = nowInChicago();
  const slot = SLOT_OVERRIDE || (now.hour < 15 ? 'morning' : 'evening');
  console.log(`Mode ${MODE} · Chicago date ${now.date} hour ${now.hour} · slot ${slot}`);

  const users = await db.collection('users').listDocuments();
  let sent = 0, failed = 0;
  for(const userRef of users){
    const [keysDoc, prefsDoc, payDoc, subsSnap] = await Promise.all([
      userRef.collection('settings').doc('pushKeys').get(),
      userRef.collection('settings').doc('notifications').get(),
      userRef.collection('settings').doc('pay').get(),
      userRef.collection('pushSubscriptions').get(),
    ]);
    const subs = subsSnap.docs.map(d => d.data()).filter(s => s && s.subscription && s.subscription.endpoint);
    if(!keysDoc.exists || !subs.length){ console.log('A user without notification devices — skipping'); continue; }
    const keys = keysDoc.data();
    const prefs = {...NOTIFY_DEFAULTS, ...((prefsDoc.exists && prefsDoc.data()) || {})};

    const [loadsSnap, advSnap, docsSnap] = await Promise.all([
      userRef.collection('loads').select('date', 'pay', 'miles').get(),
      userRef.collection('advances').select('weekStart', 'amount', 'date').get(),
      userRef.collection('documents').where('kind', '==', 'settlement').select('weekStart').get(),
    ]);
    const loads = loadsSnap.docs.map(d => d.data());
    const advances = advSnap.docs.map(d => d.data());
    const settlementWeeks = new Set(docsSnap.docs.map(d => d.data().weekStart));
    const weekPay = makePayCalc(loads, advances, normalizePaySettings(payDoc.exists ? payDoc.data() : null));

    let messages;
    if(MODE === 'test'){
      const p = weekPay(addDays(addDays(now.date, (5 - dow(now.date) + 7) % 7), -19));
      messages = [{tag: 'test', title: '🔔 Load Tracker notifications are on',
        body: `This is a test from the server. Your next check (${fmtDate(p.payDate)}) is ${money(p.net)} net so far.`}];
    } else {
      messages = buildMessages({today: now.date, weekPay, loads, settlementWeeks}, prefs, slot, MODE === 'all');
    }
    console.log(`${subs.length} device(s) · ${loads.length} loads · ${messages.length} message(s) due: ${messages.map(m => m.tag.split('-')[0]).join(', ') || 'none'}`);
    if(MODE === 'check' || !messages.length) continue;

    webpush.setVapidDetails('mailto:qtlee322@gmail.com', keys.publicKey, keys.privateKey);
    for(const m of messages){
      const payload = JSON.stringify({title: m.title, body: m.body, tag: m.tag, url: APP_URL});
      for(const s of subs){
        try{
          await webpush.sendNotification(s.subscription, payload, {TTL: 60 * 60 * 12, urgency: 'normal'});
          sent++;
        }catch(e){
          failed++;
          console.log(`Send failed (${s.deviceName || 'device'}): ${e.statusCode || ''} ${e.statusCode === 404 || e.statusCode === 410 ? 'device unsubscribed — turn notifications on again in the app' : (e.body || e.message || '').toString().slice(0, 200)}`);
        }
      }
    }
  }
  console.log(`Done — ${sent} sent, ${failed} failed`);
  if(failed && !sent) process.exitCode = 1;
}

if(process.argv[1] && process.argv[1].endsWith('notify.mjs') && !process.env.NOTIFY_NO_MAIN){
  main().catch(e => { console.error(e.message || e); process.exit(1); });
}
export {buildMessages, makePayCalc, normalizePaySettings, addDays};
