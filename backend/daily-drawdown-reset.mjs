import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

function patchFile(file, marker, transform) {
  const full = path.join(root, file);
  let source = readFileSync(full, 'utf8');
  if (source.includes(marker)) return false;
  const next = transform(source);
  if (next === source) return false;
  writeFileSync(full, next);
  return true;
}

// Backend account refresh: define the trading day as 09:15 IST -> 09:14:59 IST
// belongs to the previous trading day; from 09:15:00 IST it is the new day.
patchFile('backend/server.js', '// AURA_DAILY_RESET_0915_IST', source => {
  const old = '  const todayKey = new Date().toISOString().slice(0,10);';
  const replacement = `  // AURA_DAILY_RESET_0915_IST\n  // Trading day rolls at 09:15 Asia/Kolkata (UTC+05:30).\n  const todayKey = new Date(Date.now() - (3 * 60 + 45) * 60 * 1000).toISOString().slice(0,10);`;
  if (!source.includes(old)) throw new Error('Daily reset anchor not found in backend/server.js');
  return source.replace(old, replacement);
});

// Mongo challenge/risk engine: same 09:15 IST boundary so it cannot overwrite
// the dashboard with a different daily-reset day.
patchFile('backend/challenge-rules-engine.js', '// AURA_DAILY_RESET_0915_IST', source => {
  const old = `const dayStart=()=>{\n  const now=new Date(),ist=new Date(now.getTime()+330*60000);\n  ist.setUTCHours(0,30,0,0);\n  return new Date(ist.getTime()-330*60000);\n};`;
  const replacement = `const AURA_DAILY_RESET_0915_IST = 9 * 60 + 15;\nconst dayStart=()=>{\n  const now=new Date();\n  const istMs=now.getTime()+330*60000;\n  const shiftedMs=istMs-AURA_DAILY_RESET_0915_IST*60000;\n  const shifted=new Date(shiftedMs);\n  const y=shifted.getUTCFullYear(),m=shifted.getUTCMonth(),d=shifted.getUTCDate();\n  const resetUtc=Date.UTC(y,m,d)-330*60000+AURA_DAILY_RESET_0915_IST*60000;\n  return new Date(resetUtc);\n};`;
  if (!source.includes(old)) throw new Error('Daily reset anchor not found in backend/challenge-rules-engine.js');
  return source.replace(old, replacement);
});

// Dashboard: show a compact red 15-minute countdown in the Daily Drawdown card
// from 09:00 to 09:15 IST. It hides outside that window and after the reset.
patchFile('courses.html', '<!-- AURA_DAILY_DRAWDOWN_COUNTDOWN -->', source => {
  const oldCard = '  <div class="stat"><span>Daily Drawdown</span><strong id="dailyDrawdown">—</strong></div>';
  const newCard = `  <div class="stat" id="dailyDrawdownStat"><span>Daily Drawdown</span><strong id="dailyDrawdown">—</strong><small id="dailyDrawdownCountdown" style="display:none;margin-top:5px;color:#e6004d;font-size:11px;font-weight:900;letter-spacing:.2px;"></small></div>`;
  if (!source.includes(oldCard)) throw new Error('Daily Drawdown card anchor not found in courses.html');
  const script = `\n<!-- AURA_DAILY_DRAWDOWN_COUNTDOWN -->\n<script>\n(function(){\n  const countdown=document.getElementById('dailyDrawdownCountdown');\n  if(!countdown)return;\n  const IST_OFFSET_MS=330*60000;\n  const START_MINUTES=9*60;\n  const RESET_MINUTES=9*60+15;\n  function tick(){\n    const now=new Date();\n    const ist=new Date(now.getTime()+IST_OFFSET_MS);\n    const minutes=ist.getUTCHours()*60+ist.getUTCMinutes();\n    const seconds=ist.getUTCSeconds();\n    if(minutes>=START_MINUTES && minutes<RESET_MINUTES){\n      const remaining=(RESET_MINUTES-minutes-1)*60+(60-seconds);\n      const mm=String(Math.floor(remaining/60)).padStart(2,'0');\n      const ss=String(remaining%60).padStart(2,'0');\n      countdown.textContent='Reset in '+mm+':'+ss;\n      countdown.style.display='block';\n    }else{\n      countdown.textContent='';\n      countdown.style.display='none';\n    }\n  }\n  tick();\n  setInterval(tick,1000);\n})();\n</script>`;
  const updated=source.replace(oldCard, newCard);
  if (!updated.includes('</body>')) throw new Error('Body anchor not found in courses.html');
  return updated.replace('</body>', script + '\n</body>');
});
