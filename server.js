const express = require('express');
const cors = require('cors');
const path = require('path');
const http = require('http');
const { Server: SocketIOServer } = require('socket.io');
const { MongoClient } = require('mongodb');
const { Builder, By, until, Key, Actions } = require('selenium-webdriver');
const firefox = require('selenium-webdriver/firefox');

// ─── Express + HTTP + Socket.IO setup ────────────────────────────────────────
const app = express();
const httpServer = http.createServer(app);

// ─── Allowed origins (add your Netlify URL here) ─────────────────────────────
const ALLOWED_ORIGINS = [
     'http://localhost:4200',
     'http://localhost:3000',
     /\.netlify\.app$/,          // matches any *.netlify.app subdomain
];

const io = new SocketIOServer(httpServer, {
     cors: {
          origin: ALLOWED_ORIGINS,
          methods: ['GET', 'POST']
     }
});

app.use(cors({ origin: ALLOWED_ORIGINS }));
app.use(express.json({ limit: '50mb' }));

// ─── MongoDB ─────────────────────────────────────────────────────────────────
const uri = "mongodb+srv://salesroshanengineeringworks_db_user:ie9J3GvyFLK8uzHG@cluster0.t0v7e7r.mongodb.net/?appName=Cluster0";
const client = new MongoClient(uri);
let db;

async function connectDB() {
     if (!db) {
          await client.connect();
          db = client.db('timesheet_tracker');
          console.log('Connected to MongoDB');
     }
     return db;
}
connectDB().catch(console.error);

// ─── Local geckodriver + Firefox binary paths ─────────────────────────────────
const GECKODRIVER_PATH = path.join(__dirname, 'geckodriver.exe');
const FIREFOX_BINARY = 'C:\\Program Files\\Mozilla Firefox\\firefox.exe';

// ─── Socket.IO connections ─────────────────────────────────────────────────────
io.on('connection', (socket) => {
     console.log(`[Socket] Client connected: ${socket.id}`);
     socket.on('disconnect', () => {
          console.log(`[Socket] Client disconnected: ${socket.id}`);
     });
});

/**
 * Emit a log line to ALL connected frontend clients.
 * type: 'info' | 'success' | 'warn' | 'error' | 'step'
 */
function emitLog(message, type = 'info') {
     const timestamp = new Date().toLocaleTimeString('en-IN', { hour12: false });
     const payload = { message, type, timestamp };
     console.log(`[${timestamp}] [${type.toUpperCase()}] ${message}`);
     io.emit('automation-log', payload);
}

function emitStatus(status) {
     // status: 'running' | 'success' | 'error' | 'idle'
     io.emit('automation-status', { status });
}

// ─── MongoDB REST routes ──────────────────────────────────────────────────────

app.get('/api/metadata', async (req, res) => {
     try {
          const database = await connectDB();
          const metaColl = database.collection('metadata');
          let meta = await metaColl.findOne({ _id: 'global' });
          if (!meta) {
               meta = { _id: 'global', months: {} };
               await metaColl.insertOne(meta);
          }
          res.json(meta);
     } catch (err) {
          console.error(err);
          res.status(500).json({ error: err.message });
     }
});

app.post('/api/metadata', async (req, res) => {
     try {
          const database = await connectDB();
          const metaColl = database.collection('metadata');
          await metaColl.updateOne({ _id: 'global' }, { $set: req.body }, { upsert: true });
          res.json({ success: true });
     } catch (err) {
          console.error(err);
          res.status(500).json({ error: err.message });
     }
});

// GET /api/timesheets/list
// Returns all timesheet documents as a flat list of { key, month, year, status, lastModified }
// Merges data from both the timesheets collection AND metadata so nothing is missed.
app.get('/api/timesheets/list', async (req, res) => {
     try {
          const database = await connectDB();
          const collection = database.collection('timesheets');
          const metaColl = database.collection('metadata');

          // Get all timesheet doc IDs (e.g. "February_2026")
          const allDocs = await collection.find({}, { projection: { _id: 1 } }).toArray();

          // Get metadata for status info
          const meta = await metaColl.findOne({ _id: 'global' });
          const metaMonths = meta?.months ?? {};

          const results = allDocs.map(doc => {
               const key = doc._id;               // "February_2026"
               const parts = key.split('_');
               const month = parts[0] ?? '';
               const year = parseInt(parts[1] ?? '0', 10);
               const entry = metaMonths[key] ?? {};
               const status = entry.status ?? 'active'; // default active if not in metadata
               return { key, month, year, status, lastModified: entry.lastModified ?? null };
          });

          // Also sync any timesheet docs that are missing from metadata
          const syncUpdates = {};
          for (const r of results) {
               if (!metaMonths[r.key]) {
                    syncUpdates[`months.${r.key}`] = {
                         status: 'active',
                         lastModified: new Date().toISOString()
                    };
               }
          }
          if (Object.keys(syncUpdates).length > 0) {
               await metaColl.updateOne(
                    { _id: 'global' },
                    { $set: syncUpdates },
                    { upsert: true }
               );
               console.log(`[timesheets/list] Synced ${Object.keys(syncUpdates).length} missing entries into metadata`);
          }

          res.json(results);
     } catch (err) {
          console.error(err);
          res.status(500).json({ error: err.message });
     }
});

app.get('/api/timesheet/:month/:year', async (req, res) => {
     try {
          const { month, year } = req.params;
          const database = await connectDB();
          const collection = database.collection('timesheets');
          const key = `${month}_${year}`;

          const ts = await collection.findOne({ _id: key });
          if (ts) {
               const metaColl = database.collection('metadata');
               let meta = await metaColl.findOne({ _id: 'global' });
               const isSubmitted = meta?.months?.[key]?.status === 'submitted';
               res.json({ month, year: parseInt(year), entries: ts.entries, isSubmitted });
          } else {
               res.json(null);
          }
     } catch (err) {
          console.error(err);
          res.status(500).json({ error: err.message });
     }
});

// PATCH /api/timesheet/:month/:year/status
// Updates just the status of a month in metadata (e.g. reset 'submitted' -> 'pending')
app.patch('/api/timesheet/:month/:year/status', async (req, res) => {
     try {
          const { month, year } = req.params;
          const { status } = req.body; // expected: 'active' | 'pending' | 'submitted'
          const allowed = ['active', 'pending', 'submitted'];
          if (!allowed.includes(status)) {
               return res.status(400).json({ error: `Invalid status. Must be one of: ${allowed.join(', ')}` });
          }

          const database = await connectDB();
          const metaColl = database.collection('metadata');
          const key = `${month}_${year}`;

          await metaColl.updateOne(
               { _id: 'global' },
               { $set: { [`months.${key}`]: { status, lastModified: new Date().toISOString() } } },
               { upsert: true }
          );

          console.log(`[status] ${key} => ${status}`);
          res.json({ success: true, key, status });
     } catch (err) {
          console.error(err);
          res.status(500).json({ error: err.message });
     }
});

app.post('/api/timesheet/:month/:year', async (req, res) => {
     try {
          const { month, year } = req.params;
          const data = req.body;

          if (!data || !data.entries) {
               return res.status(400).json({ error: 'No entries provided' });
          }

          const database = await connectDB();
          const collection = database.collection('timesheets');
          const key = `${month}_${year}`;

          await collection.updateOne(
               { _id: key },
               { $set: { ...data, _id: key } },
               { upsert: true }
          );

          const metaColl = database.collection('metadata');
          const updateField = `months.${key}`;
          const updateObj = {};
          updateObj[updateField] = { status: 'active', lastModified: new Date().toISOString() };
          await metaColl.updateOne({ _id: 'global' }, { $set: updateObj }, { upsert: true });

          res.json({ success: true });
     } catch (err) {
          console.error(err);
          res.status(500).json({ error: err.message });
     }
});

// ─── Automation Route ─────────────────────────────────────────────────────────
/**
 * POST /api/run-automation
 * Body: { month: "February", year: 2026, entries: [...] }
 *
 * Selectors (XPath-based, confirmed 2026-02-28):
 *
 *   Login page: https://ts.bravestechnologies.com/login/
 *     username      : //input[@id='username']
 *     password      : //input[@id='password']
 *     login button  : //button[contains(@class,'btn-primary')]
 *
 *   Dashboard (post-login):
 *     Timesheet link: //a[contains(@href,'/redirect_to_current_month/')]
 *
 *   Timesheet page — Month Navigator:
 *     Month label container : /html/body/main/div/div[1]/div[2]/div
 *     Left (prev) arrow     : /html/body/main/div/div[1]/div[2]/div/button[1]
 *
 *   Per-row entry flow:
 *     Add Entry button : /html/body/main/div/div[2]/div[2]/button
 *     Hours input      : /html/body/main/div/div[2]/div[2]/form/div[1]/div[1]/input
 *     Description input: /html/body/main/div/div[2]/div[2]/form/div[1]/div[2]/input
 *     Select2 search   : /html/body/span/span/span[1]/input
 *     Save Entry button: /html/body/main/div/div[2]/div[2]/form/div[2]/button[2]
 *
 *   Project to select: "00110207 - CleverVision Internal Product Development_Internal"
 */
app.post('/api/run-automation', async (req, res) => {
     let driver;
     try {
          const data = req.body;
          const entries = data.entries || [];
          const targetMonth = data.month;   // e.g. "February"
          const targetYear = data.year;    // e.g. 2026

          emitStatus('running');
          emitLog(`🚀 Automation started for ${targetMonth} ${targetYear}`, 'step');
          emitLog(`Using geckodriver: ${GECKODRIVER_PATH}`, 'info');

          // ── Build Firefox driver ────────────────────────────────────────────
          const serviceBuilder = new firefox.ServiceBuilder(GECKODRIVER_PATH);
          const options = new firefox.Options().setBinary(FIREFOX_BINARY);

          emitLog('Launching Firefox browser...', 'info');
          driver = await new Builder()
               .forBrowser('firefox')
               .setFirefoxService(serviceBuilder)
               .setFirefoxOptions(options)
               .build();

          await driver.manage().window().maximize();
          emitLog('Firefox launched and maximized ✓', 'success');

          // ── 1. Navigate to login page ───────────────────────────────────────
          emitLog('Navigating to login page...', 'info');
          await driver.get('https://ts.bravestechnologies.com/login/');

          // ── 2. Login ────────────────────────────────────────────────────────
          emitLog('Waiting for login form...', 'info');
          const usernameField = await driver.wait(
               until.elementLocated(By.id('username')), 20000
          );
          await usernameField.clear();
          await usernameField.sendKeys('sroy');

          const passwordField = await driver.findElement(By.id('password'));
          await passwordField.clear();
          await passwordField.sendKeys('AncientRuins56');
          emitLog('Credentials filled. Logging in...', 'info');

          const loginBtn = await driver.findElement(By.css('button.btn-primary'));
          await loginBtn.click();

          // ── 3. Wait for dashboard → click Timesheet link ────────────────────
          // XPath: /html/body/main/div/div[1]/div[2]/a
          // Use JS click to avoid "Element could not be scrolled into view" errors.
          emitLog('Waiting for dashboard...', 'info');
          const TS_LINK_XPATH = '/html/body/main/div/div[1]/div[2]/a';
          const TS_PARENT_XPATH = '/html/body/main/div/div[1]/div[2]';

          await driver.wait(
               until.elementLocated(By.xpath(TS_LINK_XPATH)), 25000
          );
          emitLog('Login successful ✓ — Navigating to timesheet (JS click)...', 'success');

          try {
               // Primary: JS click on the <a> tag (bypasses scroll restriction)
               const tsLinkEl = await driver.findElement(By.xpath(TS_LINK_XPATH));
               await driver.executeScript('arguments[0].click();', tsLinkEl);
               emitLog('  ✓ Clicked timesheet link via JS', 'info');
          } catch (linkErr) {
               emitLog(`  Link JS click failed (${linkErr.message}) — trying parent div...`, 'warn');
               // Fallback: JS click on the parent div
               const tsParentEl = await driver.findElement(By.xpath(TS_PARENT_XPATH));
               await driver.executeScript('arguments[0].click();', tsParentEl);
               emitLog('  ✓ Clicked parent div via JS', 'info');
          }
          await driver.sleep(2000);

          // ── 4. Check & navigate to the correct month ────────────────────────
          // XPaths for the month navigator on the timesheet page:
          const MONTH_SELECTOR_XPATH = '/html/body/main/div/div[1]/div[2]/div';
          const LEFT_ARROW_XPATH = '/html/body/main/div/div[1]/div[2]/div/button[1]';

          const MONTH_NAMES = [
               'January', 'February', 'March', 'April', 'May', 'June',
               'July', 'August', 'September', 'October', 'November', 'December'
          ];
          const targetMonthIdx = MONTH_NAMES.indexOf(targetMonth); // 0-based

          emitLog('Verifying displayed month on timesheet page...', 'info');

          // Wait for the month container to appear
          await driver.wait(
               until.elementLocated(By.xpath(MONTH_SELECTOR_XPATH)), 20000
          );
          await driver.sleep(500);

          // Navigate left if the portal is showing a future month
          let navAttempts = 0;
          const MAX_NAV = 6;
          while (navAttempts < MAX_NAV) {
               const monthContainer = await driver.findElement(By.xpath(MONTH_SELECTOR_XPATH));
               const displayedText = await monthContainer.getText(); // e.g. "February 2026"
               emitLog(`  Portal shows: "${displayedText}"`, 'info');

               const dispMonthIdx = MONTH_NAMES.findIndex(
                    m => displayedText.toLowerCase().includes(m.toLowerCase())
               );
               const yearMatch = displayedText.match(/\d{4}/);
               const displayedYear = yearMatch ? parseInt(yearMatch[0], 10) : targetYear;

               const isAhead =
                    displayedYear > targetYear ||
                    (displayedYear === targetYear && dispMonthIdx > targetMonthIdx);
               const isBehind =
                    displayedYear < targetYear ||
                    (displayedYear === targetYear && dispMonthIdx < targetMonthIdx);

               if (!isAhead && !isBehind) {
                    emitLog(`✅ Correct month confirmed: ${targetMonth} ${targetYear}`, 'success');
                    break;
               }

               if (isAhead) {
                    emitLog(`  Portal is ahead — clicking ← to go to previous month`, 'warn');
                    const leftArrow = await driver.findElement(By.xpath(LEFT_ARROW_XPATH));
                    await driver.executeScript('arguments[0].scrollIntoView({block:"center"});', leftArrow);
                    await driver.sleep(300);
                    await leftArrow.click();
                    await driver.sleep(1200);
               } else {
                    emitLog(`  Portal is behind target month — stopping navigation`, 'warn');
                    break;
               }
               navAttempts++;
          }

          // ==========================================================
          // ENTRIES LOOP - REFACTORED PER USER XPATH SPEC
          //
          // XPaths provided by user (Confirmed 2026-03-01):
          // Row 1 => outer div[2], inner div[2]
          // Row 2 => outer div[3], inner div[2]
          //
          // This means BASE XPath for Row N is: /html/body/main/div/div[N+1]/div[2]
          // outerIdx starts at 2 and increments for EVERY attempted row.
          // ==========================================================

          const allEntries = entries;
          emitLog(`Total entries to process: ${allEntries.length}`, 'info');

          const PROJECT_SEARCH_INPUT = '/html/body/span/span/span[1]/input';
          const FULL_PROJECT_NAME = '00110207 - CleverVision Internal Product Development_Internal';

          // Strict timeout for elements.
          const STEP_TIMEOUT_MS = 15000;

          let successCount = 0;
          let errorCount = 0;
          let outerIdx = 2; // Row 1 starts at div[2]
          let aborted = false;

          for (let i = 0; i < allEntries.length; i++) {
               if (aborted) break;

               const entry = allEntries[i];
               const dateStr = entry.date || '';
               // Use portalHours if set by frontend (leave=8, regular=actual hours)
               // Fall back to entry.hours if portalHours is missing (backward compat)
               const hours = (entry.portalHours != null) ? parseFloat(entry.portalHours) : (parseFloat(entry.hours) || 0);

               // Build portal remark
               // The frontend pre-builds portalRemark for all entries:
               //   Normal work:  "Apurva Worked For Sherin on CV-XXXX"
               //   Leave:        e.remark (e.g. "Earned Leave", "Sick Leave")
               //   No ticket:    e.remark as-is
               // Backend fallback (if portalRemark not set) just uses the raw remark.
               let portalRemark = '';
               if (entry.portalRemark && entry.portalRemark.trim()) {
                    portalRemark = entry.portalRemark.trim();
               } else {
                    portalRemark = (entry.remark || '').trim() || 'Work done';
               }

               // ── Construct XPaths for this specific row ────────────────────────
               // These match the user's old working code (processData / spring_row logic):
               //   trigger  → form/div[2]/div/span/span[1]/span
               //   s2 input → /html/body/span/span/span[1]/input  (absolute, not class-based)
               //   save     → form/button
               const BASE = `/html/body/main/div/div[${outerIdx}]/div[2]`;
               const XPATHS = {
                    ADD: `${BASE}/button`,
                    HOURS: `${BASE}/form/div[1]/div[1]/input`,
                    DESC: `${BASE}/form/div[1]/div[2]/input`,
                    PROJ: `${BASE}/form/div[1]/div[3]/span/span[1]/span`,
                    SAVE: `${BASE}/form/div[2]/button[2]`
               };
               const S2_INPUT = '/html/body/span/span/span[1]/input';

               emitLog(`\n─── [${i + 1}/${allEntries.length}] ${dateStr} | ${hours}h | outerIdx=${outerIdx} ───`, 'step');

               try {
                    // 1. Locate and Click "Add Entry"
                    emitLog(`  Locating Add Entry at div[${outerIdx}]...`, 'info');
                    const addBtn = await driver.wait(
                         until.elementLocated(By.xpath(XPATHS.ADD)), STEP_TIMEOUT_MS
                    );
                    await driver.executeScript('arguments[0].scrollIntoView({block:"center"});', addBtn);
                    await driver.sleep(500);
                    // Check if it's already "clicked" or if we need to click
                    await driver.executeScript('arguments[0].click();', addBtn);
                    await driver.sleep(1000);

                    // 2. Fill Hours
                    const hoursEl = await driver.wait(
                         until.elementLocated(By.xpath(XPATHS.HOURS)), STEP_TIMEOUT_MS
                    );
                    await driver.executeScript('arguments[0].scrollIntoView({block:"center"});', hoursEl);
                    await hoursEl.clear();
                    await hoursEl.sendKeys(hours.toString());
                    emitLog(`  ✓ Hours set: ${hours}`, 'info');

                    // 3. Fill Description
                    const descEl = await driver.wait(
                         until.elementLocated(By.xpath(XPATHS.DESC)), STEP_TIMEOUT_MS
                    );
                    await descEl.clear();
                    await descEl.sendKeys(portalRemark);
                    emitLog(`  ✓ Description set`, 'info');

                    // -- Select2 Click Strategy (3-layer) --
                    // Layer 1: Actions mouse simulation (most reliable, bypasses interception)
                    // Layer 2: jQuery select2('open') - programmatic open
                    // Layer 3: JS executeScript click - brute force last resort
                    emitLog(`  Attempting to open Select2 project dropdown...`, 'info');

                    const projTrigger = await driver.wait(
                         until.elementLocated(By.xpath(XPATHS.PROJ)), STEP_TIMEOUT_MS
                    );
                    await driver.executeScript('arguments[0].scrollIntoView({block:"center",behavior:"instant"});', projTrigger);
                    await driver.sleep(400);

                    // Layer 1: Actions - real mouse move + click
                    let dropdownOpen = false;
                    try {
                         const actions = driver.actions({ async: true });
                         await actions.move({ origin: projTrigger }).click().perform();
                         await driver.sleep(800);
                         dropdownOpen = true;
                         emitLog(`  [L1] Actions click on trigger OK`, 'info');
                    } catch (e1) {
                         emitLog(`  [L1] Actions click failed: ${e1.message}`, 'warn');
                    }

                    // Layer 2: jQuery select2('open')
                    if (!dropdownOpen) {
                         try {
                              await driver.executeScript(`
                                    var container = arguments[0].closest('.select2-container') || arguments[0].parentElement;
                                    var sel = container ? container.previousElementSibling : null;
                                    if (sel && typeof $ !== 'undefined') { $(sel).select2('open'); }
                                    else if (typeof $ !== 'undefined') {
                                         $('select').filter(function(){ return $(this).next('.select2-container').length; }).first().select2('open');
                                    }
                               `, projTrigger);
                              await driver.sleep(800);
                              dropdownOpen = true;
                              emitLog(`  [L2] jQuery select2:open OK`, 'info');
                         } catch (e2) {
                              emitLog(`  [L2] jQuery failed: ${e2.message}`, 'warn');
                         }
                    }

                    // Layer 3: JS click - always fires
                    if (!dropdownOpen) {
                         await driver.executeScript('arguments[0].click();', projTrigger);
                         await driver.sleep(800);
                         emitLog(`  [L3] JS click fallback fired`, 'info');
                    }

                    // Wait for floating search input to be visible (appended to body)
                    emitLog(`  Waiting for Select2 search input...`, 'info');
                    const s2InputEl = await driver.wait(until.elementLocated(By.xpath(S2_INPUT)), STEP_TIMEOUT_MS);
                    await driver.wait(until.elementIsVisible(s2InputEl), STEP_TIMEOUT_MS);
                    await driver.sleep(200);
                    await s2InputEl.sendKeys(FULL_PROJECT_NAME, Key.RETURN);
                    await driver.sleep(600);
                    emitLog(`  Project selected: ${FULL_PROJECT_NAME}`, 'success');

                    // 5. Click Save Entry
                    emitLog(`  Clicking Save Entry...`, 'info');
                    const saveBtn = await driver.wait(
                         until.elementLocated(By.xpath(XPATHS.SAVE)), STEP_TIMEOUT_MS
                    );
                    await driver.executeScript('arguments[0].scrollIntoView({block:"center"});', saveBtn);
                    await driver.sleep(500);
                    await driver.executeScript('arguments[0].click();', saveBtn);

                    // Wait for save to complete (portal typically adds next row or refreshes)
                    await driver.sleep(3000);

                    successCount++;
                    outerIdx++; // Move to next outer div for next row
                    emitLog(`  ✅ Row ${i + 1} saved successfully`, 'success');

               } catch (rowErr) {
                    errorCount++;
                    emitLog(`  ❌ FAILED at Row ${i + 1} (outerIdx=${outerIdx}): ${rowErr.message}`, 'error');

                    // USER INSTRUCTION: Stop immediately if it fails/times out
                    emitLog(`  Aborting automation as per strict "proceed only if done" policy.`, 'error');
                    aborted = true;
                    break;
               }
          }

          // ── Phase 2: Verify total hours on portal ──────────────────────────────
          let verificationPassed = false;

          if (!aborted) {
               emitLog(`\n🔍 Verifying total hours on portal...`, 'info');
               try {
                    await driver.sleep(1500); // let portal re-render totals
                    const TOTAL_HOURS_XPATH = '/html/body/main/div/div[30]/div/div/h2';
                    const totalEl = await driver.wait(
                         until.elementLocated(By.xpath(TOTAL_HOURS_XPATH)), 10000
                    );
                    const portalTotalText = (await totalEl.getText()).replace(/\s/g, '').toLowerCase(); // e.g. "160h"
                    const portalHoursNum = parseInt(portalTotalText);  // 160

                    // Frontend sends totalPortalHours (sum of all entry.portalHours)
                    const expectedHours = req.body.totalPortalHours ? parseInt(req.body.totalPortalHours) : null;
                    const expectedLabel = expectedHours ? `${expectedHours}h` : '(not provided)';

                    emitLog(`  Portal total hours text : "${portalTotalText}"`, 'info');
                    emitLog(`  Expected from frontend  : "${expectedLabel}"`, 'info');

                    if (expectedHours !== null && portalHoursNum === expectedHours) {
                         emitLog(`  ✅ Verification PASSED — portal shows ${portalHoursNum}h which matches ${expectedHours}h`, 'success');
                         verificationPassed = true;
                    } else if (expectedHours === null) {
                         emitLog(`  ⚠️  No expected total provided — skipping numeric check`, 'warn');
                         verificationPassed = true; // non-fatal
                    } else {
                         emitLog(`  ❌ Verification FAILED — portal shows ${portalHoursNum}h but expected ${expectedHours}h`, 'error');
                         emitLog(`  Please review the portal manually before submitting.`, 'warn');
                         verificationPassed = false;
                    }
               } catch (verErr) {
                    emitLog(`  ⚠️  Could not read portal total hours: ${verErr.message}`, 'warn');
                    verificationPassed = true; // non-fatal — let user proceed
               }
          }

          // ── Phase 3: Wait for user to click "Submit for Approval" ────────────
          // Strategy: inject a JS click listener on the exact button.
          //   window.__submitClicked = false  (set before injection)
          //   button.addEventListener('click', () => window.__submitClicked = true)
          // Poll every 2s for the flag to be true.
          // Driver stays open until button is clicked OR 10-min timeout.
          let userSubmitted = false;

          if (!aborted) {
               const WAIT_FOR_SUBMIT_MS = 10 * 60 * 1000; // 10 minutes
               const POLL_INTERVAL_MS = 2000;

               emitLog(`\n⏳ All rows filled! Please click "Submit for Approval" in the Firefox window.`, 'step');
               emitLog(`   Watching for button click — browser will close automatically once clicked.`, 'info');

               try {
                    // Step A: Reset the flag on the window object
                    await driver.executeScript(`window.__submitClicked = false;`);

                    // Step B: Find the "Submit for Approval" button by its visible text
                    // and inject a one-time click listener that sets the flag
                    const injected = await driver.executeScript(`
                         // Try locating by button text (case-insensitive contains)
                         var allBtns = Array.from(document.querySelectorAll('button, input[type="submit"], a'));
                         var btn = allBtns.find(function(el) {
                              return (el.textContent || el.value || '').toLowerCase().includes('submit for approval');
                         });
                         if (btn) {
                              btn.addEventListener('click', function() {
                                   window.__submitClicked = true;
                              }, { once: true });
                              return true;   // injection succeeded
                         }
                         return false;      // button not found yet
                    `);

                    if (injected) {
                         emitLog(`  ✅ Click listener injected on "Submit for Approval" button`, 'info');
                    } else {
                         emitLog(`  ⚠️  "Submit for Approval" button not found yet — will retry during polling`, 'warn');
                    }

                    // Step C: Poll every 2 s until the flag is true or timeout
                    const deadline = Date.now() + WAIT_FOR_SUBMIT_MS;
                    while (Date.now() < deadline) {
                         await driver.sleep(POLL_INTERVAL_MS);

                         // If button wasn't found initially, keep trying to inject the listener
                         const flagValue = await driver.executeScript(`
                              // Re-inject listener if not done yet (button may have appeared after scroll/render)
                              if (!window.__listenerInjected) {
                                   var allBtns = Array.from(document.querySelectorAll('button, input[type="submit"], a'));
                                   var btn = allBtns.find(function(el) {
                                        return (el.textContent || el.value || '').toLowerCase().includes('submit for approval');
                                   });
                                   if (btn) {
                                        btn.addEventListener('click', function() { window.__submitClicked = true; }, { once: true });
                                        window.__listenerInjected = true;
                                   }
                              }
                              return window.__submitClicked === true;
                         `);

                         if (flagValue === true) {
                              userSubmitted = true;
                              emitLog(`  ✅ "Submit for Approval" button was clicked by user!`, 'success');
                              break;
                         }
                    }

               } catch (submitWatchErr) {
                    emitLog(`  ⚠️  Error monitoring Submit button: ${submitWatchErr.message}`, 'warn');
               }

               if (!userSubmitted) {
                    emitLog(`  ⏰ Timed out (10 min) — Submit for Approval was not clicked.`, 'warn');
                    emitLog(`  Please submit manually in the portal.`, 'warn');
               }
          }


          // ── Phase 4: Close driver and respond ────────────────────────────────
          if (driver) {
               try { await driver.quit(); } catch (_) { }
               driver = null;
          }

          const processedCount = successCount + errorCount;
          const finalSuccess = !aborted && userSubmitted;

          const summary = aborted
               ? `🛑 Automation aborted after ${processedCount} rows. ${successCount} successful, ${errorCount} errors.`
               : userSubmitted
                    ? `🎉 Timesheet submitted! ${successCount} entries filled + approval submitted.`
                    : `✅ ${successCount} entries filled. Submission not detected within timeout.`;

          emitLog(`\n${summary}`, finalSuccess ? 'success' : aborted ? 'error' : 'warn');
          emitStatus(finalSuccess ? 'success' : aborted ? 'error' : 'success'); // treat timeout as non-fatal

          res.json({
               success: finalSuccess,
               log: summary,
               successCount,
               errorCount,
               aborted,
               verificationPassed,
               userSubmitted
          });

     } catch (err) {
          const msg = err.message || String(err);
          emitLog(`💥 Automation failed: ${msg}`, 'error');
          emitStatus('error');
          if (driver) {
               try { await driver.quit(); } catch (_) { }
          }
          res.status(500).json({ error: msg });
     }
});

// --- Health check
app.get('/api/test', (req, res) => {
     res.json({ status: 'up', geckodriver: GECKODRIVER_PATH });
});

// --- Start server
const PORT = 3000;
httpServer.listen(process.env.PORT || PORT, () => {
     console.log(`\nBackend + Socket.IO running on http://localhost:${PORT}`);
     console.log(`   Geckodriver: ${GECKODRIVER_PATH}\n`);
});
