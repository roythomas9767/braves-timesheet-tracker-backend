/**
 * fix-portal-remarks.js
 *
 * Fixes portalRemark values in all MongoDB timesheet documents.
 *
 * Correct rules:
 *   Leave day  (Earned/Sick/Casual Leave, Holiday, Day Off...)
 *     → portalRemark = "Apurva Worked For Sherin on {lastKnownTicket}"
 *
 *   Regular work day  (any remark that is NOT a leave)
 *     → portalRemark = e.remark   (raw remark, exactly as-is, NO prefix added)
 *
 * Run: node fix-portal-remarks.js
 */

const { MongoClient } = require('mongodb');

const MONGO_URI = "mongodb+srv://salesroshanengineeringworks_db_user:ie9J3GvyFLK8uzHG@cluster0.t0v7e7r.mongodb.net/?appName=Cluster0";
const DB_NAME = 'timesheet_tracker';
const COLL_NAME = 'timesheets';

function isLeaveRemark(r) {
     if (!r) return false;
     const lower = r.toLowerCase().trim();
     if (lower.includes('weekoff') || lower === 'week off') return false;
     return (
          lower.includes('earned leave') ||
          lower.includes('sick leave') ||
          lower.includes('casual leave') ||
          lower.includes('leave') ||
          lower.includes('holiday') ||
          (/\boff\b/.test(lower) && !lower.includes('worked on'))
     );
}

async function main() {
     const client = new MongoClient(MONGO_URI);
     try {
          await client.connect();
          console.log('Connected to MongoDB\n');

          const coll = client.db(DB_NAME).collection(COLL_NAME);
          const docs = await coll.find({}).toArray();
          console.log(`Found ${docs.length} timesheet document(s)\n`);

          let totalFixed = 0;

          for (const doc of docs) {
               const entries = Array.isArray(doc.entries) ? doc.entries : [];
               if (!entries.length) { console.log(`[${doc._id}] No entries — skipping\n`); continue; }

               // Find fallback ticket (first CV-XXXX seen across all entries)
               let fallbackTicket = 'CV-2721';
               for (const e of entries) {
                    const m = (e.remark || '').match(/CV-\d+/);
                    if (m) { fallbackTicket = m[0]; break; }
               }

               let lastKnownTicket = fallbackTicket;
               let docChanged = false;

               for (const e of entries) {
                    const rawRemark = (e.remark || '');
                    const leave = isLeaveRemark(rawRemark);

                    // Keep lastKnownTicket updated from regular (non-leave) entries that have a ticket
                    if (!leave) {
                         const m = rawRemark.match(/CV-\d+/);
                         if (m) lastKnownTicket = m[0];
                    }

                    // ── The only correct rule ──────────────────────────────────────────
                    // Leave  → use the "Apurva Worked For Sherin on" prefix + last ticket
                    // Others → raw remark, no prefix whatsoever
                    const expected = leave
                         ? `Apurva Worked For Sherin on ${lastKnownTicket}`
                         : rawRemark;

                    if (e.portalRemark !== expected) {
                         console.log(`[${doc._id}] "${e.date}"  leave=${leave}`);
                         console.log(`  remark      : "${rawRemark}"`);
                         console.log(`  OLD remark  : "${e.portalRemark}"`);
                         console.log(`  NEW remark  : "${expected}"\n`);
                         e.portalRemark = expected;
                         docChanged = true;
                         totalFixed++;
                    }
               }

               if (docChanged) {
                    await coll.updateOne({ _id: doc._id }, { $set: { entries } });
                    console.log(`[${doc._id}] Document updated\n`);
               } else {
                    console.log(`[${doc._id}] No changes needed\n`);
               }
          }

          console.log(`Done. ${totalFixed} entry/entries corrected across ${docs.length} document(s).`);
     } catch (err) {
          console.error('Error:', err.message);
     } finally {
          await client.close();
     }
}

main();
