#!/usr/bin/env node
/**
 * dafeiyu doctor — answers "why is my whale not reacting?"
 *
 *   node doctor.js
 *
 * Read-only. Touches nothing but the two agent databases and its own ports.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');

let { DatabaseSync } = {};
try { ({ DatabaseSync } = require('node:sqlite')); } catch { /* reported below */ }

const ok = (m) => console.log('  ok     ' + m);
const bad = (m) => console.log('  FAIL   ' + m);
const skip = (m) => console.log('  --     ' + m);
const info = (m) => console.log('         ' + m);

const HOME = os.homedir();
const OC_DB = path.join(HOME, '.local', 'share', 'opencode', 'opencode.db');
const FB_ROOT = path.join(HOME, '.config', 'freebuff-desktop', 'projects');

function portBusy(port) {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port }, () => { s.destroy(); resolve(true); });
    s.on('error', () => resolve(false));
    setTimeout(() => { s.destroy(); resolve(false); }, 800);
  });
}

async function main() {
  console.log('\ndafeiyu doctor\n');

  // ---- runtime
  const major = Number(process.versions.node.split('.')[0]);
  if (DatabaseSync) ok(`node ${process.versions.node}`);
  else bad(`node ${process.versions.node} — need 22+ (node:sqlite is missing)`);

  const electron = path.join(__dirname, 'node_modules', 'electron');
  if (fs.existsSync(electron)) ok('electron installed');
  else bad('electron missing — run: npm install');

  // ---- opencode
  if (fs.existsSync(OC_DB)) {
    ok('opencode database found');
    info(OC_DB);
    try {
      const db = new DatabaseSync(OC_DB, { readOnly: true });
      const s = db.prepare(`
        select id, title, time_updated from session_v2
        order by time_updated desc limit 1
      `).get();
      if (s) {
        const mins = Math.round((Date.now() - s.time_updated) / 60000);
        info(`newest session: ${(s.title || s.id).slice(0, 44)}  (${mins}m ago)`);
      } else {
        info('no sessions yet — start one in opencode');
      }
      db.close();
    } catch (e) {
      bad('opencode database unreadable: ' + e.message);
    }
  } else {
    skip('opencode not installed (fine — it is one of two sources)');
    info(OC_DB);
  }

  // ---- freebuff
  if (fs.existsSync(FB_ROOT)) {
    const projects = fs.readdirSync(FB_ROOT, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .filter((e) => fs.existsSync(path.join(FB_ROOT, e.name, 'desktop-v2.db')));
    if (projects.length) {
      ok(`freebuff: ${projects.length} project database(s)`);
      let newest = null;
      for (const p of projects) {
        const db = path.join(FB_ROOT, p.name, 'desktop-v2.db');
        let stamp = 0;
        for (const f of [db + '-wal', db]) {
          try { stamp = Math.max(stamp, fs.statSync(f).mtimeMs); } catch { /* gone */ }
        }
        if (!newest || stamp > newest.stamp) newest = { name: p.name, db, stamp };
      }
      const mins = Math.round((Date.now() - newest.stamp) / 60000);
      info(`most recently written: ${newest.name}  (${mins}m ago)`);
    } else {
      skip('freebuff installed but no project databases yet');
    }
  } else {
    skip('freebuff not installed (fine — it is one of two sources)');
    info(FB_ROOT);
  }

  // ---- ports
  for (const [port, label] of [[8791, 'freebuff hook'], [8792, 'opencode hook']]) {
    const busy = await portBusy(port);
    if (busy) ok(`${label} listening on ${port}`);
    else skip(`${label} not running on ${port} (only while the widget is up)`);
  }

  // ---- verdict
  console.log('');
  if (!fs.existsSync(OC_DB) && !fs.existsSync(FB_ROOT)) {
    console.log('  Neither agent was found. The whale will sit at idle.');
    console.log('  Install opencode or Freebuff, run a turn, then run this again.');
  } else {
    console.log('  Looks workable. Start the widget with start.cmd (or npm start).');
    console.log('  If it still does not react, run a turn in your agent and');
    console.log('  check runtime/*.log for what the hook saw.');
  }
  console.log('');
}

main();
