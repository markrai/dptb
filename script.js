// Support switching profiles via URL: ?profile=<id>
// Allowed chars: letters, numbers, underscore, hyphen
const _params = new URLSearchParams(window.location.search);
const _profileParam = _params.get('profile');
const PROFILE_ID = (_profileParam && /^[A-Za-z0-9_-]+$/.test(_profileParam)) ? _profileParam : null;
// Determine CSV base prefix. If a global override is set, use it; otherwise infer
// from path (inside /generate/ -> '../', at repo root -> './').
const __OVERRIDE_BASE = (typeof window !== 'undefined' && window.__CSV_BASE_PREFIX__ !== undefined) ? String(window.__CSV_BASE_PREFIX__) : null;
const BASE_PREFIX = __OVERRIDE_BASE !== null ? __OVERRIDE_BASE : (location.pathname.includes('/generate/') ? '../' : './');
function csvPath(name){
  // No default profile fallback; require a profile
  return `${BASE_PREFIX}profiles/${PROFILE_ID}/csv/${name}`;
}

const SLEEP_PATH = csvPath("fitbit_sleep.csv");
const HRV_PATH   = csvPath("fitbit_hrv.csv");
const STEPS_PATH = csvPath("fitbit_activity.csv");
const RHR_PATH   = csvPath("fitbit_rhr.csv");
let rawSleep = [];
initProfileControl();
let rawHRV = [];
let rawSteps = [];
let rawRHR = [];
let chart;

// Initialize profile control: dropdown (preferred) or header badge (fallback)
async function initProfileControl(){
  try {
    const select = document.getElementById('profileSelect');
    if (select) {
      // Build list from server with fallback to manifest
      const ids = new Set();
      // Preferred: fetch from API for authoritative list
      let loadedFromApi = false;
      try {
        const apiResp = await fetch('/api/profiles', { cache: 'no-store' });
        if (apiResp.ok) {
          const profiles = await apiResp.json();
          if (Array.isArray(profiles)) {
            for (const p of profiles) {
              const id = typeof p === 'string' ? p : p && p.name;
              if (typeof id === 'string' && /^[A-Za-z0-9_-]+$/.test(id)) ids.add(id);
            }
            loadedFromApi = true;
          }
        }
      } catch(_) { /* ignore */ }
      // Fallback: profiles/index.json
      if (!loadedFromApi) {
        try {
          const listUrl = `${BASE_PREFIX}profiles/index.json`;
          const resp = await fetch(listUrl, { cache: 'no-store' });
          if (resp.ok) {
            const arr = await resp.json();
            if (Array.isArray(arr) && arr.length > 0) {
              for (const id of arr) {
                if (typeof id === 'string' && /^[A-Za-z0-9_-]+$/.test(id)) ids.add(id);
              }
            }
          }
        } catch(_) { /* ignore */ }
      }
      // Ensure the current profile from URL is present
      if (PROFILE_ID) ids.add(PROFILE_ID);
      // Replace options
      while (select.firstChild) select.removeChild(select.firstChild);
      const list = Array.from(ids);
      // Update profile status dot color based on availability
      try { updateStatusIndicator('profileStatus', list.length > 0); } catch(_) {
        const el = document.getElementById('profileStatus'); if (el) el.style.color = list.length>0?'#7bffbf':'#ff9b9b';
      }
      for (const id of list) {
        const opt = document.createElement('option');
        opt.value = id;
        opt.textContent = id;
        select.appendChild(opt);
      }
      
      // Add Profile Management option
      const managementOpt = document.createElement('option');
      managementOpt.value = '__profile_management__';
      managementOpt.textContent = 'Profile Management';
      managementOpt.style.fontStyle = 'italic';
      select.appendChild(managementOpt);
      // If no profiles available, show a placeholder and stop
      if (list.length === 0) {
        const opt = document.createElement('option');
        opt.value = '';
        opt.textContent = 'Create New Profile';
        opt.disabled = true;
        opt.selected = true;
        select.appendChild(opt);
        // Show the no-profile modal (no existing profiles)
        showNoProfileModal(false);
        return;
      }
      // If no profile selected, pick the first available and redirect
      if (!PROFILE_ID && list.length > 0) {
        const first = list[0];
        const params = new URLSearchParams(window.location.search);
        params.set('profile', first);
        const qs = params.toString();
        const url = location.pathname + (qs ? ('?' + qs) : '');
        location.assign(url);
        return;
      }
      // Set current selection
      if (PROFILE_ID) select.value = PROFILE_ID;
      // If just authorized, show a nudge to fetch data
      try {
        const just = sessionStorage.getItem('fitbaus:justAuthorized');
        if (just && (!PROFILE_ID || PROFILE_ID === just)){
          const fs = document.getElementById('fetchStatus');
          if (fs){ fs.textContent = 'user authorized - press ↻ to fetch data!'; fs.style.color = '#7bffbf'; fs.style.opacity='1'; fs.style.transition=''; }
          sessionStorage.removeItem('fitbaus:justAuthorized');
        }
      } catch(_) {}
      // On change, update URL's profile param and reload
      select.addEventListener('change', (e) => {
        const v = e.target.value;
        
        // Handle Profile Management selection
        if (v === '__profile_management__') {
          showNoProfileModal(true); // Has existing profiles, so allow closing
          // Reset selection to current profile
          select.value = PROFILE_ID || '';
          return;
        }
        
        const params = new URLSearchParams(window.location.search);
        if (v) params.set('profile', v); else params.delete('profile');
        const qs = params.toString();
        const url = location.pathname + (qs ? ('?' + qs) : '');
        location.assign(url);
      });
      return;
    }
    // Fallback: show a badge either in-grid or in the header
    const badgeEl = document.getElementById('profileBadge');
    if (badgeEl) {
      badgeEl.textContent = PROFILE_ID ? `Profile: ${PROFILE_ID}` : 'Profile: (none)';
      return;
    }
    const header = document.querySelector('.header');
    if (header) {
      const badge = document.createElement('div');
      badge.className = 'pill blue';
      badge.textContent = PROFILE_ID ? `Profile: ${PROFILE_ID}` : 'Profile: (none)';
      header.appendChild(badge);
    }
  } catch (e) { /* no-op */ }
}

function num(v){ if(v===undefined||v===null||v==="") return NaN; const n=+v; return Number.isFinite(n)?n:NaN }
function parseDate(s){
  try{
    if (s == null) return null;
    if (s instanceof Date) return isNaN(s) ? null : s;
    if (typeof s === 'string'){
      const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
      if (m){
        const y = +m[1], mo = +m[2]-1, d = +m[3];
        const local = new Date(y, mo, d); // interpret date-only as local midnight
        return isNaN(local) ? null : local;
      }
    }
    const d = new Date(s);
    return isNaN(d) ? null : d;
  }catch(_){ return null }
}
function toISODate(d){ return d.toISOString().slice(0,10) }
function pct(a,b){ return b>0? (100*a/b): NaN }
function clamp(x,lo,hi){ if(x==null||isNaN(x))return NaN; return Math.max(lo,Math.min(hi,x)) }
function recomputeSleepScore(row){ const ma=num(row.minutesAsleep); const eff=num(row.efficiency); const lat=clamp(num(row.minutesToFallAsleep)||0,0,60); const awake=clamp(num(row.minutesAwake)||0,0,1e9); const md=num(row.minutesDeep); const mr=num(row.minutesREM); const D=clamp(((ma-300)/240)*100,0,100); const E=clamp(eff,0,100); const prop = (md+mr)/ma; const S=clamp(((prop-0.25)/0.35)*100,0,100); const C=clamp(100-0.5*lat-0.5*awake,0,100); let parts=[],w=[]; if(!isNaN(D)){parts.push(D);w.push(0.4)} if(!isNaN(E)){parts.push(E);w.push(0.3)} if(!isNaN(S)){parts.push(S);w.push(0.2)} if(!isNaN(C)){parts.push(C);w.push(0.1)} if(!parts.length) return NaN; const sw=w.reduce((a,b)=>a+b,0); const score = parts.reduce((s,v,i)=>s+v*(w[i]/sw),0); return Math.round(score*10)/10 }
function stagePerc(row){ const ma=num(row.minutesAsleep); return { deep:pct(num(row.minutesDeep),ma), rem:pct(num(row.minutesREM),ma), light:pct(num(row.minutesLight),ma) } }
function fmt(n,dec=1){ return Number.isFinite(n)? n.toFixed(dec):"" }

function validateSleepData(data){
  if(!data || data.length === 0) return false;
  const requiredCols = ['date', 'minutesAsleep', 'efficiency'];
  const hasRequiredCols = requiredCols.every(col => data[0].hasOwnProperty(col));
  if(!hasRequiredCols) return false;
  // Check if we have at least some valid data
  const validRows = data.filter(row => row.date && !isNaN(parseFloat(row.minutesAsleep)));
  return validRows.length > 0;
}

function validateHRVData(data){
  if(!data || data.length === 0) return false;
  const requiredCols = ['date', 'dailyRmssd'];
  const hasRequiredCols = requiredCols.every(col => data[0].hasOwnProperty(col));
  if(!hasRequiredCols) return false;
  // Check if we have at least some valid data
  const validRows = data.filter(row => row.date && !isNaN(parseFloat(row.dailyRmssd)));
  return validRows.length > 0;
}

function validateStepsData(data){
  if(!data || data.length === 0) return false;
  const requiredCols = ['date', 'steps'];
  const hasRequiredCols = requiredCols.every(col => data[0].hasOwnProperty(col));
  if(!hasRequiredCols) return false;
  // Check if we have at least some valid data
  const validRows = data.filter(row => row.date && !isNaN(parseFloat(row.steps)));
  return validRows.length > 0;
}

function validateRHRData(data){
  if(!data || data.length === 0) return false;
  const requiredCols = ['date', 'resting_heart_rate'];
  const hasRequiredCols = requiredCols.every(col => data[0].hasOwnProperty(col));
  if(!hasRequiredCols) return false;
  // Check if we have at least some valid data
  const validRows = data.filter(row => row.date && !isNaN(parseFloat(row.resting_heart_rate)));
  return validRows.length > 0;
}

function startOfDay(d){ const x=new Date(d); x.setHours(0,0,0,0); return x }
function isDatasetStale(rows, dateField){
  try{
    if(!rows || rows.length===0) return false;
    const ds = rows.map(r=>parseDate(r && r[dateField])).filter(Boolean);
    if(ds.length===0) return false;
    const latest = new Date(Math.max.apply(null, ds.map(d=>d.getTime())));
    const days = (startOfDay(new Date()) - startOfDay(latest)) / (1000*60*60*24);
    return days > 1; // older than 1 day
  }catch(_){ return false }
}
function updateStatusIndicator(elementId, isValid){
  const element = document.getElementById(elementId);
  if(!element){ return }
  // Map status id to corresponding file input and display elements for tooltip updates
  const idMap = {
    sleepStatus: { input: 'sleepFile', display: 'sleepFileDisplay' },
    hrvStatus: { input: 'hrvFile', display: 'hrvFileDisplay' },
    stepsStatus: { input: 'stepsFile', display: 'stepsFileDisplay' },
    rhrStatus: { input: 'rhrFile', display: 'rhrFileDisplay' }
  };

  const targets = idMap[elementId] || {};
  const inputEl = targets.input ? document.getElementById(targets.input) : null;
  const displayEl = targets.display ? document.getElementById(targets.display) : null;

  if(!isValid){
    element.style.color = '#ff9b9b';
    if (inputEl) inputEl.title = 'No file chosen';
    if (displayEl) displayEl.title = 'No file chosen';
    return;
  }
  let stale = false;
  switch(elementId){
    case 'sleepStatus': stale = isDatasetStale(rawSleep, 'date'); break;
    case 'hrvStatus': stale = isDatasetStale(rawHRV, 'date'); break;
    case 'stepsStatus': stale = isDatasetStale(rawSteps, 'date'); break;
    case 'rhrStatus': stale = isDatasetStale(rawRHR, 'date'); break;
    default: stale = false; // For non-CSV indicators (e.g., profile), keep boolean behavior
  }
  if(stale){
    element.style.color = '#ffb347'; // light orange
    if (inputEl) inputEl.title = 'data needs update';
    if (displayEl) displayEl.title = 'data needs update';
  } else {
    element.style.color = '#7bffbf'; // green
    if (inputEl) inputEl.title = 'data successfully loaded';
    if (displayEl) displayEl.title = 'data successfully loaded';
  }
}

async function fetchCSV(path){ const res = await fetch(path,{cache:"no-store"}); if(!res.ok) throw new Error(`HTTP ${res.status}`); return await res.text() }
function parseCSV(text){ return Papa.parse(text,{header:true,dynamicTyping:false,skipEmptyLines:true}).data }

async function tryLoadDefaults(){ let sleepLoaded=false, hrvLoaded=false, stepsLoaded=false, rhrLoaded=false; try{ const t = await fetchCSV(SLEEP_PATH); rawSleep = parseCSV(t); sleepLoaded=true; document.getElementById('sleepFileDisplay').textContent = 'fitbit_sleep.csv'; const isValid = validateSleepData(rawSleep); updateStatusIndicator('sleepStatus', isValid); }catch(e){ updateStatusIndicator('sleepStatus', false); }
 try{ const t2 = await fetchCSV(HRV_PATH); rawHRV = parseCSV(t2); hrvLoaded=true; document.getElementById('hrvFileDisplay').textContent = 'fitbit_hrv.csv'; const isValid = validateHRVData(rawHRV); updateStatusIndicator('hrvStatus', isValid); }catch(e){ updateStatusIndicator('hrvStatus', false); }
 try{ const t3 = await fetchCSV(STEPS_PATH); rawSteps = parseCSV(t3); stepsLoaded=true; document.getElementById('stepsFileDisplay').textContent = 'fitbit_activity.csv'; const isValid = validateStepsData(rawSteps); updateStatusIndicator('stepsStatus', isValid); console.log('Steps loaded successfully:', rawSteps.length, 'rows'); }catch(e){ console.log('Error loading steps:', e); updateStatusIndicator('stepsStatus', false); }
 try{ const t4 = await fetchCSV(RHR_PATH); rawRHR = parseCSV(t4); rhrLoaded=true; document.getElementById('rhrFileDisplay').textContent = 'fitbit_rhr.csv'; const isValid = validateRHRData(rawRHR); updateStatusIndicator('rhrStatus', isValid); console.log('RHR loaded successfully:', rawRHR.length, 'rows'); }catch(e){ console.log('Error loading RHR:', e); updateStatusIndicator('rhrStatus', false); } }

function fileToData(file, cb){ const r=new FileReader(); r.onload=()=>cb(parseCSV(r.result)); r.readAsText(file) }

function normalizeSleepRows(rows){ return rows.map(r=>{ const d = parseDate(r.date); const s = parseDate(r.startTime); const e = parseDate(r.endTime); const main = String(r.isMainSleep).toLowerCase()==='true'; const m = stagePerc(r); const ss = recomputeSleepScore(r); return { dateISO: d? toISODate(d): null, date:d, start:s, end:e, isMainSleep: main, minutesAsleep: num(r.minutesAsleep), efficiency: num(r.efficiency), minutesDeep: num(r.minutesDeep), minutesREM: num(r.minutesREM), minutesLight: num(r.minutesLight), minutesWakeStages: num(r.minutesWakeStages), minutesAwake: num(r.minutesAwake), minutesToFallAsleep: num(r.minutesToFallAsleep), sleepScore:ss, pctDeep:m.deep, pctREM:m.rem, pctLight:m.light } }).filter(r=>r.date)
}

function normalizeStepsRows(rows){ return rows.map(r=>{ const d = parseDate(r.date); const sm = num(r.sedentaryMinutes); const smClean = (sm===1440)? NaN : sm; return { dateISO: d? toISODate(d): null, date:d, steps: num(r.steps), sedentaryMinutes: smClean } }).filter(r=>r.date && Number.isFinite(r.steps))
}

function filterSleep(data){ const mainOnly = document.getElementById('mainOnly').checked; let from = document.getElementById('dateFrom').value; let to = document.getElementById('dateTo').value; const chartType = document.getElementById('chartType').value; const sleepToggle = document.getElementById('sleepViewToggle'); const toggleValue = parseInt(sleepToggle.value); const isYearlyView = toggleValue === 2; return data.filter(r=>{ if(mainOnly && !r.isMainSleep) return false; if(chartType === 'daily_score' && isYearlyView){ if(from && r.date.getFullYear() < parseInt(from)) return false; if(to && r.date.getFullYear() > parseInt(to)) return false; } else { if(from && r.dateISO < from) return false; if(to && r.dateISO > to) return false; } return true }) }

function groupByMonth(rows){ const map=new Map(); rows.forEach(r=>{ const k = r.dateISO.slice(0,7); if(!map.has(k)) map.set(k,[]); map.get(k).push(r) }); const out=[...map.entries()].sort((a,b)=>a[0].localeCompare(b[0])).map(([k,v])=>({ key:k, date:new Date(k+'-01'), sleepScore:avg(v.map(x=>x.sleepScore)), minutesAsleep:avg(v.map(x=>x.minutesAsleep)), efficiency:avg(v.map(x=>x.efficiency)), pctDeep:avg(v.map(x=>x.pctDeep)), pctREM:avg(v.map(x=>x.pctREM)), pctLight:avg(v.map(x=>x.pctLight)) })); return out }
function groupByYear(rows){ const map=new Map(); rows.forEach(r=>{ const k = r.date.getFullYear(); if(!map.has(k)) map.set(k,[]); map.get(k).push(r) }); const out=[...map.entries()].sort((a,b)=>a[0]-b[0]).map(([k,v])=>({ key:String(k), date:new Date(k,0,1), sleepScore:avg(v.map(x=>x.sleepScore)), minutesAsleep:avg(v.map(x=>x.minutesAsleep)), efficiency:avg(v.map(x=>x.efficiency)), pctDeep:avg(v.map(x=>x.pctDeep)), pctREM:avg(v.map(x=>x.pctREM)), pctLight:avg(v.map(x=>x.pctLight)) })); return out }

function groupStepsByMonth(rows){ const map=new Map(); rows.forEach(r=>{ const k = r.dateISO.slice(0,7); if(!map.has(k)) map.set(k,[]); map.get(k).push(r) }); const out=[...map.entries()].sort((a,b)=>a[0].localeCompare(b[0])).map(([k,v])=>({ key:k, date:new Date(k+'-01'), steps:avg(v.map(x=>x.steps)), sedentaryMinutes:avg(v.map(x=>x.sedentaryMinutes)) })); return out }
function groupStepsByYear(rows){ const map=new Map(); rows.forEach(r=>{ const k = r.date.getFullYear(); if(!map.has(k)) map.set(k,[]); map.get(k).push(r) }); const out=[...map.entries()].sort((a,b)=>a[0]-b[0]).map(([k,v])=>({ key:String(k), date:new Date(k,0,1), steps:avg(v.map(x=>x.steps)), sedentaryMinutes:avg(v.filter(x=>Number.isFinite(x.sedentaryMinutes) && x.sedentaryMinutes > 0).map(x=>x.sedentaryMinutes)) })); return out }

function groupRHRByMonth(rows){ const map=new Map(); rows.forEach(r=>{ const k = `${r.date.getFullYear()}-${String(r.date.getMonth()+1).padStart(2,'0')}`; if(!map.has(k)) map.set(k,[]); map.get(k).push(r) }); const out=[...map.entries()].sort((a,b)=>a[0].localeCompare(b[0])).map(([k,v])=>({ key:k, date:new Date(k+'-01'), rhr:avg(v.map(x=>x.rhr)) })); return out }

function groupRHRByYear(rows){ const map=new Map(); rows.forEach(r=>{ const k = r.date.getFullYear(); if(!map.has(k)) map.set(k,[]); map.get(k).push(r) }); const out=[...map.entries()].sort((a,b)=>a[0]-b[0]).map(([k,v])=>({ key:String(k), date:new Date(k,0,1), rhr:avg(v.map(x=>x.rhr)) })); return out }
function avg(arr){ const a = arr.filter(x=>Number.isFinite(x)); return a.length? a.reduce((s,v)=>s+v,0)/a.length : NaN }

// Analytics helper utilities
function quantile(arr, p) {
  const a = arr.filter(x => Number.isFinite(x)).sort((x, y) => x - y);
  if (a.length === 0) return NaN;
  const index = p * (a.length - 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return a[lower];
  return a[lower] + (a[upper] - a[lower]) * (index - lower);
}

function stdev(arr) {
  const a = arr.filter(x => Number.isFinite(x));
  if (a.length < 2) return NaN;
  const mean = avg(a);
  const variance = a.reduce((sum, x) => sum + Math.pow(x - mean, 2), 0) / a.length;
  return Math.sqrt(variance);
}

function cv(arr) {
  const a = arr.filter(x => Number.isFinite(x));
  if (a.length < 2) return NaN;
  const mean = avg(a);
  if (mean <= 0) return NaN;
  return stdev(a) / mean;
}

function groupByMonthStrict(rows, key) {
  const map = new Map();
  rows.forEach(r => {
    if (Number.isFinite(r[key]) && r.dateISO) {
      const k = r.dateISO.slice(0, 7);
      if (!map.has(k)) map.set(k, []);
      map.get(k).push(r);
    }
  });
  return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([k, v]) => ({
    key: k,
    date: new Date(k + '-01'),
    [key]: avg(v.map(x => x[key]))
  }));
}

function monthName(dateOrString) {
  const date = typeof dateOrString === 'string' ? new Date(dateOrString) : dateOrString;
  return date.toLocaleDateString('en-US', { month: 'short' });
}

function modeDayOfWeek(isoDates) {
  const dayCounts = new Map();
  isoDates.forEach(iso => {
    const day = new Date(iso + 'T00:00:00Z').toLocaleDateString('en-US', { weekday: 'long' });
    dayCounts.set(day, (dayCounts.get(day) || 0) + 1);
  });
  let maxCount = 0;
  let modeDay = '';
  for (const [day, count] of dayCounts) {
    if (count > maxCount || (count === maxCount && day < modeDay)) {
      maxCount = count;
      modeDay = day;
    }
  }
  return modeDay;
}

function computeAnalytics() {
  const from = document.getElementById('dateFrom').value;
  const to = document.getElementById('dateTo').value;
  const mainOnly = document.getElementById('mainOnly').checked;
  
  // Load and filter data
  const sleepN = normalizeSleepRows(rawSleep);
  const filtered = filterSleep(sleepN);
  const hrv = tryLoadHRV();
  const steps = tryLoadSteps();
  const rhr = tryLoadRHR();
  
  // Filter by date range
  const filteredHRV = hrv ? hrv.filter(r => {
    if (from && r.dateISO < from) return false;
    if (to && r.dateISO > to) return false;
    return true;
  }) : [];
  
  const filteredSteps = steps ? steps.filter(r => {
    if (from && r.dateISO < from) return false;
    if (to && r.dateISO > to) return false;
    return true;
  }) : [];
  
  const filteredRHR = rhr ? rhr.filter(r => {
    if (from && r.dateISO < from) return false;
    if (to && r.dateISO > to) return false;
    return true;
  }) : [];
  
  const results = [];
  
  // A) Multi-year trend
  if (filtered.length > 0) {
    const yearly = groupByYear(filtered);
    const yearlySteps = filteredSteps.length > 0 ? groupStepsByYear(filteredSteps) : [];
    const yearlyRHR = filteredRHR.length > 0 ? groupRHRByYear(filteredRHR) : [];
    const yearlyHRV = filteredHRV.length > 0 ? groupByYear(filteredHRV.map(r => ({ date: new Date(r.dateISO), rmssd: r.rmssd }))) : [];
    
    ['sleepScore', 'minutesAsleep'].forEach(metric => {
      if (yearly.length >= 2) {
        const data = yearly.map((r, i) => ({ x: i, y: r[metric] })).filter(d => Number.isFinite(d.y));
        if (data.length >= 2) {
          const reg = calculateLinearRegression(data);
          if (reg) {
            const start = data[0].y;
            const end = data[data.length - 1].y;
            const delta = end - start;
            const pctChange = ((end - start) / start) * 100;
            results.push({
              Section: 'Multi-year trend',
              Metric: `${metric} trend`,
              Value: `${delta > 0 ? '+' : ''}${pctChange.toFixed(1)}% (${start.toFixed(1)}→${end.toFixed(1)})`,
              Notes: `slope ${reg.slope > 0 ? '+' : ''}${reg.slope.toFixed(2)} points/year; n=${data.length} years`
            });
          }
        }
      }
    });
    
    if (yearlySteps.length >= 2) {
      const data = yearlySteps.map((r, i) => ({ x: i, y: r.steps })).filter(d => Number.isFinite(d.y));
      if (data.length >= 2) {
        const reg = calculateLinearRegression(data);
        if (reg) {
          const start = data[0].y;
          const end = data[data.length - 1].y;
          const delta = end - start;
          const pctChange = ((end - start) / start) * 100;
          results.push({
            Section: 'Multi-year trend',
            Metric: 'steps trend',
            Value: `${delta > 0 ? '+' : ''}${pctChange.toFixed(1)}% (${Math.round(start)}→${Math.round(end)})`,
            Notes: `slope ${reg.slope > 0 ? '+' : ''}${reg.slope.toFixed(0)} steps/year; n=${data.length} years`
          });
        }
      }
    }
    
    // Add sedentary trend calculation (daily trend over selected date range)
    console.log('Checking sedentary trend - filteredSteps length:', filteredSteps.length);
    if (filteredSteps.length >= 30) {
      const sedentaryData = filteredSteps
        .filter(r => Number.isFinite(r.sedentaryMinutes) && r.sedentaryMinutes > 0)
        .map((r, i) => ({ x: i, y: r.sedentaryMinutes }))
        .sort((a, b) => a.x - b.x);
      
      console.log('Sedentary data after filtering:', sedentaryData.length, 'records');
      console.log('Sample sedentary data:', sedentaryData.slice(0, 5));
      
      if (sedentaryData.length >= 30) {
        const reg = calculateLinearRegression(sedentaryData);
        console.log('Linear regression result:', reg);
        if (reg) {
          const start = sedentaryData[0].y;
          const end = sedentaryData[sedentaryData.length - 1].y;
          const delta = end - start;
          const pctChange = ((end - start) / start) * 100;
          const startHours = Math.round(start / 60);
          const endHours = Math.round(end / 60);
          const days = Math.round((sedentaryData[sedentaryData.length - 1].x - sedentaryData[0].x) / 30); // approximate months
          console.log('Adding sedentary trend result:', { start, end, delta, pctChange, startHours, endHours, days });
          results.push({
            Section: 'Multi-year trend',
            Metric: 'sedentary trend',
            Value: `${delta > 0 ? '+' : ''}${pctChange.toFixed(1)}% (${startHours}h→${endHours}h)`,
            Notes: `slope ${reg.slope > 0 ? '+' : ''}${reg.slope.toFixed(1)} min/month; n=${sedentaryData.length} days over ${days} months`
          });
        } else {
          console.log('Linear regression failed');
        }
      } else {
        console.log('Not enough sedentary data after filtering:', sedentaryData.length);
      }
    } else {
      console.log('Not enough filtered steps data:', filteredSteps.length);
    }
  }
  
  // B) Seasonality by month
  if (filtered.length > 0) {
    const monthly = groupByMonth(filtered);
    const monthlyRHR = filteredRHR.length > 0 ? groupRHRByMonth(filteredRHR) : [];
    const monthlyHRV = filteredHRV.length > 0 ? groupByMonthStrict(filteredHRV.map(r => ({ dateISO: r.dateISO, rmssd: r.rmssd })), 'rmssd') : [];
    
    ['sleepScore', 'minutesAsleep'].forEach(metric => {
      if (monthly.length > 0) {
        const monthData = monthly.map(r => ({ 
          year: parseInt(r.key.split('-')[0]), 
          month: parseInt(r.key.split('-')[1]), 
          value: r[metric],
          key: r.key
        })).filter(d => Number.isFinite(d.value));
        if (monthData.length > 0) {
          // Sort by value to get best and second best
          const sortedData = [...monthData].sort((a, b) => b.value - a.value);
          const best = sortedData[0];
          const secondBest = sortedData.length > 1 ? sortedData[1] : null;
          const worst = monthData.reduce((min, curr) => curr.value < min.value ? curr : min);
          
          // Count days for the best month
          const bestMonthKey = best.key;
          const bestMonthDays = filtered.filter(r => r.dateISO.slice(0,7) === bestMonthKey).length;
          
          const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
          
          // Create tooltip text if less than 15 days
          let tooltipText = '';
          if (bestMonthDays < 15) {
            tooltipText = `Only ${bestMonthDays} days were tracked during this month`;
            if (secondBest) {
              tooltipText += `. The next best month was ${monthNames[secondBest.month - 1]} ${secondBest.year} (${secondBest.value.toFixed(1)})`;
            }
          }
          
          results.push({
            Section: 'Seasonality',
            Metric: `Best month for ${metric}`,
            Value: `${monthNames[best.month - 1]} ${best.year} ${best.value.toFixed(1)}`,
            Notes: `range ${worst.value.toFixed(1)}–${best.value.toFixed(1)}`,
            Tooltip: tooltipText
          });
        }
      }
    });
  }
  
  // C) Day-of-week effects
  if (filtered.length > 0) {
    const dayData = filtered.map(r => ({ day: r.date.getDay(), score: r.sleepScore })).filter(d => Number.isFinite(d.score));
    if (dayData.length > 0) {
      const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
      const dayAverages = Array(7).fill(0).map((_, i) => {
        const dayScores = dayData.filter(d => d.day === i).map(d => d.score);
        return { day: i, avg: avg(dayScores), count: dayScores.length };
      }).filter(d => d.count >= 2);
      
      if (dayAverages.length > 0) {
        const max = dayAverages.reduce((max, curr) => curr.avg > max.avg ? curr : max);
        const min = dayAverages.reduce((min, curr) => curr.avg < min.avg ? curr : min);
        const spread = max.avg - min.avg;
        results.push({
          Section: 'Day-of-week',
          Metric: 'Sleep score spread',
          Value: `~${spread.toFixed(1)} pts`,
          Notes: `max ${dayNames[max.day]} ${max.avg.toFixed(1)}, min ${dayNames[min.day]} ${min.avg.toFixed(1)}`
        });
      }
    }
  }
  
  // D) Load–recovery relationships
  if (filtered.length > 0 && filteredSteps.length > 0) {
    const mapSleep = new Map(filtered.map(r => [sleepKey(r.dateISO), r.sleepScore]));
    const pairs = filteredSteps.filter(r => r.steps > 0).map(r => {
      const score = mapSleep.get(r.dateISO);
      return Number.isFinite(score) ? { steps: r.steps, score } : null;
    }).filter(p => p !== null);
    
    if (pairs.length >= 20) {
      const xs = pairs.map(p => p.steps);
      const ys = pairs.map(p => p.score);
      const pearson = calculateCorrelation(xs, ys);
      const spearman = calculateSpearmanCorrelation(xs, ys);
      results.push({
        Section: 'Load–recovery',
        Metric: 'Same-day steps vs sleep score',
        Value: `Pearson ${pearson.toFixed(3)}, Spearman ${spearman.toFixed(3)}`,
        Notes: `n=${pairs.length} pairs`
      });
    }
  }
  
  if (filteredSteps.length > 0 && filteredHRV.length > 0) {
    const mapHRV = new Map(filteredHRV.map(r => [r.dateISO, r.rmssd]));
    const pairs = filteredSteps.filter(r => r.steps > 0).map(r => {
      const nextDay = addDaysISO(r.dateISO, 1);
      const hrv = mapHRV.get(nextDay);
      return Number.isFinite(hrv) && hrv > 0 ? { steps: r.steps, hrv } : null;
    }).filter(p => p !== null);
    
    if (pairs.length >= 20) {
      const xs = winsorize(pairs.map(p => p.steps), 0.01);
      const ys = winsorize(pairs.map(p => p.hrv), 0.01);
      const pearson = calculateCorrelation(xs, ys);
      const spearman = calculateSpearmanCorrelation(pairs.map(p => p.steps), pairs.map(p => p.hrv));
      results.push({
        Section: 'Load–recovery',
        Metric: 'Prev-day steps vs next-day HRV',
        Value: `Pearson ${pearson.toFixed(3)}, Spearman ${spearman.toFixed(3)}`,
        Notes: `winsorized 1%; n=${pairs.length} pairs`
      });
    }
  }
  
  // E) Consistency metrics
  if (filtered.length > 0) {
    const monthly = groupByMonth(filtered);
    if (monthly.length >= 2) {
      const monthlyCVs = monthly.map(r => {
        const monthData = filtered.filter(f => f.dateISO.startsWith(r.key)).map(f => f.minutesAsleep).filter(Number.isFinite);
        return { month: r.key, cv: cv(monthData), meanScore: r.sleepScore };
      }).filter(d => Number.isFinite(d.cv) && Number.isFinite(d.meanScore));
      
      if (monthlyCVs.length >= 2) {
        const cvs = monthlyCVs.map(d => d.cv);
        const scores = monthlyCVs.map(d => d.meanScore);
        const overallCV = avg(cvs);
        const correlation = calculateCorrelation(cvs, scores);
        results.push({
          Section: 'Consistency',
          Metric: 'Sleep minutes CV',
          Value: overallCV.toFixed(2),
          Notes: `corr with score ${correlation.toFixed(3)}`
        });
      }
    }
  }
  
  // F) Recipe probabilities
  if (filtered.length > 0) {
    const totalNights = filtered.length;
    if (totalNights >= 50) {
      const prob1 = filtered.filter(r => r.minutesAsleep >= 420 && r.sleepScore >= 75).length;
      const denom1 = filtered.filter(r => r.minutesAsleep >= 420).length;
      if (denom1 >= 50) {
        results.push({
          Section: 'Recipe probabilities',
          Metric: 'Sleep≥7h → score≥75',
          Value: `${Math.round((prob1 / denom1) * 100)}%`,
          Notes: `${prob1}/${denom1} nights`
        });
      }
      
      const prob2 = filtered.filter(r => r.minutesAsleep >= 450 && r.sleepScore >= 80).length;
      const denom2 = filtered.filter(r => r.minutesAsleep >= 450).length;
      if (denom2 >= 50) {
        results.push({
          Section: 'Recipe probabilities',
          Metric: 'Sleep≥7.5h → score≥80',
          Value: `${Math.round((prob2 / denom2) * 100)}%`,
          Notes: `${prob2}/${denom2} nights`
        });
      }
      
      // Deep+REM → next-day HRV (if HRV data available)
      const hrv = tryLoadHRV();
      if (hrv && hrv.length > 0) {
        const filteredHRV = hrv.filter(r => {
          if (from && r.dateISO < from) return false;
          if (to && r.dateISO > to) return false;
          return true;
        });
        
        if (filteredHRV.length > 0) {
          const medianHRV = quantile(filteredHRV.map(r => r.rmssd).filter(Number.isFinite), 0.5);
          
          const prob3 = filtered.filter(r => {
            const deepRem = (r.minutesDeep || 0) + (r.minutesREM || 0);
            if (deepRem / r.minutesAsleep < 0.30) return false;
            
            // Find next-day HRV
            const nextDay = addDaysISO(r.dateISO, 1);
            const nextDayHRV = filteredHRV.find(h => h.dateISO === nextDay);
            return nextDayHRV && nextDayHRV.rmssd >= medianHRV;
          }).length;
          
          const denom3 = filtered.filter(r => {
            const deepRem = (r.minutesDeep || 0) + (r.minutesREM || 0);
            return deepRem / r.minutesAsleep >= 0.30;
          }).length;
          
          if (denom3 >= 10) {
            results.push({
              Section: 'Recipe probabilities',
              Metric: 'Deep+REM≥30% → next-day HRV≥median',
              Value: `${Math.round((prob3 / denom3) * 100)}%`,
              Notes: `${prob3}/${denom3} nights; median HRV ${medianHRV.toFixed(1)}`
            });
          }
        }
      }
    }
  }
  
  // G) Recovery after low HRV
  if (filteredHRV.length > 0) {
    const validHRV = filteredHRV.filter(r => r.rmssd > 0).map(r => r.rmssd);
    if (validHRV.length > 0) {
      const threshold = quantile(validHRV, 0.2);
      const median = quantile(validHRV, 0.5);
      const lowDays = filteredHRV.filter(r => r.rmssd <= threshold);
      
      if (lowDays.length > 0) {
        const reboundDays = lowDays.map(day => {
          const dayIndex = filteredHRV.findIndex(r => r.dateISO === day.dateISO);
          for (let i = dayIndex + 1; i < filteredHRV.length; i++) {
            if (filteredHRV[i].rmssd >= median) return i - dayIndex;
          }
          return null;
        }).filter(d => d !== null);
        
        if (reboundDays.length > 0) {
          const medianRebound = quantile(reboundDays, 0.5);
          results.push({
            Section: 'Recovery',
            Metric: 'Low HRV rebound',
            Value: `median ${Math.round(medianRebound)} day${Math.round(medianRebound) !== 1 ? 's' : ''}`,
            Notes: `threshold 20th pct; n=${reboundDays.length} cases`
          });
        }
      }
    }
  }
  
  // H) CUSUM shifts
  if (filteredRHR.length > 0) {
    const baselineVals = filteredRHR.slice(0, Math.min(30, filteredRHR.length)).map(r => r.rhr);
    const { mean: baseline, k, h } = cusumParamsFromBaseline(baselineVals);
    const cusumData = calculateCUSUM(filteredRHR, baseline, 'rhr', k, h);
    if (cusumData.length > 0) {
      const maxUpper = Math.max(...cusumData.map(c => c.upperSum));
      const maxLower = Math.max(...cusumData.map(c => c.lowerSum));
      const maxExcursion = Math.max(maxUpper, maxLower);
      // Gate on decision interval h to avoid weak signals
      if (maxExcursion >= h) {
        const useUpper = maxUpper > maxLower;
        const series = cusumData.map(c => useUpper ? c.upperSum : c.lowerSum);
        const peakIndex = series.indexOf(Math.max(...series));
        // Find onset: last zero before the peak
        let onsetIndex = 0;
        for (let i = peakIndex - 1; i >= 0; i--) {
          if (series[i] === 0) { onsetIndex = i + 1; break; }
        }
        const onsetDate = cusumData[onsetIndex].date;
        const direction = useUpper ? 'up' : 'down';
        results.push({
          Section: 'CUSUM',
          Metric: 'RHR sustained shift',
          Value: `${direction} since ${onsetDate}`,
          Notes: `largest excursion ${maxExcursion.toFixed(1)} at ${cusumData[peakIndex].date}`
        });
      }
    }
  }
  
  if (filteredHRV.length > 0) {
    const validHRV = filteredHRV.filter(r => r.rmssd > 0);
    if (validHRV.length > 0) {
      const baselineVals = validHRV.slice(0, Math.min(30, validHRV.length)).map(r => r.rmssd);
      const { mean: baseline, k, h } = cusumParamsFromBaseline(baselineVals);
      const cusumData = calculateCUSUM(validHRV, baseline, 'rmssd', k, h);
      if (cusumData.length > 0) {
        const maxUpper = Math.max(...cusumData.map(c => c.upperSum));
        const maxLower = Math.max(...cusumData.map(c => c.lowerSum));
        const maxExcursion = Math.max(maxUpper, maxLower);
        // Gate on decision interval h to avoid weak signals
        if (maxExcursion >= h) {
          const useUpper = maxUpper > maxLower;
          const series = cusumData.map(c => useUpper ? c.upperSum : c.lowerSum);
          const peakIndex = series.indexOf(Math.max(...series));
          // Find onset: last zero before the peak
          let onsetIndex = 0;
          for (let i = peakIndex - 1; i >= 0; i--) {
            if (series[i] === 0) { onsetIndex = i + 1; break; }
          }
          const onsetDate = cusumData[onsetIndex].date;
          const direction = useUpper ? 'up' : 'down';
          results.push({
            Section: 'CUSUM',
            Metric: 'HRV sustained shift',
            Value: `${direction} since ${onsetDate}`,
            Notes: `largest excursion ${maxExcursion.toFixed(1)} at ${cusumData[peakIndex].date}`
          });
        }
      }
    }
  }
  
  return results;
}

// Keep RHR date inputs in sync with the selected RHR view (daily/monthly/yearly)
function syncRHRDateInputs(){
  try{
    const chartType = document.getElementById('chartType')?.value;
    if (chartType !== 'daily_rhr') return;
    const dateFrom = document.getElementById('dateFrom');
    const dateTo = document.getElementById('dateTo');
    const rhrToggle = document.getElementById('rhrViewToggle');
    if (!dateFrom || !dateTo || !rhrToggle) return;
    const toggleValue = parseInt(rhrToggle.value);
    const isYearlyView = toggleValue === 2;
    if (isYearlyView) {
      // numeric year inputs for yearly view
      dateFrom.type = 'number';
      dateTo.type = 'number';
      dateFrom.min = '2000';
      dateFrom.max = '2030';
      dateTo.min = '2000';
      dateTo.max = '2030';
      const isYear = (s)=> /^\d{4}$/.test(String(s||''));
      if (!(isYear(dateFrom.value) && isYear(dateTo.value))){
        try{
          const r = tryLoadRHR();
          if (r && r.length > 0){
            let minY = r[0].date.getFullYear();
            let maxY = minY;
            for(const record of r){
              const y = record.date.getFullYear();
              if (y < minY) minY = y;
              if (y > maxY) maxY = y;
            }
            dateFrom.value = String(minY);
            dateTo.value = String(maxY);
          } else {
            const cy = new Date().getFullYear();
            dateFrom.value = String(cy - 1);
            dateTo.value = String(cy);
          }
        }catch(_){
          const cy = new Date().getFullYear();
          dateFrom.value = String(cy - 1);
          dateTo.value = String(cy);
        }
      }
    } else {
      // date inputs for daily/monthly
      dateFrom.type = 'date';
      dateTo.type = 'date';
      dateFrom.min = '';
      dateFrom.max = '';
      dateTo.min = '';
      dateTo.max = '';
      const isISO = (s)=> /^\d{4}-\d{2}-\d{2}$/.test(String(s||''));
      // only set defaults when either input is invalid/empty
      // but honor open start: if From is empty and To is valid, do not auto-fill
      if ((!isISO(dateFrom.value) || !isISO(dateTo.value)) && !(dateFrom.value === '' && isISO(dateTo.value))){
        const today = new Date();
        const six = new Date(); six.setMonth(today.getMonth()-6);
        dateFrom.value = six.toISOString().slice(0,10);
        dateTo.value = today.toISOString().slice(0,10);
      }
    }
  }catch(_){ /* no-op */ }
}

function tryLoadHRV(){ if(!rawHRV||!rawHRV.length) return null; const rows = rawHRV.map(r=>({ dateISO: toISODate(parseDate(r.date)), rmssd: num(r.dailyRmssd||r.rmssd) })).filter(r=>r.dateISO && Number.isFinite(r.rmssd)); return rows.length > 0 ? rows : null; }

function tryLoadSteps(){ if(!rawSteps||!rawSteps.length) return null; const rows = normalizeStepsRows(rawSteps); return rows.length > 0 ? rows : null; }

function normalizeRHRRows(rows){ return rows.map(r=>{ const d = parseDate(r.date); const rhr = num(r.resting_heart_rate); return { dateISO: d? toISODate(d): null, date:d, rhr:rhr } }).filter(r=>r.date && Number.isFinite(r.rhr)) }

function tryLoadRHR(){ if(!rawRHR||!rawRHR.length) return null; const rows = normalizeRHRRows(rawRHR); return rows.length > 0 ? rows : null; }

function scatterSeries(xs, ys){ const pts=[]; for(let i=0;i<xs.length;i++){ if(Number.isFinite(xs[i])&&Number.isFinite(ys[i])) pts.push({x:xs[i],y:ys[i]}) } return pts }

function averageRanks(values){
  const withIdx = values.map((v,i)=>({v,i})).sort((a,b)=>a.v-b.v);
  const ranks = new Array(values.length);
  let i = 0;
  while(i < withIdx.length){
    let j = i+1;
    while(j < withIdx.length && withIdx[j].v === withIdx[i].v) j++;
    const avg = (i+1 + j) / 2;
    for(let k=i;k<j;k++) ranks[withIdx[k].i] = avg;
    i = j;
  }
  return ranks;
}

function calculateCorrelation(x, y){
  const n = x.length;
  if(n < 2) return 0;
  const sumX = x.reduce((a,b)=>a+b,0);
  const sumY = y.reduce((a,b)=>a+b,0);
  const sumXY = x.reduce((s,xi,i)=>s+xi*y[i],0);
  const sumX2 = x.reduce((s,xi)=>s+xi*xi,0);
  const sumY2 = y.reduce((s,yi)=>s+yi*yi,0);
  const num = n*sumXY - sumX*sumY;
  const den = Math.sqrt((n*sumX2 - sumX*sumX)*(n*sumY2 - sumY*sumY));
  return den === 0 ? 0 : num/den;
}

function calculateSpearmanCorrelation(x, y){
  if(x.length < 2) return 0;
  const rx = averageRanks(x);
  const ry = averageRanks(y);
  return calculateCorrelation(rx, ry);
}

function addDaysISO(iso, days){
  const [y,m,d] = iso.split('-').map(Number);
  const ms = Date.UTC(y, m-1, d) + days*24*3600*1000;
  const nd = new Date(ms);
  return nd.toISOString().slice(0,10);
}

function winsorize(arr, p=0.01){
  const a = arr.slice().sort((x,y)=>x-y);
  const lo = a[Math.floor(p*a.length)];
  const hi = a[Math.floor((1-p)*a.length)-1];
  return arr.map(v => Math.min(hi, Math.max(lo, v)));
}

// Sleep date interpretation toggle
const sleepUsesBedtimeDate = true; // Set to true if sleep CSV uses bedtime date, false if wake date
const sleepKey = iso => sleepUsesBedtimeDate ? iso : addDaysISO(iso, -1);

function lineSeries(rows, xKey, yKey){ return rows.filter(r=>Number.isFinite(r[yKey])).map(r=>({x:r[xKey], y:r[yKey]})) }
// Build a dense daily series from min to max date, inserting nulls for missing days
function dailyLineSeries(rows, xKey, yKey){
  const pts = rows.filter(r=>r && r[xKey] !== undefined && r[xKey] !== null);
  if(pts.length === 0) return [];
  // Map latest value per ISO date
  const byDay = new Map();
  let minD = null, maxD = null;
  for(const r of pts){
    const d0 = parseDate(r[xKey]);
    const d = d0 ? startOfDay(d0) : null;
    if(!d) continue;
    const iso = toISODate(d);
    const val = Number.isFinite(r[yKey]) ? r[yKey] : null;
    byDay.set(iso, val);
    if(!minD || d < minD) minD = new Date(d);
    if(!maxD || d > maxD) maxD = new Date(d);
  }
  if(!minD || !maxD) return [];
  const out = [];
  for(let d = new Date(minD); d <= maxD; d.setDate(d.getDate()+1)){
    const iso = toISODate(d);
    const val = byDay.has(iso) ? byDay.get(iso) : null;
    out.push({ x: new Date(d), y: val });
  }
  return out;
}

function renderTable(rows){ 
  // Backwards compatibility: only render if legacy preview table exists
  const table = document.getElementById('previewTable');
  if(!table) return;
  const head = table.querySelector('thead');
  const body = table.querySelector('tbody');
  if(!head || !body) return;
  body.innerHTML=''; 
  head.innerHTML=''; 
  
  // Special handling for histogram steps - only show histogram data
  if(rows && rows.histogram && rows.top20) {
    const histCols = Object.keys(rows.histogram[0]);
    head.innerHTML = '<tr>'+histCols.map(c=>`<th>${c}</th>`).join('')+'</tr>';
    rows.histogram.slice(0,100).forEach(r=>{ 
      body.innerHTML += '<tr>'+histCols.map(c=>`<td>${r[c]??''}</td>`).join('')+'</tr>' 
    });
    return;
  }
  
  if(!rows.length) return; 
  const cols = Object.keys(rows[0]); 
  head.innerHTML = '<tr>'+cols.map(c=>`<th>${c}</th>`).join('')+'</tr>'; 
  rows.slice(0,100).forEach(r=>{ 
    body.innerHTML += '<tr>'+cols.map(c=>`<td>${r[c]??''}</td>`).join('')+'</tr>' 
  }) 
}

// Render preview rows to a specific table by id (used for collapsible steps preview)
function renderTableTo(tableId, rows){
  const table = document.getElementById(tableId);
  if(!table) return;
  const head = table.querySelector('thead');
  const body = table.querySelector('tbody');
  body.innerHTML = '';
  head.innerHTML = '';
  if(!rows || rows.length === 0){ return; }
  const cols = Object.keys(rows[0]);
  head.innerHTML = '<tr>'+cols.map(c=>`<th>${c}</th>`).join('')+'</tr>';
  rows.slice(0,100).forEach(r=>{
    body.innerHTML += '<tr>'+cols.map(c=>`<td>${r[c]??''}</td>`).join('')+'</tr>'
  });
}

function renderTopStepsTable(top20Data) {
  const head = document.querySelector('#topStepsTable thead');
  const body = document.querySelector('#topStepsTable tbody');
  const section = document.getElementById('topStepsSection');
  
  head.innerHTML = '';
  body.innerHTML = '';
  
  if (!top20Data || !top20Data.length) {
    section.style.display = 'none';
    return;
  }
  
  // Show the section
  section.style.display = 'block';
  
  // Create table headers
  head.innerHTML = '<tr><th>Rank</th><th>Date</th><th>Steps</th></tr>';
  
  // Add data rows
  top20Data.forEach((r, i) => {
    body.innerHTML += `<tr><td>${i+1}</td><td>${r.date}</td><td>${r.steps}</td></tr>`;
  });
}

function renderBottomStepsTable(bottom20Data) {
  const head = document.querySelector('#bottomStepsTable thead');
  const body = document.querySelector('#bottomStepsTable tbody');
  const section = document.getElementById('bottomStepsSection');
  
  head.innerHTML = '';
  body.innerHTML = '';
  
  if (!bottom20Data || !bottom20Data.length) {
    section.style.display = 'none';
    return;
  }
  
  // Show the section
  section.style.display = 'block';
  
  // Create table headers
  head.innerHTML = '<tr><th>Rank</th><th>Date</th><th>Steps</th></tr>';
  
  // Add data rows
  bottom20Data.forEach((r, i) => {
    body.innerHTML += `<tr><td>${i+1}</td><td>${r.date}</td><td>${r.steps}</td></tr>`;
  });
}

function renderTopRHRTable(top20Data) {
  const head = document.querySelector('#topRHRTable thead');
  const body = document.querySelector('#topRHRTable tbody');
  const section = document.getElementById('topRHRSection');
  
  head.innerHTML = '';
  body.innerHTML = '';
  
  if (!top20Data || !top20Data.length) {
    section.style.display = 'none';
    return;
  }
  
  // Show the section
  section.style.display = 'block';
  
  // Create table headers
  head.innerHTML = '<tr><th>Rank</th><th>Date</th><th>RHR</th></tr>';
  
  // Add data rows
  top20Data.forEach((r, i) => {
    body.innerHTML += `<tr><td>${i+1}</td><td>${r.date}</td><td>${r.rhr}</td></tr>`;
  });
}

function renderBottomRHRTable(bottom20Data) {
  const head = document.querySelector('#bottomRHRTable thead');
  const body = document.querySelector('#bottomRHRTable tbody');
  const section = document.getElementById('bottomRHRSection');
  
  head.innerHTML = '';
  body.innerHTML = '';
  
  if (!bottom20Data || !bottom20Data.length) {
    section.style.display = 'none';
    return;
  }
  
  // Show the section
  section.style.display = 'block';
  
  // Create table headers
  head.innerHTML = '<tr><th>Rank</th><th>Date</th><th>RHR</th></tr>';
  
  // Add data rows
  bottom20Data.forEach((r, i) => {
    body.innerHTML += `<tr><td>${i+1}</td><td>${r.date}</td><td>${r.rhr}</td></tr>`;
  });
}

function renderTopSleepScoreTable(top20Data) {
  const head = document.querySelector('#topSleepScoreTable thead');
  const body = document.querySelector('#topSleepScoreTable tbody');
  const section = document.getElementById('topSleepScoreSection');
  
  head.innerHTML = '';
  body.innerHTML = '';
  
  if (!top20Data || !top20Data.length) {
    section.style.display = 'none';
    return;
  }
  
  // Show the section
  section.style.display = 'block';
  
  // Create table headers
  head.innerHTML = '<tr><th>Rank</th><th>Date</th><th>Sleep Score</th></tr>';
  
  // Add data rows
  top20Data.forEach((r, i) => {
    body.innerHTML += `<tr><td>${i+1}</td><td>${r.date}</td><td>${r.sleepScore}</td></tr>`;
  });
}

function renderBottomSleepScoreTable(bottom20Data) {
  const head = document.querySelector('#bottomSleepScoreTable thead');
  const body = document.querySelector('#bottomSleepScoreTable tbody');
  const section = document.getElementById('bottomSleepScoreSection');
  
  head.innerHTML = '';
  body.innerHTML = '';
  
  if (!bottom20Data || !bottom20Data.length) {
    section.style.display = 'none';
    return;
  }
  
  // Show the section
  section.style.display = 'block';
  
  // Create table headers
  head.innerHTML = '<tr><th>Rank</th><th>Date</th><th>Sleep Score</th></tr>';
  
  // Add data rows
  bottom20Data.forEach((r, i) => {
    body.innerHTML += `<tr><td>${i+1}</td><td>${r.date}</td><td>${r.sleepScore}</td></tr>`;
  });
}

function renderTopHRVTable(top20Data) {
  const head = document.querySelector('#topHRVTable thead');
  const body = document.querySelector('#topHRVTable tbody');
  const section = document.getElementById('topHRVSection');
  
  head.innerHTML = '';
  body.innerHTML = '';
  
  if (!top20Data || !top20Data.length) {
    section.style.display = 'none';
    return;
  }
  
  // Show the section
  section.style.display = 'block';
  
  // Create table headers
  head.innerHTML = '<tr><th>Rank</th><th>Date</th><th>HRV</th></tr>';
  
  // Add data rows
  top20Data.forEach((r, i) => {
    body.innerHTML += `<tr><td>${i+1}</td><td>${r.date}</td><td>${r.hrv}</td></tr>`;
  });
}

function renderBottomHRVTable(bottom20Data) {
  const head = document.querySelector('#bottomHRVTable thead');
  const body = document.querySelector('#bottomHRVTable tbody');
  const section = document.getElementById('bottomHRVSection');
  
  head.innerHTML = '';
  body.innerHTML = '';
  
  if (!bottom20Data || !bottom20Data.length) {
    section.style.display = 'none';
    return;
  }
  
  // Show the section
  section.style.display = 'block';
  
  // Create table headers
  head.innerHTML = '<tr><th>Rank</th><th>Date</th><th>HRV</th></tr>';
  
  // Add data rows
  bottom20Data.forEach((r, i) => {
    body.innerHTML += `<tr><td>${i+1}</td><td>${r.date}</td><td>${r.hrv}</td></tr>`;
  });
}

function calculateCUSUM(data, target, fieldName = 'rhr', k = 0.5, h = 5) {
  // CUSUM parameters: k = reference value, h = decision interval
  const cusum = [];
  let upperSum = 0;
  let lowerSum = 0;
  
  data.forEach((record, index) => {
    const value = record[fieldName];
    const deviation = value - target;
    upperSum = Math.max(0, upperSum + deviation - k);
    lowerSum = Math.max(0, lowerSum - deviation - k);
    
    cusum.push({
      index: index,
      value: value,
      upperSum: upperSum,
      lowerSum: lowerSum,
      date: record.dateISO
    });
  });
  
  return cusum;
}

function std(arr){
  const a = arr.filter(Number.isFinite);
  if (a.length === 0) return NaN;
  const m = avg(a);
  const v = avg(a.map(x => (x - m) * (x - m)));
  return Math.sqrt(v);
}

function cusumParamsFromBaseline(values){
  const a = values.filter(Number.isFinite);
  if (a.length === 0) return { mean: NaN, sigma: NaN, k: 0.5, h: 5 };
  const mean = avg(a);
  const sigma = std(a);
  const safeSigma = (Number.isFinite(sigma) && sigma > 0) ? sigma : 1;
  const k = 0.5 * safeSigma;
  const h = 5 * safeSigma;
  return { mean, sigma: safeSigma, k, h };
}

// Find notable CUSUM shift onsets where the cumulative sum first exceeds the
// decision interval h after a zero baseline (separate for upper/lower).
function detectCUSUMEvents(cusumData, h = 5){
  const events = [];
  if (!Array.isArray(cusumData) || cusumData.length === 0) return events;
  let upperOnset = null, upperCrossed = false;
  let lowerOnset = null, lowerCrossed = false;
  for (let i = 0; i < cusumData.length; i++){
    const u = cusumData[i].upperSum;
    const l = cusumData[i].lowerSum;
    // Track upper run
    if (u > 0){
      if (upperOnset === null) upperOnset = i; // mark start of run
      if (!upperCrossed && u >= h){
        events.push({ dateISO: cusumData[upperOnset].date, direction: 'up' });
        upperCrossed = true;
      }
    } else { // reset
      upperOnset = null; upperCrossed = false;
    }
    // Track lower run
    if (l > 0){
      if (lowerOnset === null) lowerOnset = i;
      if (!lowerCrossed && l >= h){
        events.push({ dateISO: cusumData[lowerOnset].date, direction: 'down' });
        lowerCrossed = true;
      }
    } else {
      lowerOnset = null; lowerCrossed = false;
    }
  }
  // Deduplicate by date/direction
  const seen = new Set();
  return events.filter(e=>{ const k = e.dateISO+"|"+e.direction; if(seen.has(k)) return false; seen.add(k); return true; });
}

function renderRHRCUSUMChart(rhrData) {
  const section = document.getElementById('rhrCusumSection');
  const canvas = document.getElementById('rhrCusumChart');
  
  if (!rhrData || rhrData.length < 10) {
    section.style.display = 'none';
    return;
  }
  
  // Show the section
  section.style.display = 'block';
  
  // Calculate baseline (first 30 days or all data if less than 30) and sigma-scaled params
  const baselineRows = rhrData.slice(0, Math.min(30, rhrData.length));
  const baselineValues = baselineRows.map(r => r.rhr);
  const { mean: target, sigma, k, h } = cusumParamsFromBaseline(baselineValues);
  
  // Debug: Log CUSUM parameters and baseline info
  console.log('RHR CUSUM Debug Info:');
  console.log('Baseline period:', baselineRows[0]?.dateISO, 'to', baselineRows[baselineRows.length-1]?.dateISO);
  console.log('Baseline mean (target):', target.toFixed(2));
  console.log('Baseline sigma:', sigma.toFixed(2));
  console.log('k (reference value):', k.toFixed(2));
  console.log('h (decision interval):', h.toFixed(2));
  console.log('Data range:', rhrData[0]?.dateISO, 'to', rhrData[rhrData.length-1]?.dateISO);
  
  // Calculate CUSUM
  const cusumData = calculateCUSUM(rhrData, target, 'rhr', k, h);
  
  // Debug: Log CUSUM values around September 2025
  console.log('CUSUM values around September 2025:');
  const septData = cusumData.filter(c => c.date && c.date.includes('2025-09'));
  septData.forEach(c => {
    console.log(`${c.date}: RHR=${c.value}, UpperSum=${c.upperSum.toFixed(2)}, LowerSum=${c.lowerSum.toFixed(2)}`);
  });
  
  // Debug: Find when upperSum first exceeds h
  const firstExceed = cusumData.find(c => c.upperSum >= h);
  if (firstExceed) {
    console.log(`First time upperSum >= h (${h.toFixed(2)}): ${firstExceed.date}, value=${firstExceed.value}, upperSum=${firstExceed.upperSum.toFixed(2)}`);
  }
  
  // Prepare chart data
  const labels = rhrData.map(r => r.dateISO);
  const rhrValues = rhrData.map(r => r.rhr);
  const upperCUSUM = cusumData.map(c => c.upperSum);
  const lowerCUSUM = cusumData.map(c => c.lowerSum);
  
  // Create chart
  const ctx = canvas.getContext('2d');
  
  // Destroy existing chart if it exists
  if (window.rhrCusumChartInstance) {
    window.rhrCusumChartInstance.destroy();
  }
  
  window.rhrCusumChartInstance = new Chart(ctx, {
    type: 'line',
    data: {
      labels: labels,
      datasets: [
        {
          label: 'RHR',
          data: rhrValues,
          borderColor: '#ff8aa1', // Red
          backgroundColor: '#ff8aa120',
          yAxisID: 'y',
          tension: 0.1
        },
        {
          label: 'Upper CUSUM',
          data: upperCUSUM,
          borderColor: '#7bffbf', // Green
          backgroundColor: 'transparent',
          yAxisID: 'y1',
          tension: 0.1
        },
        {
          label: 'Lower CUSUM',
          data: lowerCUSUM,
          borderColor: '#ffd166', // Red
          backgroundColor: 'transparent',
          yAxisID: 'y1',
          tension: 0.1
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          display: true,
          position: 'top',
          labels: {
            color: '#e6eaf3'
          }
        },
        tooltip: {
          mode: 'index',
          intersect: false,
          callbacks: {
            title: function(context) {
              return context[0].label;
            },
            label: function(context) {
              if (context.datasetIndex === 0) {
                return `RHR: ${context.parsed.y.toFixed(1)}`;
              } else if (context.datasetIndex === 1) {
                return `Upper CUSUM: ${context.parsed.y.toFixed(2)}`;
              } else {
                return `Lower CUSUM: ${context.parsed.y.toFixed(2)}`;
              }
            }
          }
        }
      },
      scales: {
        x: {
          type: 'time',
          time: {
            unit: 'day'
          },
          title: {
            display: true,
            text: 'Date',
            color: '#e6eaf3'
          },
          grid: {
            color: '#1a2349'
          },
          ticks: {
            color: '#9aa5c6'
          }
        },
        y: {
          type: 'linear',
          display: true,
          position: 'left',
          title: {
            display: true,
            text: 'RHR (bpm)',
            color: '#e6eaf3'
          },
          grid: {
            color: '#1a2349'
          },
          ticks: {
            color: '#9aa5c6'
          }
        },
        y1: {
          type: 'linear',
          display: true,
          position: 'right',
          title: {
            display: true,
            text: 'CUSUM',
            color: '#e6eaf3'
          },
          grid: {
            drawOnChartArea: false,
          },
          ticks: {
            color: '#9aa5c6'
          }
        }
      }
    }
  });

  // Render notable CUSUM events list and info under the chart
  try {
    const events = detectCUSUMEvents(cusumData, h);
    let container = document.getElementById('rhrCusumEvents');
    if (!container){
      container = document.createElement('div');
      container.id = 'rhrCusumEvents';
      container.className = 'muted';
      container.style.marginTop = '8px';
      section.appendChild(container);
    }
    if (events.length === 0){
      container.textContent = '';
    } else {
      const sorted = [...events].sort((a,b)=> (a.dateISO < b.dateISO ? 1 : (a.dateISO > b.dateISO ? -1 : 0)));
      const lines = sorted.map(e => {
        const d = parseDate(e.dateISO);
        const dow = d ? d.toLocaleDateString('en-US', { weekday: 'short' }) : '';
        const up = e.direction === 'up';
        const what = up ? 'RHR sustained shift up' : 'RHR sustained shift down';
        const cls = up ? 'bad' : 'good'; // For RHR, up is bad (higher heart rate), down is good (lower heart rate)
        return `<div class="${cls}">${dow}, ${e.dateISO} ${what}</div>`;
      });
      container.innerHTML = lines.join('');
    }

    // Counts and baseline/params info
    let info = document.getElementById('rhrCusumInfo');
    if (!info){
      info = document.createElement('div');
      info.id = 'rhrCusumInfo';
      info.className = 'muted';
      info.style.marginTop = '6px';
      section.appendChild(info);
    }
    const upCount = events.filter(e=>e.direction==='up').length;
    const downCount = events.filter(e=>e.direction==='down').length;
    const parts = [];
    parts.push(`Up shifts: ${upCount}, Down shifts: ${downCount}`);
    const baselineStart = baselineRows.length ? baselineRows[0].dateISO : null;
    const baselineEnd = baselineRows.length ? baselineRows[baselineRows.length - 1].dateISO : null;
    if (baselineStart && baselineEnd){
      parts.push(`Baseline: ${baselineStart} to ${baselineEnd}`);
    }
    parts.push(`μ=${Number.isFinite(target)?target.toFixed(1):'n/a'}  σ=${Number.isFinite(sigma)?sigma.toFixed(1):'n/a'}  k=${Number.isFinite(k)?k.toFixed(1):'n/a'}  h=${Number.isFinite(h)?h.toFixed(1):'n/a'}`);
    info.textContent = parts.join('  ·  ');
  } catch(_) { /* no-op */ }
}

function renderHRVCUSUMChart(hrvData) {
  const section = document.getElementById('hrvCusumSection');
  const canvas = document.getElementById('hrvCusumChart');
  
  if (!hrvData || hrvData.length < 10) {
    section.style.display = 'none';
    return;
  }
  
  // Show the section
  section.style.display = 'block';
  
  // Filter data based on checkbox
  const ignoreZero = document.getElementById('hrvCusumIgnoreZero').checked;
  const filteredData = ignoreZero ? hrvData.filter(r => r.rmssd > 0) : hrvData;
  
  if (filteredData.length < 10) {
    section.style.display = 'none';
    return;
  }
  
  // Calculate baseline (first 30 days or all data if less than 30) and sigma-scaled params
  const baselineRows = filteredData.slice(0, Math.min(30, filteredData.length));
  const baselineValues = baselineRows.map(r => r.rmssd);
  const baselineStart = baselineRows.length ? baselineRows[0].dateISO : null;
  const baselineEnd = baselineRows.length ? baselineRows[baselineRows.length - 1].dateISO : null;
  const { mean: target, sigma, k, h } = cusumParamsFromBaseline(baselineValues);
  
  // Calculate CUSUM
  const cusumData = calculateCUSUM(filteredData, target, 'rmssd', k, h);
  
  // Prepare chart data with daily gaps (nulls) so lines don't connect across missing days
  const hrvSeries = dailyLineSeries(filteredData, 'dateISO', 'rmssd');
  const upperSeries = dailyLineSeries(cusumData, 'date', 'upperSum');
  const lowerSeries = dailyLineSeries(cusumData, 'date', 'lowerSum');
  
  // Create chart
  const ctx = canvas.getContext('2d');
  
  // Destroy existing chart if it exists
  if (window.hrvCusumChartInstance) {
    window.hrvCusumChartInstance.destroy();
  }
  
  window.hrvCusumChartInstance = new Chart(ctx, {
    type: 'line',
    data: {
      datasets: [
        {
          label: 'HRV',
          data: hrvSeries,
          borderColor: '#ff8aa1', // Red
          backgroundColor: '#ff8aa120',
          yAxisID: 'y',
          tension: 0.1,
          spanGaps: false
        },
        {
          label: 'Upper CUSUM',
          data: upperSeries,
          borderColor: '#7bffbf', // Green
          backgroundColor: 'transparent',
          yAxisID: 'y1',
          tension: 0.1,
          spanGaps: false
        },
        {
          label: 'Lower CUSUM',
          data: lowerSeries,
          borderColor: '#ffd166', // Yellow
          backgroundColor: 'transparent',
          yAxisID: 'y1',
          tension: 0.1,
          spanGaps: false
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          display: true,
          position: 'top',
          labels: {
            color: '#e6eaf3'
          }
        },
        tooltip: {
          mode: 'index',
          intersect: false,
          callbacks: {
            title: function(context) {
              // Use the data point's x value (which is the date) instead of label
              const date = new Date(context[0].parsed.x);
              return date.toLocaleDateString('en-US', { 
                year: 'numeric', 
                month: 'short', 
                day: 'numeric' 
              });
            },
            label: function(context) {
              if (context.datasetIndex === 0) {
                return `HRV: ${context.parsed.y.toFixed(1)}`;
              } else if (context.datasetIndex === 1) {
                return `Upper CUSUM: ${context.parsed.y.toFixed(2)}`;
              } else {
                return `Lower CUSUM: ${context.parsed.y.toFixed(2)}`;
              }
            }
          }
        }
      },
      scales: {
        x: {
          type: 'time',
          time: {
            unit: 'day'
          },
          title: {
            display: true,
            text: 'Date',
            color: '#e6eaf3'
          },
          grid: {
            color: '#1a2349'
          },
          ticks: {
            color: '#9aa5c6'
          }
        },
        y: {
          type: 'linear',
          display: true,
          position: 'left',
          title: {
            display: true,
            text: 'HRV (RMSSD)',
            color: '#e6eaf3'
          },
          grid: {
            color: '#1a2349'
          },
          ticks: {
            color: '#9aa5c6'
          }
        },
        y1: {
          type: 'linear',
          display: true,
          position: 'right',
          title: {
            display: true,
            text: 'CUSUM',
            color: '#e6eaf3'
          },
          grid: {
            drawOnChartArea: false,
          },
          ticks: {
            color: '#9aa5c6'
          }
        }
      }
    }
  });

  // Render notable CUSUM events list and info under the chart
  try {
    const events = detectCUSUMEvents(cusumData, h);
    let container = document.getElementById('hrvCusumEvents');
    if (!container){
      container = document.createElement('div');
      container.id = 'hrvCusumEvents';
      container.className = 'muted';
      container.style.marginTop = '8px';
      section.appendChild(container);
    }
    if (events.length === 0){
      container.textContent = '';
    } else {
      const sorted = [...events].sort((a,b)=> (a.dateISO < b.dateISO ? 1 : (a.dateISO > b.dateISO ? -1 : 0)));
      const lines = sorted.map(e => {
        const d = parseDate(e.dateISO);
        const dow = d ? d.toLocaleDateString('en-US', { weekday: 'short' }) : '';
        const up = e.direction === 'up';
        const what = up ? 'HRV sustained shift up' : 'HRV sustained shift down';
        const cls = up ? 'good' : 'bad';
        return `<div class="${cls}">${dow}, ${e.dateISO} ${what}</div>`;
      });
      container.innerHTML = lines.join('');
    }

    // Counts and baseline/params info
    let info = document.getElementById('hrvCusumInfo');
    if (!info){
      info = document.createElement('div');
      info.id = 'hrvCusumInfo';
      info.className = 'muted';
      info.style.marginTop = '6px';
      section.appendChild(info);
    }
    const upCount = events.filter(e=>e.direction==='up').length;
    const downCount = events.filter(e=>e.direction==='down').length;
    const parts = [];
    parts.push(`Up shifts: ${upCount}, Down shifts: ${downCount}`);
    if (baselineStart && baselineEnd){
      parts.push(`Baseline: ${baselineStart} to ${baselineEnd}`);
    }
    parts.push(`μ=${Number.isFinite(target)?target.toFixed(1):'n/a'}  σ=${Number.isFinite(sigma)?sigma.toFixed(1):'n/a'}  k=${Number.isFinite(k)?k.toFixed(1):'n/a'}  h=${Number.isFinite(h)?h.toFixed(1):'n/a'}`);
    info.textContent = parts.join('  ·  ');
  } catch(_) { /* no-op */ }
}

function createMessageChart(message) {
  return {
    type: 'bar',
    data: {
      labels: [''],
      datasets: [{
        label: '',
        data: [0],
        backgroundColor: 'transparent',
        borderColor: 'transparent'
      }]
    },
    options: {
      responsive: true,
      plugins: {
        legend: { display: false },
        tooltip: { enabled: false },
        afterDraw: function(chart) {
          const ctx = chart.ctx;
          const width = chart.width;
          const height = chart.height;
          
          ctx.save();
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillStyle = '#9aa5c6';
          ctx.font = 'bold 16px Inter, system-ui, sans-serif';
          ctx.fillText(message, width / 2, height / 2);
          ctx.restore();
        }
      },
      scales: {
        x: { display: false },
        y: { display: false }
      },
      animation: false,
      elements: {
        bar: { borderWidth: 0 }
      }
    }
  };
}

function renderAnalyticsBadges(slopegraphData, analytics, extra){
  const el = document.getElementById('analyticsBadges');
  if(!el) return;
  el.innerHTML = '';

  const pill = (text, cls='neutral', tooltip='') => `<span class="pill ${cls}" title="${tooltip}">${text}</span>`;
  const isNum = v => typeof v === 'number' && Number.isFinite(v);
  const added = []; // track whether we showed anything

  // ------------- helpers -------------
  const pick = (section, metricContains) =>
    analytics.find(r => r.Section === section && r.Metric.toLowerCase().includes(metricContains));

  const parsePearson = v => {
    const m = /Pearson\s+(-?\d+(?:\.\d+)?)/i.exec(v||'');
    return m ? parseFloat(m[1]) : NaN;
  };

  const winTrend = arr => {
    const a = arr.filter(Number.isFinite);
    if (a.length < 21) return null; // need at least ~3 weeks to be meaningful
    const w = Math.max(7, Math.floor(a.length/3)); // average first/last third
    const start = a.slice(0, w);
    const end   = a.slice(-w);
    const s = avg(start), e = avg(end);
    if (!Number.isFinite(s) || !Number.isFinite(e) || s === 0) return null;
    return { start: s, end: e, pct: ((e - s) / s) * 100 };
  };

  const findOptimalSleepDuration = (sleepData, minEfficiency) => {
    if (!sleepData || sleepData.length < 10) return null;
    
    // Group by 0.5-hour bins
    const bins = {};
    sleepData.forEach(record => {
      if (!Number.isFinite(record.minutesAsleep) || !Number.isFinite(record.efficiency)) return;
      
      const hours = record.minutesAsleep / 60;
      const bin = Math.floor(hours * 2) / 2; // Round to nearest 0.5
      if (bin < 4 || bin > 12) return; // Reasonable sleep range
      
      if (!bins[bin]) bins[bin] = { total: 0, success: 0 };
      bins[bin].total++;
      if (record.efficiency >= minEfficiency) bins[bin].success++;
    });
    
    // Find bin with highest success rate (minimum 5 samples)
    let bestBin = null;
    let bestRate = 0;
    
    Object.entries(bins).forEach(([hours, data]) => {
      if (data.total < 5) return; // Need at least 5 samples
      const rate = (data.success / data.total) * 100;
      if (rate > bestRate) {
        bestRate = rate;
        bestBin = parseFloat(hours);
      }
    });
    
    if (!bestBin || bestRate < 10) return null; // No meaningful pattern
    
    const range = `${bestBin}-${bestBin + 0.5}`;
    return { range, rate: Math.round(bestRate) };
  };

  // Find best duration window by highest average sleep score
  const findBestDurationByScore = (sleepData, windowHours = 1.0, stepHours = 0.25, minSamples = 15) => {
    if (!sleepData || sleepData.length < minSamples) return null;
    const rows = sleepData.filter(r => Number.isFinite(r.minutesAsleep) && Number.isFinite(r.sleepScore));
    if (rows.length < minSamples) return null;

    const toHours = v => v / 60;
    let best = null; // { start, end, mean, n }
    const lo = 4.0, hi = 10.0; // search range in hours
    for (let h = lo; h <= hi - windowHours + 1e-9; h += stepHours) {
      const hEnd = h + windowHours;
      const inWin = rows.filter(r => {
        const hrs = toHours(r.minutesAsleep);
        return hrs >= h && hrs < hEnd;
      });
      if (inWin.length >= minSamples) {
        const mean = avg(inWin.map(r => r.sleepScore));
        if (Number.isFinite(mean) && (!best || mean > best.mean)) {
          best = { start: h, end: hEnd, mean, n: inWin.length };
        }
      }
    }
    if (!best) return null;
    const fmt = x => (Math.round(x * 2) / 2).toString(); // keep halves
    return { range: `${fmt(best.start)}-${fmt(best.end)}`, mean: best.mean, n: best.n };
  };

  // Compute optimal bedtime window (30-min bins) for highest average sleep score
  const findOptimalBedtimeWindow = (sleepData, minSamples = 5, minNights = 10) => {
    if (!sleepData || sleepData.length < minNights) return null;

    // Use only records with a real bedtime start timestamp
    const withStart = sleepData.filter(r => r && r.start instanceof Date && Number.isFinite(r.sleepScore));
    if (withStart.length < minNights) return null; // safeguard: not enough valid start times

    const bins = new Map(); // key: bin start hour (e.g., 22.0, 22.5, ...), value: {sum, total}

    withStart.forEach(record => {
      // Interpret start time; treat early-morning bedtimes as >24 to keep ordering contiguous
      let h = record.start.getHours() + (record.start.getMinutes() || 0) / 60;
      if (h < 12) h += 24; // 0-11 -> 24-35 to keep evening-to-early-morning contiguous

      // Focus on reasonable main-sleep bedtime window: 18:00 (18) to 30:00 (6 AM next day)
      if (h < 18 || h > 30) return;

      const bin = Math.floor(h * 2) / 2; // 30-min bins
      const key = bin.toFixed(1);
      const cur = bins.get(key) || { sum: 0, total: 0 };
      cur.sum += record.sleepScore;
      cur.total += 1;
      bins.set(key, cur);
    });

    let best = null; // { bin, mean, total }
    for (const [k, v] of bins.entries()) {
      if (v.total < minSamples) continue;
      const mean = v.sum / v.total;
      if (!best || mean > best.mean) best = { bin: parseFloat(k), mean, total: v.total };
    }

    if (!best) return null;

    const fmtTime = (hh) => {
      // Map 24-30 back to 0-6 for display
      let hours = Math.floor(hh % 24);
      let minutes = Math.round((hh - Math.floor(hh)) * 60);
      if (minutes === 60) { minutes = 0; hours = (hours + 1) % 24; }
      const ampm = hours >= 12 ? 'PM' : 'AM';
      const h12 = ((hours + 11) % 12) + 1;
      return `${h12}:${String(minutes).padStart(2,'0')} ${ampm}`;
    };

    const start = best.bin;
    const end = start + 0.5;
    return { label: `${fmtTime(start)}–${fmtTime(end)}`, mean: best.mean, n: best.total };
  };

  // ------------- 1) primary trends -------------
  // If yearly slopegraph is present, use it
  if (Array.isArray(slopegraphData) && slopegraphData.length){
    let hrvPillShown = false;
    slopegraphData.forEach(item => {
      if (!isNum(item.pctChange)) return;
      const delta = (item.pctChange >= 0 ? '+' : '') + item.pctChange.toFixed(1) + '%';
      const good = item.metric === 'RHR' ? (item.pctChange < 0) : (item.pctChange >= 0);
      const metricLower = String(item.metric).toLowerCase();
      if (metricLower === 'hrv') {
        const absPct = Math.abs(item.pctChange).toFixed(1);
        const __hr = (extra && extra.filteredHRV) ? extra.filteredHRV : [];
        let __min='9999-99-99', __max='0000-00-00';
        __hr.forEach(r=>{ const d=r&&(r.dateISO||(r.date instanceof Date?r.date.toISOString().slice(0,10):null)); if(!d)return; if(d<__min)__min=d; if(d>__max)__max=d; });
        const __range = (__min==='9999-99-99'||__max==='0000-00-00') ? '' : `${__min} and ${__max}`;
        const tip = __range
          ? `Your HRV has ${item.pctChange >= 0 ? 'increased' : 'decreased'} by ${absPct}% between ${__range}. Higher HRV generally indicates better recovery.`
          : `Your HRV has ${item.pctChange >= 0 ? 'increased' : 'decreased'} by ${absPct}%. Higher HRV generally indicates better recovery.`;
        el.innerHTML += pill(`HRV ${delta}`, good ? 'good' : 'bad', tip);
        hrvPillShown = true;
      } else {
        el.innerHTML += pill(`${item.metric} ${delta}`, good ? 'good' : 'bad');
      }
      added.push(1);
    });
    // Ensure an HRV delta pill is present even if slopegraph lacked it
    if (!hrvPillShown) {
      const { filteredHRV = [] } = extra || {};
      const series = filteredHRV.map(r => r.rmssd).filter(Number.isFinite);
      if (series.length >= 2) {
        const s = series[0];
        const e = series[series.length - 1];
        if (Number.isFinite(s) && s !== 0 && Number.isFinite(e)) {
          const pct = ((e - s) / s) * 100;
          const delta = (pct >= 0 ? '+' : '') + pct.toFixed(1) + '%';
          let __min='9999-99-99', __max='0000-00-00';
          filteredHRV.forEach(r=>{ const d=r&&(r.dateISO||(r.date instanceof Date?r.date.toISOString().slice(0,10):null)); if(!d)return; if(d<__min)__min=d; if(d>__max)__max=d; });
          const __range = (__min==='9999-99-99'||__max==='0000-00-00') ? '' : `${__min} and ${__max}`;
          const tip = __range
            ? `Your HRV has ${pct >= 0 ? 'increased' : 'decreased'} by ${Math.abs(pct).toFixed(1)}% between ${__range}. Higher HRV generally indicates better recovery.`
            : `Your HRV has ${pct >= 0 ? 'increased' : 'decreased'} by ${Math.abs(pct).toFixed(1)}%. Higher HRV generally indicates better recovery.`;
          el.innerHTML += pill(`HRV ${delta}`, pct >= 0 ? 'good' : 'bad', tip);
          added.push(1);
        }
      }
    }
   } else {
    // Fallback: compute trends inside the current window
    const { filteredSleep=[], filteredHRV=[], filteredRHR=[], filteredSteps=[] } = extra || {};
    const addWin = (label, series, goodWhenUp=true, invert=false) => {
      const t = winTrend(series);
      if (!t) return;
      const pct = invert ? -t.pct : t.pct;
      const good = goodWhenUp ? pct >= 0 : pct < 0;
      el.innerHTML += pill(`${label} ${(pct>=0?'+':'')}${pct.toFixed(1)}%`, good ? 'good' : 'bad');
      added.push(1);
    };
    addWin('Sleep Score',     filteredSleep.map(r=>r.sleepScore), true);
    addWin('Minutes Asleep',  filteredSleep.map(r=>r.minutesAsleep), true);
    // HRV trend pill with fallback for short series
    (function(){
      const series = filteredHRV.map(r=>r.rmssd).filter(Number.isFinite);
      const t = winTrend(series);
      if (t) {
        const pct = t.pct;
        const delta = (pct>=0?'+':'') + pct.toFixed(1) + '%';
        let __min='9999-99-99', __max='0000-00-00';
        filteredHRV.forEach(r=>{ const d=r&&(r.dateISO||(r.date instanceof Date?r.date.toISOString().slice(0,10):null)); if(!d)return; if(d<__min)__min=d; if(d>__max)__max=d; });
        const __range = (__min==='9999-99-99'||__max==='0000-00-00') ? '' : `${__min} and ${__max}`;
        const tip = __range
          ? `Your HRV has ${pct >= 0 ? 'increased' : 'decreased'} by ${Math.abs(pct).toFixed(1)}% between ${__range}. Higher HRV generally indicates better recovery.`
          : `Your HRV has ${pct >= 0 ? 'increased' : 'decreased'} by ${Math.abs(pct).toFixed(1)}%. Higher HRV generally indicates better recovery.`;
        el.innerHTML += pill(`HRV ${delta}`, pct >= 0 ? 'good' : 'bad', tip);
        added.push(1);
      } else if (series.length >= 2) {
        const s = series[0];
        const e = series[series.length-1];
        if (s && Number.isFinite(s) && Number.isFinite(e)){
          const pct = ((e - s) / s) * 100;
          const delta = (pct>=0?'+':'') + pct.toFixed(1) + '%';
          let __min='9999-99-99', __max='0000-00-00';
          filteredHRV.forEach(r=>{ const d=r&&(r.dateISO||(r.date instanceof Date?r.date.toISOString().slice(0,10):null)); if(!d)return; if(d<__min)__min=d; if(d>__max)__max=d; });
          const __range = (__min==='9999-99-99'||__max==='0000-00-00') ? '' : `${__min} and ${__max}`;
          const tip = __range
            ? `Your HRV has ${pct >= 0 ? 'increased' : 'decreased'} by ${Math.abs(pct).toFixed(1)}% between ${__range}. Higher HRV generally indicates better recovery.`
            : `Your HRV has ${pct >= 0 ? 'increased' : 'decreased'} by ${Math.abs(pct).toFixed(1)}%. Higher HRV generally indicates better recovery.`;
          el.innerHTML += pill(`HRV ${delta}`, pct >= 0 ? 'good' : 'bad', tip);
          added.push(1);
        }
      }
    })();
    addWin('RHR',             filteredRHR.map(r=>r.rhr), false, true); // lower is better
    addWin('Steps',           filteredSteps.map(r=>r.steps), true);
  }
  
  // Sedentary trend - always run regardless of slopegraph data
  (function(){
    const { filteredSteps=[] } = extra || {};
    const sedentarySeries = filteredSteps.map(r=>r.sedentaryMinutes).filter(Number.isFinite);
    const t = winTrend(sedentarySeries);
    if (t) {
      const pct = -t.pct; // invert because lower is better
      const good = pct < 0; // negative change is good
      const tooltip = `Sedentary time has ${pct >= 0 ? 'increased' : 'decreased'} by ${Math.abs(pct).toFixed(1)}%`;
      el.innerHTML += pill(`Sedentary ${(pct>=0?'+':'')}${pct.toFixed(1)}%`, good ? 'good' : 'bad', tooltip);
      added.push(1);
    }
  })();

  // ------------- 2) consistency & recovery -------------
  const cvRow = pick('Consistency', 'cv');
  if (cvRow) {
    const val = parseFloat(cvRow.Value);
    const percentage = isNum(val) ? (val * 100).toFixed(0) : cvRow.Value;
    const tooltip = `Your sleep duration varies by ${percentage}% on average - lower values mean more consistent sleep times`;
    el.innerHTML += pill(`Sleep Variation ${percentage}%`, isNum(val) ? (val < 0.25 ? 'good' : 'bad') : 'neutral', tooltip);
    added.push(1);
  }

  const rebound = pick('Recovery', 'rebound');
  if (rebound) {
    const days = parseInt((rebound.Value.match(/\d+/)||[])[0] || '999', 10);
    const tooltip = `It takes you a median of ${days} day${days !== 1 ? 's' : ''} to recover from low HRV episodes back to normal levels`;
    el.innerHTML += pill(`HRV rebound ${rebound.Value}`, 'yellow', tooltip);
    added.push(1);
  }

  // ------------- 3) recipe hit-rates -------------
  const prob75 = analytics.find(r => r.Section==='Recipe probabilities' && r.Metric.includes('score≥75'));
  const prob80 = analytics.find(r => r.Section==='Recipe probabilities' && r.Metric.includes('score≥80'));
  const probHRV = analytics.find(r => r.Section==='Recipe probabilities' && r.Metric.includes('next-day HRV'));
  
  if (prob75) { 
    const tooltip = `When you sleep 7+ hours, you get a good sleep score (75+) only ${prob75.Value} of the time`;
    el.innerHTML += pill(`${prob75.Metric} ${prob75.Value}`, 'blue', tooltip); 
    added.push(1); 
  }
  if (prob80) { 
    const tooltip = `When you sleep 7.5+ hours, you get an excellent sleep score (80+) only ${prob80.Value} of the time`;
    el.innerHTML += pill(`${prob80.Metric} ${prob80.Value}`, 'blue', tooltip); 
    added.push(1); 
  }
  if (probHRV) {
    const tooltip = `When you get 30%+ deep+REM sleep, you have above-median HRV (good recovery) the next day ${probHRV.Value} of the time`;
    el.innerHTML += pill(`${probHRV.Metric} ${probHRV.Value}`, 'blue', tooltip);
    added.push(1);
  }

  // ------------- 3.5) optimal sleep duration (based on efficiency) -------------
  const { filteredSleep=[] } = extra || {};
  if (filteredSleep.length > 0) {
    // Find optimal duration for high efficiency (85%+)
    const optimal85 = findOptimalSleepDuration(filteredSleep, 85);
    if (false && optimal85) {
      const tooltip = `Your best sleep duration range for achieving 85%+ efficiency is ${optimal85.range} hours with ${optimal85.rate}% success rate`;
      el.innerHTML += pill(`Optimal sleep: ${optimal85.range}h → 85%+ efficiency (${optimal85.rate}%)`, 'yellow', tooltip);
      added.push(1);
    }
    
    // Find optimal duration for very high efficiency (90%+)
    const optimal90 = findOptimalSleepDuration(filteredSleep, 90);
    if (false && optimal90) {
      const tooltip = `Your best sleep duration range for achieving 90%+ efficiency is ${optimal90.range} hours with ${optimal90.rate}% success rate`;
      el.innerHTML += pill(`Best duration: ${optimal90.range}h → 90%+ efficiency (${optimal90.rate}%)`, 'blue', tooltip);
      added.push(1);
    }

    // Best duration by highest average sleep score (1h sliding window)
    const bestScoreDur = findBestDurationByScore(filteredSleep, 1.0, 0.25, 15);
    if (bestScoreDur) {
      const tooltip = `Highest average sleep score in 1h sliding windows (step 0.25h); based on ${bestScoreDur.n} nights in the peak window`;
      el.innerHTML += pill(`Best duration: ${bestScoreDur.range}h → highest avg score ${bestScoreDur.mean.toFixed(1)}`, 'blue', tooltip);
      added.push(1);
    }
  }

  // 3.6) optimal bedtime window (based on highest average sleep score)
  if (filteredSleep.length > 0 && (typeof sleepUsesBedtimeDate === 'undefined' || sleepUsesBedtimeDate)) {
    const bestBed = findOptimalBedtimeWindow(filteredSleep, 5);
    if (bestBed) {
      const tooltip = `Highest average sleep score in 30-min bins; based on ${bestBed.n} nights in the peak bin; considers bedtimes 6 PM–6 AM`;
      el.innerHTML += pill(`Best bedtime: ${bestBed.label} avg score ${bestBed.mean.toFixed(1)}`, 'blue', tooltip);
      added.push(1);
    }
  }

  // ------------- 4) correlations (gate weak) -------------
  const corrSleepHRV = pick('Load–recovery', 'sleep score');
  if (corrSleepHRV) {
    const r = Math.abs(parsePearson(corrSleepHRV.Value));
    if (r >= 0.2) { el.innerHTML += pill(`Sleep↔HRV ${corrSleepHRV.Value}`, 'neutral'); added.push(1); }
  }
  const corrStepsHRV = pick('Load–recovery', 'prev-day steps');
  if (corrStepsHRV) {
    const r = Math.abs(parsePearson(corrStepsHRV.Value));
    if (r >= 0.2) { el.innerHTML += pill(`Steps↔HRV ${corrStepsHRV.Value}`, 'neutral'); added.push(1); }
  }

  // ------------- 5) seasonality quick hit -------------
  const bestScore = analytics.find(r => r.Section==='Seasonality' && r.Metric.toLowerCase().includes('best month for sleepscore'));
  if (bestScore) { 
    const tooltip = bestScore.Tooltip || '';
    el.innerHTML += pill(`Best month (sleep) ${bestScore.Value}`, 'blue', tooltip); 
    added.push(1); 
  }

  // ------------- 6) CUSUM shifts -------------
  const rhrShift = analytics.find(r => r.Section==='CUSUM' && r.Metric.includes('RHR'));
  if (rhrShift) {
    const isUp = rhrShift.Value.toLowerCase().includes('up');
    const color = isUp ? 'bad' : 'good'; // RHR up = bad, RHR down = good
    const tip = `CUSUM detected a sustained change in resting heart rate (${rhrShift.Value}). Lower RHR is better; a downward shift suggests improvement.`;
    el.innerHTML += pill(`RHR shift ${rhrShift.Value}`, color, tip);
    added.push(1);
  }
  const hrvShift = analytics.find(r => r.Section==='CUSUM' && r.Metric.includes('HRV'));
  if (hrvShift) {
    const isUp = hrvShift.Value.toLowerCase().includes('up');
    const color = isUp ? 'good' : 'bad'; // HRV up = good, HRV down = bad
    const tip = `CUSUM detected a sustained change in HRV (${hrvShift.Value}). Higher HRV is better; an upward shift suggests improved recovery.`;
    el.innerHTML += pill(`HRV shift ${hrvShift.Value}`, color, tip);
    added.push(1);
  }

  // Show/hide bar entirely
  if (added.length) {
    el.classList.remove('hidden');
    el.style.display = 'flex';
  } else {
    el.classList.add('hidden');
    el.style.display = 'none';
  }
}

function hideAnalyticsBadges(){
  const el = document.getElementById('analyticsBadges');
  if(!el) return;
  el.innerHTML = '';
  el.classList.add('hidden');
  el.style.display = 'none';
}

// Linear regression calculation
function calculateLinearRegression(data) {
  if (data.length < 2) return null;
  const n = data.length;
  const sumX = data.reduce((sum, d) => sum + d.x, 0);
  const sumY = data.reduce((sum, d) => sum + d.y, 0);
  const sumXY = data.reduce((sum, d) => sum + d.x * d.y, 0);
  const sumXX = data.reduce((sum, d) => sum + d.x * d.x, 0);
  const slope = (n * sumXY - sumX * sumY) / (n * sumXX - sumX * sumX);
  const intercept = (sumY - slope * sumX) / n;
  return { slope, intercept };
}

// Correlation Matrix Functions
function computeCorrelationMatrix(sleepData, hrvData, stepsData, rhrData) {
  // Create a map of all available dates across all datasets
  const allDates = new Set();
  
  sleepData.forEach(d => allDates.add(d.dateISO));
  hrvData.forEach(d => allDates.add(d.dateISO));
  stepsData.forEach(d => allDates.add(d.dateISO));
  rhrData.forEach(d => allDates.add(d.dateISO));
  
  const sortedDates = Array.from(allDates).sort();
  
  // Create aligned datasets for correlation calculation
  const alignedData = [];
  
  for (const date of sortedDates) {
    const sleep = sleepData.find(d => d.dateISO === date);
    const hrv = hrvData.find(d => d.dateISO === date);
    const steps = stepsData.find(d => d.dateISO === date);
    const rhr = rhrData.find(d => d.dateISO === date);
    
    if (sleep && hrv && steps && rhr) {
      alignedData.push({
        date: date,
        sleepScore: sleep.sleepScore,
        minutesAsleep: sleep.minutesAsleep,
        efficiency: sleep.efficiency,
        pctDeep: sleep.pctDeep,
        pctREM: sleep.pctREM,
        pctLight: sleep.pctLight,
        hrv: hrv.rmssd,
        steps: steps.steps,
        rhr: rhr.rhr,
        sedentaryMinutes: steps.sedentaryMinutes
      });
    }
  }
  
  if (alignedData.length < 3) {
    return { error: 'Insufficient data for correlation analysis' };
  }
  
  // Define metrics for correlation matrix
  // Note: sedentaryMinutes values of 1440 (24 hours) are already converted to NaN in normalizeStepsRows()
  // to indicate days when the watch was not worn, and will be filtered out during correlation calculation
  const metrics = [
    { key: 'sleepScore', label: 'Sleep Score', data: alignedData.map(d => d.sleepScore) },
    { key: 'minutesAsleep', label: 'Minutes Asleep', data: alignedData.map(d => d.minutesAsleep) },
    { key: 'efficiency', label: 'Sleep Efficiency', data: alignedData.map(d => d.efficiency) },
    { key: 'pctDeep', label: 'Deep Sleep %', data: alignedData.map(d => d.pctDeep) },
    { key: 'pctREM', label: 'REM Sleep %', data: alignedData.map(d => d.pctREM) },
    { key: 'pctLight', label: 'Light Sleep %', data: alignedData.map(d => d.pctLight) },
    { key: 'hrv', label: 'HRV (RMSSD)', data: alignedData.map(d => d.hrv) },
    { key: 'steps', label: 'Steps', data: alignedData.map(d => d.steps) },
    { key: 'rhr', label: 'Resting HR', data: alignedData.map(d => d.rhr) },
    { key: 'sedentaryMinutes', label: 'Sedentary Minutes', data: alignedData.map(d => d.sedentaryMinutes) }
  ];
  
  // Calculate correlation matrix
  const correlationMatrix = [];
  const labels = metrics.map(m => m.label);
  
  // Debug: Log data quality for each metric
  console.log('Correlation Matrix Data Quality Check:');
  metrics.forEach((metric, idx) => {
    const validValues = metric.data.filter(val => typeof val === 'number' && !isNaN(val) && isFinite(val));
    const invalidCount = metric.data.length - validValues.length;
    console.log(`${metric.label}: ${validValues.length} valid values, ${invalidCount} invalid values`);
    if (validValues.length > 0) {
      console.log(`  Range: ${Math.min(...validValues).toFixed(2)} to ${Math.max(...validValues).toFixed(2)}`);
    }
  });
  
  for (let i = 0; i < metrics.length; i++) {
    const row = [];
    for (let j = 0; j < metrics.length; j++) {
      if (i === j) {
        row.push(1.0); // Perfect correlation with itself
      } else {
        const correlation = calculatePearsonCorrelation(metrics[i].data, metrics[j].data);
        row.push(correlation);
        
        // Debug: Log problematic correlations
        if (isNaN(correlation)) {
          console.warn(`NaN correlation between ${metrics[i].label} and ${metrics[j].label}`);
        }
      }
    }
    correlationMatrix.push(row);
  }
  
  return {
    labels: labels,
    matrix: correlationMatrix,
    dataPoints: alignedData.length,
    dateRange: {
      from: sortedDates[0],
      to: sortedDates[sortedDates.length - 1]
    }
  };
}

function calculatePearsonCorrelation(x, y) {
  if (x.length !== y.length || x.length === 0) return 0;
  
  // Filter out invalid values (NaN, null, undefined, non-finite)
  const validPairs = [];
  for (let i = 0; i < x.length; i++) {
    const xVal = x[i];
    const yVal = y[i];
    if (typeof xVal === 'number' && typeof yVal === 'number' && 
        !isNaN(xVal) && !isNaN(yVal) && 
        isFinite(xVal) && isFinite(yVal)) {
      validPairs.push({ x: xVal, y: yVal });
    }
  }
  
  if (validPairs.length < 2) return 0; // Need at least 2 valid pairs
  
  const n = validPairs.length;
  const sumX = validPairs.reduce((sum, pair) => sum + pair.x, 0);
  const sumY = validPairs.reduce((sum, pair) => sum + pair.y, 0);
  const sumXY = validPairs.reduce((sum, pair) => sum + pair.x * pair.y, 0);
  const sumXX = validPairs.reduce((sum, pair) => sum + pair.x * pair.x, 0);
  const sumYY = validPairs.reduce((sum, pair) => sum + pair.y * pair.y, 0);
  
  const numerator = n * sumXY - sumX * sumY;
  const denominator = Math.sqrt((n * sumXX - sumX * sumX) * (n * sumYY - sumY * sumY));
  
  if (denominator === 0) return 0;
  
  const correlation = numerator / denominator;
  
  // Additional validation
  if (isNaN(correlation) || !isFinite(correlation)) {
    console.warn('Invalid correlation calculated:', { x, y, validPairs, numerator, denominator });
    return 0;
  }
  
  return correlation;
}

function generatePredictions() {
  const sleepN = normalizeSleepRows(rawSleep);
  const filtered = filterSleep(sleepN);
  const hrv = tryLoadHRV();
  const steps = tryLoadSteps();
  const rhr = tryLoadRHR();
  
  const from = document.getElementById('dateFrom').value;
  const to = document.getElementById('dateTo').value;
  
  // Filter data by date range
  const filteredSleep = filtered.filter(r => {
    if (from && r.dateISO < from) return false;
    if (to && r.dateISO > to) return false;
    return true;
  });
  
  const filteredHRV = hrv ? hrv.filter(r => {
    if (from && r.dateISO < from) return false;
    if (to && r.dateISO > to) return false;
    return true;
  }) : [];
  
  const filteredSteps = steps ? steps.filter(r => {
    if (from && r.dateISO < from) return false;
    if (to && r.dateISO > to) return false;
    return true;
  }) : [];
  
  const filteredRHR = rhr ? rhr.filter(r => {
    if (from && r.dateISO < from) return false;
    if (to && r.dateISO > to) return false;
    return true;
  }) : [];
  
  if (filteredSleep.length < 7) {
    return {
      error: 'Insufficient data for predictions (need at least 7 days)',
      dataPoints: filteredSleep.length
    };
  }
  
  const predictions = [];
  
  // Sleep Score Predictions
  const recentSleepScores = filteredSleep.slice(-14).map(r => r.sleepScore).filter(Number.isFinite);
  if (recentSleepScores.length >= 7) {
    const avgSleepScore = recentSleepScores.reduce((a, b) => a + b, 0) / recentSleepScores.length;
    const trend = calculateTrend(recentSleepScores);
    const predictedScore = Math.max(0, Math.min(100, avgSleepScore + trend * 7));
    
    predictions.push({
      metric: 'Sleep Score',
      current: avgSleepScore.toFixed(1),
      predicted: predictedScore.toFixed(1),
      trend: trend > 0 ? 'Improving' : trend < 0 ? 'Declining' : 'Stable',
      confidence: Math.min(95, Math.max(60, recentSleepScores.length * 5)),
      insight: getSleepInsight(predictedScore, avgSleepScore)
    });
  }
  
  // HRV Predictions
  const recentHRV = filteredHRV.slice(-14).map(r => r.rmssd).filter(Number.isFinite);
  if (recentHRV.length >= 7) {
    const avgHRV = recentHRV.reduce((a, b) => a + b, 0) / recentHRV.length;
    const trend = calculateTrend(recentHRV);
    const predictedHRV = Math.max(0, avgHRV + trend * 7);
    
    predictions.push({
      metric: 'HRV (RMSSD)',
      current: avgHRV.toFixed(1),
      predicted: predictedHRV.toFixed(1),
      trend: trend > 0 ? 'Improving' : trend < 0 ? 'Declining' : 'Stable',
      confidence: Math.min(95, Math.max(60, recentHRV.length * 5)),
      insight: getHRVInsight(predictedHRV, avgHRV)
    });
  }
  
  // Steps Predictions
  const recentSteps = filteredSteps.slice(-14).map(r => r.steps).filter(Number.isFinite);
  if (recentSteps.length >= 7) {
    const avgSteps = recentSteps.reduce((a, b) => a + b, 0) / recentSteps.length;
    const trend = calculateTrend(recentSteps);
    const predictedSteps = Math.max(0, avgSteps + trend * 7);
    
    predictions.push({
      metric: 'Daily Steps',
      current: Math.round(avgSteps).toLocaleString(),
      predicted: Math.round(predictedSteps).toLocaleString(),
      trend: trend > 0 ? 'Increasing' : trend < 0 ? 'Decreasing' : 'Stable',
      confidence: Math.min(95, Math.max(60, recentSteps.length * 5)),
      insight: getStepsInsight(predictedSteps, avgSteps)
    });
  }
  
  // RHR Predictions
  const recentRHR = filteredRHR.slice(-14).map(r => r.rhr).filter(Number.isFinite);
  if (recentRHR.length >= 7) {
    const avgRHR = recentRHR.reduce((a, b) => a + b, 0) / recentRHR.length;
    const trend = calculateTrend(recentRHR);
    const predictedRHR = Math.max(40, avgRHR + trend * 7);
    
    predictions.push({
      metric: 'Resting HR',
      current: avgRHR.toFixed(1),
      predicted: predictedRHR.toFixed(1),
      trend: trend < 0 ? 'Improving' : trend > 0 ? 'Increasing' : 'Stable',
      confidence: Math.min(95, Math.max(60, recentRHR.length * 5)),
      insight: getRHRInsight(predictedRHR, avgRHR)
    });
  }
  
  // Weekly Pattern Predictions
  const weeklyPattern = analyzeWeeklyPatterns(filteredSleep, filteredHRV, filteredSteps, filteredRHR);
  if (weeklyPattern) {
    predictions.push(weeklyPattern);
  }
  
  // Health Risk Assessment
  const riskAssessment = assessHealthRisks(predictions);
  if (riskAssessment) {
    predictions.push(riskAssessment);
  }
  
  return {
    predictions,
    dataPoints: Math.min(filteredSleep.length, filteredHRV.length, filteredSteps.length, filteredRHR.length),
    generatedAt: new Date().toISOString()
  };
}

function calculateTrend(data) {
  if (data.length < 2) return 0;
  const n = data.length;
  const sumX = (n * (n - 1)) / 2;
  const sumY = data.reduce((a, b) => a + b, 0);
  const sumXY = data.reduce((sum, y, x) => sum + x * y, 0);
  const sumXX = (n * (n - 1) * (2 * n - 1)) / 6;
  
  const slope = (n * sumXY - sumX * sumY) / (n * sumXX - sumX * sumX);
  return slope;
}

function getSleepInsight(predicted, current) {
  const diff = predicted - current;
  if (diff > 5) return 'Sleep quality is improving significantly';
  if (diff > 2) return 'Sleep quality is improving moderately';
  if (diff < -5) return 'Sleep quality may be declining';
  if (diff < -2) return 'Sleep quality is slightly declining';
  return 'Sleep quality is stable';
}

function getHRVInsight(predicted, current) {
  const diff = predicted - current;
  if (diff > 5) return 'Recovery capacity is improving';
  if (diff > 2) return 'Recovery capacity is slightly improving';
  if (diff < -5) return 'Recovery capacity may be declining';
  if (diff < -2) return 'Recovery capacity is slightly declining';
  return 'Recovery capacity is stable';
}

function getStepsInsight(predicted, current) {
  const diff = predicted - current;
  if (diff > 1000) return 'Activity level is increasing significantly';
  if (diff > 500) return 'Activity level is increasing moderately';
  if (diff < -1000) return 'Activity level may be decreasing';
  if (diff < -500) return 'Activity level is slightly decreasing';
  return 'Activity level is stable';
}

function getRHRInsight(predicted, current) {
  const diff = predicted - current;
  if (diff < -3) return 'Cardiovascular fitness is improving';
  if (diff < -1) return 'Cardiovascular fitness is slightly improving';
  if (diff > 3) return 'Cardiovascular fitness may be declining';
  if (diff > 1) return 'Cardiovascular fitness is slightly declining';
  return 'Cardiovascular fitness is stable';
}

function analyzeWeeklyPatterns(sleep, hrv, steps, rhr) {
  if (sleep.length < 14) return null;
  
  const dayOfWeek = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const patterns = [];
  
  // Analyze sleep patterns by day of week
  const sleepByDay = {};
  sleep.forEach(r => {
    const day = new Date(r.dateISO).getDay();
    if (!sleepByDay[day]) sleepByDay[day] = [];
    sleepByDay[day].push(r.sleepScore);
  });
  
  let bestDay = 0, worstDay = 0;
  let bestScore = 0, worstScore = 100;
  
  for (let day = 0; day < 7; day++) {
    if (sleepByDay[day] && sleepByDay[day].length > 0) {
      const avgScore = sleepByDay[day].reduce((a, b) => a + b, 0) / sleepByDay[day].length;
      if (avgScore > bestScore) {
        bestScore = avgScore;
        bestDay = day;
      }
      if (avgScore < worstScore) {
        worstScore = avgScore;
        worstDay = day;
      }
    }
  }
  
  return {
    metric: 'Weekly Sleep Pattern',
    current: `${dayOfWeek[bestDay]} (${bestScore.toFixed(1)})`,
    predicted: `${dayOfWeek[worstDay]} (${worstScore.toFixed(1)})`,
    trend: 'Weekly Cycle',
    confidence: 85,
    insight: `Best sleep: ${dayOfWeek[bestDay]}, Challenging: ${dayOfWeek[worstDay]}`
  };
}

function assessHealthRisks(predictions) {
  let riskScore = 0;
  let riskFactors = [];
  
  predictions.forEach(p => {
    if (p.metric === 'Sleep Score' && parseFloat(p.predicted) < 70) {
      riskScore += 2;
      riskFactors.push('Poor sleep quality predicted');
    }
    if (p.metric === 'HRV (RMSSD)' && parseFloat(p.predicted) < 30) {
      riskScore += 2;
      riskFactors.push('Low recovery capacity predicted');
    }
    if (p.metric === 'Resting HR' && parseFloat(p.predicted) > 80) {
      riskScore += 1;
      riskFactors.push('Elevated resting heart rate predicted');
    }
    if (p.metric === 'Daily Steps' && parseInt(p.predicted.replace(/,/g, '')) < 5000) {
      riskScore += 1;
      riskFactors.push('Low activity level predicted');
    }
  });
  
  let riskLevel = 'Low';
  if (riskScore >= 4) riskLevel = 'High';
  else if (riskScore >= 2) riskLevel = 'Moderate';
  
  return {
    metric: 'Health Risk',
    current: riskFactors.length > 0 ? riskFactors.join(', ') : 'No immediate concerns',
    predicted: riskLevel,
    trend: riskScore > 0 ? 'Monitor' : 'Stable',
    confidence: 75,
    insight: (riskScore > 0) ? 'Prioritize recovery' : (riskLevel === 'High' ? 'Consider lifestyle adjustments' : 'Continue current habits')
  };
}

function createPredictionsChart(predictionsData) {
  if (predictionsData.error) {
    return createMessageChart(predictionsData.error);
  }
  
  // Create a custom HTML display for predictions
  const container = document.createElement('div');
  container.className = 'predictions-container';
  const isSmall = Math.min(window.innerWidth||0, (window.screen&&window.screen.width)||0) <= 768;
  container.style.cssText = `
    background: #0b1020;
    border-radius: 12px;
    padding: ${isSmall ? 12 : 20}px;
    margin: 12px 0;
    border: 1px solid #1a2349;
  `;
  
  // Title removed as requested
  
  // Create predictions grid
  const grid = document.createElement('div');
  grid.style.cssText = `
    display: grid;
    grid-template-columns: ${isSmall ? '1fr' : 'repeat(auto-fit, minmax(280px, 1fr))'};
    gap: ${isSmall ? 10 : 16}px;
    margin-bottom: ${isSmall ? 12 : 20}px;
  `;
  
  predictionsData.predictions.forEach(prediction => {
    const card = document.createElement('div');
    card.style.cssText = `
      background: #0e1530;
      border-radius: 8px;
      padding: ${isSmall ? 12 : 16}px;
      border: 1px solid #263266;
    `;
    
    const metric = document.createElement('div');
    metric.textContent = prediction.metric;
    metric.style.cssText = `
      color: #e6eaf3;
      font-size: ${isSmall ? 15 : 16}px;
      font-weight: 600;
      margin-bottom: ${isSmall ? 8 : 12}px;
    `;
    card.appendChild(metric);
    
    const current = document.createElement('div');
    // Highlight weekday colors for Weekly Sleep Pattern (Best=green)
    if (prediction.metric === 'Weekly Sleep Pattern') {
      const curText = String(prediction.current || '');
      const curDay = curText.split(' (')[0];
      const curRest = curText.slice(curDay.length);
      current.innerHTML = `<strong>Best:</strong> <span style="color:#4CAF50">${curDay}</span>${curRest}`;
    } else {
    current.innerHTML = `<strong>Current:</strong> ${prediction.current}`;
    }
    current.style.cssText = `color: #a9b3d8; margin-bottom: ${isSmall ? 6 : 8}px; font-size: ${isSmall ? 13 : 14}px;`;
    card.appendChild(current);
    
    const predicted = document.createElement('div');
    if (prediction.metric === 'Weekly Sleep Pattern') {
      const predText = String(prediction.predicted || '');
      const predDay = predText.split(' (')[0];
      const predRest = predText.slice(predDay.length);
      predicted.innerHTML = `<strong>Worst:</strong> <span style="color:#f44336">${predDay}</span>${predRest}`;
    } else {
    predicted.innerHTML = `<strong>Predicted:</strong> ${prediction.predicted}`;
    }
    predicted.style.cssText = `color: #a9b3d8; margin-bottom: ${isSmall ? 6 : 8}px; font-size: ${isSmall ? 13 : 14}px;`;
    card.appendChild(predicted);
    
    const trend = document.createElement('div');
    let trendColor = '#ffc107'; // Default yellow for stable
    
    if (prediction.metric === 'Resting HR') {
      // For RHR: Increasing is bad (red), Improving is good (green)
      trendColor = prediction.trend.includes('Improving') ? '#4CAF50' : 
                   prediction.trend.includes('Increasing') ? '#f44336' : '#ffc107';
    } else {
      // For other metrics: Improving/Increasing is good (green), Declining/Decreasing is bad (red)
      trendColor = prediction.trend.includes('Improving') || prediction.trend.includes('Increasing') ? '#4CAF50' : 
                   prediction.trend.includes('Declining') || prediction.trend.includes('Decreasing') ? '#f44336' : '#ffc107';
    }
    
    // Health Risk badge: show Stable as green
    if (prediction.metric === 'Health Risk' && prediction.trend === 'Stable') {
      trendColor = '#4CAF50';
    }
    // Weekly Sleep Pattern: keep trend color same as other text (not yellow)
    if (prediction.metric === 'Weekly Sleep Pattern' && prediction.trend === 'Weekly Cycle') {
      trendColor = '#a9b3d8';
    }
    trend.innerHTML = `<strong>Trend:</strong> <span style="color: ${trendColor}">${prediction.trend}</span>`;
    trend.style.cssText = `color: #a9b3d8; margin-bottom: ${isSmall ? 6 : 8}px; font-size: ${isSmall ? 13 : 14}px;`;
    card.appendChild(trend);
    
    const confidence = document.createElement('div');
    confidence.innerHTML = `<strong>Confidence:</strong> ${prediction.confidence}%`;
    confidence.style.cssText = `color: #9aa5c6; margin-bottom: ${isSmall ? 6 : 8}px; font-size: ${isSmall ? 11 : 12}px;`;
    card.appendChild(confidence);
    
    const insight = document.createElement('div');
    insight.textContent = prediction.insight;
    insight.style.cssText = `
      color: #e6eaf3;
      font-style: italic;
      font-size: ${isSmall ? 12 : 13}px;
      margin-top: ${isSmall ? 6 : 8}px;
      padding-top: ${isSmall ? 6 : 8}px;
      border-top: 1px solid #263266;
    `;
    card.appendChild(insight);
    
    grid.appendChild(card);
  });
  
  container.appendChild(grid);
  
  // Multi-profile widgets (only if more than one profile exists)
  (async function buildMultiProfileSection(){
    try{
      const profilesUrl = `${BASE_PREFIX}profiles/index.json`;
      const resp = await fetch(profilesUrl, { cache: 'no-store' });
      if(!resp.ok){
        const info = document.createElement('div');
        info.className = 'muted';
        info.style.cssText = 'margin-top:8px;font-size:12px;color:#9aa5c6';
        info.textContent = 'Family Insights unavailable: could not load profiles/index.json';
        container.appendChild(info);
        return;
      }
      const ids = await resp.json();
      if(!Array.isArray(ids) || ids.length < 2){
        const info = document.createElement('div');
        info.className = 'muted';
        info.style.cssText = 'margin-top:8px;font-size:12px;color:#9aa5c6';
        info.textContent = 'Family Insights require at least two profiles in profiles/index.json';
        container.appendChild(info);
        return;
      }

      // Section container
      const mp = document.createElement('div');
      const __isSmall = Math.min(window.innerWidth||0, (window.screen&&window.screen.width)||0) <= 768;
      mp.style.cssText = `margin-top:${__isSmall?12:20}px;padding:${__isSmall?12:16}px;border:1px solid #263266;border-radius:10px;background:#0e1530;`;

      const title = document.createElement('div');
      title.textContent = 'Family Insights';
      title.style.cssText = `font-weight:600;font-size:16px;color:#e6eaf3;margin-bottom:12px;`;
      mp.appendChild(title);

      // Picker row
      const picker = document.createElement('div');
      picker.style.cssText = `display:flex;gap:${__isSmall?8:12}px;flex-wrap:wrap;align-items:center;margin-bottom:${__isSmall?8:12}px;`;
      const selA = document.createElement('select');
      const selB = document.createElement('select');
      [selA, selB].forEach(sel=>{
        sel.style.cssText = `background:#0e1530;color:#e6eaf3;border:1px solid #263266;border-radius:8px;padding:8px;min-width:${__isSmall?120:160}px;`;
        ids.forEach(id=>{ const o=document.createElement('option'); o.value=id; o.textContent=id; sel.appendChild(o) });
      });
      selA.value = ids[0];
      selB.value = ids[1];
      const labA = document.createElement('label'); labA.textContent = 'User A'; labA.style.cssText='font-size:12px;color:#a9b3d8';
      const labB = document.createElement('label'); labB.textContent = 'User B'; labB.style.cssText='font-size:12px;color:#a9b3d8';
      const wrapA = document.createElement('div'); wrapA.style.cssText='display:flex;flex-direction:column;gap:6px'; wrapA.append(labA, selA);
      const wrapB = document.createElement('div'); wrapB.style.cssText='display:flex;flex-direction:column;gap:6px'; wrapB.append(labB, selB);
      picker.append(wrapA, wrapB);
      mp.appendChild(picker);

      // Cards container
      const cards = document.createElement('div');
      cards.style.cssText = `display:grid;grid-template-columns:${__isSmall?'1fr':'repeat(auto-fit, minmax(260px, 1fr))'};gap:${__isSmall?8:12}px;`;
      mp.appendChild(cards);

      container.appendChild(mp);

      async function fetchProfileData(pid){
        async function safeFetch(path){ try{ const t=await fetchCSV(path); return parseCSV(t); }catch(_){ return [] } }
        const base = `${BASE_PREFIX}profiles/${pid}/csv/`;
        const sleepRaw = await safeFetch(base+`fitbit_sleep.csv`);
        const stepsRaw = await safeFetch(base+`fitbit_activity.csv`);
        const rhrRaw   = await safeFetch(base+`fitbit_rhr.csv`);
        return {
          sleep: normalizeSleepRows(sleepRaw),
          steps: normalizeStepsRows(stepsRaw),
          rhr: normalizeRHRRows(rhrRaw)
        };
      }

      function joinByDate(aRows, bRows, aKey, bKey){
        const mapA = new Map(aRows.map(r=>[r.dateISO, r[aKey]]));
        const out=[];
        for(const r of bRows){ if(mapA.has(r.dateISO)){ const av=mapA.get(r.dateISO); const bv=r[bKey]; if(Number.isFinite(av) && Number.isFinite(bv)) out.push({a:av,b:bv,date:r.dateISO}); } }
        return out;
      }

      function pearson(pairs){
        const xs=pairs.map(p=>p.a), ys=pairs.map(p=>p.b); const n=xs.length; if(n<3) return NaN;
        const sx=xs.reduce((s,v)=>s+v,0), sy=ys.reduce((s,v)=>s+v,0);
        const sxx=xs.reduce((s,v)=>s+v*v,0), syy=ys.reduce((s,v)=>s+v*v,0), sxy=xs.reduce((s,v,i)=>s+v*ys[i],0);
        const num=n*sxy - sx*sy; const den=Math.sqrt((n*sxx - sx*sx)*(n*syy - sy*sy)); return den===0?NaN:num/den;
      }

      function pct(n,d){ return d>0? Math.round((n/d)*100): 0 }

      function summarizeCorrelation(r){
        if(!Number.isFinite(r)) return {score:'–', text:'Not enough overlapping days'};
        const s = r.toFixed(2);
        let note = 'Weak';
        const a=Math.abs(r);
        if(a>=0.7) note='Strong'; else if(a>=0.4) note='Moderate';
        return {score:s, text:`${note} correlation`};
      }

      function computeWidgets(A,B){
        // 1) Bedtime Correlation (do their bedtimes match?)
        // Build bedtime hour series for A and B and compare per overlapping date
        function bedtimeSeries(rows){
          return rows
            .map(r=>{
              const t = (r && r.start instanceof Date && !isNaN(r.start)) ? r.start : null;
              const v = t ? (t.getHours() + (t.getMinutes? t.getMinutes():0)/60) : NaN;
              return { dateISO: r.dateISO, val: v };
            })
            .filter(x=>Number.isFinite(x.val));
        }
        const aBed = bedtimeSeries(A.sleep);
        const bBed = bedtimeSeries(B.sleep);
        const bedPairs = joinByDate(aBed.map(x=>({dateISO:x.dateISO, a:x.val})), bBed.map(x=>({dateISO:x.dateISO, b:x.val})), 'a','b');
        const overlapCount = bedPairs.length;
        // Circular difference across 24h clock
        const circDiff = (h1,h2)=>{ const d=Math.abs(h1-h2); return Math.min(d, 24-d) };
        const diffs = bedPairs.map(p=>circDiff(p.a,p.b));
        const withinHrs = 1.0;
        const matches = diffs.filter(d=>Number.isFinite(d) && d<=withinHrs).length;
        const matchPct = overlapCount>0 ? Math.round((matches/overlapCount)*100) : 0;
        const avgDiff = diffs.length? (diffs.reduce((s,v)=>s+v,0)/diffs.length) : NaN;
        const c1 = { score: overlapCount>0? `${matchPct}%` : '–', text: isNaN(avgDiff)? 'No overlapping bedtimes' : `Avg difference ${avgDiff.toFixed(1)}h (≤${withinHrs}h on ${matches} nights)` };
        const aSleepDays = A.sleep.length;
        const bSleepDays = B.sleep.length;

        // 2) Cross-Influence Modeling (A steps today -> B steps tomorrow)
        const mapBNext = new Map(B.steps.map(r=>[addDaysISO(r.dateISO,-1), r.steps]));
        const pairs2 = A.steps.map(r=>({a:r.steps, b: mapBNext.get(r.dateISO)})).filter(p=>Number.isFinite(p.a) && Number.isFinite(p.b));
        let liftText = 'Not enough data'; let liftPct = null;
        if(pairs2.length>=20){
          const a75 = quantile(pairs2.map(p=>p.a), 0.75);
          const bMed = quantile(pairs2.map(p=>p.b), 0.5);
          const whenActive = pairs2.filter(p=>p.a>=a75);
          const whenNot = pairs2.filter(p=>p.a<a75);
          const pActive = whenActive.length? (whenActive.filter(p=>p.b>=bMed).length/whenActive.length): 0;
          const pNot = whenNot.length? (whenNot.filter(p=>p.b>=bMed).length/whenNot.length): 0;
          const lift = pNot>0? ((pActive-pNot)/pNot): (pActive>0?1:0);
          liftPct = Math.round(pActive*100);
          liftText = `If ${selA.value} is active today, ${selB.value} has ${liftPct}% chance to be active tomorrow`;
        }

        // 3) Joint Burnout Prediction (last 7 days trend)
        function lastNDays(arr,n){ return arr.slice(-n); }
        const days = 7;
        const aS = lastNDays(A.sleep.map(r=>r.sleepScore).filter(Number.isFinite), days);
        const bS = lastNDays(B.sleep.map(r=>r.sleepScore).filter(Number.isFinite), days);
        const aR = lastNDays(A.rhr.map(r=>r.rhr).filter(Number.isFinite), days);
        const bR = lastNDays(B.rhr.map(r=>r.rhr).filter(Number.isFinite), days);
        const aP = lastNDays(A.steps.map(r=>r.steps).filter(Number.isFinite), days);
        const bP = lastNDays(B.steps.map(r=>r.steps).filter(Number.isFinite), days);
        const _mean2 = arr=>arr.length? arr.reduce((s,v)=>s+v,0)/arr.length: NaN;
        // Personalized RHR elevation using baseline (exclude last 7 days)
        function rhrElevated(userRhr){
          try{
            const series = userRhr.slice().sort((a,b)=>String(a.dateISO).localeCompare(String(b.dateISO)));
            if(series.length < 14) return false; // need baseline + recent
            const baselinePool = series.slice(0, Math.max(0, series.length - 7));
            const baselineValsRaw = baselinePool.map(r=>r.rhr).filter(Number.isFinite);
            if(baselineValsRaw.length < 30) return false; // insufficient baseline
            const baselineVals = winsorize(baselineValsRaw, 0.01);
            const mu = _mean2(baselineVals);
            const sd = stdev(baselineVals);
            const recent7 = series.slice(-7).map(r=>r.rhr).filter(Number.isFinite);
            if(recent7.length < 5) return false;
            const recentMean = _mean2(recent7);
            const threshold = mu + Math.max(3, 1.0 * (Number.isFinite(sd)? sd : 0));
            // stability: at least 2 of last 3 days elevated
            const last3 = series.slice(-3).map(r=>r.rhr).filter(Number.isFinite);
            const elevatedDays = last3.filter(v => v >= threshold).length;
            return (recentMean >= threshold) && (elevatedDays >= 2);
          }catch(_){ return false }
        }
        const aRhrElev = rhrElevated(A.rhr || []);
        const bRhrElev = rhrElevated(B.rhr || []);
        const aRisk = (_mean2(aS)<75?1:0) + (aRhrElev?1:0) + (_mean2(aP)<6000?1:0);
        const bRisk = (_mean2(bS)<75?1:0) + (bRhrElev?1:0) + (_mean2(bP)<6000?1:0);
        const totalRisk = aRisk + bRisk;
        let burnoutText = 'Risk low and stable';
        if(totalRisk>=4) burnoutText = 'Family fatigue risk rising this week';
        else if(totalRisk>=2) burnoutText = 'Elevated shared fatigue signals - consider lighter days';

        let sleepInsight = c1.text;
        return {
          sleepCorr: { score: c1.score, insight: sleepInsight, overlapCount, aSleepDays, bSleepDays },
          crossInfluence: { score: (liftPct==null? '–': `${liftPct}%`), insight: (liftPct==null? 'Not enough data' : `If ${selA.value} walks today, ${selB.value} is ${liftPct}% likely to walk tomorrow`) },
          burnout: { score: totalRisk>=4? 'High': totalRisk>=2? 'Moderate':'Low', insight: burnoutText }
        };
      }

      function renderCards(widgets){
        cards.innerHTML = '';
        const defs = [
          { title: 'Bedtime Alignment', data: widgets.sleepCorr },
          { title: 'Cross-Influence Modeling', data: widgets.crossInfluence },
          { title: 'Joint Burnout Prediction', data: widgets.burnout }
        ];
        defs.forEach(d=>{
          const card=document.createElement('div');
          card.style.cssText='background:#0b1020;border:1px solid #1a2349;border-radius:8px;padding:12px;';
          const h=document.createElement('div'); h.textContent=d.title; h.style.cssText='font-weight:600;color:#e6eaf3;margin-bottom:6px'; card.appendChild(h);
          if (d.title === 'Joint Burnout Prediction'){
            const tip = 'Uses last 7 days for both users. Flags: sleep score < 75, resting HR elevated vs personal baseline (μ + max(3 bpm, 1σ) and ≥2 of last 3 days), steps < 6000/day. Total flags → Low/Moderate/High.';
            card.title = tip;
          }
          if (d.title === 'Bedtime Alignment'){
            const tip = 'Aligned bedtimes support circadian entrainment and co-regulation: consistent lights-out within ~1 hour is linked to better sleep quality, higher HRV, and easier wake times. Large misalignments can increase light exposure/noise mismatch and fragment sleep.';
            card.title = tip;
          }
          const s=document.createElement('div');
          let scoreColor = '#a9b3d8';
          if (d.title === 'Joint Burnout Prediction'){
            if (d.data.score === 'Low') scoreColor = '#4CAF50';
            else if (d.data.score === 'Moderate') scoreColor = '#ffc107';
            else if (d.data.score === 'High') scoreColor = '#f44336';
          } else if (d.title === 'Bedtime Alignment') {
            const pct = typeof d.data.score === 'string' && d.data.score.endsWith('%') ? parseInt(d.data.score.replace('%',''), 10) : NaN;
            if (Number.isFinite(pct)){
              if (pct >= 70) scoreColor = '#4CAF50';
              else if (pct >= 40) scoreColor = '#ffc107';
              else scoreColor = '#f44336';
            }
          }
          s.innerHTML=`<strong>Score:</strong> <span style="color:${scoreColor}">${d.data.score}</span>`;
          s.style.cssText='color:#a9b3d8;margin-bottom:6px;font-size:13px';
          card.appendChild(s);
          const i=document.createElement('div'); i.textContent=d.data.insight; i.style.cssText='color:#e6eaf3;font-size:13px'; card.appendChild(i);
          if (d.title === 'Bedtime Alignment' && typeof d.data.overlapCount === 'number'){
            const diag=document.createElement('div');
            diag.className='muted';
            diag.style.cssText='margin-top:6px;font-size:12px;color:#9aa5c6';
            diag.textContent = `Overlapping days: ${d.data.overlapCount} (A: ${d.data.aSleepDays}, B: ${d.data.bSleepDays})`;
            card.appendChild(diag);
          }
          cards.appendChild(card);
        })
      }

      let cache = new Map();
      async function get(pid){ if(cache.has(pid)) return cache.get(pid); const d=await fetchProfileData(pid); cache.set(pid,d); return d }

      async function refresh(){
        if(selA.value===selB.value) { cards.innerHTML='<div class="muted">Select two different users to compare.</div>'; return; }
        const [A,B] = await Promise.all([get(selA.value), get(selB.value)]);
        const widgets = computeWidgets(A,B);
        renderCards(widgets);
      }

      selA.addEventListener('change', refresh);
      selB.addEventListener('change', refresh);
      refresh();
    }catch(_){ /* ignore */ }
  })();
  
  // Disclaimer removed per request
  
  // Insert container before footer
  const chartElement = document.getElementById('chart');
  const parentContainer = chartElement.parentElement;
  const footer = parentContainer.querySelector('.footer');
  
  if (footer) {
    parentContainer.insertBefore(container, footer);
  } else {
    parentContainer.appendChild(container);
  }
  
  return null; // Hide the main chart canvas
}

function createCorrelationMatrixChart(correlationData) {
  if (correlationData.error) {
    return createMessageChart(correlationData.error);
  }
  
  const { labels, matrix, dataPoints, dateRange } = correlationData;
  
  // Create a custom HTML table-based correlation matrix (includes legend)
  createCorrelationMatrixTable(correlationData);
  
  // Return null to hide the chart area completely
  return null;
}

function createCorrelationMatrixTable(correlationData) {
  const { labels, matrix, dataPoints, dateRange } = correlationData;
  
  // Remove existing table if it exists
  const existingTable = document.getElementById('correlationMatrixTable');
  if (existingTable) {
    existingTable.remove();
  }
  
  // Create table container
  const tableContainer = document.createElement('div');
  tableContainer.id = 'correlationMatrixTable';
  tableContainer.style.cssText = `
    margin: 20px 0;
    background: #0b1020;
    border-radius: 12px;
    padding: 20px;
    border: 1px solid #1a2349;
    overflow-x: auto;
  `;
  
  // Title removed as requested
  
  // Add correlation legend at the top of the container
  addCorrelationLegendToContainer(tableContainer);
  
  // Create table
  const table = document.createElement('table');
  table.style.cssText = `
    width: 100%;
    border-collapse: collapse;
    margin: 0 auto;
    font-size: 10px;
  `;
  
  // Create header row
  const headerRow = document.createElement('tr');
  
  // Empty cell for top-left corner
  const emptyHeader = document.createElement('th');
  emptyHeader.style.cssText = `
    background: #1a2349;
    color: #a9b3d8;
    padding: 12px 8px;
    border: 1px solid #263266;
    font-weight: 600;
  `;
  headerRow.appendChild(emptyHeader);
  
  // Add column headers
  labels.forEach(label => {
    const th = document.createElement('th');
    th.textContent = label;
    th.style.cssText = `
      background: #1a2349;
      color: #a9b3d8;
      padding: 8px 4px;
      border: 1px solid #263266;
      font-weight: 600;
      text-align: center;
      writing-mode: vertical-rl;
      text-orientation: mixed;
      min-width: 50px;
      height: 100px;
      font-size: 11px;
    `;
    headerRow.appendChild(th);
  });
  
  table.appendChild(headerRow);
  
  // Create data rows
  matrix.forEach((row, i) => {
    const tr = document.createElement('tr');
    
    // Row header
    const rowHeader = document.createElement('th');
    rowHeader.textContent = labels[i];
    rowHeader.style.cssText = `
      background: #1a2349;
      color: #a9b3d8;
      padding: 8px 6px;
      border: 1px solid #263266;
      font-weight: 600;
      text-align: right;
      width: 100px;
      font-size: 11px;
    `;
    tr.appendChild(rowHeader);
    
    // Data cells
    row.forEach((value, j) => {
      const td = document.createElement('td');
      
      // Skip diagonal cells (same metric vs itself)
      if (i === j) {
        td.innerHTML = `
          <div style="
            background: transparent;
            padding: 4px;
            border-radius: 4px;
            text-align: center;
            min-width: 40px;
            height: 24px;
          "></div>
        `;
        td.style.cssText = `
          padding: 4px;
          border: 1px solid #263266;
          text-align: center;
          vertical-align: middle;
        `;
        tr.appendChild(td);
        return;
      }
      
      const color = getCorrelationColor(value);
      const strength = getCorrelationStrength(value);
      
      const displayValue = isNaN(value) || !isFinite(value) ? 'N/A' : value.toFixed(3);
      const displayStrength = isNaN(value) || !isFinite(value) ? 'No Data' : strength;
      
      td.innerHTML = `
        <div style="
          background: ${isNaN(value) || !isFinite(value) ? '#263266' : color};
          color: ${isNaN(value) || !isFinite(value) ? '#9aa5c6' : (Math.abs(value) > 0.3 ? '#ffffff' : '#a9b3d8')};
          padding: 4px;
          border-radius: 4px;
          text-align: center;
          font-weight: 600;
          font-family: 'Courier New', monospace;
          cursor: pointer;
          transition: all 0.2s ease;
          min-width: 40px;
          font-size: 10px;
        " 
        onmouseover="this.style.transform='scale(1.05)'" 
        onmouseout="this.style.transform='scale(1)'"
        title="${labels[i]} vs ${labels[j]}: ${displayValue} (${displayStrength}) - ${getCorrelationInterpretation(value, labels[i], labels[j])}
${getCorrelationStatement(value, labels[i], labels[j])}">
          ${displayValue}
        </div>
      `;
      
      td.style.cssText = `
        padding: 2px;
        border: 1px solid #263266;
        text-align: center;
        vertical-align: middle;
      `;
      
      tr.appendChild(td);
    });
    
    table.appendChild(tr);
  });
  
  tableContainer.appendChild(table);
  
  // Add interpretation note
  const note = document.createElement('div');
  note.style.cssText = `
    margin-top: 16px;
    padding: 12px;
    background: #0e1530;
    border-radius: 8px;
    border: 1px solid #263266;
    color: #9aa5c6;
    font-size: 11px;
    text-align: center;
  `;
  note.innerHTML = `
    <strong>How to read:</strong> Values range from -1.0 (perfect negative correlation) to +1.0 (perfect positive correlation). 
    Hover over cells for detailed information. Values close to 0 indicate no meaningful relationship.
  `;
  tableContainer.appendChild(note);
  
  // Insert table after the chart area, then move toolbar below it
  const chartElement = document.getElementById('chart');
  const parentContainer = chartElement.parentElement;
  const toolbar = parentContainer.querySelector('.toolbar');
  const footer = parentContainer.querySelector('.footer');
  
  if (footer) {
    // Insert correlation matrix before footer
    parentContainer.insertBefore(tableContainer, footer);
    
    // If toolbar exists, move it after the correlation matrix
    if (toolbar) {
      parentContainer.insertBefore(toolbar, footer);
    }
  } else {
    parentContainer.appendChild(tableContainer);
    if (toolbar) {
      parentContainer.appendChild(toolbar);
    }
  }
}

function addCorrelationLegend() {
  // This function is now only used for non-correlation matrix cases
  // The correlation matrix handles its own legend internally
  return;
}

function addCorrelationLegendToContainer(container) {
  // Create legend container
  const legendContainer = document.createElement('div');
  legendContainer.className = 'correlation-legend';
  legendContainer.style.cssText = `
    margin: 0 0 20px 0;
  `;
  
  const legendItems = [
    { color: 'rgba(123, 255, 191, 0.8)', label: 'Strong Positive', range: '0.7 - 1.0' },
    { color: 'rgba(123, 255, 191, 0.5)', label: 'Moderate Positive', range: '0.3 - 0.7' },
    { color: 'rgba(123, 255, 191, 0.3)', label: 'Weak Positive', range: '0.1 - 0.3' },
    { color: 'rgba(154, 165, 198, 0.3)', label: 'No Correlation', range: '-0.1 - 0.1' },
    { color: 'rgba(255, 155, 155, 0.3)', label: 'Weak Negative', range: '-0.3 - -0.1' },
    { color: 'rgba(255, 155, 155, 0.5)', label: 'Moderate Negative', range: '-0.7 - -0.3' },
    { color: 'rgba(255, 155, 155, 0.8)', label: 'Strong Negative', range: '-1.0 - -0.7' }
  ];
  
  legendItems.forEach(item => {
    const legendItem = document.createElement('div');
    legendItem.className = 'correlation-legend-item';
    
    const colorBox = document.createElement('div');
    colorBox.className = 'correlation-legend-color';
    colorBox.style.backgroundColor = item.color;
    
    const label = document.createElement('span');
    label.innerHTML = `${item.label} <span class="correlation-value">(${item.range})</span>`;
    
    legendItem.appendChild(colorBox);
    legendItem.appendChild(label);
    legendContainer.appendChild(legendItem);
  });
  
  // Insert legend into the container (after title, before table)
  container.appendChild(legendContainer);
}

function getCorrelationInterpretation(value, metric1, metric2) {
  const abs = Math.abs(value);
  if (abs < 0.1) return 'No meaningful relationship';
  
  const strength = abs >= 0.7 ? 'Very strong' : 
                   abs >= 0.5 ? 'Strong' : 
                   abs >= 0.3 ? 'Moderate' : 'Weak';
  
  // Health context interpretation
  const isPositive = value > 0;
  
  // Define health-beneficial relationships
  const beneficialPairs = [
    ['Sleep Score', 'HRV (RMSSD)'],
    ['Sleep Score', 'Sleep Efficiency'],
    ['Sleep Score', 'Minutes Asleep'],
    ['HRV (RMSSD)', 'Sleep Efficiency'],
    ['HRV (RMSSD)', 'Minutes Asleep'],
    ['Steps', 'HRV (RMSSD)'],
    ['Steps', 'Sleep Score']
  ];
  
  const detrimentalPairs = [
    ['Sleep Score', 'Resting HR'],
    ['HRV (RMSSD)', 'Resting HR'],
    ['Steps', 'Resting HR']
  ];
  
  const pairKey = [metric1, metric2].sort().join(' vs ');
  const isBeneficial = beneficialPairs.some(pair => 
    pair.sort().join(' vs ') === pairKey
  );
  const isDetrimental = detrimentalPairs.some(pair => 
    pair.sort().join(' vs ') === pairKey
  );
  
  if (isBeneficial && isPositive) {
    return `${strength} beneficial relationship`;
  } else if (isBeneficial && !isPositive) {
    return `${strength} concerning relationship`;
  } else if (isDetrimental && !isPositive) {
    return `${strength} beneficial relationship`;
  } else if (isDetrimental && isPositive) {
    return `${strength} concerning relationship`;
  } else {
    return `${strength} relationship`;
  }
}

function getCorrelationStatement(value, metric1, metric2) {
  const abs = Math.abs(value);
  if (abs < 0.1) return 'No clear pattern between these metrics.';
  
  const isPositive = value > 0;
  const strength = abs >= 0.7 ? 'strongly' : 
                   abs >= 0.5 ? 'clearly' : 
                   abs >= 0.3 ? 'tends to be' : 'slightly';
  
  // Create natural language statements
  const statements = {
    'Sleep Score': {
      'HRV (RMSSD)': isPositive ? 
        `When sleep quality is high, HRV is ${strength} high.` : 
        `When sleep quality is high, HRV is ${strength} low.`,
      'Minutes Asleep': isPositive ? 
        `When sleep quality is high, sleep duration is ${strength} long.` : 
        `When sleep quality is high, sleep duration is ${strength} short.`,
      'Sleep Efficiency': isPositive ? 
        `When sleep quality is high, sleep efficiency is ${strength} high.` : 
        `When sleep quality is high, sleep efficiency is ${strength} low.`,
      'Deep Sleep %': isPositive ? 
        `When sleep quality is high, deep sleep is ${strength} high.` : 
        `When sleep quality is high, deep sleep is ${strength} low.`,
      'REM Sleep %': isPositive ? 
        `When sleep quality is high, REM sleep is ${strength} high.` : 
        `When sleep quality is high, REM sleep is ${strength} low.`,
      'Light Sleep %': isPositive ? 
        `When sleep quality is high, light sleep is ${strength} high.` : 
        `When sleep quality is high, light sleep is ${strength} low.`,
      'Steps': isPositive ? 
        `When sleep quality is high, daily steps are ${strength} high.` : 
        `When sleep quality is high, daily steps are ${strength} low.`,
      'Resting HR': isPositive ? 
        `When sleep quality is high, resting heart rate is ${strength} high.` : 
        `When sleep quality is high, resting heart rate is ${strength} low.`
    },
    'HRV (RMSSD)': {
      'Sleep Efficiency': isPositive ? 
        `When HRV is high, sleep efficiency is ${strength} high.` : 
        `When HRV is high, sleep efficiency is ${strength} low.`,
      'Minutes Asleep': isPositive ? 
        `When HRV is high, sleep duration is ${strength} long.` : 
        `When HRV is high, sleep duration is ${strength} short.`,
      'Deep Sleep %': isPositive ? 
        `When HRV is high, deep sleep is ${strength} high.` : 
        `When HRV is high, deep sleep is ${strength} low.`,
      'REM Sleep %': isPositive ? 
        `When HRV is high, REM sleep is ${strength} high.` : 
        `When HRV is high, REM sleep is ${strength} low.`,
      'Light Sleep %': isPositive ? 
        `When HRV is high, light sleep is ${strength} high.` : 
        `When HRV is high, light sleep is ${strength} low.`,
      'Steps': isPositive ? 
        `When HRV is high, daily steps are ${strength} high.` : 
        `When HRV is high, daily steps are ${strength} low.`,
      'Resting HR': isPositive ? 
        `When HRV is high, resting heart rate is ${strength} high.` : 
        `When HRV is high, resting heart rate is ${strength} low.`
    },
    'Steps': {
      'Sleep Efficiency': isPositive ? 
        `When daily steps are high, sleep efficiency is ${strength} high.` : 
        `When daily steps are high, sleep efficiency is ${strength} low.`,
      'Minutes Asleep': isPositive ? 
        `When daily steps are high, sleep duration is ${strength} long.` : 
        `When daily steps are high, sleep duration is ${strength} short.`,
      'Deep Sleep %': isPositive ? 
        `When daily steps are high, deep sleep is ${strength} high.` : 
        `When daily steps are high, deep sleep is ${strength} low.`,
      'REM Sleep %': isPositive ? 
        `When daily steps are high, REM sleep is ${strength} high.` : 
        `When daily steps are high, REM sleep is ${strength} low.`,
      'Light Sleep %': isPositive ? 
        `When daily steps are high, light sleep is ${strength} high.` : 
        `When daily steps are high, light sleep is ${strength} low.`,
      'Resting HR': isPositive ? 
        `When daily steps are high, resting heart rate is ${strength} high.` : 
        `When daily steps are high, resting heart rate is ${strength} low.`
    },
    'Resting HR': {
      'Sleep Efficiency': isPositive ? 
        `When resting heart rate is high, sleep efficiency is ${strength} high.` : 
        `When resting heart rate is high, sleep efficiency is ${strength} low.`,
      'Minutes Asleep': isPositive ? 
        `When resting heart rate is high, sleep duration is ${strength} long.` : 
        `When resting heart rate is high, sleep duration is ${strength} short.`,
      'Deep Sleep %': isPositive ? 
        `When resting heart rate is high, deep sleep is ${strength} high.` : 
        `When resting heart rate is high, deep sleep is ${strength} low.`,
      'REM Sleep %': isPositive ? 
        `When resting heart rate is high, REM sleep is ${strength} high.` : 
        `When resting heart rate is high, REM sleep is ${strength} low.`,
      'Light Sleep %': isPositive ? 
        `When resting heart rate is high, light sleep is ${strength} high.` : 
        `When resting heart rate is high, light sleep is ${strength} low.`
    }
  };
  
  // Handle reverse relationships
  const reverseStatements = {
    'Sleep Efficiency': {
      'Deep Sleep %': isPositive ? 
        `When sleep efficiency is high, deep sleep is ${strength} high.` : 
        `When sleep efficiency is high, deep sleep is ${strength} low.`,
      'REM Sleep %': isPositive ? 
        `When sleep efficiency is high, REM sleep is ${strength} high.` : 
        `When sleep efficiency is high, REM sleep is ${strength} low.`,
      'Light Sleep %': isPositive ? 
        `When sleep efficiency is high, light sleep is ${strength} high.` : 
        `When sleep efficiency is high, light sleep is ${strength} low.`
    },
    'Minutes Asleep': {
      'Deep Sleep %': isPositive ? 
        `When sleep duration is long, deep sleep is ${strength} high.` : 
        `When sleep duration is long, deep sleep is ${strength} low.`,
      'REM Sleep %': isPositive ? 
        `When sleep duration is long, REM sleep is ${strength} high.` : 
        `When sleep duration is long, REM sleep is ${strength} low.`,
      'Light Sleep %': isPositive ? 
        `When sleep duration is long, light sleep is ${strength} high.` : 
        `When sleep duration is long, light sleep is ${strength} low.`
    }
  };
  
  // Check for direct relationship
  if (statements[metric1] && statements[metric1][metric2]) {
    return statements[metric1][metric2];
  }
  
  // Check for reverse relationship
  if (statements[metric2] && statements[metric2][metric1]) {
    return statements[metric2][metric1];
  }
  
  // Check reverse statements
  if (reverseStatements[metric1] && reverseStatements[metric1][metric2]) {
    return reverseStatements[metric1][metric2];
  }
  
  if (reverseStatements[metric2] && reverseStatements[metric2][metric1]) {
    return reverseStatements[metric2][metric1];
  }
  
  // Fallback for any missing combinations
  return isPositive ? 
    `When ${metric1} is high, ${metric2} is ${strength} high.` : 
    `When ${metric1} is high, ${metric2} is ${strength} low.`;
}

function getCorrelationColor(value) {
  // Strong positive correlation (0.7 to 1.0) - Green
  if (value >= 0.7) return `rgba(123, 255, 191, ${Math.abs(value)})`;
  // Moderate positive correlation (0.3 to 0.7) - Light Green
  if (value >= 0.3) return `rgba(123, 255, 191, ${Math.abs(value) * 0.7})`;
  // Weak positive correlation (0.1 to 0.3) - Very Light Green
  if (value >= 0.1) return `rgba(123, 255, 191, ${Math.abs(value) * 0.4})`;
  // No correlation (-0.1 to 0.1) - Neutral
  if (value >= -0.1) return `rgba(154, 165, 198, 0.3)`;
  // Weak negative correlation (-0.3 to -0.1) - Very Light Red
  if (value >= -0.3) return `rgba(255, 155, 155, ${Math.abs(value) * 0.4})`;
  // Moderate negative correlation (-0.7 to -0.3) - Light Red
  if (value >= -0.7) return `rgba(255, 155, 155, ${Math.abs(value) * 0.7})`;
  // Strong negative correlation (-1.0 to -0.7) - Red
  return `rgba(255, 155, 155, ${Math.abs(value)})`;
}

function getCorrelationStrength(value) {
  const abs = Math.abs(value);
  if (abs >= 0.7) return 'Strong';
  if (abs >= 0.3) return 'Moderate';
  if (abs >= 0.1) return 'Weak';
  return 'Very Weak';
}

function render(){
  const status=document.getElementById('status');
  const chartType=document.getElementById('chartType').value;
  
  // Show/hide toggles based on chart type and adjust Profile position
  if (chartType === 'daily_steps') {
    document.getElementById('stepsViewToggle').closest('.cell').style.display = 'flex';
    document.getElementById('rhrViewToggle').closest('.cell').style.display = 'none';
    document.getElementById('sleepViewToggle').closest('.cell').style.display = 'none';
    document.getElementById('minutesViewToggle').closest('.cell').style.display = 'none';
    // Position Profile element to stay in first row by using absolute positioning
    const profileCell = document.querySelector('.profile-cell');
    const isSmall = Math.min(window.innerWidth||0, (window.screen&&window.screen.width)||0) <= 768;
    if (profileCell && !isSmall) {
      profileCell.style.position = 'absolute';
      profileCell.style.right = '0';
      profileCell.style.top = '0';
      profileCell.style.width = '200px';
    } else if (profileCell && isSmall) {
      profileCell.style.position = '';
      profileCell.style.right = '';
      profileCell.style.top = '';
      profileCell.style.width = '';
    }
  } else if (chartType === 'daily_rhr') {
    document.getElementById('stepsViewToggle').closest('.cell').style.display = 'none';
    document.getElementById('rhrViewToggle').closest('.cell').style.display = 'flex';
    document.getElementById('sleepViewToggle').closest('.cell').style.display = 'none';
    document.getElementById('minutesViewToggle').closest('.cell').style.display = 'none';
    // Position Profile element to stay in first row by using absolute positioning
    const profileCell = document.querySelector('.profile-cell');
    const isSmall = Math.min(window.innerWidth||0, (window.screen&&window.screen.width)||0) <= 768;
    if (profileCell && !isSmall) {
      profileCell.style.position = 'absolute';
      profileCell.style.right = '0';
      profileCell.style.top = '0';
      profileCell.style.width = '200px';
    } else if (profileCell && isSmall) {
      profileCell.style.position = '';
      profileCell.style.right = '';
      profileCell.style.top = '';
      profileCell.style.width = '';
    }
  } else if (chartType === 'daily_score') {
    document.getElementById('stepsViewToggle').closest('.cell').style.display = 'none';
    document.getElementById('rhrViewToggle').closest('.cell').style.display = 'none';
    document.getElementById('sleepViewToggle').closest('.cell').style.display = 'flex';
    document.getElementById('minutesViewToggle').closest('.cell').style.display = 'none';
    // Position Profile element to stay in first row by using absolute positioning
    const profileCell = document.querySelector('.profile-cell');
    const isSmall = Math.min(window.innerWidth||0, (window.screen&&window.screen.width)||0) <= 768;
    if (profileCell && !isSmall) {
      profileCell.style.position = 'absolute';
      profileCell.style.right = '0';
      profileCell.style.top = '0';
      profileCell.style.width = '200px';
    } else if (profileCell && isSmall) {
      profileCell.style.position = '';
      profileCell.style.right = '';
      profileCell.style.top = '';
      profileCell.style.width = '';
    }
  } else if (chartType === 'daily_minutes') {
    document.getElementById('stepsViewToggle').closest('.cell').style.display = 'none';
    document.getElementById('rhrViewToggle').closest('.cell').style.display = 'none';
    document.getElementById('sleepViewToggle').closest('.cell').style.display = 'none';
    document.getElementById('minutesViewToggle').closest('.cell').style.display = 'flex';
    // Position Profile element to stay in first row by using absolute positioning
    const profileCell = document.querySelector('.profile-cell');
    const isSmall = Math.min(window.innerWidth||0, (window.screen&&window.screen.width)||0) <= 768;
    if (profileCell && !isSmall) {
      profileCell.style.position = 'absolute';
      profileCell.style.right = '0';
      profileCell.style.top = '0';
      profileCell.style.width = '200px';
    } else if (profileCell && isSmall) {
      profileCell.style.position = '';
      profileCell.style.right = '';
      profileCell.style.top = '';
      profileCell.style.width = '';
    }
  } else if (chartType === 'life_events') {
    // Hide chart-specific view toggles in Life Events
    document.getElementById('stepsViewToggle').closest('.cell').style.display = 'none';
    document.getElementById('rhrViewToggle').closest('.cell').style.display = 'none';
    document.getElementById('sleepViewToggle').closest('.cell').style.display = 'none';
    document.getElementById('minutesViewToggle').closest('.cell').style.display = 'none';
    // Keep Profile aligned to top-right like other screens
    const profileCell = document.querySelector('.profile-cell');
    const isSmall = Math.min(window.innerWidth||0, (window.screen&&window.screen.width)||0) <= 768;
    if (profileCell && !isSmall) {
      profileCell.style.position = 'absolute';
      profileCell.style.right = '0';
      profileCell.style.top = '0';
      profileCell.style.width = '200px';
    } else if (profileCell && isSmall) {
      profileCell.style.position = '';
      profileCell.style.right = '';
      profileCell.style.top = '';
      profileCell.style.width = '';
    }
  } else {
    document.getElementById('stepsViewToggle').closest('.cell').style.display = 'none';
    document.getElementById('rhrViewToggle').closest('.cell').style.display = 'none';
    document.getElementById('sleepViewToggle').closest('.cell').style.display = 'none';
    document.getElementById('minutesViewToggle').closest('.cell').style.display = 'none';
    // Keep Profile element positioning consistent for all chart types
    const profileCell = document.querySelector('.profile-cell');
    const isSmall = Math.min(window.innerWidth||0, (window.screen&&window.screen.width)||0) <= 768;
    if (profileCell && !isSmall) {
      profileCell.style.position = 'absolute';
      profileCell.style.right = '0';
      profileCell.style.top = '0';
      profileCell.style.width = '200px';
    } else if (profileCell && isSmall) {
      profileCell.style.position = '';
      profileCell.style.right = '';
      profileCell.style.top = '';
      profileCell.style.width = '';
    }
  }
  
  // Show/hide and enable/disable analytics download button and hide badges for non-analytics
  const downloadAnalytics = document.getElementById('downloadAnalytics');
  const refreshBtn = document.getElementById('refreshBtn');
  if (chartType === 'analytics') {
    downloadAnalytics.style.display = 'block';
    downloadAnalytics.disabled = false;
  } else {
    downloadAnalytics.style.display = 'none';
    downloadAnalytics.disabled = true;
    hideAnalyticsBadges();
  }
  // Hide refresh button for Steps & Activity per request
  if (refreshBtn) refreshBtn.style.display = (chartType === 'daily_steps') ? 'none' : '';

  // Ensure Non‑Sedentary chart is cleaned up when leaving Steps & Activity
  if (chartType !== 'daily_steps'){
    try{
      const sedDiv = document.getElementById('sedentaryLineChart');
      if (sedDiv) sedDiv.style.display = 'none';
      if (window.sedentaryChart && window.sedentaryChart.destroy){
        try { window.sedentaryChart.destroy(); } catch(_){ /* ignore */ }
        window.sedentaryChart = null;
      }
      const sedMeta = document.getElementById('sedentaryMeta');
      if (sedMeta) sedMeta.innerText = '';
    } catch(_) { /* ignore */ }
  }
  
  // Ensure date inputs are aligned with expectations for the selected chart
  try {
    const dateFrom = document.getElementById('dateFrom');
    const dateTo = document.getElementById('dateTo');
    const isISO = (s)=> /^\d{4}-\d{2}-\d{2}$/.test(String(s||''));
    const setLastSixMonths = ()=>{
      const today = new Date();
      const six = new Date(); six.setMonth(today.getMonth()-6);
      dateFrom.value = six.toISOString().slice(0,10);
      dateTo.value = today.toISOString().slice(0,10);
    };
    // Daily charts default to last 6 months if invalid
    // For Steps yearly mode, skip this so numeric year inputs are not overridden
    if (["daily_score","daily_minutes"].includes(chartType)
        || (chartType === 'daily_steps' && (parseInt((document.getElementById('stepsViewToggle')||{value:'0'}).value,10) !== 2))){
      // Honor open start: if From is empty and To is valid, do not auto-fill
      if ((!isISO(dateFrom.value) || !isISO(dateTo.value)) && !(dateFrom.value === '' && isISO(dateTo.value))) setLastSixMonths();
    }
    // RHR date input handling is synchronized by syncRHRDateInputs() on relevant events
    // Monthly sleep views: if invalid, use full data range; fallback to 6 months
    if (["stages_pct"].includes(chartType)){
      // Honor open start: if From is empty and To is valid, do not auto-fill
      if ((!isISO(dateFrom.value) || !isISO(dateTo.value)) && !(dateFrom.value === '' && isISO(dateTo.value))){
        try {
          const all = normalizeSleepRows(rawSleep);
          const mainOnly = document.getElementById('mainOnly').checked;
          const rows = mainOnly ? all.filter(r=>r.isMainSleep) : all;
          if (rows.length > 0){
            let minD = rows[0].date, maxD = rows[0].date;
            for(const r of rows){ if(r.date < minD) minD = r.date; if(r.date > maxD) maxD = r.date; }
            dateFrom.value = toISODate(minD);
            dateTo.value = toISODate(maxD);
          } else {
            setLastSixMonths();
          }
        } catch(_){ setLastSixMonths(); }
      }
    }
    // Steps correlation: default to last 6 months if invalid
    if (["corr_steps_hrv"].includes(chartType)){
      // Honor open start: if From is empty and To is valid, do not auto-fill
      if ((!isISO(dateFrom.value) || !isISO(dateTo.value)) && !(dateFrom.value === '' && isISO(dateTo.value))) setLastSixMonths();
    }
  } catch(_) { /* best-effort */ }

  const sleepN = normalizeSleepRows(rawSleep); const filtered = filterSleep(sleepN);
 
 // Check for data availability in yearly mode and update input styling
if(chartType === 'daily_score'){
   const sleepToggle = document.getElementById('sleepViewToggle');
   const toggleValue = parseInt(sleepToggle.value);
   const isYearlyView = toggleValue === 2;
   
   if (isYearlyView) {
   const dateFrom = document.getElementById('dateFrom');
   const dateTo = document.getElementById('dateTo');
   const hasData = filtered.length > 0;
   if(hasData){
     dateFrom.classList.remove('no-data');
     dateTo.classList.remove('no-data');
   } else {
     dateFrom.classList.add('no-data');
     dateTo.classList.add('no-data');
     }
   }
 }
 
const monthly = groupByMonth(filtered); const yearly = groupByYear(filtered); const meta=document.getElementById('meta'); 
const avgScore = filtered.length > 0 ? filtered.map(r => r.sleepScore).filter(Number.isFinite).reduce((sum, score) => sum + score, 0) / filtered.map(r => r.sleepScore).filter(Number.isFinite).length : 0;

let metaText = `${filtered.length} nights • range ${filtered.length? filtered[0].dateISO:''} to ${filtered.length? filtered[filtered.length-1].dateISO:''} • avg ${Number.isFinite(avgScore) ? avgScore.toFixed(1) : 'N/A'}`;

// Add trend for daily_score chart (with toggle support)
if(chartType === 'daily_score') {
  const sleepToggle = document.getElementById('sleepViewToggle');
  const toggleValue = parseInt(sleepToggle.value);
  const isMonthlyView = toggleValue === 1;
  const isYearlyView = toggleValue === 2;
  
  if (isYearlyView && yearly.length >= 2) {
    const validData = yearly.map(r => r.sleepScore).filter(Number.isFinite);
  if(validData.length >= 2) {
    const regressionData = validData.map((score, index) => ({ x: index, y: score }));
    const regression = calculateLinearRegression(regressionData);
    if(regression) {
      const trend = regression.slope > 0 ? '+' : '';
      metaText += ` • trend ${trend}${regression.slope.toFixed(3)} points`;
    }
  }
  } else if (isMonthlyView && monthly.length >= 2) {
  const validData = monthly.map(r => r.sleepScore).filter(Number.isFinite);
  if(validData.length >= 2) {
    const regressionData = validData.map((score, index) => ({ x: index, y: score }));
    const regression = calculateLinearRegression(regressionData);
    if(regression) {
      const trend = regression.slope > 0 ? '+' : '';
      metaText += ` • trend ${trend}${regression.slope.toFixed(3)} points`;
    }
  }
  } else if (filtered.length >= 2) {
    const validData = filtered.map(r => r.sleepScore).filter(Number.isFinite);
  if(validData.length >= 2) {
    const regressionData = validData.map((score, index) => ({ x: index, y: score }));
    const regression = calculateLinearRegression(regressionData);
    if(regression) {
      const trend = regression.slope > 0 ? '+' : '';
      metaText += ` • trend ${trend}${regression.slope.toFixed(3)} points`;
      }
    }
  }
}

// Add trend for daily_minutes chart
if(chartType === 'daily_minutes' && filtered.length >= 2) {
  const validData = filtered.map(r => r.minutesAsleep).filter(Number.isFinite);
  if(validData.length >= 2) {
    const regressionData = validData.map((minutes, index) => ({ x: index, y: minutes }));
    const regression = calculateLinearRegression(regressionData);
    if(regression) {
      const trend = regression.slope > 0 ? '+' : '';
      metaText += ` • trend ${trend}${regression.slope.toFixed(3)}`;
    }
  }
}

// Add trend for daily_minutes chart (with toggle support)
if(chartType === 'daily_minutes') {
  const minutesToggle = document.getElementById('minutesViewToggle');
  const toggleValue = parseInt(minutesToggle.value);
  const isMonthlyView = toggleValue === 1;
  
  if (isMonthlyView && monthly.length >= 2) {
  const validData = monthly.map(r => r.minutesAsleep).filter(Number.isFinite);
  if(validData.length >= 2) {
    const regressionData = validData.map((minutes, index) => ({ x: index, y: minutes }));
    const regression = calculateLinearRegression(regressionData);
    if(regression) {
      const trend = regression.slope > 0 ? '+' : '';
      metaText += ` • trend ${trend}${regression.slope.toFixed(3)}`;
    }
  }
  } else if (filtered.length >= 2) {
    const validData = filtered.map(r => r.minutesAsleep).filter(Number.isFinite);
    if(validData.length >= 2) {
      const regressionData = validData.map((minutes, index) => ({ x: index, y: minutes }));
      const regression = calculateLinearRegression(regressionData);
      if(regression) {
        const trend = regression.slope > 0 ? '+' : '';
        metaText += ` • trend ${trend}${regression.slope.toFixed(3)}`;
      }
    }
  }
}



 
 let preview = []; // Initialize preview variable early
 const ctx=document.getElementById('chart').getContext('2d'); if(chart) chart.destroy();
 let cfg=null; const palette=['#8ab4ff','#7bffbf','#ffd166','#ff8aa1','#c5a3ff','#a6f0ff'];
 if(chartType==='daily_score'){
   const sleepToggle = document.getElementById('sleepViewToggle');
   const toggleValue = parseInt(sleepToggle.value);
   const isMonthlyView = toggleValue === 1;
   const isYearlyView = toggleValue === 2;

   if (isYearlyView) {
     // Yearly view - bar chart
     const ds = yearly.map(r=>({x:r.date,y:r.sleepScore})); 
     preview = yearly.map(r=>({year:r.key,sleepScore:fmt(r.sleepScore)}));
     const avgSleepScore = yearly.reduce((sum, r) => sum + r.sleepScore, 0) / yearly.length;
     const from = document.getElementById('dateFrom').value;
     const to = document.getElementById('dateTo').value;
     metaText = `${yearly.length} years • range ${from || 'start'} to ${to || 'end'} • avg ${avgSleepScore.toFixed(1)} sleep score per year`;
     cfg={type:'bar',data:{datasets:[{label:'Avg Sleep Score',data:ds,backgroundColor:palette[0]}]},options:{scales:{x:{type:'time',time:{unit:'year'}},y:{min:0,max:100}},plugins:{tooltip:{callbacks:{title:function(context){const dataIndex=context[0].dataIndex;const yearData=yearly[dataIndex];if(!yearData)return'';return yearData.key},label:function(context){return context.dataset.label + ': ' + context.parsed.y.toFixed(2)}}}}}}
   } else if (isMonthlyView) {
     // Monthly view - line chart
     const ds = lineSeries(monthly,'date','sleepScore'); 
     preview = monthly.map(r=>({month:r.key,sleepScore:fmt(r.sleepScore)}));
     const avgSleepScore = monthly.reduce((sum, r) => sum + r.sleepScore, 0) / monthly.length;
     const from = document.getElementById('dateFrom').value;
     const to = document.getElementById('dateTo').value;
     metaText = `${monthly.length} months • range ${from || 'start'} to ${to || 'end'} • avg ${avgSleepScore.toFixed(1)} sleep score per month`;
     cfg={type:'line',data:{datasets:[{label:'Avg Sleep Score',data:ds,borderColor:palette[0],tension:.2}]},options:{scales:{x:{type:'time',time:{unit:'month'}},y:{min:0,max:100}},plugins:{tooltip:{callbacks:{title:function(context){const dataIndex=context[0].dataIndex;const monthData=monthly[dataIndex];if(!monthData)return'';const[year,month]=monthData.key.split('-');const date=new Date(year,month-1,1);return date.toLocaleDateString('en-US',{month:'long',year:'numeric'})}}}}}}
   } else {
     // Daily view - line chart with gaps
   const startDate = new Date(filtered[0].date);
   const endDate = new Date(filtered[filtered.length - 1].date);
   const dateMap = new Map(filtered.map(r => [r.dateISO, r.sleepScore]));
   
   const ds = [];
   const currentDate = new Date(startDate);
   while (currentDate <= endDate) {
     const dateISO = currentDate.toISOString().slice(0, 10);
     const scoreValue = dateMap.get(dateISO);
     ds.push({
       x: currentDate.getTime(),
       y: scoreValue !== undefined ? scoreValue : null
     });
     currentDate.setDate(currentDate.getDate() + 1);
   }
   
   // Update metaText for daily view with date range
   const from = document.getElementById('dateFrom').value;
   const to = document.getElementById('dateTo').value;
   const avgScore = filtered.length > 0 ? filtered.map(r => r.sleepScore).filter(Number.isFinite).reduce((sum, score) => sum + score, 0) / filtered.map(r => r.sleepScore).filter(Number.isFinite).length : 0;
   metaText = `${filtered.length} nights • range ${from || 'start'} to ${to || 'end'} • avg ${Number.isFinite(avgScore) ? avgScore.toFixed(1) : 'N/A'} sleep score`;
   
   preview = filtered.map(r=>({date:r.dateISO,sleepScore:fmt(r.sleepScore,1),minutesAsleep:r.minutesAsleep,efficiency:fmt(r.efficiency,1)}));
   cfg={type:'line',data:{datasets:[{label:'Sleep Score',data:ds,borderColor:palette[0],tension:.2,spanGaps:false}]},options:{responsive:true,scales:{x:{type:'time',time:{unit:'day'}},y:{title:{display:true,text:'Score'},min:0,max:100}},plugins:{legend:{display:true},tooltip:{callbacks:{title:function(context){const date=new Date(context[0].parsed.x);return date.toISOString().slice(0,10)}}}}}}
 }
 
 // Add histogram functionality to daily_score
 if (filtered && filtered.length > 0) {
   const arr = filtered.map(r => r.sleepScore).filter(Number.isFinite);
  const bins = 20; 
   const min = 0, max = 100;
   const step = (max - min) / bins;
   const hist = new Array(bins).fill(0);
   
   arr.forEach(v => {
     const i = Math.max(0, Math.min(bins - 1, Math.floor((v - min) / step)));
     hist[i]++;
   });
   
   const labels = [...Array(bins)].map((_, i) => 
     `${Math.round(min + i * step)}-${Math.round(min + (i + 1) * step)}`
   );
  
  // Get top 20 highest sleep score days
  const top20SleepScore = filtered
    .filter(r => Number.isFinite(r.sleepScore))
    .sort((a, b) => b.sleepScore - a.sleepScore)
    .slice(0, 20)
    .map(r => {
      const date = new Date(r.date);
      const dayOfWeek = date.toLocaleDateString('en-US', { weekday: 'short' });
      return { date: `${dayOfWeek} ${r.dateISO}`, sleepScore: Math.round(r.sleepScore) };
    });
  
  // Get bottom 20 lowest sleep score days
  const bottom20SleepScore = filtered
    .filter(r => Number.isFinite(r.sleepScore))
    .sort((a, b) => a.sleepScore - b.sleepScore)
    .slice(0, 20)
    .map(r => {
      const date = new Date(r.date);
      const dayOfWeek = date.toLocaleDateString('en-US', { weekday: 'short' });
      return { date: `${dayOfWeek} ${r.dateISO}`, sleepScore: Math.round(r.sleepScore) };
    });
  
  // Render the sleep score tables
  renderTopSleepScoreTable(top20SleepScore);
  renderBottomSleepScoreTable(bottom20SleepScore);
  
   // Create histogram chart configuration
   const histogramConfig = {
     type: 'bar',
     data: {
       labels,
       datasets: [{
         label: 'Nights',
         data: hist,
         backgroundColor: palette[0]
       }]
     },
     options: {
       responsive: true,
       scales: {
         y: { beginAtZero: true, title: { display: true, text: 'Count' } },
         x: { title: { display: true, text: 'Sleep Score Range' } }
       },
       plugins: {
         tooltip: {
           callbacks: {
             title: function(context) {
               return 'Sleep Score: ' + (context && context[0] && context[0].label ? context[0].label : '');
             }
           }
         }
       }
     }
   };
   
  // Store histogram config for rendering
  window.sleepHistogramConfig = histogramConfig;
  
  // Create preview data for sleep histogram - show histogram buckets with counts
  const sleepHistogramPreview = labels.map((label, index) => ({
    bucket: label,
    'count (# of days)': hist[index],
    percentage: ((hist[index] / arr.length) * 100).toFixed(1) + '%'
  })).sort((a, b) => b['count (# of days)'] - a['count (# of days)']); // Sort by count in descending order
  
  // Store preview data for rendering
  window.sleepHistogramPreview = sleepHistogramPreview;
  
  // Set histogram meta text
  const from = document.getElementById('dateFrom').value;
  const to = document.getElementById('dateTo').value;
  const avgSleepScore = arr.reduce((sum, v) => sum + v, 0) / arr.length;
   
   // Check if monthly view is selected to show months instead of nights
   const sleepToggle = document.getElementById('sleepViewToggle');
   const toggleValue = parseInt(sleepToggle.value);
   const isMonthlyView = toggleValue === 1;
   const isYearlyView = toggleValue === 2;
   
   let count, unit;
   if (isYearlyView) {
     // For yearly view, count unique years
     const years = new Set(filtered.map(r => r.date.getFullYear()));
     count = years.size;
     unit = 'years';
   } else if (isMonthlyView) {
     // For monthly view, count unique months
     const months = new Set(filtered.map(r => r.dateISO.slice(0, 7)));
     count = months.size;
     unit = 'months';
   } else {
     // For daily view, count nights
     count = arr.length;
     unit = 'nights';
   }
   
   // Get actual date range from the filtered data
   let dateRangeText = '';
   if (filtered && filtered.length > 0) {
     const firstDate = filtered[0].dateISO;
     const lastDate = filtered[filtered.length - 1].dateISO;
     dateRangeText = `range ${firstDate} to ${lastDate}`;
   } else {
     dateRangeText = `range ${from || 'start'} to ${to || 'end'}`;
   }
   
   const histogramMetaText = `${count} ${unit} • ${dateRangeText} • avg ${avgSleepScore.toFixed(1)} score`;
   const histogramMetaElement = document.getElementById('sleepHistogramMeta');
   if (histogramMetaElement) {
     histogramMetaElement.innerHTML = histogramMetaText;
   }
 }
 }
 if(chartType==='daily_minutes'){
   const minutesToggle = document.getElementById('minutesViewToggle');
   const toggleValue = parseInt(minutesToggle.value);
   const isMonthlyView = toggleValue === 1;

   if (isMonthlyView) {
     // Monthly view - line chart
     const ds = lineSeries(monthly,'date','minutesAsleep'); 
     preview = monthly.map(r=>({month:r.key,minutesAsleep:fmt(r.minutesAsleep,1)}));
     cfg={type:'line',data:{datasets:[{label:'Avg Minutes Asleep',data:ds,borderColor:palette[0],tension:.2}]},options:{scales:{x:{type:'time',time:{unit:'month'}},y:{title:{display:true,text:'Minutes'}}},plugins:{tooltip:{callbacks:{title:function(context){const dataIndex=context[0].dataIndex;const monthData=monthly[dataIndex];if(!monthData)return'';const[year,month]=monthData.key.split('-');const date=new Date(year,month-1,1);return date.toLocaleDateString('en-US',{month:'long',year:'numeric'})},label:function(context){return context.dataset.label + ': ' + Math.round(context.parsed.y)}}}}}}
   } else {
     // Daily view - line chart with gaps
     const ds = dailyLineSeries(filtered,'date','minutesAsleep'); 
     preview = filtered.map(r=>({date:r.dateISO,minutesAsleep:r.minutesAsleep}));
   cfg={type:'line',data:{datasets:[{label:'Minutes Asleep',data:ds,borderColor:palette[0],tension:.2,spanGaps:false}]},options:{responsive:true,scales:{x:{type:'time'},y:{title:{display:true,text:'Minutes'}}},plugins:{tooltip:{callbacks:{title:function(context){const date=new Date(context[0].parsed.x);return date.toISOString().slice(0,10)}}}}}}
 }
 }
 if(chartType==='stages_pct'){
   const d1 = lineSeries(monthly,'date','pctDeep'); const d2=lineSeries(monthly,'date','pctREM'); const d3=lineSeries(monthly,'date','pctLight'); preview = monthly.map(r=>({month:r.key,pctDeep:fmt(r.pctDeep),pctREM:fmt(r.pctREM),pctLight:fmt(r.pctLight)}));
   cfg={type:'line',data:{datasets:[{label:'Deep %',data:d1,borderColor:palette[1],tension:.2},{label:'REM %',data:d2,borderColor:palette[3],tension:.2},{label:'Light %',data:d3,borderColor:palette[4],tension:.2}]},options:{scales:{x:{type:'time',time:{unit:'month'}},y:{title:{display:true,text:'% of minutes asleep'},min:0,max:100}},plugins:{tooltip:{callbacks:{title:function(context){const date=new Date(context[0].parsed.x);return date.toISOString().slice(0,10)}}}}}}
 }
if(chartType==='corr_same'){
  const h = tryLoadHRV(); 
  if(!h){ 
    document.getElementById('note').innerHTML = 'HRV CSV not loaded'; 
    preview=[]; 
    cfg = createMessageChart('Please load fitbit_hrv.csv to view this chart');
  }
  else{
    // Show the additional chart below the main chart
    document.getElementById('dualHRVCorrelationCharts').style.display = 'block';
    
    const mapHRV = new Map(h.map(r=>[r.dateISO,r.rmssd])); 
    
    // Same night correlation (for main chart)
    const ptsSame = []; 
    filtered.forEach(r=>{ 
      const key = r.dateISO; 
      const rm = mapHRV.get(key); 
      if(Number.isFinite(r.sleepScore)&&Number.isFinite(rm)&&rm>0) ptsSame.push({x:r.sleepScore,y:rm}) 
    }); 
    
    // Next day correlation (for additional chart)
    const ptsNext = []; 
    filtered.forEach(r=>{ 
      const key = addDaysISO(r.dateISO, 1); 
      const rm = mapHRV.get(key); 
      if(Number.isFinite(r.sleepScore)&&Number.isFinite(rm)&&rm>0) ptsNext.push({x:r.sleepScore,y:rm}) 
    }); 
    
    // Calculate correlations
    let sameCorrelationText = '';
    let nextCorrelationText = '';
    
    if(ptsSame.length > 1){
      const xsSame = ptsSame.map(p => p.x);
      const ysSame = winsorize(ptsSame.map(p => p.y));
      const pearsonSame = calculateCorrelation(xsSame, ysSame);
      const spearmanSame = calculateSpearmanCorrelation(xsSame, ysSame);
      sameCorrelationText = ` • Pearson: ${pearsonSame.toFixed(3)} • Spearman: ${spearmanSame.toFixed(3)}`;
    }
    
    if(ptsNext.length > 1){
      const xsNext = ptsNext.map(p => p.x);
      const ysNext = winsorize(ptsNext.map(p => p.y));
      const pearsonNext = calculateCorrelation(xsNext, ysNext);
      const spearmanNext = calculateSpearmanCorrelation(xsNext, ysNext);
      nextCorrelationText = ` • Pearson: ${pearsonNext.toFixed(3)} • Spearman: ${spearmanNext.toFixed(3)}`;
    }
    
    // Clear main meta text since we'll show it below each chart
    metaText = '';
    
    // Create meta text for the first chart (Same Night) and display it
    const sameNightMetaText = `Same Night: ${ptsSame.length} points${sameCorrelationText}`;
    
    // Add the Same Night meta text below the first chart
    let sameNightMetaElement = document.getElementById('sameNightMeta');
    if (!sameNightMetaElement) {
      sameNightMetaElement = document.createElement('div');
      sameNightMetaElement.id = 'sameNightMeta';
      sameNightMetaElement.className = 'footer-muted';
      sameNightMetaElement.style.marginTop = '8px';
      sameNightMetaElement.style.fontSize = '12px';
      sameNightMetaElement.style.color = '#a9b3d8';
      sameNightMetaElement.style.textAlign = 'left';
      // Insert after the main chart
      document.getElementById('chart').parentNode.insertBefore(sameNightMetaElement, document.getElementById('chart').nextSibling);
    }
    sameNightMetaElement.textContent = sameNightMetaText;
    
    // Create meta text for the second chart (Next Day) and display it
    const nextDayMetaText = `Next Day: ${ptsNext.length} points${nextCorrelationText}`;
    
    // Add the Next Day meta text below the second chart
    let nextDayMetaElement = document.getElementById('nextDayMeta');
    if (!nextDayMetaElement) {
      nextDayMetaElement = document.createElement('div');
      nextDayMetaElement.id = 'nextDayMeta';
      nextDayMetaElement.className = 'footer-muted';
      nextDayMetaElement.style.marginTop = '8px';
      nextDayMetaElement.style.fontSize = '12px';
      nextDayMetaElement.style.color = '#a9b3d8';
      nextDayMetaElement.style.textAlign = 'left';
      document.getElementById('dualHRVCorrelationCharts').appendChild(nextDayMetaElement);
    }
    nextDayMetaElement.textContent = nextDayMetaText;
    
    // Main chart configuration (Same Night)
    cfg = {
      type: 'scatter',
      data: {
        datasets: [{
          label: 'Sleep Score vs RMSSD (Same Night)',
          data: ptsSame,
          backgroundColor: palette[2],
          borderColor: palette[2],
          pointRadius: 4,
          pointHoverRadius: 6
        }]
      },
      options: {
        responsive: true,
        scales: {
          x: {
            title: { display: true, text: 'Sleep Score' },
            min: 0,
            max: 100
          },
          y: {
            title: { display: true, text: 'RMSSD' }
          }
        }
      }
    };
    
    // Additional chart configuration (Next Day)
    const nextConfig = {
      type: 'scatter',
      data: {
        datasets: [{
          label: 'Sleep Score vs RMSSD (Next Day)',
          data: ptsNext,
          backgroundColor: palette[3],
          borderColor: palette[3],
          pointRadius: 4,
          pointHoverRadius: 6
        }]
      },
      options: {
        responsive: true,
        scales: {
          x: {
            title: { display: true, text: 'Sleep Score' },
            min: 0,
            max: 100
          },
          y: {
            title: { display: true, text: 'RMSSD' }
          }
        }
      }
    };
    
    // Render the additional chart
    const nextCtx = document.getElementById('hrvCorrNextChart').getContext('2d');
    
    // Destroy existing additional chart if it exists
    if(window.hrvCorrNextChart && typeof window.hrvCorrNextChart.destroy === 'function') {
      window.hrvCorrNextChart.destroy();
    }
    
    window.hrvCorrNextChart = new Chart(nextCtx, nextConfig);
    
    // Add debounced resize listener for the second chart
    let resizeTimeout;
    const handleResize = function() {
      clearTimeout(resizeTimeout);
      resizeTimeout = setTimeout(function() {
        if (window.hrvCorrNextChart && typeof window.hrvCorrNextChart.resize === 'function' && 
            document.getElementById('dualHRVCorrelationCharts').style.display !== 'none') {
          window.hrvCorrNextChart.resize();
        }
      }, 100);
    };
    
    // Remove any existing listener first
    if (window.hrvCorrResizeHandler) {
      window.removeEventListener('resize', window.hrvCorrResizeHandler);
    }
    
    // Add new listener and store reference
    window.hrvCorrResizeHandler = handleResize;
    window.addEventListener('resize', handleResize);
    
    // Set preview data
    preview = ptsSame.slice(0,50).map(p=>({sleepScore:fmt(p.x),rmssd:fmt(p.y)}));
  }
}
 if (chartType === 'hrv_heatmap') {
   const h = tryLoadHRV();
   if (!h) {
     document.getElementById('note').innerHTML = 'HRV CSV not loaded';
     preview = [];
     cfg = createMessageChart('Please load fitbit_hrv.csv to view this chart');
   } else {
     // Filter HRV data by date range
     const from = document.getElementById('dateFrom').value;
     const to = document.getElementById('dateTo').value;
     const filteredHRV = h.filter(r => {
       if (from && r.dateISO < from) return false;
       if (to && r.dateISO > to) return false;
       return true;
     });

     if (filteredHRV.length === 0) {
       document.getElementById('note').innerHTML = 'No HRV values inside selected date range.';
       preview = [];
       cfg = { type: 'bar', data: { labels: [], datasets: [] } };
       metaText = 'No HRV data available for selected date range';
     } else {
       // Update meta text with filtered data (only valid HRV values)
       const validHRV = filteredHRV.filter(r => Number.isFinite(r.rmssd));
       const totalHRV = validHRV.reduce((sum, r) => sum + r.rmssd, 0);
       const avgHRV = validHRV.length > 0 ? totalHRV / validHRV.length : 0;
       const minHRV = validHRV.length > 0 ? Math.min(...validHRV.map(r => r.rmssd)) : 0;
       const maxHRV = validHRV.length > 0 ? Math.max(...validHRV.map(r => r.rmssd)) : 0;
       metaText = `${validHRV.length} HRV readings • range ${minHRV.toFixed(1)} to ${maxHRV.toFixed(1)} • avg ${avgHRV.toFixed(1)}`;
       const dayOrder = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'];

       // Robust weekday from ISO date without TZ drift
       const getDayNameUTC = iso => {
         const d = new Date(iso + 'T00:00:00Z');
         return ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][d.getUTCDay()];
       };

       // Bucket HRV by weekday
       const buckets = new Map(dayOrder.map(d => [d, []]));
       filteredHRV.forEach(r => {
         const dn = getDayNameUTC(r.dateISO);
         if (buckets.has(dn)) buckets.get(dn).push(r.rmssd);
       });

       // Compute averages (keep all 7 days; if empty, avg = NaN)
       const rows = dayOrder.map(day => {
         const arr = buckets.get(day);
         const avg = arr.length ? arr.reduce((s,v)=>s+v,0) / arr.length : NaN;
         return { day, avg, n: arr.length };
       });

       // Only plot tiles that have data
       const heatmapData = rows
         .filter(r => Number.isFinite(r.avg))
         .map(r => ({ x: r.day, y: 'HRV', v: r.avg }));

       // Only show days with data in preview
       preview = rows
         .filter(r => Number.isFinite(r.avg))
         .map(r => ({
           day: r.day,
           avgHRV: r.avg.toFixed(2),
           count: r.n
         }));

       // Get top 20 highest HRV days
       const top20HRV = filteredHRV
         .filter(r => Number.isFinite(r.rmssd) && r.rmssd > 0)
         .sort((a, b) => b.rmssd - a.rmssd)
         .slice(0, 20)
         .map(r => {
           const date = new Date(r.dateISO + 'T00:00:00Z');
           const dayOfWeek = date.toLocaleDateString('en-US', { weekday: 'short' });
           return { date: `${dayOfWeek} ${r.dateISO}`, hrv: r.rmssd.toFixed(1) };
         });
       
       // Get bottom 20 lowest HRV days
       const bottom20HRV = filteredHRV
         .filter(r => Number.isFinite(r.rmssd) && r.rmssd > 0)
         .sort((a, b) => a.rmssd - b.rmssd)
         .slice(0, 20)
         .map(r => {
           const date = new Date(r.dateISO + 'T00:00:00Z');
           const dayOfWeek = date.toLocaleDateString('en-US', { weekday: 'short' });
           return { date: `${dayOfWeek} ${r.dateISO}`, hrv: r.rmssd.toFixed(1) };
         });
       
       // Render the HRV tables
       renderTopHRVTable(top20HRV);
       renderBottomHRVTable(bottom20HRV);
       
       // Render the HRV CUSUM chart
       renderHRVCUSUMChart(filteredHRV);

       if (heatmapData.length === 0) {
         document.getElementById('note').innerHTML = 'No HRV values inside selected date range.';
         cfg = { type: 'bar', data: { labels: [], datasets: [] } };
       } else {
       const minV = Math.min(...heatmapData.map(d => d.v));
       const maxV = Math.max(...heatmapData.map(d => d.v));

       const colorFor = v => {
         if (!(maxV > minV)) return 'rgb(128,128,128)';  // zero-variance guard
         const t = (v - minV) / (maxV - minV);           // 0..1
         const r = Math.round(255 * (1 - t));
         const b = Math.round(255 * t);
         return `rgb(${r},0,${b})`;                      // red→blue
       };

       // Check if matrix chart type is available, fallback to bar chart
       if (Chart.controllers && Chart.controllers.matrix) {
         cfg = {
           type: 'matrix',
         data: {
           datasets: [{
             label: 'Average HRV by Day of Week',
             data: heatmapData,
             backgroundColor: ctx => colorFor(ctx.raw.v),   // <-- use raw.v
             width: () => 70,
             height: () => 40,
             borderWidth: 1,
             borderColor: '#1a2349'
           }]
         },
         options: {
           responsive: true,
           plugins: {
             legend: { 
               display: true,
               position: 'bottom',
               labels: {
                 generateLabels: function(chart) {
                   const minV = Math.min(...heatmapData.map(d => d.v));
                   const maxV = Math.max(...heatmapData.map(d => d.v));
                   return [
                      {
                        text: `Lowest HRV (${minV.toFixed(1)})`,
                        fillStyle: 'rgb(255,0,0)',
                        strokeStyle: 'rgb(255,0,0)',
                        lineWidth: 2,
                        fontColor: '#e6eaf3'
                      },
                      {
                        text: `Highest HRV (${maxV.toFixed(1)})`,
                        fillStyle: 'rgb(0,0,255)',
                        strokeStyle: 'rgb(0,0,255)',
                        lineWidth: 2,
                        fontColor: '#e6eaf3'
                      }
                   ];
                 },
                    color: '#e6eaf3',
                 font: { size: 12 }
               }
             },
             tooltip: {
               callbacks: {
                 title: c => c[0].raw.x,
                 label: c => `Average HRV: ${c.raw.v.toFixed(2)}`
               }
             }
           },
           scales: {
             x: {
               type: 'category',
               labels: heatmapData.map(d => d.x),
               title: { display: true, text: 'Day of Week' },
               offset: true,
               grid: { color: '#1a2349' },
               ticks: { color: '#9aa5c6' }
             },
             y: {
               type: 'category',
               labels: ['HRV'],
               title: { display: true, text: 'HRV (RMSSD)' },
               offset: true,
               grid: { color: '#1a2349' },
               ticks: { color: '#9aa5c6' }
             }
           }
         }
       };
       } else {
         // Fallback to bar chart if matrix is not available
         const labels = heatmapData.map(d => d.x);
         const data = heatmapData.map(d => d.v);
         const backgroundColors = heatmapData.map(d => colorFor(d.v));
         
         cfg = {
           type: 'bar',
           data: {
             labels: labels,
             datasets: [{
               label: 'Average HRV by Day of Week',
               data: data,
               backgroundColor: backgroundColors,
               borderColor: '#1a2349',
               borderWidth: 1
             }]
           },
           options: {
             responsive: true,
             plugins: {
               legend: { 
                 display: true,
                 position: 'bottom',
                 labels: {
                   generateLabels: function(chart) {
                     const minV = Math.min(...heatmapData.map(d => d.v));
                     const maxV = Math.max(...heatmapData.map(d => d.v));
                     return [
                      {
                        text: `Low HRV (${minV.toFixed(1)})`,
                        fillStyle: 'rgb(255,0,0)',
                        strokeStyle: 'rgb(255,0,0)',
                        lineWidth: 2,
                        fontColor: '#e6eaf3'
                      },
                      {
                        text: `High HRV (${maxV.toFixed(1)})`,
                        fillStyle: 'rgb(0,0,255)',
                        strokeStyle: 'rgb(0,0,255)',
                        lineWidth: 2,
                        fontColor: '#e6eaf3'
                      }
                     ];
                   },
                   color: '#e6eaf3',
                   font: { size: 12 }
                 }
               },
               tooltip: {
                 callbacks: {
                   title: c => c[0].label,
                   label: c => `Average HRV: ${c.parsed.y.toFixed(2)}`
                 }
               }
             },
             scales: {
               x: {
                 title: { display: true, text: 'Day of Week' },
                 grid: { color: '#1a2349' },
                 ticks: { color: '#9aa5c6' }
               },
               y: {
                 title: { display: true, text: 'HRV (RMSSD)' },
                 grid: { color: '#1a2349' },
                 ticks: { color: '#9aa5c6' }
               }
             }
           }
         };
       }
     }
     }
   }
 }

 // Steps charts
 if (chartType === 'daily_steps') {
   console.log('Daily steps chart selected');
   const s = tryLoadSteps();
   console.log('Steps data:', s);
   if (!s) {
     document.getElementById('note').innerHTML = 'Steps CSV not loaded';
     preview = [];
     cfg = createMessageChart('Please load fitbit_activity.csv to view this chart');
   } else {
     const from = document.getElementById('dateFrom').value;
     const to = document.getElementById('dateTo').value;
     const filtered = s.filter(r => {
       if (from && r.dateISO < from) return false;
       if (to && r.dateISO > to) return false;
       return true;
     });
    
    // Check toggle state to determine view mode (0=Daily, 1=Monthly, 2=Yearly)
    const toggleValue = parseInt(document.getElementById('stepsViewToggle').value);
    const isMonthlyView = toggleValue === 1;
    const isYearlyView = toggleValue === 2;
    
    if (isMonthlyView) {
      // Reset date inputs to normal date pickers and constrain to data/today
      const df = document.getElementById('dateFrom');
      const dt = document.getElementById('dateTo');
      df.type = 'date'; dt.type = 'date';
      try {
        let minD = s[0]?.date;
        for (const r of s){ if (r.date < minD) minD = r.date; }
        const minISO = minD ? new Date(minD).toISOString().slice(0,10) : '';
        const todayISO = new Date().toISOString().slice(0,10);
        df.min = minISO; dt.min = minISO;
        df.max = todayISO; dt.max = todayISO;
      } catch(_) { /* ignore min/max calc */ }
      
      // If inputs are invalid/empty, set default to last 6 months for Monthly view
      const today = new Date();
      const six = new Date(); six.setMonth(today.getMonth()-6);
      const isISO = (s)=> /^\d{4}-\d{2}-\d{2}$/.test(String(s||''));
      if (!isISO(df.value) || !isISO(dt.value)){
        df.value = six.toISOString().slice(0,10);
        dt.value = today.toISOString().slice(0,10);
      }
      
      // Re-filter data with updated date range
      const from = df.value;
      const to = dt.value;
      const filteredForMonthly = s.filter(r => {
       if (from && r.dateISO < from) return false;
       if (to && r.dateISO > to) return false;
       return true;
     });
      
      // Monthly view - same as monthly_steps
      const monthly = groupStepsByMonth(filteredForMonthly);
     const ds = monthly.map(r => ({ x: r.date, y: (Number.isFinite(r.steps) && r.steps > 0) ? r.steps : null }));
     // Prepare monthly summaries for download buttons
     window.stepsMonthlySummary = monthly.map(r=>({ date: r.date, key: r.key, steps: Number(r.steps) }));
     preview = monthly.map(r => ({ month: r.key, steps: fmt(r.steps, 0) }));
     const avgSteps = monthly.reduce((sum, r) => sum + r.steps, 0) / monthly.length;
     metaText = `${monthly.length} months • avg ${avgSteps.toFixed(0)} steps per month`;
     
      // Add trend for monthly view
     if (monthly.length >= 2) {
       const validData = monthly.map(r => r.steps).filter(s => Number.isFinite(s) && s > 0);
       if (validData.length >= 2) {
         const regressionData = validData.map((steps, index) => ({ x: index, y: steps }));
         const regression = calculateLinearRegression(regressionData);
         if (regression) {
           const trend = regression.slope > 0 ? '+' : '';
           metaText += ` • trend ${trend}${regression.slope.toFixed(1)} steps`;
         }
       }
     }
     cfg = {
       type: 'line',
       data: {
         datasets: [{
           label: 'Monthly Avg Steps',
           data: ds,
           borderColor: '#4CAF50',
           backgroundColor: 'rgba(76, 175, 80, 0.1)',
           tension: 0.2,
           fill: true,
           spanGaps: false
         }]
       },
       options: {
         responsive: true,
         scales: {
           x: { type: 'time', time: { unit: 'month' } },
           y: { title: { display: true, text: 'Steps' }, min: 0 }
         },
         plugins: {
            legend: { display: true },
           tooltip: {
             callbacks: {
               title: function(context) {
                  const date = new Date(context[0].parsed.x);
                  return date.toLocaleDateString('en-US', { year: 'numeric', month: 'short' });
               },
               label: function(context) {
                 return context.dataset.label + ': ' + Math.round(context.parsed.y).toLocaleString();
               }
             }
           }
         }
       }
     };
      // Render sedentary minutes line chart for monthly view
      try {
        const sedDiv = document.getElementById('sedentaryLineChart');
        const sedCanvas = document.getElementById('sedentaryLineCanvas');
        if (sedDiv && sedCanvas){
          sedDiv.style.display = 'block';
          const monthlyNonSed = monthly.map(r=>{ const sm = Number(r.sedentaryMinutes); const ns = Number.isFinite(sm)? Math.max(0, 1440 - sm) : NaN; return ({ x: r.date, y: ns, key: r.key }); });
          window.nonSedMonthlySummary = monthlyNonSed.map(p=>({ date: p.x, key: p.key, nonSedentaryMinutes: p.y }));
          if (window.sedentaryChart && window.sedentaryChart.destroy) {
            try { window.sedentaryChart.destroy(); } catch(_){}
          }
          const maxMonthlyY = monthlyNonSed.length? Math.max(...monthlyNonSed.map(p=>p.y)) : 0;
          const suggestedMaxMonthly = Math.ceil((maxMonthlyY||480)/60)*60; // round to next hour
          window.sedentaryChart = new Chart(sedCanvas.getContext('2d'), {
            type: 'line',
            data: { datasets: [{ label: 'Monthly Avg Non‑Sedentary Hours', data: monthlyNonSed, borderColor: '#ff9800', backgroundColor: 'rgba(255,152,0,0.15)', tension: 0.2, fill: true, spanGaps: false }] },
            options: { responsive:true, scales:{ x:{ type:'time', time:{ unit:'month' } }, y:{ title:{ display:true, text:'Hours' }, min:0, suggestedMax:suggestedMaxMonthly, ticks:{ stepSize:60, callback:(v)=>{ const h = v/60; return Number.isInteger(h) ? `${h}h` : `${h.toFixed(1)}h`; } } } }, plugins:{ legend:{ display:true }, tooltip:{ callbacks:{ title:(items)=>{ try{ const d=new Date(items[0].parsed.x); return d.toISOString().slice(0,10); }catch(_){ return items[0].label; } }, label:(ctx)=>{ const m = Number(ctx.parsed.y); if(!Number.isFinite(m)) return ''; const h = Math.floor(m/60); const mm = Math.round(m%60); const hh = h>0? `${h}h `: ''; return `${hh}${mm}m`; } } } } }
          });
          const sedMeta = document.getElementById('sedentaryMeta');
          if (sedMeta){
            if (monthlyNonSed.length){
              const valid = monthlyNonSed.filter(p=>Number.isFinite(p.y));
              const avgM = valid.length ? Math.round(valid.reduce((s,p)=>s+p.y,0)/valid.length) : 0;
              const ah = Math.floor(avgM/60); const am = Math.round(avgM%60);
              sedMeta.innerText = `${valid.length} months • avg ${ah>0? ah+"h ":""}${am}m non‑sedentary per month`;
            } else {
              sedMeta.innerText = '';
            }
          }
        }
      } catch(_) { /* ignore */ }
    } else if (isYearlyView) {
      // Yearly view - filter by selected numeric year range
      const yearly = groupStepsByYear(s);
      let filteredYearly = yearly;
      try {
        const df = document.getElementById('dateFrom');
        const dt = document.getElementById('dateTo');
        const yf = Number(df.value);
        const yt = Number(dt.value);
        if (Number.isFinite(yf) && Number.isFinite(yt)) {
          const minY = Math.min(yf, yt);
          const maxY = Math.max(yf, yt);
          filteredYearly = yearly.filter(r => {
            const y = r.date.getFullYear();
            return y >= minY && y <= maxY;
          });
        }
      } catch(_) { /* best-effort filter */ }
      
      // Update date inputs to show the full range of years (numeric inputs)
      try {
        const df = document.getElementById('dateFrom');
        const dt = document.getElementById('dateTo');
        // Determine available data range and current year
        let minY = s[0].date.getFullYear();
        for (const r of s){ const y = r.date.getFullYear(); if (y < minY) minY = y; }
        const currentYear = new Date().getFullYear();
        // Switch to numeric year inputs and constrain to data/current year
        const wasNotYearly = df.type !== 'number' || dt.type !== 'number';
        df.type = 'number'; dt.type = 'number';
        df.min = String(minY); dt.min = String(minY);
        df.max = String(currentYear); dt.max = String(currentYear);
        // Initialize only on first entry into yearly or when values invalid
        const dfValNum = Number(df.value);
        const dtValNum = Number(dt.value);
        const notInitialized = wasNotYearly || !df.dataset.yearlyInitialized;
        const dfInvalid = !Number.isFinite(dfValNum);
        const dtInvalid = !Number.isFinite(dtValNum);
        if (notInitialized || dfInvalid || dtInvalid) {
          df.value = String(minY);
          dt.value = String(currentYear);
          df.dataset.yearlyInitialized = '1';
          dt.dataset.yearlyInitialized = '1';
        } else {
          // Clamp to available range if out of bounds, but preserve user edits otherwise
          if (dfValNum < minY || dfValNum > currentYear) df.value = String(Math.min(Math.max(dfValNum, minY), currentYear));
          if (dtValNum < minY || dtValNum > currentYear) dt.value = String(Math.min(Math.max(dtValNum, minY), currentYear));
        }
      } catch(_) { /* ignore */ }
      
     const ds = filteredYearly.map(r => ({ x: r.date, y: r.steps }));
     // Prepare yearly summaries for download buttons
     window.stepsYearlySummary = filteredYearly.map(r=>({ date: r.date, key: r.key, steps: Number(r.steps) }));
     preview = filteredYearly.map(r => ({ year: r.key, steps: fmt(r.steps, 0) }));
     const avgSteps = filteredYearly.reduce((sum, r) => sum + r.steps, 0) / filteredYearly.length;
     metaText = `${filteredYearly.length} years • avg ${avgSteps.toFixed(0)} steps per year`;
     
      // Add trend for yearly view
     if (filteredYearly.length >= 2) {
       const validData = filteredYearly.map(r => r.steps).filter(s => Number.isFinite(s) && s > 0);
       if (validData.length >= 2) {
         const regressionData = validData.map((steps, index) => ({ x: index, y: steps }));
         const regression = calculateLinearRegression(regressionData);
         if (regression) {
           const trend = regression.slope > 0 ? '+' : '';
           metaText += ` • trend ${trend}${regression.slope.toFixed(1)} steps`;
         }
       }
     }
     cfg = {
       type: 'bar',
       data: {
         datasets: [{
           label: 'Yearly Avg Steps',
           data: ds,
           backgroundColor: '#4CAF50',
           borderColor: '#2E7D32',
           borderWidth: 1
         }]
       },
       options: {
         responsive: true,
         scales: {
           x: { type: 'time', time: { unit: 'year' } },
           y: { title: { display: true, text: 'Steps' }, min: 0 }
         },
         plugins: {
            legend: { display: true },
           tooltip: {
             callbacks: {
                title: function(context) {
                  const date = new Date(context[0].parsed.x);
                  return date.toLocaleDateString('en-US', { year: 'numeric' });
               },
               label: function(context) {
                 return context.dataset.label + ': ' + Math.round(context.parsed.y).toLocaleString();
               }
             }
           }
         }
       }
     };

     // Render non-sedentary hours as a bar chart for yearly view
     try {
       const sedDiv = document.getElementById('sedentaryLineChart');
       const sedCanvas = document.getElementById('sedentaryLineCanvas');
       if (sedDiv && sedCanvas){
         sedDiv.style.display = 'block';
         const yearlyNonSed = filteredYearly.map(r=>{ const sm = Number(r.sedentaryMinutes); const ns = Number.isFinite(sm)? Math.max(0, 1440 - sm) : NaN; return ({ x: r.date, y: ns, key: r.key }); });
         window.nonSedYearlySummary = yearlyNonSed.map(p=>({ date: p.x, key: p.key, nonSedentaryMinutes: p.y }));
         // Calculate day counts for each year
         const yearlyDayCounts = new Map();
         filteredYearly.forEach(r => {
           const year = r.key;
           if (!yearlyDayCounts.has(year)) yearlyDayCounts.set(year, 0);
           // Count days with valid sedentary data (excluding zeros)
           const validDays = s.filter(day => {
             const dayYear = day.date.getFullYear().toString();
             const sm = Number(day.sedentaryMinutes);
             return dayYear === year && Number.isFinite(sm) && sm > 0;
           }).length;
           yearlyDayCounts.set(year, validDays);
         });
         if (window.sedentaryChart && window.sedentaryChart.destroy) {
           try { window.sedentaryChart.destroy(); } catch(_){}
         }
         const maxYearlyY = yearlyNonSed.length? Math.max(...yearlyNonSed.map(p=>p.y)) : 0;
         const suggestedMaxYearly = Math.ceil((maxYearlyY||480)/60)*60; // round to next hour
         window.sedentaryChart = new Chart(sedCanvas.getContext('2d'), {
           type: 'bar',
           data: { datasets: [{ label: 'Yearly Avg Non‑Sedentary Hours', data: yearlyNonSed, backgroundColor: 'rgba(255,152,0,0.45)', borderColor: '#ff9800', borderWidth: 1 }] },
           options: { responsive:true, scales:{ x:{ type:'time', time:{ unit:'year' } }, y:{ title:{ display:true, text:'Hours' }, min:0, suggestedMax:suggestedMaxYearly, ticks:{ stepSize:60, callback:(v)=>{ const h = v/60; return Number.isInteger(h) ? `${h}h` : `${h.toFixed(1)}h`; } } } }, plugins:{ legend:{ display:true }, tooltip:{ callbacks:{ title:(items)=>{ try{ const d=new Date(items[0].parsed.x); return d.toISOString().slice(0,10); }catch(_){ return items[0].label; } }, label:(ctx)=>{ const m = Number(ctx.parsed.y); if(!Number.isFinite(m)) return ''; const h = Math.floor(m/60); const mm = Math.round(m%60); const hh = h>0? `${h}h `: ''; const year = new Date(ctx.parsed.x).getFullYear().toString(); const dayCount = yearlyDayCounts.get(year) || 0; return `${hh}${mm}m (${dayCount} days)`; } } } } }
         });
         const sedMeta = document.getElementById('sedentaryMeta');
         if (sedMeta){
           if (yearlyNonSed.length){
             const valid = yearlyNonSed.filter(p=>Number.isFinite(p.y));
             const avgM = valid.length ? Math.round(valid.reduce((s,p)=>s+p.y,0)/valid.length) : 0;
             const ah = Math.floor(avgM/60); const am = Math.round(avgM%60);
             sedMeta.innerText = `${valid.length} years • avg ${ah>0? ah+"h ": ''}${am}m non‑sedentary per year`;
           } else {
             sedMeta.innerText = '';
           }
         }
       }
     } catch(_) { /* ignore */ }
    } else {
      // Reset date inputs to normal date pickers and constrain to data/today
      const df = document.getElementById('dateFrom');
      const dt = document.getElementById('dateTo');
      df.type = 'date'; dt.type = 'date';
      try {
        let minD = s[0]?.date;
        for (const r of s){ if (r.date < minD) minD = r.date; }
        const minISO = minD ? new Date(minD).toISOString().slice(0,10) : '';
        const todayISO = new Date().toISOString().slice(0,10);
        df.min = minISO; dt.min = minISO;
        df.max = todayISO; dt.max = todayISO;
      } catch(_) { /* ignore min/max calc */ }
      
      // If inputs are invalid/empty, set default to last 6 months for Daily view
      const today = new Date();
      const six = new Date(); six.setMonth(today.getMonth()-6);
      const isISO = (s)=> /^\d{4}-\d{2}-\d{2}$/.test(String(s||''));
      if (!isISO(df.value) || !isISO(dt.value)){
        df.value = six.toISOString().slice(0,10);
        dt.value = today.toISOString().slice(0,10);
      }
      
      // Re-filter data with updated date range
      const from = df.value;
      const to = dt.value;
      const filteredForDaily = s.filter(r => {
        if (from && r.dateISO < from) return false;
        if (to && r.dateISO > to) return false;
        return true;
      });
      
      // Daily view - original behavior
      // Render sedentary minutes line chart for daily view
      try {
        const sedDiv = document.getElementById('sedentaryLineChart');
        const sedCanvas = document.getElementById('sedentaryLineCanvas');
        if (sedDiv && sedCanvas){
          sedDiv.style.display = 'block';
          const dailyNonSed = filteredForDaily.map(r=>{ const sm = Number(r.sedentaryMinutes); const ns = Number.isFinite(sm)? Math.max(0, 1440 - sm) : NaN; return ({ x: r.date, y: ns }); });
          if (window.sedentaryChart && window.sedentaryChart.destroy) {
            try { window.sedentaryChart.destroy(); } catch(_){}
          }
          const maxDailyY = dailyNonSed.length? Math.max(...dailyNonSed.map(p=>p.y)) : 0;
          const suggestedMaxDaily = Math.ceil((maxDailyY||480)/60)*60;
          window.sedentaryChart = new Chart(sedCanvas.getContext('2d'), {
            type: 'line',
            data: { datasets: [{ label: 'Daily Non‑Sedentary Hours', data: dailyNonSed, borderColor: '#ff9800', backgroundColor: 'rgba(255,152,0,0.15)', tension: 0.2, fill: true, spanGaps: false }] },
            options: { responsive:true, scales:{ x:{ type:'time', time:{ unit:'day' } }, y:{ title:{ display:true, text:'Hours' }, min:0, suggestedMax:suggestedMaxDaily, ticks:{ stepSize:60, callback:(v)=>{ const h = v/60; return Number.isInteger(h) ? `${h}h` : `${h.toFixed(1)}h`; } } } }, plugins:{ legend:{ display:true }, tooltip:{ callbacks:{ title:(items)=>{ try{ const d=new Date(items[0].parsed.x); return d.toISOString().slice(0,10); }catch(_){ return items[0].label; } }, label:(ctx)=>{ const m = Number(ctx.parsed.y); if(!Number.isFinite(m)) return ''; const h = Math.floor(m/60); const mm = Math.round(m%60); const hh = h>0? `${h}h `: ''; return `${hh}${mm}m`; } } } } }
          });
          const sedMeta = document.getElementById('sedentaryMeta');
          if (sedMeta){
            if (dailyNonSed.length){
              const valid = dailyNonSed.filter(p=>Number.isFinite(p.y));
              const avgM = valid.length ? Math.round(valid.reduce((s,p)=>s+p.y,0)/valid.length) : 0;
              const ah = Math.floor(avgM/60); const am = Math.round(avgM%60);
              sedMeta.innerText = `${valid.length} days • avg ${ah>0? ah+"h ":""}${am}m non‑sedentary hours per day`;
            } else {
              sedMeta.innerText = '';
            }
          }
        }
      } catch(_) { /* ignore */ }
      const ds = filteredForDaily.map(r => ({
        x: r.date,
        y: (Number.isFinite(r.steps) && r.steps > 0) ? r.steps : null
      }));
      // Also compute summaries for download buttons from the current filtered range
      try {
        const monthlyFromDaily = groupStepsByMonth(filteredForDaily);
        window.stepsMonthlySummary = monthlyFromDaily.map(r=>({ date: r.date, key: r.key, steps: Number(r.steps) }));
        const monthlyNonSed = monthlyFromDaily.map(r=>{ const sm = Number(r.sedentaryMinutes); const ns = Number.isFinite(sm)? Math.max(0,1440-sm) : NaN; return ({ date: r.date, key: r.key, nonSedentaryMinutes: ns }); });
        window.nonSedMonthlySummary = monthlyNonSed;
        const yearlyFromDaily = groupStepsByYear(filteredForDaily);
        window.stepsYearlySummary = yearlyFromDaily.map(r=>({ date: r.date, key: r.key, steps: Number(r.steps) }));
        const yearlyNonSed = yearlyFromDaily.map(r=>{ const sm = Number(r.sedentaryMinutes); const ns = Number.isFinite(sm)? Math.max(0,1440-sm) : NaN; return ({ date: r.date, key: r.key, nonSedentaryMinutes: ns }); });
        window.nonSedYearlySummary = yearlyNonSed;
      } catch(_) { /* ignore */ }
      preview = filteredForDaily.map(r => ({ date: r.dateISO, steps: r.steps }));
      const avgSteps = filteredForDaily.reduce((sum, r) => sum + r.steps, 0) / filteredForDaily.length;
      metaText = `${filteredForDaily.length} days • range ${filteredForDaily.length ? filteredForDaily[0].dateISO : ''} to ${filteredForDaily.length ? filteredForDaily[filteredForDaily.length-1].dateISO : ''} • avg ${avgSteps.toFixed(0)} steps`;
      
      // Add trend for daily_steps chart (excluding zero values which represent non-wear days)
      if (filteredForDaily.length >= 2) {
        const validData = filteredForDaily.map(r => r.steps).filter(s => Number.isFinite(s) && s > 0);
        if (validData.length >= 2) {
          const regressionData = validData.map((steps, index) => ({ x: index, y: steps }));
          const regression = calculateLinearRegression(regressionData);
          if (regression) {
            const trend = regression.slope > 0 ? '+' : '';
            metaText += ` • trend ${trend}${regression.slope.toFixed(3)} (${validData.length} active days)`;
          }
        }
      }
      cfg = {
        type: 'line',
        data: {
          datasets: [{
            label: 'Daily Steps',
            data: ds,
            borderColor: '#4CAF50',
            backgroundColor: 'rgba(76, 175, 80, 0.1)',
            tension: 0.2,
          fill: true,
          spanGaps: false
          }]
        },
        options: {
          responsive: true,
          scales: {
            x: { type: 'time', time: { unit: 'day' } },
            y: { title: { display: true, text: 'Steps' }, min: 0 }
          },
          plugins: {
            legend: { display: true },
            tooltip: {
              callbacks: {
                title: function(context) {
                  const date = new Date(context[0].parsed.x);
                  return date.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
                },
                label: function(context) {
                  return context.dataset.label + ': ' + Math.round(context.parsed.y).toLocaleString();
                }
              }
            }
          }
        }
      };
    }
    
    // Add histogram functionality to daily_steps
    if (s) {
      // Check toggle state to determine view mode (0=Daily, 1=Monthly, 2=Yearly)
      const toggleValue = parseInt(document.getElementById('stepsViewToggle').value);
      const isMonthlyView = toggleValue === 1;
      const isYearlyView = toggleValue === 2;
      
      // Always use daily data for histogram to show useful distribution patterns
     const arr = s.map(r => r.steps).filter(s => Number.isFinite(s) && s > 0);
      const count = arr.length;
      const unit = 'days';
      const avgSteps = arr.reduce((sum, v) => sum + v, 0) / arr.length;
      
     const max = Math.max(...arr);
     const binSize = 1000;
     const numBins = Math.ceil(max / binSize);
     const hist = new Array(numBins).fill(0);
     
     arr.forEach(v => {
       const binIndex = Math.floor(v / binSize);
       if (binIndex < numBins) {
         hist[binIndex]++;
       }
     });
     
    const labels = [...Array(numBins)].map((_, i) => 
      `${i * binSize + 1}-${(i + 1) * binSize}`
    );
    
      // Get top 20 highest steps days (always use daily data for tables)
    const top20Steps = s
      .filter(r => Number.isFinite(r.steps) && r.steps > 0)
      .sort((a, b) => b.steps - a.steps)
      .slice(0, 20)
      .map(r => {
        const date = new Date(r.date);
        const dayOfWeek = date.toLocaleDateString('en-US', { weekday: 'short' });
        return { date: `${dayOfWeek} ${r.dateISO}`, steps: Math.round(r.steps).toLocaleString() };
      });
    
    // Get bottom 20 lowest steps days (more than 100 steps)
    const bottom20Steps = s
      .filter(r => Number.isFinite(r.steps) && r.steps > 100)
      .sort((a, b) => a.steps - b.steps)
      .slice(0, 20)
      .map(r => {
        const date = new Date(r.date);
        const dayOfWeek = date.toLocaleDateString('en-US', { weekday: 'short' });
        return { date: `${dayOfWeek} ${r.dateISO}`, steps: Math.round(r.steps).toLocaleString() };
      });
    
    // Render the top 20 steps table
    renderTopStepsTable(top20Steps);
    
    // Render the bottom 20 steps table
    renderBottomStepsTable(bottom20Steps);
      
      // Create histogram chart configuration
      const histogramConfig = {
       type: 'bar',
       data: {
         labels,
         datasets: [{
           label: 'Days',
           data: hist,
           backgroundColor: '#4CAF50',
           borderColor: '#2E7D32',
           borderWidth: 1
         }]
       },
       options: {
         responsive: true,
         scales: {
           y: { beginAtZero: true, title: { display: true, text: 'Count' } },
           x: { title: { display: true, text: 'Steps Range' } }
         }
       }
     };
      
      // Store histogram config for rendering
      window.stepsHistogramConfig = histogramConfig;
      
      // Set histogram meta text
      const from = document.getElementById('dateFrom').value;
      const to = document.getElementById('dateTo').value;
      const histogramMetaText = `${count} ${unit} • range ${from || 'start'} to ${to || 'end'} • avg ${avgSteps.toFixed(0)} steps`;
      const histogramMetaElement = document.getElementById('histogramMeta');
      if (histogramMetaElement) {
        histogramMetaElement.innerHTML = histogramMetaText;
      }
    }
  }
}




if (chartType === 'corr_steps_hrv') {
  const s = tryLoadSteps();
  const h = tryLoadHRV();
  if (!s || !h) {
    document.getElementById('note').innerHTML = 'Steps or HRV CSV not loaded';
    preview = [];
    cfg = createMessageChart('Please load both fitbit_activity.csv and fitbit_hrv.csv to view this chart');
  } else {
    // Show the additional chart below the main chart
    document.getElementById('dualStepsCorrelationCharts').style.display = 'block';
    
    const from = document.getElementById('dateFrom').value;
    const to = document.getElementById('dateTo').value;
    
    // Filter steps data by date range
    const filteredSteps = s.filter(r => {
      if (from && r.dateISO < from) return false;
      if (to && r.dateISO > to) return false;
      return true;
    });
    
    // Create map of HRV data by date
    const mapHRV = new Map(h.map(r => [r.dateISO, r.rmssd]));
    
    // Create correlation points: previous day's steps vs current day's HRV
    const ptsHRV = [];
    filteredSteps.forEach(r => {
      const hrvDateISO = addDaysISO(r.dateISO, 1);
      const hrvValue = mapHRV.get(hrvDateISO);
      
      if (Number.isFinite(r.steps) && r.steps > 0 && Number.isFinite(hrvValue) && hrvValue > 0) {
        ptsHRV.push({ x: r.steps, y: hrvValue });
      }
    });
    
    // Get sleep data for second chart
    const sleepN = normalizeSleepRows(rawSleep);
    const filteredSleep = filterSleep(sleepN);
    const mapSleep = new Map(filteredSleep.map(r => [sleepKey(r.dateISO), r.sleepScore]));
    
    // Create correlation points: steps vs sleep score
    const ptsSleep = [];
    filteredSteps.forEach(r => {
      const sleepValue = mapSleep.get(r.dateISO);
      
      if (Number.isFinite(r.steps) && r.steps > 0 && Number.isFinite(sleepValue)) {
        ptsSleep.push({ x: r.steps, y: sleepValue });
      }
    });
    
    // Calculate correlations
    let hrvCorrelationText = '';
    let sleepCorrelationText = '';
    
    if (ptsHRV.length >= 2) {
      const xValuesHRV = winsorize(ptsHRV.map(p => p.x));
      const yValuesHRV = ptsHRV.map(p => p.y);
      const pearsonHRV = calculateCorrelation(xValuesHRV, yValuesHRV);
      const spearmanHRV = calculateSpearmanCorrelation(xValuesHRV, yValuesHRV);
      hrvCorrelationText = ` • Pearson: ${pearsonHRV.toFixed(3)} • Spearman: ${spearmanHRV.toFixed(3)}`;
    }
    
    if (ptsSleep.length >= 2) {
      const xValuesSleep = winsorize(ptsSleep.map(p => p.x));
      const yValuesSleep = ptsSleep.map(p => p.y);
      const pearsonSleep = calculateCorrelation(xValuesSleep, yValuesSleep);
      const spearmanSleep = calculateSpearmanCorrelation(xValuesSleep, yValuesSleep);
      sleepCorrelationText = ` • Pearson: ${pearsonSleep.toFixed(3)} • Spearman: ${spearmanSleep.toFixed(3)}`;
    }
    
    // Clear main meta text since we'll show it below each chart
    metaText = '';
    
    // Create meta text for the first chart (Steps vs HRV) and display it
    const stepsHrvMetaText = `Steps vs HRV: ${ptsHRV.length} data points${hrvCorrelationText}`;
    
    // Add the Steps vs HRV meta text below the first chart
    let stepsHrvMetaElement = document.getElementById('stepsHrvMeta');
    if (!stepsHrvMetaElement) {
      stepsHrvMetaElement = document.createElement('div');
      stepsHrvMetaElement.id = 'stepsHrvMeta';
      stepsHrvMetaElement.className = 'footer-muted';
      stepsHrvMetaElement.style.marginTop = '8px';
      stepsHrvMetaElement.style.fontSize = '12px';
      stepsHrvMetaElement.style.color = '#a9b3d8';
      stepsHrvMetaElement.style.textAlign = 'left';
      // Insert after the main chart
      document.getElementById('chart').parentNode.insertBefore(stepsHrvMetaElement, document.getElementById('chart').nextSibling);
    }
    stepsHrvMetaElement.textContent = stepsHrvMetaText;
    
    // Create meta text for the second chart (Steps vs Sleep) and display it
    const stepsSleepMetaText = `Steps vs Sleep Score: ${ptsSleep.length} data points${sleepCorrelationText}`;
    
    // Add the Steps vs Sleep meta text below the second chart
    let stepsSleepMetaElement = document.getElementById('stepsSleepMeta');
    if (!stepsSleepMetaElement) {
      stepsSleepMetaElement = document.createElement('div');
      stepsSleepMetaElement.id = 'stepsSleepMeta';
      stepsSleepMetaElement.className = 'footer-muted';
      stepsSleepMetaElement.style.marginTop = '8px';
      stepsSleepMetaElement.style.fontSize = '12px';
      stepsSleepMetaElement.style.color = '#a9b3d8';
      stepsSleepMetaElement.style.textAlign = 'left';
      document.getElementById('dualStepsCorrelationCharts').appendChild(stepsSleepMetaElement);
    }
    stepsSleepMetaElement.textContent = stepsSleepMetaText;
    
    // Main chart configuration (Steps vs HRV)
    cfg = {
      type: 'scatter',
      data: {
        datasets: [{
          label: 'Previous Day Steps vs HRV',
          data: ptsHRV,
          backgroundColor: '#4CAF50',
          borderColor: '#2E7D32',
          pointRadius: 4,
          pointHoverRadius: 6
        }]
      },
      options: {
        responsive: true,
        scales: {
          x: {
            title: { display: true, text: 'Previous Day Steps' },
            min: 0
          },
          y: {
            title: { display: true, text: 'HRV (RMSSD)' },
            min: 0
          }
        },
        plugins: {
          tooltip: {
            callbacks: {
              title: function() {
                return '';
              },
              label: function(context) {
                return `Steps: ${Math.round(context.parsed.x).toLocaleString()}, HRV: ${context.parsed.y.toFixed(1)}`;
              }
            }
          }
        }
      }
    };
    
    // Additional chart configuration (Steps vs Sleep)
    const sleepConfig = {
      type: 'scatter',
      data: {
        datasets: [{
          label: 'Steps vs Sleep Score',
          data: ptsSleep,
          backgroundColor: '#FF6B6B',
          borderColor: '#D32F2F',
          pointRadius: 4,
          pointHoverRadius: 6
        }]
      },
      options: {
        responsive: true,
        scales: {
          x: {
            title: { display: true, text: 'Steps' },
            min: 0
          },
          y: {
            title: { display: true, text: 'Sleep Score' },
            min: 0,
            max: 100
          }
        },
        plugins: {
          tooltip: {
            callbacks: {
              title: function() {
                return '';
              },
              label: function(context) {
                return `Steps: ${Math.round(context.parsed.x).toLocaleString()}, Sleep Score: ${context.parsed.y.toFixed(1)}`;
              }
            }
          }
        }
      }
    };
    
    // Render the additional chart
    const sleepCtx = document.getElementById('stepsCorrSleepChart').getContext('2d');
    
    // Destroy existing additional chart if it exists
    if(window.stepsCorrSleepChart && typeof window.stepsCorrSleepChart.destroy === 'function') {
      window.stepsCorrSleepChart.destroy();
    }
    
    window.stepsCorrSleepChart = new Chart(sleepCtx, sleepConfig);
    
    // Set preview data
    preview = ptsHRV.slice(0,50).map(p=>({steps:Math.round(p.x).toLocaleString(),hrv:p.y.toFixed(1)}));
  }
}


// RHR Charts
if (chartType === 'daily_rhr') {
  const r = tryLoadRHR();
  if (!r) {
    document.getElementById('note').innerHTML = 'RHR CSV not loaded';
    preview = [];
    cfg = createMessageChart('Please load fitbit_rhr.csv to view this chart');
  } else {
    // Ensure input modes/defaults are correct for RHR
    syncRHRDateInputs();
    const from = document.getElementById('dateFrom').value;
    const to = document.getElementById('dateTo').value;
    
    // Get RHR view toggle value
    const rhrViewToggle = document.getElementById('rhrViewToggle');
    const toggleValue = parseInt(rhrViewToggle.value);
    const isMonthlyView = toggleValue === 1;
    const isYearlyView = toggleValue === 2;
    
    // Filter RHR data by date range
    const filteredRHR = r.filter(record => {
      if (from && record.dateISO < from) return false;
      if (to && record.dateISO > to) return false;
      return true;
    });
    
    let ds;
    
    if (isYearlyView) {
      // Yearly view - same as yearly_rhr
      const yearly = groupRHRByYear(r); // Use all data, not filtered
      const filteredYearly = yearly;
      
      // Inputs are managed by syncRHRDateInputs(); avoid overriding user values here.
      
      ds = filteredYearly.map(r => ({ x: r.date, y: r.rhr }));
      preview = filteredYearly.map(r => ({ 
        year: r.key, 
        rhr: r.rhr.toFixed(1) 
      }));
      
      const avgRHR = avg(filteredYearly.map(r => r.rhr));
      metaText = `${filteredYearly.length} years • avg ${avgRHR.toFixed(1)} bpm`;
      
      // Add trend for yearly RHR chart
      if (filteredYearly.length >= 2) {
        const validData = filteredYearly.map(r => r.rhr).filter(Number.isFinite);
        if (validData.length >= 2) {
          const regressionData = validData.map((rhr, index) => ({ x: index, y: rhr }));
          const regression = calculateLinearRegression(regressionData);
          if (regression) {
            const trend = regression.slope > 0 ? '+' : '';
            metaText += ` • trend ${trend}${regression.slope.toFixed(3)} bpm`;
          }
        }
      }
      
      // chart type tracked via cfg below
    } else if (isMonthlyView) {
      // Reset date inputs to normal date pickers for Monthly view
      const df = document.getElementById('dateFrom');
      const dt = document.getElementById('dateTo');
      df.type = 'date'; dt.type = 'date';
      df.min = ''; dt.min = '';
      df.max = ''; dt.max = '';
      
      // Do not override user-selected dates; use current range
      const monthly = groupRHRByMonth(filteredRHR);
      ds = lineSeries(monthly, 'date', 'rhr');
      preview = monthly.map(r => ({ 
        month: r.key, 
        rhr: r.rhr.toFixed(1) 
      }));
      
      const avgRHR = avg(monthly.map(r => r.rhr));
      metaText = `${monthly.length} months • avg ${avgRHR.toFixed(1)} bpm`;
      
      // Add trend for monthly RHR chart
      if (monthly.length >= 2) {
        const validData = monthly.map(r => r.rhr).filter(Number.isFinite);
        if (validData.length >= 2) {
          const regressionData = validData.map((rhr, index) => ({ x: index, y: rhr }));
          const regression = calculateLinearRegression(regressionData);
          if (regression) {
            const trend = regression.slope > 0 ? '+' : '';
            metaText += ` • trend ${trend}${regression.slope.toFixed(3)} bpm`;
          }
        }
      }
      
      // chart type tracked via cfg below
    } else {
      // Daily view - use current range; do not override inputs
      const filteredForDaily = filteredRHR;
      if (filteredForDaily.length === 0) {
        ds = [];
        preview = [];
        metaText = '0 days';
      } else {
      // Create a complete date range and fill in missing data with null
      const startDate = new Date(filteredForDaily[0].date);
      const endDate = new Date(filteredForDaily[filteredForDaily.length - 1].date);
      const dateMap = new Map(filteredForDaily.map(r => [r.dateISO, r.rhr]));
      
      ds = [];
    const currentDate = new Date(startDate);
    while (currentDate <= endDate) {
      const dateISO = currentDate.toISOString().slice(0, 10);
      const rhrValue = dateMap.get(dateISO);
      ds.push({
        x: currentDate.getTime(),
        y: rhrValue !== undefined ? rhrValue : null
      });
      currentDate.setDate(currentDate.getDate() + 1);
    }
      preview = filteredForDaily.map(r => ({ 
      date: r.dateISO, 
      rhr: Math.round(r.rhr) 
    }));
    
      const avgRHR = avg(filteredForDaily.map(r => r.rhr));
      metaText = `${filteredForDaily.length} days • avg ${avgRHR.toFixed(1)} bpm`;
    
    // Add trend for daily RHR chart
      if (filteredForDaily.length >= 2) {
        const validData = filteredForDaily.map(r => r.rhr).filter(Number.isFinite);
      if (validData.length >= 2) {
        const regressionData = validData.map((rhr, index) => ({ x: index, y: rhr }));
        const regression = calculateLinearRegression(regressionData);
        if (regression) {
          const trend = regression.slope > 0 ? '+' : '';
          metaText += ` • trend ${trend}${regression.slope.toFixed(3)} bpm`;
        }
      }
    }
    
      // chart type tracked via cfg below
      }
    }
    
    // Configure chart based on view type
    if (isYearlyView) {
    cfg = {
        type: 'bar',
      data: {
        datasets: [{
            label: 'Avg RHR',
          data: ds,
            backgroundColor: palette[3] // Pink color for RHR
        }]
      },
      options: {
        responsive: true,
        scales: {
            x: { type: 'time', time: { unit: 'year' } },
          y: { 
              title: { display: true, text: 'RHR (bpm)' },
            min: 0
          }
        },
        plugins: {
          tooltip: {
            callbacks: {
                title: function() { return ''; },
                label: function(context) {
                  return context.dataset.label + ': ' + context.parsed.y.toFixed(1) + ' bpm';
              }
            }
          }
        }
      }
    };
    } else if (isMonthlyView) {
    cfg = {
      type: 'line',
      data: {
        datasets: [{
            label: 'Monthly Avg RHR',
          data: ds,
            borderColor: palette[3],
            backgroundColor: 'rgba(255, 192, 203, 0.1)',
            tension: 0.2,
            fill: true
        }]
      },
      options: {
          responsive: true,
        scales: {
          x: { type: 'time', time: { unit: 'month' } },
          y: { 
              title: { display: true, text: 'RHR (bpm)' },
              min: 0
          }
        },
        plugins: {
          tooltip: {
            callbacks: {
              title: function(context) {
                const dataIndex = context[0].dataIndex;
                  const monthData = ds[dataIndex];
                if (!monthData) return '';
                  const [year, month] = monthData.x.split('-');
                  const date = new Date(year, month-1, 1);
                return date.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
              },
              label: function(context) {
                  return context.dataset.label + ': ' + context.parsed.y.toFixed(1) + ' bpm';
              }
            }
          }
        }
      }
    };
  } else {
      // Daily view
    cfg = {
        type: 'line',
      data: {
        datasets: [{
            label: 'RHR',
          data: ds,
            borderColor: palette[3], // Pink color for RHR
            backgroundColor: palette[3], // Fill color for points
            pointBackgroundColor: palette[3], // Solid point background
            pointBorderColor: palette[3], // Solid point border
            pointRadius: 4, // Point size
            tension: 0.2,
            spanGaps: false
        }]
      },
      options: {
          responsive: true,
        scales: {
            x: { type: 'time', time: { unit: 'day' } },
          y: { 
            title: { display: true, text: 'BPM' },
              min: 0
          }
        },
        plugins: {
            legend: { display: true },
          tooltip: {
            callbacks: {
                title: function(context) {
                  const date = new Date(context[0].parsed.x);
                  return date.toISOString().slice(0, 10);
              }
            }
          }
        }
      }
    };
    }
  }
}



if (chartType === 'hist_rhr') {
  const r = tryLoadRHR();
  if (!r) {
    document.getElementById('note').innerHTML = 'RHR CSV not loaded';
    preview = [];
    cfg = createMessageChart('Please load fitbit_rhr.csv to view this chart');
  } else {
    const from = document.getElementById('dateFrom').value;
    const to = document.getElementById('dateTo').value;
    
    // Filter RHR data by date range
    const filteredRHR = r.filter(record => {
      if (from && record.dateISO < from) return false;
      if (to && record.dateISO > to) return false;
      return true;
    });
    
    const arr = filteredRHR.map(r => r.rhr).filter(Number.isFinite);
    const bins = 20;
    const min = Math.min(...arr);
    const max = Math.max(...arr);
    const step = (max - min) / bins;
    const hist = new Array(bins).fill(0);
    
    arr.forEach(v => {
      const i = Math.max(0, Math.min(bins - 1, Math.floor((v - min) / step)));
      hist[i]++;
    });
    
    const labels = [...Array(bins)].map((_, i) => 
      `${Math.round(min + i * step)}-${Math.round(min + (i + 1) * step)}`
    );
    
    // Get top 20 highest RHR days
    const top20RHR = filteredRHR
      .filter(r => Number.isFinite(r.rhr))
      .sort((a, b) => b.rhr - a.rhr)
      .slice(0, 20)
      .map(r => {
        const date = new Date(r.date);
        const dayOfWeek = date.toLocaleDateString('en-US', { weekday: 'short' });
        return { date: `${dayOfWeek} ${r.dateISO}`, rhr: r.rhr.toFixed(1) };
      });
    
    // Get bottom 20 lowest RHR days
    const bottom20RHR = filteredRHR
      .filter(r => Number.isFinite(r.rhr))
      .sort((a, b) => a.rhr - b.rhr)
      .slice(0, 20)
      .map(r => {
        const date = new Date(r.date);
        const dayOfWeek = date.toLocaleDateString('en-US', { weekday: 'short' });
        return { date: `${dayOfWeek} ${r.dateISO}`, rhr: r.rhr.toFixed(1) };
      });
    
    preview = labels.map((l, i) => ({ bin: l, count: hist[i] }));
    
    // Render the RHR tables
    renderTopRHRTable(top20RHR);
    renderBottomRHRTable(bottom20RHR);
    
    // Render the RHR CUSUM chart
    renderRHRCUSUMChart(filteredRHR);
    
    cfg = {
      type: 'bar',
      data: {
        labels,
        datasets: [{
          label: 'Days',
          data: hist,
          backgroundColor: palette[3] // Pink color for RHR
        }]
      },
      options: {
        scales: { y: { beginAtZero: true } }
      }
    };
  }
}

if (chartType === 'analytics') {
  // Clean up any correlation matrix elements first
  const existingTable = document.getElementById('correlationMatrixTable');
  if (existingTable) {
    existingTable.remove();
  }
  
  // Clean up any correlation legend
  const existingLegend = document.getElementById('correlationLegend');
  if (existingLegend) {
    existingLegend.remove();
  }
  
  // Clean up any correlation matrix container
  const existingContainer = document.querySelector('.correlation-matrix-container');
  if (existingContainer) {
    existingContainer.remove();
  }
  
  // Clean up any predictions container
  const existingPredictionsContainer = document.querySelector('.predictions-container');
  if (existingPredictionsContainer) {
    existingPredictionsContainer.remove();
  }
  
  // Hide all additional chart containers
  const dualHRVCharts = document.getElementById('dualHRVCorrelationCharts');
  if (dualHRVCharts) {
    dualHRVCharts.style.display = 'none';
  }
  
  const dualStepsCharts = document.getElementById('dualStepsCorrelationCharts');
  if (dualStepsCharts) {
    dualStepsCharts.style.display = 'none';
  }
  
  const stepsHistogramChart = document.getElementById('stepsHistogramChart');
  if (stepsHistogramChart) {
    stepsHistogramChart.style.display = 'none';
  }
  
  const sleepHistogramChart = document.getElementById('sleepHistogramChart');
  if (sleepHistogramChart) {
    sleepHistogramChart.style.display = 'none';
  }
  
  const rhrCusumSection = document.getElementById('rhrCusumSection');
  if (rhrCusumSection) {
    rhrCusumSection.style.display = 'none';
  }
  
  const hrvCusumSection = document.getElementById('hrvCusumSection');
  if (hrvCusumSection) {
    hrvCusumSection.style.display = 'none';
  }
  
  const analytics = computeAnalytics();
  const from = document.getElementById('dateFrom').value;
  const to = document.getElementById('dateTo').value;
  
  if (analytics.length === 0) {
    document.getElementById('note').innerHTML = 'Please load sleep, HRV, steps, and RHR CSVs to view analytics';
    preview = [];
    cfg = createMessageChart('Please load sleep, HRV, steps, and RHR CSVs to view analytics');
  } else {
    preview = analytics;
    
    // Create slopegraph data for start→end trends
    const slopegraphData = [];
    const sleepN = normalizeSleepRows(rawSleep);
    const filtered = filterSleep(sleepN);
    const hrv = tryLoadHRV();
    const steps = tryLoadSteps();
    const rhr = tryLoadRHR();
    
    // Filter by date range
    const filteredHRV = hrv ? hrv.filter(r => {
      if (from && r.dateISO < from) return false;
      if (to && r.dateISO > to) return false;
      return true;
    }) : [];
    
    const filteredSteps = steps ? steps.filter(r => {
      if (from && r.dateISO < from) return false;
      if (to && r.dateISO > to) return false;
      return true;
    }) : [];
    
    const filteredRHR = rhr ? rhr.filter(r => {
      if (from && r.dateISO < from) return false;
      if (to && r.dateISO > to) return false;
      return true;
    }) : [];
    
    const yearly = groupByYear(filtered);
    const yearlySteps = filteredSteps.length > 0 ? groupStepsByYear(filteredSteps) : [];
    const yearlyRHR = filteredRHR.length > 0 ? groupRHRByYear(filteredRHR) : [];
    const yearlyHRV = filteredHRV.length > 0 ? groupByYear(filteredHRV.map(r => ({ date: new Date(r.dateISO), rmssd: r.rmssd }))) : [];
    
    // Sleep Score
    if (yearly.length >= 2) {
      const start = yearly[0].sleepScore;
      const end = yearly[yearly.length - 1].sleepScore;
      const pctChange = ((end - start) / start) * 100;
      slopegraphData.push({
        metric: 'Sleep Score',
        start: start,
        end: end,
        pctChange: pctChange,
        color: pctChange >= 0 ? '#4CAF50' : '#f44336'
      });
    }
    
    // Minutes Asleep
    if (yearly.length >= 2) {
      const start = yearly[0].minutesAsleep;
      const end = yearly[yearly.length - 1].minutesAsleep;
      const pctChange = ((end - start) / start) * 100;
      slopegraphData.push({
        metric: 'Minutes Asleep',
        start: start,
        end: end,
        pctChange: pctChange,
        color: pctChange >= 0 ? '#4CAF50' : '#f44336'
      });
    }
    
    // HRV
    if (yearlyHRV.length >= 2) {
      const start = yearlyHRV[0].rmssd;
      const end = yearlyHRV[yearlyHRV.length - 1].rmssd;
      const pctChange = ((end - start) / start) * 100;
      slopegraphData.push({
        metric: 'HRV',
        start: start,
        end: end,
        pctChange: pctChange,
        color: pctChange >= 0 ? '#4CAF50' : '#f44336'
      });
    }
    
    // RHR
    if (yearlyRHR.length >= 2) {
      const start = yearlyRHR[0].rhr;
      const end = yearlyRHR[yearlyRHR.length - 1].rhr;
      const pctChange = ((end - start) / start) * 100;
      slopegraphData.push({
        metric: 'RHR',
        start: start,
        end: end,
        pctChange: pctChange,
        color: pctChange >= 0 ? '#f44336' : '#4CAF50' // RHR: lower is better
      });
    }
    
    // Steps
    if (yearlySteps.length >= 2) {
      const start = yearlySteps[0].steps;
      const end = yearlySteps[yearlySteps.length - 1].steps;
      const pctChange = ((end - start) / start) * 100;
      slopegraphData.push({
        metric: 'Steps',
        start: start,
        end: end,
        pctChange: pctChange,
        color: pctChange >= 0 ? '#4CAF50' : '#f44336'
      });
    }
    
    if (slopegraphData.length > 0) {
      // Create a simple message chart with trend summary
      const trendSummary = slopegraphData.map(item => 
        `${item.metric}: ${item.pctChange >= 0 ? '+' : ''}${item.pctChange.toFixed(1)}%`
      ).join(' | ');
      
      cfg = createMessageChart(`Trends: ${trendSummary}`);
    } else {
      // Show current year averages when insufficient data for trends
      const currentYearData = [];
      if (yearly.length > 0 && yearly[0] && typeof yearly[0].sleepScore === 'number') {
        currentYearData.push(`Sleep Score: ${yearly[0].sleepScore.toFixed(1)}`);
      }
      if (yearly.length > 0 && yearly[0] && typeof yearly[0].minutesAsleep === 'number') {
        currentYearData.push(`Minutes Asleep: ${Math.round(yearly[0].minutesAsleep)}`);
      }
      if (yearlySteps.length > 0 && yearlySteps[0] && typeof yearlySteps[0].steps === 'number') {
        currentYearData.push(`Steps: ${Math.round(yearlySteps[0].steps)}`);
      }
      if (yearlyRHR.length > 0 && yearlyRHR[0] && typeof yearlyRHR[0].rhr === 'number') {
        currentYearData.push(`RHR: ${yearlyRHR[0].rhr.toFixed(1)}`);
      }
      if (yearlyHRV.length > 0 && yearlyHRV[0] && typeof yearlyHRV[0].rmssd === 'number') {
        currentYearData.push(`HRV: ${yearlyHRV[0].rmssd.toFixed(1)}`);
      }
      
      const summary = currentYearData.length > 0 
        ? `Current Year Averages: ${currentYearData.join(' | ')}`
        : 'Insufficient data for analysis';
      
      cfg = createMessageChart(summary);
    }
    
    // Render analytics badges
    renderAnalyticsBadges(
      slopegraphData,
      analytics,
      {
        filteredSleep: filtered,
        filteredHRV,
        filteredRHR,
        filteredSteps
      }
    );
    
    // Update meta text
    const hrvCount = filteredHRV.length;
    const stepsCount = filteredSteps.length;
    const rhrCount = filteredRHR.length;
    
    metaText = `Analytics • range ${from || 'start'} to ${to || 'end'} • nights ${filtered.length} • HRV points ${hrvCount} • steps days ${stepsCount} • RHR days ${rhrCount}`;
  }
}

// Ensure predictions footer shows nights • range (set earlier in predictions branch)
if (chartType === 'predictions') {
  // no override here; keep existing metaText
}
 meta.innerHTML = metaText;
 
 // Only create chart if config is not null
 if (cfg) {
   try {
     chart = new Chart(ctx,cfg);
   } catch (error) {
     console.error('Error creating chart:', error);
     document.getElementById('note').innerHTML = 'Error creating chart: ' + error.message;
   }
 } else {
   // Hide chart area when no config (like for correlation matrix)
   document.getElementById('chart').style.display = 'none';
 }
 
// Hide chart canvas for analytics (we only want the badges)
if (chartType === 'analytics') {
   document.getElementById('chart').style.display = 'none';
   // Show analytics badges
   const analyticsBadges = document.getElementById('analyticsBadges');
   if (analyticsBadges) {
     analyticsBadges.style.display = 'flex';
   }
}
  // Hide chart canvas for life_events (custom UI)
  if (chartType === 'life_events') {
   document.getElementById('chart').style.display = 'none';
 }

// Render histogram chart for daily_steps
if (chartType === 'daily_steps' && window.stepsHistogramConfig) {
  const histogramDiv = document.getElementById('stepsHistogramChart');
  const histogramCanvas = document.getElementById('stepsHistogramCanvas');
  
  if (histogramDiv && histogramCanvas) {
    histogramDiv.style.display = 'block';
    
    // Destroy existing histogram chart if it exists
    if (window.stepsHistogramChart && window.stepsHistogramChart.destroy) {
      try {
        window.stepsHistogramChart.destroy();
      } catch (e) {
        console.warn('Error destroying histogram chart:', e);
      }
    }
    
    try {
      window.stepsHistogramChart = new Chart(histogramCanvas.getContext('2d'), window.stepsHistogramConfig);
    } catch (error) {
      console.error('Error creating histogram chart:', error);
    }
  }
} else {
  // Hide histogram chart for other chart types (including analytics)
  const histogramDiv = document.getElementById('stepsHistogramChart');
  if (histogramDiv) {
    histogramDiv.style.display = 'none';
  }
  // Clear the histogram chart reference when not showing
  if (window.stepsHistogramChart && window.stepsHistogramChart.destroy) {
    try {
      window.stepsHistogramChart.destroy();
    } catch (e) {
      console.warn('Error destroying histogram chart:', e);
    }
    window.stepsHistogramChart = null;
  }
}

// Life Events view
if (chartType === 'life_events') {
  // Hide any other auxiliary sections that might persist from prior views
  const hideById = (id)=>{ const el=document.getElementById(id); if(el) el.style.display='none'; };
  hideById('sleepHistogramChart');
  hideById('stepsHistogramChart');
  hideById('topStepsSection');
  hideById('bottomStepsSection');
  hideById('topRHRSection');
  hideById('bottomRHRSection');
  hideById('topSleepScoreSection');
  hideById('bottomSleepScoreSection');
  hideById('topHRVSection');
  hideById('bottomHRVSection');
  hideById('rhrCusumSection');
  hideById('hrvCusumSection');
  // Hide any collapsible previews
  hideById('sleepPreviewCollapsible');
  hideById('sleepHistogramPreviewCollapsible');
  hideById('stepsPreviewCollapsible');
  hideById('rhrPreviewCollapsible');
  hideById('hrvPreviewCollapsible');
  hideById('analyticsPreviewCollapsible');
  const dualHRVCharts = document.getElementById('dualHRVCorrelationCharts'); if(dualHRVCharts) dualHRVCharts.style.display='none';
  const dualStepsCharts = document.getElementById('dualStepsCorrelationCharts'); if(dualStepsCharts) dualStepsCharts.style.display='none';
  const existingPredictionsContainer = document.querySelector('.predictions-container'); if(existingPredictionsContainer) existingPredictionsContainer.remove();
  const existingAnalyticsBadges = document.getElementById('analyticsBadges'); if(existingAnalyticsBadges) existingAnalyticsBadges.style.display='none';
  const existingTable = document.getElementById('correlationMatrixTable'); if (existingTable) existingTable.remove();

  // Build container
  const chartElement = document.getElementById('chart');
  const parentContainer = chartElement.parentElement;
  // Remove existing
  const existing = document.getElementById('lifeEventsContainer');
  if (existing) existing.remove();
  const container = document.createElement('div');
  container.id = 'lifeEventsContainer';
  container.style.cssText = 'background:#0b1020;border:1px solid #1a2349;border-radius:14px;padding:16px;margin:16px 0;';

  // Header
  const header = document.createElement('div');
  header.style.cssText = 'display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;color:#e6eaf3;font-weight:600;';
  container.appendChild(header);

  // Helpers
  const PROFILE = PROFILE_ID || '(none)';
  const LS_KEY = `fitbaus:events:${PROFILE}`;
  function loadEvents(){
    try{
      const raw = localStorage.getItem(LS_KEY);
      if(!raw) return { version:1, profileId: PROFILE, events: [] };
      const parsed = JSON.parse(raw);
      if(!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.events)) return { version:1, profileId: PROFILE, events: [] };
      return parsed;
    }catch(_){ return { version:1, profileId: PROFILE, events: [] } }
  }
  function saveEvents(data){
    localStorage.setItem(LS_KEY, JSON.stringify(data));
  }
  function uuid(){ return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g,c=>{const r=Math.random()*16|0,v=c==='x'?r:(r&0x3|0x8);return v.toString(16)}) }
  function validate(e){
    if(!e) return false; if(!/^\d{4}-\d{2}-\d{2}$/.test(e.date||'')) return false;
    if(!e.name || !e.name.trim()) return false;
    if(!['negative','neutral','positive'].includes(e.sentiment)) return false;
    return true;
  }

  // Form (flex layout for better alignment)
  const form = document.createElement('div');
  form.style.cssText = 'display:flex;flex-wrap:wrap;gap:12px;align-items:flex-end;margin-bottom:12px;';
  form.innerHTML = `
    <div class="cell" style="width:220px;display:flex;flex-direction:column"><label>Date</label><input type="date" id="le_date"/></div>
    <div class="cell" style="flex:1;min-width:280px;display:flex;flex-direction:column"><label>Event</label><input type="text" id="le_name" placeholder="e.g., Moved house"/></div>
    <div class="cell" style="width:220px;display:flex;flex-direction:column"><label>Sentiment</label>
      <select id="le_sentiment">
        <option value="neutral">neutral</option>
        <option value="positive">positive</option>
        <option value="negative">negative</option>
      </select>
    </div>
    <div style="align-self:flex-end"><button class="btn" id="le_add">Add</button></div>
  `;
  container.appendChild(form);

  // Toolbar
  const tools = document.createElement('div');
  tools.className='toolbar';
  tools.innerHTML = `
    <button class="btn" id="le_export">Export</button>
    <button class="btn" id="le_import_btn" style="cursor:pointer;display:inline-block">Import<input type="file" id="le_import" accept="application/json" style="display:none"/></button>
  `;
  container.appendChild(tools);

  // Sentiment-Based Health Impact Patterns (aggregated across events)
  const sentimentSection = document.createElement('div');
  sentimentSection.id = 'le_sentiment_patterns';
  sentimentSection.style.cssText = 'margin:14px 0 10px 0;padding:12px;border:1px solid #1a2349;border-radius:10px;background:#0e1530;';
  const sentimentHeader = document.createElement('div');
  sentimentHeader.style.cssText = 'color:#e6eaf3;font-weight:600;margin-bottom:8px;display:flex;align-items:center;gap:8px;';
  sentimentHeader.textContent = 'Sentiment-Based Health Impact Patterns';
  sentimentSection.appendChild(sentimentHeader);
  const sentimentBody = document.createElement('div');
  sentimentBody.className = 'muted';
  sentimentBody.style.cssText = 'font-size:12px;color:#9aa5c6;margin-bottom:10px;display:flex;align-items:center;gap:8px;flex-wrap:wrap;';
  sentimentBody.innerHTML = 'How your health metrics typically respond after positive, neutral, or negative events (last <select id="sentimentWindowDays" style="background:#0b1020;border:1px solid #24305c;color:#e6eaf3;padding:2px 4px;border-radius:4px;font-size:12px;width:50px;"><option value="30">30</option><option value="15">15</option><option value="7" selected>7</option><option value="3">3</option></select> days after each event).';
  sentimentSection.appendChild(sentimentBody);
  
  
  // Add event listeners to dropdown and checkbox
  const windowDaysSelect = sentimentBody.querySelector('#sentimentWindowDays');
  const includeSameDayCheckbox = document.getElementById('includeSameDay');
  
  const refreshAnalysis = () => {
    // Clear existing results and re-render
    const existingResults = document.getElementById('sentimentResults');
    if (existingResults) existingResults.remove();
    const existingEmpty = sentimentSection.querySelector('.muted[style*="font-size:12px;color:#9aa5c6;"]');
    if (existingEmpty) existingEmpty.remove();
    // Note: We do NOT remove the impact analysis - it should remain static
    renderSentimentPatterns();
    // Also refresh the individual event list to update insights
    renderList();
  };
  
  if (windowDaysSelect) {
    windowDaysSelect.addEventListener('change', refreshAnalysis);
  }
  if (includeSameDayCheckbox) {
    includeSameDayCheckbox.addEventListener('change', refreshAnalysis);
  }


  // Compute aggregates
  function renderSentimentPatterns(){
    const data = loadEvents();
    const events = Array.isArray(data.events) ? data.events.slice() : [];
    if(events.length === 0){
      const empty = document.createElement('div');
      empty.className = 'muted';
      empty.style.cssText = 'font-size:12px;color:#9aa5c6;';
      empty.textContent = 'Not enough events yet.';
      sentimentSection.appendChild(empty);
      // Impact Analysis will be appended under the events section by addStaticImpactAnalysis()
      return;
    }

    const sleepN = normalizeSleepRows(rawSleep||[]);
    const sleepFiltered = filterSleep(sleepN); // respect mainOnly and global filters like other views
    const hrvN = tryLoadHRV() || [];
    const stepsN = tryLoadSteps() || [];
    const rhrN = tryLoadRHR() || [];

    const windowDaysSelect = document.getElementById('sentimentWindowDays');
    const windowDays = windowDaysSelect ? parseInt(windowDaysSelect.value) : 30;
    const includeSameDayCheckbox = document.getElementById('includeSameDay');
    const includeSameDay = includeSameDayCheckbox ? includeSameDayCheckbox.checked : false;
    
    console.log(`Sentiment patterns - windowDays: ${windowDays}, includeSameDay: ${includeSameDay}, events: ${events.length}`);
    const toISO = d => (d instanceof Date ? d.toISOString().slice(0,10) : String(d||''));
    const addDaysSafe = (dateObj, days) => {
      try{
        const d = new Date(dateObj.getTime());
        d.setUTCDate(d.getUTCDate() + days);
        return d;
      }catch(_){ return dateObj }
    };
    const afterWindow = (rows, dateField, valueField, startISO) => {
      const list = Array.isArray(rows) ? rows : [];
      const start = parseDate(startISO);
      const startDay = includeSameDay ? start : addDaysSafe(start, 1);
      const end = addDaysSafe(start, windowDays);
      return list
        .map(r => {
          const d = (r[dateField] instanceof Date) ? r[dateField]
                  : (r.date instanceof Date) ? r.date
                  : (r.dateISO ? parseDate(r.dateISO) : null);
          const val = Number(r[valueField]);
          return { dateObj: d, date: toISO(d || r.dateISO || r.date), value: val };
        })
        .filter(r => r.dateObj && r.dateObj >= startDay && r.dateObj <= end)
        .filter(r => Number.isFinite(r.value));
    };
    function cusumDetect(series){
      try{
        // Adjust thresholds based on window size
        const minLength = windowDays <= 3 ? 3 : windowDays <= 7 ? 5 : windowDays <= 15 ? 8 : 12;
        if(!series || series.length < minLength) return null;
        const baselineVals = series.slice(0, Math.min(windowDays <= 3 ? 2 : windowDays <= 7 ? 3 : windowDays <= 15 ? 5 : 21, series.length)).map(x=>x.value);
        if(baselineVals.length < (windowDays <= 3 ? 2 : windowDays <= 7 ? 3 : windowDays <= 15 ? 4 : 7)) return null;
        const params = cusumParamsFromBaseline(baselineVals);
        const cus = calculateCUSUM(series, params.mean, 'value', params.k, params.h);
        if(!cus || cus.length===0) return null;
        const maxUpper = Math.max(...cus.map(c => c.upperSum));
        const maxLower = Math.max(...cus.map(c => c.lowerSum));
        const maxExc = Math.max(maxUpper, maxLower);
        // Lower threshold for shorter windows
        const threshold = windowDays <= 3 ? params.h * 0.5 : windowDays <= 7 ? params.h * 0.7 : windowDays <= 15 ? params.h * 0.8 : params.h;
        if (maxExc < threshold) return null;
        const useUpper = maxUpper > maxLower;
        return { direction: useUpper ? 'increase' : 'decrease' };
      }catch(_){ return null }
    }

    function meanShiftDetect(series, metric){
      try{
        if(!series || series.length < 10) return null;
        const baseline = series.slice(0, Math.min(7, series.length));
        const window = series.slice(baseline.length);
        if(window.length < 5) return null;
        const mean = arr => arr.reduce((s,v)=>s+v,0)/arr.length;
        const valsB = baseline.map(x=>x.value).filter(Number.isFinite);
        const valsW = window.map(x=>x.value).filter(Number.isFinite);
        if(valsB.length < 5 || valsW.length < 5) return null;
        const muB = mean(valsB);
        const muW = mean(valsW);
        const stdev = a => { const m = mean(a); const v = a.reduce((s,x)=>s+(x-m)*(x-m),0)/Math.max(1,a.length-1); return Math.sqrt(v); };
        const sdB = stdev(valsB);
        const diff = muW - muB;
        // Metric-specific minimal thresholds to avoid noise triggering
        const absMin = (metric==='sleep') ? 1 : (metric==='hrv' ? 3 : (metric==='steps' ? 500 : 1));
        const relMin = 0.2 * (sdB || 0);
        const thr = Math.max(absMin, relMin);
        if(Math.abs(diff) < thr) return null;
        return { direction: diff > 0 ? 'increase' : 'decrease' };
      }catch(_){ return null }
    }

    const groups = { positive: [], negative: [] };
    events.forEach(ev=>{ if(ev && groups.hasOwnProperty(ev.sentiment)) groups[ev.sentiment].push(ev); });

    const makeRow = (label, color, results) => {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;gap:14px;align-items:center;margin:6px 0;flex-wrap:wrap;';
      const title = document.createElement('div');
      title.style.cssText = `min-width:90px;color:${color};font-weight:600;text-transform:capitalize;`;
      title.textContent = label;
      row.appendChild(title);
      const chips = document.createElement('div');
      chips.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;align-items:center;';
      const chip = (name, pct, color, arrow) => {
        const box = document.createElement('span');
        const show = Number.isFinite(pct) ? `${Math.round(pct)}%` : 'n/a';
        const arrowSymbol = arrow ? ' ↑' : ' ↓';
        box.style.cssText = 'border:1px solid #24305c;border-radius:999px;padding:4px 8px;background:#0b1020;color:#c8d0f0;font-size:12px;';
        box.innerHTML = `<span class="muted" style="color:#9aa5c6">${name}:</span> <span style="color:${color}">${show}${arrowSymbol}</span>`;
        return box;
      };
      
      // Sleep: show dominant direction
      const sleepUp = Number.isFinite(results.sleepUpPct) ? results.sleepUpPct : 0;
      const sleepDown = Number.isFinite(results.sleepDownPct) ? results.sleepDownPct : 0;
      if (sleepUp > sleepDown) {
        const color = sleepUp === 50 ? '#ffc107' : '#4CAF50';
        chips.appendChild(chip('Sleep', sleepUp, color, true));
      } else if (sleepDown > sleepUp) {
        const color = sleepDown === 50 ? '#ffc107' : '#d32f2f';
        chips.appendChild(chip('Sleep', sleepDown, color, false));
      } else if (sleepUp === sleepDown && sleepUp > 0) {
        chips.appendChild(chip('Sleep', 50, '#ffc107', true));
      } else if (sleepUp > 0 || sleepDown > 0) {
        // Fallback for any non-zero values
        const maxVal = Math.max(sleepUp, sleepDown);
        const isUp = sleepUp >= sleepDown;
        const color = maxVal === 50 ? '#ffc107' : (isUp ? '#4CAF50' : '#d32f2f');
        chips.appendChild(chip('Sleep', maxVal, color, isUp));
      }
      
      // HRV: show dominant direction
      const hrvUp = Number.isFinite(results.hrvUpPct) ? results.hrvUpPct : 0;
      const hrvDown = Number.isFinite(results.hrvDownPct) ? results.hrvDownPct : 0;
      if (hrvUp > hrvDown) {
        const color = hrvUp === 50 ? '#ffc107' : '#4CAF50';
        chips.appendChild(chip('HRV', hrvUp, color, true));
      } else if (hrvDown > hrvUp) {
        const color = hrvDown === 50 ? '#ffc107' : '#d32f2f';
        chips.appendChild(chip('HRV', hrvDown, color, false));
      } else if (hrvUp === hrvDown && hrvUp > 0) {
        chips.appendChild(chip('HRV', 50, '#ffc107', true));
      } else if (hrvUp > 0 || hrvDown > 0) {
        // Fallback for any non-zero values
        const maxVal = Math.max(hrvUp, hrvDown);
        const isUp = hrvUp >= hrvDown;
        const color = maxVal === 50 ? '#ffc107' : (isUp ? '#4CAF50' : '#d32f2f');
        chips.appendChild(chip('HRV', maxVal, color, isUp));
      }
      
      // Steps: show dominant direction
      const stepsUp = Number.isFinite(results.stepsUpPct) ? results.stepsUpPct : 0;
      const stepsDown = Number.isFinite(results.stepsDownPct) ? results.stepsDownPct : 0;
      if (stepsUp > stepsDown) {
        const color = stepsUp === 50 ? '#ffc107' : '#4CAF50';
        chips.appendChild(chip('Steps', stepsUp, color, true));
      } else if (stepsDown > stepsUp) {
        const color = stepsDown === 50 ? '#ffc107' : '#d32f2f';
        chips.appendChild(chip('Steps', stepsDown, color, false));
      } else if (stepsUp === stepsDown && stepsUp > 0) {
        chips.appendChild(chip('Steps', 50, '#ffc107', true));
      } else if (stepsUp > 0 || stepsDown > 0) {
        // Fallback for any non-zero values
        const maxVal = Math.max(stepsUp, stepsDown);
        const isUp = stepsUp >= stepsDown;
        const color = maxVal === 50 ? '#ffc107' : (isUp ? '#4CAF50' : '#d32f2f');
        chips.appendChild(chip('Steps', maxVal, color, isUp));
      }
      
      // RHR: show dominant direction
      const rhrUp = Number.isFinite(results.rhrUpPct) ? results.rhrUpPct : 0;
      const rhrDown = Number.isFinite(results.rhrDownPct) ? results.rhrDownPct : 0;
      if (rhrUp > rhrDown) {
        const color = rhrUp === 50 ? '#ffc107' : '#d32f2f';
        chips.appendChild(chip('RHR', rhrUp, color, true));
      } else if (rhrDown > rhrUp) {
        const color = rhrDown === 50 ? '#ffc107' : '#4CAF50';
        chips.appendChild(chip('RHR', rhrDown, color, false));
      } else if (rhrUp === rhrDown && rhrUp > 0) {
        chips.appendChild(chip('RHR', 50, '#ffc107', true));
      } else if (rhrUp > 0 || rhrDown > 0) {
        // Fallback for any non-zero values
        const maxVal = Math.max(rhrUp, rhrDown);
        const isUp = rhrUp >= rhrDown;
        const color = maxVal === 50 ? '#ffc107' : (isUp ? '#d32f2f' : '#4CAF50');
        chips.appendChild(chip('RHR', maxVal, color, isUp));
      }
      row.appendChild(chips);
      return row;
    };

    const computeForGroup = (evs) => {
      let sleepUp=0, sleepDown=0, sleepN=0;
      let hrvUp=0, hrvDown=0, hrvNn=0;
      let stepsUp=0, stepsDown=0, stepsNn=0;
      let rhrUp=0, rhrDown=0, rhrNn=0;
      
      evs.forEach((ev, idx) => {
        const sSeries = afterWindow(sleepFiltered, 'date', 'sleepScore', ev.date);
        const hSeries = afterWindow(hrvN, 'date', 'rmssd', ev.date);
        const stSeries = afterWindow(stepsN, 'date', 'steps', ev.date);
        const rSeries = afterWindow(rhrN, 'date', 'rhr', ev.date);
        
        const s = cusumDetect(sSeries) || meanShiftDetect(sSeries, 'sleep'); 
        if(s){ sleepN++; if(s.direction==='increase') sleepUp++; else sleepDown++; }
        
        const h = cusumDetect(hSeries) || meanShiftDetect(hSeries, 'hrv'); 
        if(h){ hrvNn++; if(h.direction==='increase') hrvUp++; else hrvDown++; }
        
        const st = cusumDetect(stSeries) || meanShiftDetect(stSeries, 'steps'); 
        if(st){ stepsNn++; if(st.direction==='increase') stepsUp++; else stepsDown++; }
        
        const r = cusumDetect(rSeries) || meanShiftDetect(rSeries, 'rhr'); 
        if(r){ rhrNn++; if(r.direction==='increase') rhrUp++; else rhrDown++; }
      });
      
      const pct = (a,n)=> n>0 ? (a*100/n) : NaN;
      return {
        sleepUpPct: pct(sleepUp, sleepN), sleepDownPct: pct(sleepDown, sleepN),
        hrvUpPct: pct(hrvUp, hrvNn), hrvDownPct: pct(hrvDown, hrvNn),
        stepsUpPct: pct(stepsUp, stepsNn), stepsDownPct: pct(stepsDown, stepsNn),
        rhrUpPct: pct(rhrUp, rhrNn), rhrDownPct: pct(rhrDown, rhrNn)
      };
    };

    const positive = computeForGroup(groups.positive);
    const negative = computeForGroup(groups.negative);

     const rowsWrap = document.createElement('div');
     rowsWrap.id = 'sentimentResults';
     rowsWrap.style.cssText = 'margin-top:4px;';
     rowsWrap.appendChild(makeRow('positive', '#4CAF50', positive));
     rowsWrap.appendChild(makeRow('negative', '#f44336', negative));
     sentimentSection.appendChild(rowsWrap);
  }

  // Set default value and initial render
  if (windowDaysSelect) {
    windowDaysSelect.value = '7';
  }
  
  // Ensure the checkbox is also properly initialized
  const includeSameDayCheckboxInit = document.getElementById('includeSameDay');
  if (includeSameDayCheckboxInit) {
    includeSameDayCheckboxInit.checked = false; // Default to unchecked
  }
  
  // Force a small delay to ensure DOM is updated before rendering
  setTimeout(() => {
    renderSentimentPatterns();
  }, 10);

  container.appendChild(sentimentSection);

  // Add static Impact Analysis function (runs only once)
  function addStaticImpactAnalysis() {
    const data = loadEvents();
    const events = Array.isArray(data.events) ? data.events.slice() : [];
    
    if (events.length === 0) {
      const analysisDiv = document.createElement('div');
      analysisDiv.id = 'impactAnalysisSection';
      analysisDiv.style.cssText = 'margin-top:12px;padding:10px;background:#0b1020;border-radius:6px;border:1px solid #1a2349;';
      
      const analysisTitle = document.createElement('div');
      analysisTitle.style.cssText = 'color:#e6eaf3;font-weight:600;margin-bottom:8px;font-size:13px;';
      analysisTitle.textContent = 'Impact Analysis';
      analysisDiv.appendChild(analysisTitle);
      
      const analysisText = document.createElement('div');
      analysisText.className = 'muted';
      analysisText.style.cssText = 'font-size:12px;color:#9aa5c6;line-height:1.4;white-space:pre-line;';
      analysisText.textContent = 'No events available for analysis.';
      analysisDiv.appendChild(analysisText);
      // Place Impact Analysis underneath the events section
      container.appendChild(analysisDiv);
      return;
    }

    // Prepare data and local helpers (self-contained for static analysis)
    const sleepN = normalizeSleepRows(rawSleep||[]);
    const sleepFiltered = filterSleep(sleepN);
    const hrvN = tryLoadHRV() || [];
    const stepsN = tryLoadSteps() || [];
    const rhrN = tryLoadRHR() || [];

    const toISO = d => (d instanceof Date ? d.toISOString().slice(0,10) : String(d||''));
    const addDaysSafe = (dateObj, days) => {
      try { const d = new Date(dateObj.getTime()); d.setUTCDate(d.getUTCDate()+days); return d; } catch(_) { return dateObj }
    };

    // Helper function to group events by sentiment
    const groupEventsBySentiment = (events, windowDays, includeSameDay) => {
      const groups = { positive: [], negative: [] };
      events.forEach(ev => { 
        if (ev && groups.hasOwnProperty(ev.sentiment)) {
          groups[ev.sentiment].push(ev);
        }
      });
      return groups;
    };

    // Generate analysis by testing all window sizes
    const windowSizes = [3, 7, 15, 30];
    let bestImpacts = {
      negative: { sleep: { window: 0, pct: 0, direction: '' }, hrv: { window: 0, pct: 0, direction: '' }, steps: { window: 0, pct: 0, direction: '' }, rhr: { window: 0, pct: 0, direction: '' } },
      positive: { sleep: { window: 0, pct: 0, direction: '' }, hrv: { window: 0, pct: 0, direction: '' }, steps: { window: 0, pct: 0, direction: '' }, rhr: { window: 0, pct: 0, direction: '' } }
    };
    
    // Test each window size
    windowSizes.forEach(windowSize => {
      // Local helpers tailored to the current window size; always exclude same-day
      const afterWindow = (rows, dateField, valueField, startISO) => {
        const list = Array.isArray(rows) ? rows : [];
        const start = parseDate(startISO);
        const startDay = addDaysSafe(start, 1); // exclude same day in static analysis
        const end = addDaysSafe(start, windowSize);
        return list
          .map(r => {
            const d = (r[dateField] instanceof Date) ? r[dateField]
                    : (r.date instanceof Date) ? r.date
                    : (r.dateISO ? parseDate(r.dateISO) : null);
            const val = Number(r[valueField]);
            return { dateObj: d, date: toISO(d || r.dateISO || r.date), value: val };
          })
          .filter(r => r.dateObj && r.dateObj >= startDay && r.dateObj <= end)
          .filter(r => Number.isFinite(r.value));
      };

      function cusumDetectLocal(series){
        try{
          const minLength = windowSize <= 3 ? 3 : windowSize <= 7 ? 5 : windowSize <= 15 ? 8 : 12;
          if(!series || series.length < minLength) return null;
          const baselineVals = series.slice(0, Math.min(windowSize <= 3 ? 2 : windowSize <= 7 ? 3 : windowSize <= 15 ? 5 : 21, series.length)).map(x=>x.value);
          if(baselineVals.length < (windowSize <= 3 ? 2 : windowSize <= 7 ? 3 : windowSize <= 15 ? 4 : 7)) return null;
          const params = cusumParamsFromBaseline(baselineVals);
          const cus = calculateCUSUM(series, params.mean, 'value', params.k, params.h);
          if(!cus || cus.length===0) return null;
          const maxUpper = Math.max(...cus.map(c => c.upperSum));
          const maxLower = Math.max(...cus.map(c => c.lowerSum));
          const maxExc = Math.max(maxUpper, maxLower);
          const threshold = windowSize <= 3 ? params.h * 0.5 : windowSize <= 7 ? params.h * 0.7 : windowSize <= 15 ? params.h * 0.8 : params.h;
          if (maxExc < threshold) return null;
          const useUpper = maxUpper > maxLower;
          return { direction: useUpper ? 'increase' : 'decrease' };
        }catch(_){ return null }
      }

      function meanShiftDetectLocal(series, metric){
        try{
          if(!series || series.length < 10) return null;
          const baseline = series.slice(0, Math.min(7, series.length));
          const window = series.slice(baseline.length);
          if(window.length < 5) return null;
          const mean = arr => arr.reduce((s,v)=>s+v,0)/arr.length;
          const valsB = baseline.map(x=>x.value).filter(Number.isFinite);
          const valsW = window.map(x=>x.value).filter(Number.isFinite);
          if(valsB.length < 5 || valsW.length < 5) return null;
          const muB = mean(valsB);
          const muW = mean(valsW);
          const stdev = a => { const m = mean(a); const v = a.reduce((s,x)=>s+(x-m)*(x-m),0)/Math.max(1,a.length-1); return Math.sqrt(v); };
          const sdB = stdev(valsB);
          const diff = muW - muB;
          const absMin = (metric==='sleep') ? 1 : (metric==='hrv' ? 3 : (metric==='steps' ? 500 : 1));
          const relMin = 0.2 * (sdB || 0);
          const thr = Math.max(absMin, relMin);
          if(Math.abs(diff) < thr) return null;
          return { direction: diff > 0 ? 'increase' : 'decrease' };
        }catch(_){ return null }
      }

      const computeForGroup = (evs) => {
        let sleepUp=0, sleepDown=0, sleepN=0;
        let hrvUp=0, hrvDown=0, hrvNn=0;
        let stepsUp=0, stepsDown=0, stepsNn=0;
        let rhrUp=0, rhrDown=0, rhrNn=0;
        
        evs.forEach((ev) => {
          const sSeries = afterWindow(sleepFiltered, 'date', 'sleepScore', ev.date);
          const hSeries = afterWindow(hrvN, 'date', 'rmssd', ev.date);
          const stSeries = afterWindow(stepsN, 'date', 'steps', ev.date);
          const rSeries = afterWindow(rhrN, 'date', 'rhr', ev.date);
          
          const s = cusumDetectLocal(sSeries) || meanShiftDetectLocal(sSeries, 'sleep');
          if(s){ sleepN++; if(s.direction==='increase') sleepUp++; else sleepDown++; }
          
          const h = cusumDetectLocal(hSeries) || meanShiftDetectLocal(hSeries, 'hrv');
          if(h){ hrvNn++; if(h.direction==='increase') hrvUp++; else hrvDown++; }
          
          const st = cusumDetectLocal(stSeries) || meanShiftDetectLocal(stSeries, 'steps');
          if(st){ stepsNn++; if(st.direction==='increase') stepsUp++; else stepsDown++; }
          
          const r = cusumDetectLocal(rSeries) || meanShiftDetectLocal(rSeries, 'rhr');
          if(r){ rhrNn++; if(r.direction==='increase') rhrUp++; else rhrDown++; }
        });
        
        const pct = (a,n)=> n>0 ? (a*100/n) : NaN;
        return {
          sleepUpPct: pct(sleepUp, sleepN), sleepDownPct: pct(sleepDown, sleepN),
          hrvUpPct: pct(hrvUp, hrvNn), hrvDownPct: pct(hrvDown, hrvNn),
          stepsUpPct: pct(stepsUp, stepsNn), stepsDownPct: pct(stepsDown, stepsNn),
          rhrUpPct: pct(rhrUp, rhrNn), rhrDownPct: pct(rhrDown, rhrNn)
        };
      };

      const testGroups = groupEventsBySentiment(events, windowSize, false); // Always exclude same-day for static analysis
      const testNegative = computeForGroup(testGroups.negative);
      const testPositive = computeForGroup(testGroups.positive);
     
     // Check negative impacts
     if (testNegative.sleepDownPct > bestImpacts.negative.sleep.pct) {
       bestImpacts.negative.sleep = { window: windowSize, pct: testNegative.sleepDownPct, direction: 'decrease' };
     }
     if (testNegative.hrvDownPct > bestImpacts.negative.hrv.pct) {
       bestImpacts.negative.hrv = { window: windowSize, pct: testNegative.hrvDownPct, direction: 'decrease' };
     }
     if (testNegative.stepsDownPct > bestImpacts.negative.steps.pct) {
       bestImpacts.negative.steps = { window: windowSize, pct: testNegative.stepsDownPct, direction: 'decrease' };
     }
     if (testNegative.rhrUpPct > bestImpacts.negative.rhr.pct) {
       bestImpacts.negative.rhr = { window: windowSize, pct: testNegative.rhrUpPct, direction: 'increase' };
     }
     
     // Check positive impacts
     if (testPositive.sleepUpPct > bestImpacts.positive.sleep.pct) {
       bestImpacts.positive.sleep = { window: windowSize, pct: testPositive.sleepUpPct, direction: 'increase' };
     }
     if (testPositive.hrvUpPct > bestImpacts.positive.hrv.pct) {
       bestImpacts.positive.hrv = { window: windowSize, pct: testPositive.hrvUpPct, direction: 'increase' };
     }
     if (testPositive.stepsUpPct > bestImpacts.positive.steps.pct) {
       bestImpacts.positive.steps = { window: windowSize, pct: testPositive.stepsUpPct, direction: 'increase' };
     }
     if (testPositive.rhrDownPct > bestImpacts.positive.rhr.pct) {
       bestImpacts.positive.rhr = { window: windowSize, pct: testPositive.rhrDownPct, direction: 'decrease' };
     }
   });
   
   // Generate analysis text
   let analysis = '';
   
   // Negative events analysis
   const negImpacts = [];
    Object.keys(bestImpacts.negative).forEach(metric => {
      const impact = bestImpacts.negative[metric];
      if (impact.pct > 0) {
        const metricName = metric === 'rhr' ? 'RHR' : (metric === 'hrv' ? 'HRV' : metric.charAt(0).toUpperCase() + metric.slice(1));
        negImpacts.push(`${metricName} is most likely to ${impact.direction} (${Math.round(impact.pct)}% probability) within ${impact.window} days`);
      }
    });
   
   if (negImpacts.length > 0) {
     analysis += `After a negative event:\n• ${negImpacts.join('\n• ')}\n\n`;
   }
   
   // Positive events analysis
   const posImpacts = [];
   Object.keys(bestImpacts.positive).forEach(metric => {
     const impact = bestImpacts.positive[metric];
     if (impact.pct > 0) {
       const metricName = metric === 'rhr' ? 'RHR' : (metric === 'hrv' ? 'HRV' : metric.charAt(0).toUpperCase() + metric.slice(1));
       posImpacts.push(`${metricName} is most likely to ${impact.direction} (${Math.round(impact.pct)}% probability) within ${impact.window} days`);
     }
   });
   
   if (posImpacts.length > 0) {
     analysis += `After a positive event:\n• ${posImpacts.join('\n• ')}`;
   }
   
   if (negImpacts.length === 0 && posImpacts.length === 0) {
     analysis = 'No significant patterns detected across any time window.';
   }
    
    // Rebuild analysis text for clear separation and per-line items
    const sections = [];
    if (negImpacts.length > 0) sections.push(`After a negative event:\n- ${negImpacts.join('\n- ')}`);
    if (posImpacts.length > 0) sections.push(`After a positive event:\n- ${posImpacts.join('\n- ')}`);
    analysis = sections.length ? sections.join('\n\n') : 'No significant patterns detected across any time window.';

    // Create and add the analysis section
    // Prevent duplicates if called again
    if (document.getElementById('impactAnalysisSection')) return;

    const analysisDiv = document.createElement('div');
    analysisDiv.id = 'impactAnalysisSection';
    analysisDiv.style.cssText = 'margin-top:12px;padding:10px;background:#0b1020;border-radius:6px;border:1px solid #1a2349;';
   
   const analysisTitle = document.createElement('div');
   analysisTitle.style.cssText = 'color:#e6eaf3;font-weight:600;margin-bottom:8px;font-size:13px;';
   analysisTitle.textContent = 'Impact Analysis';
   analysisDiv.appendChild(analysisTitle);
   
    const analysisText = document.createElement('div');
    analysisText.className = 'muted';
    analysisText.style.cssText = 'font-size:12px;color:#9aa5c6;line-height:1.4;white-space:pre-line;';
    analysisText.textContent = analysis;
    analysisDiv.appendChild(analysisText);
    // Place Impact Analysis underneath the events section
    container.appendChild(analysisDiv);
    }

  // List
  const list = document.createElement('div');
  list.id = 'le_list';
  container.appendChild(list);

  // Pagination controls
  const paginationControls = document.createElement('div');
  paginationControls.style.cssText = 'display:flex;justify-content:space-between;align-items:center;margin:12px 0;padding:8px;background:#0e1530;border-radius:6px;border:1px solid #1a2349;';
  paginationControls.innerHTML = `
    <div style="display:flex;align-items:center;gap:8px;">
      <label style="color:#e6eaf3;font-size:12px;">Show:</label>
      <select id="eventsPerPage" style="background:#0b1020;border:1px solid #24305c;color:#e6eaf3;padding:4px 8px;border-radius:4px;font-size:12px;">
        <option value="5">5</option>
        <option value="15">15</option>
        <option value="30">30</option>
        <option value="50">50</option>
        <option value="100">100</option>
        <option value="all">All</option>
      </select>
    </div>
    <div id="paginationInfo" style="color:#9aa5c6;font-size:12px;"></div>
    <div id="paginationButtons" style="display:flex;gap:4px;"></div>
  `;
  container.appendChild(paginationControls);

  let currentPage = 1;
  let eventsPerPage = 5;

  // Add event listener for per-page dropdown (after pagination controls are added to DOM)
  // Use local container scope so it works before attaching to DOM
  const eventsPerPageSelect = paginationControls.querySelector('#eventsPerPage');
  if (eventsPerPageSelect) {
    eventsPerPageSelect.addEventListener('change', (e) => {
      eventsPerPage = e.target.value === 'all' ? 'all' : parseInt(e.target.value);
      currentPage = 1; // Reset to first page
      renderList();
    });
  }

  function renderList(){
    // Ensure Impact Analysis exists under the events section after rendering
    try { if (!document.getElementById('impactAnalysisSection')) setTimeout(()=>{ try{ addStaticImpactAnalysis(); }catch(_){ } }, 0); } catch(_){ }
    const data = loadEvents();
    const allItems = data.events.slice().sort((a,b)=>{
      if(a.date!==b.date) return b.date.localeCompare(a.date);
      return (b.updatedAt||'').localeCompare(a.updatedAt||'');
    });
    
    if(allItems.length===0){
      list.innerHTML = '<div class="muted">No events yet.</div>';
      const metaEl = document.getElementById('meta');
      if(metaEl) metaEl.textContent = '0 events • newest first';
      document.getElementById('paginationInfo').textContent = '';
      document.getElementById('paginationButtons').innerHTML = '';
      return;
    }

    // Calculate pagination
    const totalPages = eventsPerPage === 'all' ? 1 : Math.ceil(allItems.length / eventsPerPage);
    const startIndex = eventsPerPage === 'all' ? 0 : (currentPage - 1) * eventsPerPage;
    const endIndex = eventsPerPage === 'all' ? allItems.length : startIndex + eventsPerPage;
    const items = allItems.slice(startIndex, endIndex);

    // Update pagination info
    const paginationInfo = document.getElementById('paginationInfo');
    if (eventsPerPage === 'all') {
      paginationInfo.textContent = `Showing all ${allItems.length} events`;
    } else {
      paginationInfo.textContent = `Showing ${startIndex + 1}-${Math.min(endIndex, allItems.length)} of ${allItems.length} events`;
    }

    // Update pagination buttons
    const paginationButtons = document.getElementById('paginationButtons');
    if (totalPages <= 1) {
      paginationButtons.innerHTML = '';
    } else {
      let buttonsHTML = '';
      if (currentPage > 1) {
        buttonsHTML += `<button class="btn" id="prevPage" style="padding:4px 8px;font-size:12px;">‹ Prev</button>`;
      }
      buttonsHTML += `<span style="color:#9aa5c6;padding:4px 8px;font-size:12px;">Page ${currentPage} of ${totalPages}</span>`;
      if (currentPage < totalPages) {
        buttonsHTML += `<button class="btn" id="nextPage" style="padding:4px 8px;font-size:12px;">Next ›</button>`;
      }
      paginationButtons.innerHTML = buttonsHTML;
      
      // Add event listeners to pagination buttons
      const prevBtn = document.getElementById('prevPage');
      const nextBtn = document.getElementById('nextPage');
      if (prevBtn) {
        prevBtn.addEventListener('click', () => {
          currentPage--;
          renderList();
        });
      }
      if (nextBtn) {
        nextBtn.addEventListener('click', () => {
          currentPage++;
          renderList();
        });
      }
    }
    list.innerHTML = '';
    // Prepare health data once
    const sleepN = normalizeSleepRows(rawSleep||[]);
    const hrvN = tryLoadHRV() || [];
    const stepsN = tryLoadSteps() || [];
    const rhrN = tryLoadRHR() || [];
    function iso(d){ return (d instanceof Date)? d.toISOString().slice(0,10): String(d||''); }
    function afterOrEq(a,b){ return String(a)>=String(b) }
    function inWindow(startIso, rows, key){ return rows.filter(r=> afterOrEq(r.dateISO||r.date, startIso) && Number.isFinite(r[key])) }
    function corrPairs(aRows, aKey, bRows, bKey, align){
      const mapA = new Map(aRows.map(r=>[align(r), r[aKey]]));
      const out = [];
      for(const r of bRows){ const k = align(r); if(mapA.has(k)){ const av=mapA.get(k), bv=r[bKey]; if(Number.isFinite(av)&&Number.isFinite(bv)) out.push({a:av,b:bv}) } }
      return out;
    }
    function pearsonPairs(p){ const n=p.length; if(n<3) return NaN; const xs=p.map(x=>x.a), ys=p.map(x=>x.b); const sx=xs.reduce((s,v)=>s+v,0), sy=ys.reduce((s,v)=>s+v,0); const sxx=xs.reduce((s,v)=>s+v*v,0), syy=ys.reduce((s,v)=>s+v*v,0), sxy=xs.reduce((s,v,i)=>s+v*ys[i],0); const num=n*sxy-sx*sy; const den=Math.sqrt((n*sxx-sx*sx)*(n*syy-sy*sy)); return den===0?NaN:num/den }
    function summarizeCorr(r){ if(!Number.isFinite(r)) return 'n/a'; const a=Math.abs(r); const s=r.toFixed(2); const label=a>=0.7?'strong':a>=0.4?'moderate':'weak'; return `${s} (${label})` }

    items.forEach(ev=>{
      const row = document.createElement('div');
      row.style.cssText='display:flex;gap:12px;align-items:center;justify-content:flex-start;border:1px solid #263266;border-radius:8px;padding:10px;margin:6px 0;background:#0e1530;flex-wrap:wrap;';
      const left = document.createElement('div');
      left.style.cssText='display:flex;gap:12px;align-items:center;color:#e6eaf3;flex:1;min-width:0;';
      const tagColor = ev.sentiment==='positive'?'#4CAF50': ev.sentiment==='negative'?'#f44336':'#9aa5c6';
      left.innerHTML = `<span class="muted" style="width:100px;display:inline-block">${ev.date}</span><span style="color:${tagColor};font-weight:600;text-transform:capitalize;width:90px;display:inline-block">${ev.sentiment}</span><span style="display:inline-block;max-width:600px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${ev.name}</span>`;
      const right = document.createElement('div');
      right.style.cssText = 'flex:0 0 150px;display:flex;gap:8px;justify-content:flex-start';
      right.innerHTML = `<button class="btn" data-id="${ev.id}" data-act="edit">Edit</button> <button class="btn" data-id="${ev.id}" data-act="del">Delete</button>`;
      row.append(left,right);
      list.appendChild(row);

      // Narrative insights after the event date (CUSUM-driven)
      const start = String(ev.date);
      const windowDaysSelect = document.getElementById('sentimentWindowDays');
      const windowDays = windowDaysSelect ? parseInt(windowDaysSelect.value) : 30;
      const includeSameDayCheckbox = document.getElementById('includeSameDay');
      const includeSameDay = includeSameDayCheckbox ? includeSameDayCheckbox.checked : false;
      
      console.log(`Individual event - windowDays: ${windowDays}, includeSameDay: ${includeSameDay}`);
      
      // Use original inWindow function but with window size limit and same-day toggle
      const endDate = addDaysISO(start, windowDays);
      const startDate = includeSameDay ? start : addDaysISO(start, 1);
      const afterSleep = inWindow(start, sleepN, 'sleepScore').filter(r => r.dateISO >= startDate && r.dateISO <= endDate);
      const afterHRV = inWindow(start, hrvN, 'rmssd').filter(r => r.dateISO >= startDate && r.dateISO <= endDate);
      const afterSteps = inWindow(start, stepsN, 'steps').filter(r => r.dateISO >= startDate && r.dateISO <= endDate);
      const afterRHR = inWindow(start, rhrN, 'rhr').filter(r => r.dateISO >= startDate && r.dateISO <= endDate);
      // Align by same-day ISO
      const alignISO = r=> String(r.dateISO || r.date);
      function describeCUSUM(series, key){
        try{
          // Adjust thresholds based on window size
          const minLength = windowDays <= 3 ? 3 : windowDays <= 7 ? 5 : windowDays <= 15 ? 8 : 15;
          if(!series || series.length < minLength) return null;
          const vals = series.map(r=>r[key]).filter(Number.isFinite);
          if(vals.length < minLength) return null;
          const baselineVals = vals.slice(0, Math.min(windowDays <= 3 ? 2 : windowDays <= 7 ? 3 : windowDays <= 15 ? 5 : 30, vals.length));
          const { mean: baseline, k, h } = cusumParamsFromBaseline(baselineVals);
          const cus = calculateCUSUM(series.map(r=>({ date:r.dateISO||r.date, [key]: r[key] })), baseline, key, k, h);
          if(!cus || cus.length===0) return null;
          const maxUpper = Math.max(...cus.map(c => c.upperSum));
          const maxLower = Math.max(...cus.map(c => c.lowerSum));
          const maxExc = Math.max(maxUpper, maxLower);
          // Lower threshold for shorter windows
          const threshold = windowDays <= 3 ? h * 0.5 : windowDays <= 7 ? h * 0.7 : windowDays <= 15 ? h * 0.8 : h;
          if (maxExc < threshold) return null;
          const useUpper = maxUpper > maxLower;
          const seriesVals = cus.map(c => useUpper ? c.upperSum : c.lowerSum);
          const peakIndex = seriesVals.indexOf(Math.max(...seriesVals));
          let onsetIndex = 0; for(let i=peakIndex-1;i>=0;i--){ if(seriesVals[i]===0){ onsetIndex=i+1; break; } }
          const onsetDate = cus[onsetIndex].date;
          const direction = useUpper ? 'increase' : 'decrease';
          return { onsetDate, direction, strength: maxExc.toFixed(1) };
        }catch(_){ return null }
      }

      const narratives = [];
      function narr(label, cus, metric){
        if(!cus) return;
        const since = cus.onsetDate ? `since ${cus.onsetDate}` : 'since';
        // Color rules per request
        let color = '#9aa5c6';
        const red = '#d32f2f'; // darker red for better readability
        if(metric==='sleep') color = (cus.direction==='increase') ? '#4CAF50' : red;
        else if(metric==='hrv') color = (cus.direction==='increase') ? '#4CAF50' : red;
        else if(metric==='steps') color = (cus.direction==='increase') ? '#4CAF50' : red;
        else if(metric==='rhr') color = (cus.direction==='increase') ? red : '#4CAF50';
        narratives.push(`<span style="color:${color}">${label} shows a sustained ${cus.direction} ${since} (Δ ${cus.strength}).</span>`);
      }
      narr('Sleep score', describeCUSUM(afterSleep, 'sleepScore'), 'sleep');
      narr('HRV', describeCUSUM(afterHRV, 'rmssd'), 'hrv');
      narr('Activity (steps)', describeCUSUM(afterSteps, 'steps'), 'steps');
      narr('Resting HR', describeCUSUM(afterRHR, 'rhr'), 'rhr');

      if(narratives.length){
        const corrDiv = document.createElement('div');
        corrDiv.className='muted';
        corrDiv.style.cssText='flex-basis:100%; margin:6px 0 0 0; padding:8px 8px 0 8px; border-top:1px solid #1a2349; color:#9aa5c6; font-size:12px; margin-left:214px;';
        corrDiv.innerHTML = narratives.map(t=>`<div>${t}</div>`).join('');
        row.appendChild(corrDiv);
      }
    });

    // Update footer meta with total events count on every render
    const metaEl = document.getElementById('meta');
    if(metaEl) metaEl.textContent = `${items.length} events • newest first`;
  }

  function addEvent(){
    const date = document.getElementById('le_date').value;
    const name = document.getElementById('le_name').value;
    const sentiment = document.getElementById('le_sentiment').value;
    const ev = { id: uuid(), date, name: name.trim(), sentiment, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    if(!validate(ev)){ alert('Please enter a valid date, event, and sentiment.'); return; }
    const data = loadEvents();
    data.events.push(ev);
    saveEvents(data);
    document.getElementById('le_name').value='';
    renderList();
  }

  function onListClick(e){
    const btn = e.target.closest('button'); if(!btn) return;
    const id = btn.getAttribute('data-id');
    const act = btn.getAttribute('data-act');
    const data = loadEvents();
    if(act==='del'){
      if(!confirm('Delete this event?')) return;
      data.events = data.events.filter(x=>x.id!==id);
      saveEvents(data); renderList(); return;
    }
    if(act==='edit'){
      const ev = data.events.find(x=>x.id===id); if(!ev) return;
      const newName = prompt('Edit event name', ev.name) ?? ev.name;
      const newDate = prompt('Edit date (YYYY-MM-DD)', ev.date) ?? ev.date;
      const newSent = prompt('Edit sentiment (negative|neutral|positive)', ev.sentiment) ?? ev.sentiment;
      const updated = { ...ev, name:newName.trim(), date:newDate, sentiment:newSent, updatedAt:new Date().toISOString() };
      if(!validate(updated)){ alert('Invalid values.'); return; }
      data.events = data.events.map(x=>x.id===id? updated: x);
      saveEvents(data); renderList(); return;
    }
  }

  // Attach to DOM before binding events so querySelector can find elements
  const parent = chartElement.parentElement;
  const footer = parent.querySelector('.footer');
  if (footer) parent.insertBefore(container, footer); else parent.appendChild(container);

  // Bind events using container-local query
  const addBtn = container.querySelector('#le_add');
  if (addBtn) addBtn.addEventListener('click', addEvent);
  list.addEventListener('click', onListClick);
  const exportBtn = container.querySelector('#le_export');
  if (exportBtn) exportBtn.addEventListener('click', ()=>{
    const data = loadEvents();
    const blob = new Blob([JSON.stringify(data, null, 2)], {type:'application/json'});
    const a = document.createElement('a');
    const dateStr = new Date().toISOString().slice(0,10).replace(/-/g,'');
    a.href = URL.createObjectURL(blob);
    a.download = `${PROFILE}-events-${dateStr}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  });
  const importBtn = container.querySelector('#le_import_btn');
  if (importBtn) importBtn.addEventListener('click', ()=> {
    const importInput = container.querySelector('#le_import');
    if (importInput) importInput.click();
  });
  const importInput = container.querySelector('#le_import');
  if (importInput) importInput.addEventListener('change', (e)=>{
    const f = e.target.files && e.target.files[0]; if(!f) return;
    const reader = new FileReader();
    reader.onload = () => {
      try{
        const parsed = JSON.parse(String(reader.result||'{}'));
        if(!parsed || typeof parsed!=='object' || !Array.isArray(parsed.events)) throw new Error('Invalid file');
        if(parsed.profileId && parsed.profileId !== PROFILE) {
          if(!confirm(`File is for profile ${parsed.profileId}. Import into ${PROFILE}?`)) return;
          parsed.profileId = PROFILE;
        }
        parsed.version = 1;
        saveEvents(parsed);
        renderList();
        render(); // Refresh the chart to stay on Life Events view
      }catch(err){ alert('Could not import: ' + (err && err.message ? err.message : 'Unknown error')); }
    };
    reader.readAsText(f);
  });

  renderList();
  // Footer meta for this view
  metaText = `${loadEvents().events.length} events • newest first`;

  // Gray out Date From/To controls for Life Events and set them to oldest available Fitbit data date
  try{
    const fromEl = document.getElementById('dateFrom');
    const toEl = document.getElementById('dateTo');
    const data = loadEvents();
    // Determine oldest date across loaded Fitbit datasets
    const dates = [];
    try { (normalizeSleepRows(rawSleep||[])).forEach(r=>{ if(r.dateISO) dates.push(String(r.dateISO)); }); } catch(_){}
    try { (tryLoadHRV()||[]).forEach(r=>{ if(r.dateISO) dates.push(String(r.dateISO)); }); } catch(_){}
    try { (tryLoadSteps()||[]).forEach(r=>{ if(r.dateISO) dates.push(String(r.dateISO)); }); } catch(_){}
    try { (tryLoadRHR()||[]).forEach(r=>{ if(r.dateISO) dates.push(String(r.dateISO)); }); } catch(_){}
    let oldest = null;
    if (dates.length){
      oldest = dates.sort()[0];
      if (fromEl) fromEl.value = oldest;
    }
    const todayISO = new Date().toISOString().slice(0,10);
    if (toEl) toEl.value = todayISO;
    // Limit Life Event date picker range
    const leDate = document.getElementById('le_date');
    if (leDate){
      if (fromEl && fromEl.value) leDate.min = fromEl.value; else if (oldest) leDate.min = oldest;
      leDate.max = toEl && toEl.value ? toEl.value : todayISO;
    }
    if (fromEl){ fromEl.disabled = true; fromEl.style.opacity = '0.5'; fromEl.style.pointerEvents = 'none'; }
    if (toEl){ toEl.disabled = true; toEl.style.opacity = '0.5'; toEl.style.pointerEvents = 'none'; }
  }catch(_){ /* ignore */ }
}
// Render sleep histogram chart for daily_score
if (chartType === 'daily_score' && window.sleepHistogramConfig) {
  const histogramDiv = document.getElementById('sleepHistogramChart');
  const histogramCanvas = document.getElementById('sleepHistogramCanvas');
  
  if (histogramDiv && histogramCanvas) {
    histogramDiv.style.display = 'block';
    
    // Destroy existing histogram chart if it exists
    if (window.sleepHistogramChart && window.sleepHistogramChart.destroy) {
      try {
        window.sleepHistogramChart.destroy();
      } catch (e) {
        console.warn('Error destroying sleep histogram chart:', e);
      }
    }
    
    try {
      window.sleepHistogramChart = new Chart(histogramCanvas.getContext('2d'), window.sleepHistogramConfig);
    } catch (error) {
      console.error('Error creating sleep histogram chart:', error);
    }
  }
} else {
  // Hide sleep histogram chart for other chart types (including analytics)
  const histogramDiv = document.getElementById('sleepHistogramChart');
  if (histogramDiv) {
    histogramDiv.style.display = 'none';
  }
  // Clear the sleep histogram chart reference when not showing
  if (window.sleepHistogramChart && window.sleepHistogramChart.destroy) {
    try {
      window.sleepHistogramChart.destroy();
    } catch (e) {
      console.warn('Error destroying sleep histogram chart:', e);
    }
    window.sleepHistogramChart = null;
  }
}
 renderTable(preview);
 
 // Collapsible steps preview logic
 (function(){
    const coll = document.getElementById('stepsPreviewCollapsible');
    const content = document.getElementById('stepsPreviewContent');
    const tri = document.getElementById('stepsPreviewTriangle');
    const toggle = document.getElementById('stepsPreviewToggle');
    const label = document.getElementById('stepsPreviewLabel');
    if(!coll || !content || !tri || !toggle) return;
    // Ensure one-time handler
    if(!toggle._bound){
      toggle.addEventListener('click', function(){
        const expanded = toggle.getAttribute('aria-expanded') === 'true';
        const next = !expanded;
        toggle.setAttribute('aria-expanded', String(next));
        tri.textContent = next ? '▼' : '◀';
        content.style.display = next ? 'block' : 'none';
        if(label){ label.style.display = next ? 'inline' : 'none'; }
      });
      toggle._bound = true;
    }
  const ct = document.getElementById('chartType').value;
  const previewCard = document.getElementById('previewTable')?.closest('.card');
  if(ct === 'daily_steps' || ct === 'corr_steps_hrv'){
      // Show collapsible, hide old preview card
      if(previewCard) previewCard.style.display = 'none';
      coll.style.display = 'block';
      // Default collapsed state
      toggle.setAttribute('aria-expanded','false');
      tri.textContent = '◀';
      content.style.display = 'none';
      if(label){ label.style.display = 'none'; }
      // Render into collapsible table
      renderTableTo('stepsPreviewTable', preview);
    } else {
      // Hide collapsible, show old preview card
      coll.style.display = 'none';
      if(previewCard) previewCard.style.display = '';
    }
  })();
 
 // Collapsible daily sleep score preview logic
 (function(){
   const coll = document.getElementById('sleepPreviewCollapsible');
   const content = document.getElementById('sleepPreviewContent');
   const tri = document.getElementById('sleepPreviewTriangle');
   const toggle = document.getElementById('sleepPreviewToggle');
   const label = document.getElementById('sleepPreviewLabel');
   if(!coll || !content || !tri || !toggle) return;
   if(!toggle._bound){
     toggle.addEventListener('click', function(){
       const expanded = toggle.getAttribute('aria-expanded') === 'true';
       const next = !expanded;
       toggle.setAttribute('aria-expanded', String(next));
       tri.textContent = next ? '▼' : '◀';
       content.style.display = next ? 'block' : 'none';
       if(label){ label.style.display = next ? 'inline' : 'none'; }
     });
     toggle._bound = true;
   }
  const ct = document.getElementById('chartType').value;
  const previewCard = document.getElementById('previewTable')?.closest('.card');
  if(ct === 'daily_score' || ct === 'daily_minutes' || ct === 'stages_pct' || ct === 'corr_same'){
    if(previewCard) previewCard.style.display = 'none';
    coll.style.display = 'block';
    toggle.setAttribute('aria-expanded','false');
    tri.textContent = '◀';
    content.style.display = 'none';
    if(label){ label.style.display = 'none'; }
    renderTableTo('sleepPreviewTable', preview);
  } else {
    coll.style.display = 'none';
    if(previewCard) previewCard.style.display = '';
  }
  })();
 
 // Collapsible RHR preview logic
 (function(){
   const coll = document.getElementById('rhrPreviewCollapsible');
   const content = document.getElementById('rhrPreviewContent');
   const tri = document.getElementById('rhrPreviewTriangle');
   const toggle = document.getElementById('rhrPreviewToggle');
   const label = document.getElementById('rhrPreviewLabel');
   if(!coll || !content || !tri || !toggle) return;
   if(!toggle._bound){
     toggle.addEventListener('click', function(){
       const expanded = toggle.getAttribute('aria-expanded') === 'true';
       const next = !expanded;
       toggle.setAttribute('aria-expanded', String(next));
       tri.textContent = next ? '▼' : '◀';
       content.style.display = next ? 'block' : 'none';
       if(label){ label.style.display = next ? 'inline' : 'none'; }
     });
     toggle._bound = true;
   }
   const ct = document.getElementById('chartType').value;
   const previewCard = document.getElementById('previewTable')?.closest('.card');
   if(ct === 'daily_rhr' || ct === 'hist_rhr'){
     if(previewCard) previewCard.style.display = 'none';
     coll.style.display = 'block';
     toggle.setAttribute('aria-expanded','false');
     tri.textContent = '◀';
     content.style.display = 'none';
     if(label){ label.style.display = 'none'; }
     renderTableTo('rhrPreviewTable', preview);
   } else {
     coll.style.display = 'none';
     if(previewCard) previewCard.style.display = '';
   }
 })();
 
 // Collapsible HRV preview logic
 (function(){
   const coll = document.getElementById('hrvPreviewCollapsible');
   const content = document.getElementById('hrvPreviewContent');
   const tri = document.getElementById('hrvPreviewTriangle');
   const toggle = document.getElementById('hrvPreviewToggle');
   const label = document.getElementById('hrvPreviewLabel');
   if(!coll || !content || !tri || !toggle) return;
   if(!toggle._bound){
     toggle.addEventListener('click', function(){
       const expanded = toggle.getAttribute('aria-expanded') === 'true';
       const next = !expanded;
       toggle.setAttribute('aria-expanded', String(next));
       tri.textContent = next ? '▼' : '◀';
       content.style.display = next ? 'block' : 'none';
       if(label){ label.style.display = next ? 'inline' : 'none'; }
     });
     toggle._bound = true;
   }
   const ct = document.getElementById('chartType').value;
   const previewCard = document.getElementById('previewTable')?.closest('.card');
   if(ct === 'hrv_heatmap'){
     if(previewCard) previewCard.style.display = 'none';
     coll.style.display = 'block';
     toggle.setAttribute('aria-expanded','false');
     tri.textContent = '◀';
     content.style.display = 'none';
     if(label){ label.style.display = 'none'; }
     renderTableTo('hrvPreviewTable', preview);
   } else {
     coll.style.display = 'none';
     if(previewCard) previewCard.style.display = '';
   }
 })();
 
 // Collapsible Analytics preview logic
 (function(){
   const coll = document.getElementById('analyticsPreviewCollapsible');
   const content = document.getElementById('analyticsPreviewContent');
   const tri = document.getElementById('analyticsPreviewTriangle');
   const toggle = document.getElementById('analyticsPreviewToggle');
   const label = document.getElementById('analyticsPreviewLabel');
   if(!coll || !content || !tri || !toggle) return;
   if(!toggle._bound){
     toggle.addEventListener('click', function(){
       const expanded = toggle.getAttribute('aria-expanded') === 'true';
       const next = !expanded;
       toggle.setAttribute('aria-expanded', String(next));
       tri.textContent = next ? '▼' : '◀';
       content.style.display = next ? 'block' : 'none';
       if(label){ label.style.display = next ? 'inline' : 'none'; }
     });
     toggle._bound = true;
   }
   const ct = document.getElementById('chartType').value;
   const previewCard = document.getElementById('previewTable')?.closest('.card');
   if(ct === 'analytics'){
     if(previewCard) previewCard.style.display = 'none';
     coll.style.display = 'block';
     toggle.setAttribute('aria-expanded','false');
     tri.textContent = '◀';
     content.style.display = 'none';
     if(label){ label.style.display = 'none'; }
     renderTableTo('analyticsPreviewTable', preview);
   } else {
     coll.style.display = 'none';
     if(previewCard) previewCard.style.display = '';
   }
 })();

// Collapsible Sleep Histogram preview logic
(function(){
  const coll = document.getElementById('sleepHistogramPreviewCollapsible');
  const content = document.getElementById('sleepHistogramPreviewContent');
  const tri = document.getElementById('sleepHistogramPreviewTriangle');
  const toggle = document.getElementById('sleepHistogramPreviewToggle');
  const label = document.getElementById('sleepHistogramPreviewLabel');
  if(!coll || !content || !tri || !toggle) return;
  if(!toggle._bound){
    toggle.addEventListener('click', function(){
      const expanded = toggle.getAttribute('aria-expanded') === 'true';
      const next = !expanded;
      toggle.setAttribute('aria-expanded', String(next));
      tri.textContent = next ? '▼' : '◀';
      content.style.display = next ? 'block' : 'none';
      if(label){ label.style.display = next ? 'inline' : 'none'; }
    });
    toggle._bound = true;
  }
  const ct = document.getElementById('chartType').value;
  const previewCard = document.getElementById('previewTable')?.closest('.card');
  if(ct === 'daily_score'){
    if(previewCard) previewCard.style.display = 'none';
    coll.style.display = 'block';
    toggle.setAttribute('aria-expanded','false');
    tri.textContent = '◀';
    content.style.display = 'none';
    if(label){ label.style.display = 'none'; }
    // Populate the sleep histogram preview table
    if(window.sleepHistogramPreview) {
      renderTableTo('sleepHistogramPreviewTable', window.sleepHistogramPreview);
    }
  } else {
    coll.style.display = 'none';
    if(previewCard) previewCard.style.display = '';
  }
 })();
 
// Hide steps sections for non-steps charts
if (chartType !== 'daily_steps') {
   document.getElementById('topStepsSection').style.display = 'none';
   document.getElementById('bottomStepsSection').style.display = 'none';
 }
 
 // Hide RHR sections for non-histogram RHR charts
 if (chartType !== 'hist_rhr') {
   document.getElementById('topRHRSection').style.display = 'none';
   document.getElementById('bottomRHRSection').style.display = 'none';
   document.getElementById('rhrCusumSection').style.display = 'none';
 }
 
// Hide sleep score sections for non-sleep score charts
if (chartType !== 'daily_score') {
   document.getElementById('topSleepScoreSection').style.display = 'none';
   document.getElementById('bottomSleepScoreSection').style.display = 'none';
 }
 
 // Hide HRV sections for non-HRV heatmap charts
 if (chartType !== 'hrv_heatmap') {
   document.getElementById('topHRVSection').style.display = 'none';
   document.getElementById('bottomHRVSection').style.display = 'none';
   document.getElementById('hrvCusumSection').style.display = 'none';
 }
 
// Hide "Ignore Naps" checkbox for non-sleep charts (show for predictions too)
const sleepCharts = ['daily_score', 'daily_minutes', 'stages_pct', 'corr_same', 'analytics', 'predictions'];
 const ignoreNapsCell = document.getElementById('mainOnly').closest('.cell');
 if (sleepCharts.includes(chartType)) {
   ignoreNapsCell.style.visibility = 'visible';
   ignoreNapsCell.style.opacity = '1';
 } else {
   ignoreNapsCell.style.visibility = 'hidden';
   ignoreNapsCell.style.opacity = '0';
 }

// Show/hide additional HRV correlation chart
if (chartType === 'corr_same') {
  document.getElementById('dualHRVCorrelationCharts').style.display = 'block';
} else {
  document.getElementById('dualHRVCorrelationCharts').style.display = 'none';
  
  // Clean up additional HRV correlation chart when switching away
  if(window.hrvCorrNextChart && typeof window.hrvCorrNextChart.destroy === 'function') {
    window.hrvCorrNextChart.destroy();
    window.hrvCorrNextChart = null;
  }
  
  // Clean up resize listener when switching away
  if (window.hrvCorrResizeHandler) {
    window.removeEventListener('resize', window.hrvCorrResizeHandler);
    window.hrvCorrResizeHandler = null;
  }
  
  // Clean up meta elements when switching away
  const sameNightMetaElement = document.getElementById('sameNightMeta');
  if (sameNightMetaElement) {
    sameNightMetaElement.remove();
  }
  
  const nextDayMetaElement = document.getElementById('nextDayMeta');
  if (nextDayMetaElement) {
    nextDayMetaElement.remove();
  }
}

// Show/hide additional Steps correlation chart
if (chartType === 'corr_steps_hrv') {
  document.getElementById('dualStepsCorrelationCharts').style.display = 'block';
} else {
  document.getElementById('dualStepsCorrelationCharts').style.display = 'none';
  
  // Clean up additional Steps correlation chart when switching away
  if(window.stepsCorrSleepChart && typeof window.stepsCorrSleepChart.destroy === 'function') {
    window.stepsCorrSleepChart.destroy();
    window.stepsCorrSleepChart = null;
  }
  
  // Clean up Steps meta elements when switching away
  const stepsHrvMetaElement = document.getElementById('stepsHrvMeta');
  if (stepsHrvMetaElement) {
    stepsHrvMetaElement.remove();
  }
  
  const stepsSleepMetaElement = document.getElementById('stepsSleepMeta');
  if (stepsSleepMetaElement) {
    stepsSleepMetaElement.remove();
  }
}

if (chartType === 'predictions') {
  // Clean up any other elements first
  const existingAnalyticsBadges = document.getElementById('analyticsBadges');
  if (existingAnalyticsBadges) {
    existingAnalyticsBadges.style.display = 'none';
  }
  
  const existingTable = document.getElementById('correlationMatrixTable');
  if (existingTable) {
    existingTable.remove();
  }
  
  const existingLegend = document.getElementById('correlationLegend');
  if (existingLegend) {
    existingLegend.remove();
  }
  
  const existingContainer = document.querySelector('.correlation-matrix-container');
  if (existingContainer) {
    existingContainer.remove();
  }
  
  // Hide all additional chart containers
  const dualHRVCharts = document.getElementById('dualHRVCorrelationCharts');
  if (dualHRVCharts) {
    dualHRVCharts.style.display = 'none';
  }
  
  const dualStepsCharts = document.getElementById('dualStepsCorrelationCharts');
  if (dualStepsCharts) {
    dualStepsCharts.style.display = 'none';
  }
  
  const stepsHistogramChart = document.getElementById('stepsHistogramChart');
  if (stepsHistogramChart) {
    stepsHistogramChart.style.display = 'none';
  }
  
  const sleepHistogramChart = document.getElementById('sleepHistogramChart');
  if (sleepHistogramChart) {
    sleepHistogramChart.style.display = 'none';
  }
  
  const rhrCusumSection = document.getElementById('rhrCusumSection');
  if (rhrCusumSection) {
    rhrCusumSection.style.display = 'none';
  }
  
  const hrvCusumSection = document.getElementById('hrvCusumSection');
  if (hrvCusumSection) {
    hrvCusumSection.style.display = 'none';
  }
  
  // Clean up any existing predictions container first
  const existingPredictionsContainer = document.querySelector('.predictions-container');
  if (existingPredictionsContainer) {
    existingPredictionsContainer.remove();
  }
  
  // Generate predictions
  const predictions = generatePredictions();
  preview = predictions;
  
  // Create predictions display
  cfg = createPredictionsChart(predictions);
  
  // Set metaText for predictions (nights • range only; no averages)
  const from = document.getElementById('dateFrom').value;
  const to = document.getElementById('dateTo').value;
  metaText = `${filtered.length} nights • range ${from || 'start'} to ${to || 'end'}`;
  
} else if (chartType === 'correlation_matrix') {
  // Clean up any analytics elements first
  const existingAnalyticsBadges = document.getElementById('analyticsBadges');
  if (existingAnalyticsBadges) {
    existingAnalyticsBadges.style.display = 'none';
  }
  
  // Clean up any predictions container
  const existingPredictionsContainer = document.querySelector('.predictions-container');
  if (existingPredictionsContainer) {
    existingPredictionsContainer.remove();
  }
  
  const from = document.getElementById('dateFrom').value;
  const to = document.getElementById('dateTo').value;
  
  // Load and filter data
  const sleepN = normalizeSleepRows(rawSleep);
  const filtered = filterSleep(sleepN);
  const hrv = tryLoadHRV();
  const steps = tryLoadSteps();
  const rhr = tryLoadRHR();
  
  // Filter by date range
  const filteredSleep = filtered.filter(r => {
    if (from && r.dateISO < from) return false;
    if (to && r.dateISO > to) return false;
    return true;
  });
  
  const filteredHRV = hrv ? hrv.filter(r => {
    if (from && r.dateISO < from) return false;
    if (to && r.dateISO > to) return false;
    return true;
  }) : [];
  
  const filteredSteps = steps ? steps.filter(r => {
    if (from && r.dateISO < from) return false;
    if (to && r.dateISO > to) return false;
    return true;
  }) : [];
  
  const filteredRHR = rhr ? rhr.filter(r => {
    if (from && r.dateISO < from) return false;
    if (to && r.dateISO > to) return false;
    return true;
  }) : [];
  
  if (filteredSleep.length === 0 || filteredHRV.length === 0 || filteredSteps.length === 0 || filteredRHR.length === 0) {
    document.getElementById('note').innerHTML = 'Please load sleep, HRV, steps, and RHR CSVs to view correlation matrix';
    preview = [];
    cfg = createMessageChart('Please load sleep, HRV, steps, and RHR CSVs to view correlation matrix');
  } else {
    // Create correlation matrix
    const correlationData = computeCorrelationMatrix(filteredSleep, filteredHRV, filteredSteps, filteredRHR);
    preview = correlationData;
    
    // Set dynamic metaText based on actual data points and date range
    const from = document.getElementById('dateFrom').value;
    const to = document.getElementById('dateTo').value;
    
    if (from && to) {
      const startDate = new Date(from);
      const endDate = new Date(to);
      const diffTime = Math.abs(endDate - startDate);
      const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
      const diffMonths = Math.ceil(diffTime / (1000 * 60 * 60 * 24 * 30.44)); // Average days per month
      const diffYears = Math.ceil(diffTime / (1000 * 60 * 60 * 24 * 365.25)); // Average days per year
      
      let timeUnit, count;
      if (diffYears >= 2) {
        timeUnit = 'years';
        count = diffYears;
      } else if (diffMonths >= 2) {
        timeUnit = 'months';
        count = diffMonths;
      } else {
        timeUnit = 'nights';
        count = diffDays;
      }
      
      // Use actual data point count, but show the appropriate time unit
      const actualDataPoints = Math.min(filteredSleep.length, filteredHRV.length, filteredSteps.length, filteredRHR.length);
      metaText = `Correlation Matrix • ${actualDataPoints} data points (${count} ${timeUnit}) • range ${from} to ${to}`;
    } else {
      metaText = `Correlation Matrix • ${filteredSleep.length} nights`;
    }
    
    // Create heatmap visualization
    cfg = createCorrelationMatrixChart(correlationData);
    
    // Ensure toolbar is positioned below the correlation matrix
    const toolbar = document.querySelector('.toolbar');
    const footer = document.querySelector('.footer');
    if (toolbar && footer) {
      // Move toolbar to be after correlation matrix but before footer
      footer.parentNode.insertBefore(toolbar, footer);
    }
  }
}

// Hide all other sections when analytics or correlation matrix is selected
if (chartType === 'analytics' || chartType === 'correlation_matrix') {
  // Ensure Life Events UI is fully removed when switching to these views
  const leContainer = document.getElementById('lifeEventsContainer');
  if (leContainer) leContainer.remove();
  try {
    const fromEl = document.getElementById('dateFrom');
    const toEl = document.getElementById('dateTo');
    const sameDayToggle = document.getElementById('sameDayToggleCell');
    if (fromEl) { fromEl.disabled = false; fromEl.style.opacity = ''; fromEl.style.pointerEvents = ''; }
    if (toEl) { toEl.disabled = false; toEl.style.opacity = ''; toEl.style.pointerEvents = ''; }
    if (sameDayToggle) { sameDayToggle.style.display = 'none'; }
  } catch(_) { /* ignore */ }
  document.getElementById('topStepsSection').style.display = 'none';
  document.getElementById('bottomStepsSection').style.display = 'none';
  document.getElementById('topRHRSection').style.display = 'none';
  document.getElementById('bottomRHRSection').style.display = 'none';
  document.getElementById('topSleepScoreSection').style.display = 'none';
  document.getElementById('bottomSleepScoreSection').style.display = 'none';
  document.getElementById('topHRVSection').style.display = 'none';
  document.getElementById('bottomHRVSection').style.display = 'none';
  document.getElementById('rhrCusumSection').style.display = 'none';
  document.getElementById('hrvCusumSection').style.display = 'none';
  // Chart display will be handled by the render function based on cfg
} else {
  // Clean up correlation elements when switching away
  const existingLegend = document.getElementById('correlationLegend');
  if (existingLegend) {
    existingLegend.remove();
  }
  const existingTable = document.getElementById('correlationMatrixTable');
  if (existingTable) {
    existingTable.remove();
  }
  // Clean up analytics elements when switching away
  const existingAnalyticsBadges = document.getElementById('analyticsBadges');
  if (existingAnalyticsBadges) {
    existingAnalyticsBadges.style.display = 'none';
  }
  
  // Clean up predictions elements when switching away (but not when creating predictions)
  if (chartType !== 'predictions') {
    const existingPredictionsContainer = document.querySelector('.predictions-container');
    if (existingPredictionsContainer) {
      existingPredictionsContainer.remove();
    }
  }
  // Show chart for all other chart types (except analytics, predictions, and life_events)
  if (chartType !== 'analytics' && chartType !== 'predictions' && chartType !== 'life_events') {
    document.getElementById('chart').style.display = 'block';
  } else if (chartType === 'predictions' || chartType === 'life_events') {
    // Hide chart canvas for predictions (custom display handles it)
    document.getElementById('chart').style.display = 'none';
  }
  
  // Clean up Life Events container and restore controls when switching away
  if (chartType !== 'life_events') {
    const leContainer = document.getElementById('lifeEventsContainer');
    if (leContainer) leContainer.remove();
    try {
      const fromEl = document.getElementById('dateFrom');
      const toEl = document.getElementById('dateTo');
      const sameDayToggle = document.getElementById('sameDayToggleCell');
      if (fromEl) { fromEl.disabled = false; fromEl.style.opacity = ''; fromEl.style.pointerEvents = ''; }
      if (toEl) { toEl.disabled = false; toEl.style.opacity = ''; toEl.style.pointerEvents = ''; }
      if (sameDayToggle) { sameDayToggle.style.display = 'none'; }
    } catch(_) { /* ignore */ }
  } else {
    // Show same-day toggle for Life Events
    try {
      const sameDayToggle = document.getElementById('sameDayToggleCell');
      if (sameDayToggle) { sameDayToggle.style.display = 'block'; }
    } catch(_) { /* ignore */ }
  }
}
}

function downloadCSV(rows, name){ if(!rows.length) return; const cols = Object.keys(rows[0]); const csv = [cols.join(',')].concat(rows.map(r=>cols.map(c=>r[c]??'').join(','))).join('\n'); const blob = new Blob([csv],{type:'text/csv'}); const url = URL.createObjectURL(blob); const a=document.createElement('a'); a.href=url; a.download=name; a.click(); URL.revokeObjectURL(url) }

function mergeByKey(rowsA, rowsB, key){ const map=new Map(); for(const r of rowsA){ map.set(r[key],{...r}); } for(const r of rowsB){ const k=r[key]; if(map.has(k)) map.set(k,{...map.get(k),...r}); else map.set(k,{...r}); } return [...map.values()].sort((a,b)=> String(a[key]).localeCompare(String(b[key]))); }

  function buildSummaries(){ const sleepN = normalizeSleepRows(rawSleep); const filtered = filterSleep(sleepN); const monthly = groupByMonth(filtered); const yearly = groupByYear(filtered); const mRows = monthly.map(r=>({month:r.key,sleepScore:fmt(r.sleepScore),minutesAsleep:fmt(r.minutesAsleep),efficiency:fmt(r.efficiency),pctDeep:fmt(r.pctDeep),pctREM:fmt(r.pctREM),pctLight:fmt(r.pctLight)})); const yRows = yearly.map(r=>({year:r.key,sleepScore:fmt(r.sleepScore),minutesAsleep:fmt(r.minutesAsleep),efficiency:fmt(r.efficiency),pctDeep:fmt(r.pctDeep),pctREM:fmt(r.pctREM),pctLight:fmt(r.pctLight)})); return {mRows,yRows} }

async function init(){ if(!PROFILE_ID){ return; } await tryLoadDefaults(); 
  // Set default date values
  const today = new Date();
  const sixMonthsAgo = new Date();
  sixMonthsAgo.setMonth(today.getMonth() - 6);
  
  document.getElementById('dateFrom').value = sixMonthsAgo.toISOString().slice(0, 10);
  document.getElementById('dateTo').value = today.toISOString().slice(0, 10);
  
  // Set max date to today to prevent future date selection
  const todayString = today.toISOString().slice(0, 10);
  document.getElementById('dateFrom').max = todayString;
  document.getElementById('dateTo').max = todayString;
  
  const sleepFile = document.getElementById('sleepFile'); if (sleepFile) sleepFile.addEventListener('change',e=>{ const f=e.target.files[0]; if(!f) return; document.getElementById('sleepFileDisplay').textContent = f.name; fileToData(f,d=>{ rawSleep=d; const isValid = validateSleepData(d); updateStatusIndicator('sleepStatus', isValid); render() }) }); 
  const hrvFile = document.getElementById('hrvFile'); if (hrvFile) hrvFile.addEventListener('change',e=>{ const f=e.target.files[0]; if(!f) return; document.getElementById('hrvFileDisplay').textContent = f.name; fileToData(f,d=>{ rawHRV=d; const isValid = validateHRVData(d); updateStatusIndicator('hrvStatus', isValid); render() }) }); 
  const stepsFile = document.getElementById('stepsFile'); if (stepsFile) stepsFile.addEventListener('change',e=>{ const f=e.target.files[0]; if(!f) return; document.getElementById('stepsFileDisplay').textContent = f.name; fileToData(f,d=>{ rawSteps=d; const isValid = validateStepsData(d); updateStatusIndicator('stepsStatus', isValid); render() }) }); 
  const rhrFile = document.getElementById('rhrFile'); if (rhrFile) rhrFile.addEventListener('change',e=>{ const f=e.target.files[0]; if(!f) return; document.getElementById('rhrFileDisplay').textContent = f.name; fileToData(f,d=>{ rawRHR=d; const isValid = validateRHRData(d); updateStatusIndicator('rhrStatus', isValid); render() }) });
  const refreshBtnEl = document.getElementById('refreshBtn'); if (refreshBtnEl) refreshBtnEl.addEventListener('click',render);
  
  // Fetch data button functionality
  const fetchBtn = document.getElementById('fetchDataBtn');
  const fetchStatus = document.getElementById('fetchStatus');
  if (fetchBtn && fetchStatus) {
    fetchBtn.addEventListener('click', async function() {
      if (!PROFILE_ID) {
        fetchStatus.textContent = 'Error: No profile selected';
        fetchStatus.style.color = '#ff9b9b';
        return;
      }
      
      // Disable button and show status
      fetchBtn.disabled = true;
      fetchBtn.textContent = '⏳';
      fetchBtn.style.color = '#9aa5c6';
      fetchBtn.style.cursor = 'not-allowed';
      fetchBtn.style.animation = 'spin 1s linear infinite';
      fetchStatus.textContent = 'Starting...';
      fetchStatus.style.color = '#7bffbf';
      
      try {
        // Start fetch operation
        const response = await fetch('/api/fetch-data', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ profile: PROFILE_ID })
        });
        
        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}));
          throw new Error(`HTTP ${response.status}: ${errorData.error || 'Unknown error'}`);
        }
        
        const result = await response.json();
        const jobId = result.job_id;
        currentFetchJobId = jobId; // Store globally for modal access
        
        console.log(`[Main] Created job ${jobId}`);
        
        // Clear any existing job ID when starting a new fetch
        if (currentFetchJobId && currentFetchJobId !== jobId) {
          console.log(`[Main] Clearing old job ID ${currentFetchJobId} for new job ${jobId}`);
        }
        
        // Cancel fetch retry function
        window.cancelFetchRetry = async (jobId) => {
          console.log(`[Cancel] Attempting to cancel job ${jobId}`);
          if (confirm('Are you sure you want to cancel this fetch operation?')) {
            try {
              const response = await fetch(`/api/cancel-fetch/${jobId}`, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                }
              });
              
              console.log(`[Cancel] Cancel response status: ${response.status}`);
              
              if (response.ok) {
                const result = await response.json();
                console.log(`[Cancel] Cancel successful:`, result);
                fetchStatus.textContent = 'Fetch cancelled';
                fetchStatus.style.color = '#ff9b9b';
                fetchBtn.disabled = false;
                fetchBtn.textContent = '↻';
                fetchBtn.style.color = '#7bffbf';
                fetchBtn.style.cursor = 'pointer';
                fetchBtn.style.animation = 'none';
                
                // Clear the current job ID to prevent further polling
                currentFetchJobId = null;
              } else {
                const errorData = await response.json().catch(() => ({}));
                console.error('Failed to cancel fetch:', errorData.error || 'Unknown error');
                alert(`Failed to cancel fetch: ${errorData.error || 'Unknown error'}`);
              }
            } catch (error) {
              console.error('Error cancelling fetch:', error);
              alert(`Error cancelling fetch: ${error.message}`);
            }
          }
        };

        // Poll for status updates
        const pollStatus = async () => {
          try {
            const statusResponse = await fetch(`/api/fetch-status/${jobId}`);
            if (!statusResponse.ok) {
              throw new Error(`HTTP ${statusResponse.status}`);
            }
            
            const status = await statusResponse.json();
            
            console.log(`[Main] Job ${jobId} status:`, status.status);
            
            if (status.status === 'completed') {
              // Check if there were any real warnings during the fetch (not normal 404s or 500s)
              const hasWarnings = status.output && status.output.includes('⚠️') && 
                !status.output.includes('404 - Data not found') &&
                !status.output.includes('500 - API error') &&
                !status.output.includes('This is normal if your watch wasn\'t synced') &&
                !status.output.includes('This usually means the date range is too large');
              const successMessage = hasWarnings ? '✅ Success (with warnings)' : '✅ Success';
              fetchStatus.textContent = successMessage;
              fetchStatus.style.color = '#7bffbf';
              fetchBtn.textContent = '↻';
              fetchBtn.style.color = '#7bffbf';
              fetchBtn.style.cursor = 'pointer';
              fetchBtn.style.animation = 'none';
              fetchBtn.disabled = false;
              
              // Clear current job ID
              currentFetchJobId = null;
              
              
              // Reload data and refresh display
              await tryLoadDefaults();
              render();
              
              // Fade away success message after 3 seconds
              setTimeout(() => {
                fetchStatus.style.transition = 'opacity 1s ease-out';
                fetchStatus.style.opacity = '0';
                setTimeout(() => {
                  fetchStatus.textContent = '';
                  fetchStatus.style.color = '#9aa5c6';
                  fetchStatus.style.opacity = '1';
                  fetchStatus.style.transition = '';
                }, 1000);
              }, 3000);
              
            } else if (status.status === 'failed' || status.status === 'error' || status.status === 'timeout') {
              let errorMsg = '❌ Failed';
              if (status.error && (status.error.includes('re-authorization') || status.error.includes('Token expired') || status.error.includes('not found') || status.error.includes('Token refresh failed'))) {
                // Extract the specific error message
                let specificError = status.error;
                if (status.error.includes('Token refresh failed:')) {
                  specificError = status.error.split('Token refresh failed: ')[1].split('. ')[0];
                  errorMsg = '❌ Token Refresh Failed';
                } else if (status.error.includes('not found')) {
                  specificError = 'Profile not found';
                  errorMsg = '❌ Profile Not Found';
                } else {
                  specificError = 'Authorization required';
                  errorMsg = '❌ Needs Authorization';
                }
                
                // Show the specific error and command
                fetchStatus.innerHTML = `${errorMsg}<br><small style="color:#7bffbf;">Go to Profile Management → Existing Profiles → Auth</small>`;
              } else {
                // Show the full error message for other types of failures
                fetchStatus.innerHTML = `${errorMsg}<br><small style="color:#9aa5c6;">${status.error || 'Unknown error'}</small>`;
              }
              fetchStatus.style.color = '#ff9b9b';
              fetchBtn.textContent = '↻';
              fetchBtn.style.color = '#ff9b9b';
              fetchBtn.style.cursor = 'pointer';
              fetchBtn.style.animation = 'none';
              fetchBtn.disabled = false;
              
              // Clear current job ID
              currentFetchJobId = null;
              
              
            } else if (status.status === 'running') {
              // Check if there are any real warnings in the output (not normal 404s or 500s)
              const hasWarnings = status.output && status.output.includes('⚠️') && 
                !status.output.includes('404 - Data not found') &&
                !status.output.includes('500 - API error') &&
                !status.output.includes('This is normal if your watch wasn\'t synced') &&
                !status.output.includes('This usually means the date range is too large');
              const warningIndicator = hasWarnings ? ' ⚠️' : '';
              
              // Render a progress bar based on start_date -> today using server-provided fields
              const renderFetchProgress = (st)=>{
                const today = new Date();
                const todayStr = today.toISOString().slice(0,10);
                const startStr = st.start_date;
                const lastStr = st.last_date || startStr;
                const csv = st.current_csv || (st.current_script || '').replace('fetch_','').replace('.py','');
                let pct = 0;
                try{
                  if (startStr){
                    const startD = new Date(startStr + 'T00:00:00Z');
                    const lastD = lastStr ? new Date(lastStr + 'T00:00:00Z') : startD;
                    const total = Math.max(1, Math.floor((today - startD) / (24*3600*1000)));
                    const done = Math.max(0, Math.floor((Math.min(today, lastD) - startD) / (24*3600*1000)));
                    pct = Math.max(0, Math.min(100, Math.round((done/total)*100)));
                  }
                }catch(_){ pct = 0; }
                const label = csv ? `${csv}${warningIndicator}` : `Fetching${warningIndicator}`;
                const throttleActive = !!st.throttle_active;
                const mmss = st.throttle_mmss;
                const reason = st.throttle_reason;
                const until = st.throttle_until;
                const throttleLine = throttleActive
                  ? `<div style="margin-top:2px;color:#ff9b9b;display:flex;align-items:center;gap:8px;">
                       <span>${reason || 'Rate limited'} — retrying at ${until || '…'}</span>
                       <button onclick="cancelFetchRetry('${jobId}')" style="background:none;border:none;color:#ff9b9b;cursor:pointer;font-size:14px;padding:2px;margin-left:4px;" title="Cancel retry">×</button>
                     </div>`
                  : '';
                const bar = `
                  <div style="display:flex;align-items:center;gap:8px;">
                    <span style="color:#7bffbf;white-space:nowrap;">${label}</span>
                    <div style="flex:1;height:6px;background:#2d3748;border-radius:4px;overflow:hidden;">
                      <div style="height:100%;width:${pct}%;background:#7bffbf;transition:width 0.5s;"></div>
                    </div>
                    <span style="color:#7bffbf;min-width:32px;text-align:right;">${pct}%</span>
                  </div>
                  <div style="margin-top:2px;color:#9aa5c6;">${startStr || 'unknown'} → ${todayStr}</div>
                  ${throttleLine}
                `;
                fetchStatus.innerHTML = bar;
              };
              function renderFetchProgress2(st){
                const today = new Date();
                const todayStr = today.toISOString().slice(0,10);
                const startStr = st.start_date;
                const lastStr = st.last_date || startStr;
                const csv = st.current_csv || (st.current_script || '').replace('fetch_','').replace('.py','');
                let pct = 0;
                try{
                  if (startStr){
                    const startD = new Date(startStr + 'T00:00:00Z');
                    const lastD = lastStr ? new Date(lastStr + 'T00:00:00Z') : startD;
                    const total = Math.max(1, Math.floor((today - startD) / (24*3600*1000)));
                    const done = Math.max(0, Math.floor((Math.min(today, lastD) - startD) / (24*3600*1000)));
                    pct = Math.max(0, Math.min(100, Math.round((done/total)*100)));
                  }
                }catch(_){ pct = 0; }
                const label = csv ? `${csv}${warningIndicator}` : `Fetching${warningIndicator}`;
                const throttleActive = !!st.throttle_active;
                const mmss = st.throttle_mmss;
                const until = st.throttle_until; // 'HH:MM:SS' in server local time (Eastern)
                // derive mm:ss if not provided
                let derivedMMSS = null;
                if (!mmss && until && /^\d{2}:\d{2}:\d{2}$/.test(until)) {
                  try {
                    const now = new Date();
                    const [uh, um, us] = until.split(':').map(x => parseInt(x, 10));
                    // Server time is in Eastern, treat as local time
                    const tgt = new Date(now);
                    tgt.setHours(uh, um, us || 0, 0);
                    if (tgt <= now) { tgt.setDate(tgt.getDate() + 1); }
                    const diff = Math.max(0, Math.round((tgt - now) / 1000));
                    const m = Math.floor(diff / 60);
                    const s = diff % 60;
                    derivedMMSS = `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
                  } catch(_) {}
                }
                // format until time in 12h clock (server time is local time)
                let untilDisplay = null;
                if (until && /^\d{2}:\d{2}:\d{2}$/.test(until)) {
                  try {
                    const [hh, mm] = until.split(':');
                    let H = parseInt(hh, 10);
                    const M = parseInt(mm, 10);
                    const ampm = H >= 12 ? 'PM' : 'AM';
                    H = H % 12; if (H === 0) H = 12;
                    untilDisplay = `${H}:${String(M).padStart(2,'0')} ${ampm}`;
                  } catch(_) {}
                }
                const mmssDisplay = mmss || derivedMMSS || '…';
                const throttleLine = throttleActive
                  ? `<div style="margin-top:2px;color:#ff9b9b;display:flex;align-items:center;gap:8px;">
                       <span>API Limit - retrying at ${untilDisplay || '…'}</span>
                       <button onclick="cancelFetchRetry('${jobId}')" style="background:none;border:none;color:#ff9b9b;cursor:pointer;font-size:14px;padding:2px;margin-left:4px;" title="Cancel retry">×</button>
                     </div>`
                  : '';
                const bar = `
                  <div style="display:flex;align-items:center;gap:8px;">
                    <span style="color:#7bffbf;white-space:nowrap;">${label}</span>
                    <div style="flex:1;height:6px;background:#2d3748;border-radius:4px;overflow:hidden;">
                      <div style="height:100%;width:${pct}%;background:#7bffbf;transition:width 0.5s;"></div>
                    </div>
                    <span style="color:#7bffbf;min-width:32px;text-align:right;">${pct}%</span>
                  </div>
                  <div style=\"margin-top:2px;color:#9aa5c6;\">${startStr || 'unknown'} → ${todayStr}</div>
                  ${throttleLine}
                `;
                fetchStatus.innerHTML = bar;
              }
              renderFetchProgress2(status);
              // Continue polling - use longer interval when throttled
              const pollInterval = status.throttle_active ? 10000 : 2000; // 10s when throttled, 2s normally
              setTimeout(pollStatus, pollInterval);
              
            } else {
              // Still queued or other status
              fetchStatus.textContent = '⏳ Queued...';
              fetchStatus.style.color = '#7bffbf';
              // Poll less frequently when throttled to reduce server load
              const pollInterval = status.throttle_active ? 10000 : 1000; // 10s when throttled, 1s normally
              setTimeout(pollStatus, pollInterval);
            }
            
          } catch (error) {
            console.error('Error polling fetch status:', error);
            
            // Check if it's a 404 error (job not found) - this might be a race condition
            if (error.message && error.message.includes('404')) {
              console.log('Job not found (404) - might be a race condition, retrying...');
              // Retry once more after a short delay
              setTimeout(pollStatus, 2000);
              return;
            }
            
            fetchStatus.textContent = `❌ Error`;
            fetchStatus.style.color = '#ff9b9b';
            fetchBtn.textContent = '↻';
            fetchBtn.style.color = '#ff9b9b';
            fetchBtn.style.cursor = 'pointer';
            fetchBtn.style.animation = 'none';
            fetchBtn.disabled = false;
          }
        };
        
        // Start polling
        setTimeout(pollStatus, 1000);
        
      } catch (error) {
        console.error('Error starting fetch:', error);
        fetchStatus.textContent = `❌ Error: ${error.message}`;
        fetchStatus.style.color = '#ff9b9b';
        fetchBtn.textContent = '↻';
        fetchBtn.style.color = '#7bffbf';
        fetchBtn.style.cursor = 'pointer';
        fetchBtn.style.animation = 'none';
        fetchBtn.disabled = false;
      }
    });
  }
  document.getElementById('chartType').addEventListener('change',function(){
  const chartType = this.value;
  const dateFrom = document.getElementById('dateFrom');
  const dateTo = document.getElementById('dateTo');
  
  if(chartType === 'daily_score'){
    const sleepToggle = document.getElementById('sleepViewToggle');
    const toggleValue = parseInt(sleepToggle.value);
    const isYearlyView = toggleValue === 2;
    
    if (isYearlyView) {
      // Switch inputs to numeric year for yearly sleep view
    dateFrom.type = 'number';
    dateTo.type = 'number';
    dateFrom.min = '2000';
      dateTo.max = '2030';
    dateTo.min = '2000';
    dateTo.max = '2030';
    try {
      const all = normalizeSleepRows(rawSleep);
      if (all && all.length > 0){
        let minY = all[0].date.getFullYear();
        let maxY = minY;
        for(const r of all){
          const y = r.date.getFullYear();
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
        dateFrom.value = minY;
        dateTo.value = maxY;
      } else {
        const cy = new Date().getFullYear();
        dateFrom.value = cy - 1;
        dateTo.value = cy;
      }
    } catch(_) {
      const cy = new Date().getFullYear();
      dateFrom.value = cy - 1;
      dateTo.value = cy;
    }
    } else {
      // Reset to date inputs for daily/monthly sleep view
      dateFrom.type = 'date';
      dateTo.type = 'date';
      dateFrom.min = '';
      dateFrom.max = todayString;
      dateTo.min = '';
      dateTo.max = todayString;
      // Only set default 6-month range if inputs are invalid;
      // honor open start (blank From with valid To)
      const isISO = (s)=> /^\d{4}-\d{2}-\d{2}$/.test(String(s||''));
      if ((!isISO(dateFrom.value) || !isISO(dateTo.value)) && !(dateFrom.value === '' && isISO(dateTo.value))) {
        const sixMonthsAgo = new Date();
        sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
        dateFrom.value = sixMonthsAgo.toISOString().slice(0, 10);
        dateTo.value = todayString;
      }
    }
  } else if (false){ // yearly_steps removed
    // Switch inputs to numeric year and set to full available range from steps data
    dateFrom.type = 'number';
    dateTo.type = 'number';
    dateFrom.min = '2000';
    dateFrom.max = '2030';
    dateTo.min = '2000';
    dateTo.max = '2030';
    try {
      const s = tryLoadSteps();
      if (s && s.length > 0){
        let minY = s[0].date.getFullYear();
        let maxY = minY;
        for(const r of s){
          const y = r.date.getFullYear();
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
        dateFrom.value = minY;
        dateTo.value = maxY;
      } else {
        const cy = new Date().getFullYear();
        dateFrom.value = cy - 1;
        dateTo.value = cy;
      }
    } catch(_) {
      const cy = new Date().getFullYear();
      dateFrom.value = cy - 1;
      dateTo.value = cy;
    }
  } else if (chartType === 'daily_rhr') {
    // Delegate to shared sync logic for RHR
    syncRHRDateInputs();
  } else if (chartType === 'analytics') {
    // Set date inputs for comprehensive analytics
    dateFrom.type = 'date';
    dateTo.type = 'date';
    dateFrom.removeAttribute('placeholder');
    dateTo.removeAttribute('placeholder');
    
    // Set min/max dates based on available data
    const todayString = new Date().toISOString().slice(0, 10);
    let minDate = todayString; // Default to today if no data
    
    // Find the earliest date from all available data
    const allSteps = tryLoadSteps();
    const allSleep = normalizeSleepRows(rawSleep);
    const allHRV = tryLoadHRV();
    const allRHR = tryLoadRHR();
    
    const allDates = [];
    if (allSteps && allSteps.length > 0) allDates.push(...allSteps.map(r => r.dateISO));
    if (allSleep && allSleep.length > 0) allDates.push(...allSleep.map(r => r.dateISO));
    if (allHRV && allHRV.length > 0) allDates.push(...allHRV.map(r => r.dateISO));
    if (allRHR && allRHR.length > 0) allDates.push(...allRHR.map(r => r.dateISO));
    
    if (allDates.length > 0) {
      minDate = allDates.sort()[0];
    }
    
    dateFrom.min = minDate;
    dateTo.min = minDate;
    dateFrom.max = todayString;
    dateTo.max = todayString;
    
    // Set default date range to 6 months ago to today
    const sixMonthsAgo = new Date();
    sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
    const sixMonthsAgoString = sixMonthsAgo.toISOString().slice(0, 10);
    
    // Use the later of 6 months ago or the earliest data date
    const defaultFrom = sixMonthsAgoString > minDate ? sixMonthsAgoString : minDate;
    dateFrom.value = defaultFrom;
    dateTo.value = todayString;
  } else if (chartType === 'predictions') {
    // Set date inputs for predictions
    dateFrom.type = 'date';
    dateTo.type = 'date';
    dateFrom.removeAttribute('min');
    dateTo.removeAttribute('min');
    dateFrom.removeAttribute('placeholder');
    dateTo.removeAttribute('placeholder');
    // Restore max date to today for date inputs
    const todayString = new Date().toISOString().slice(0, 10);
    dateFrom.max = todayString;
    dateTo.max = todayString;
    
    // Set default date range to last 3 months for predictions only if inputs are invalid/empty
    const isISO = (s)=> /^\d{4}-\d{2}-\d{2}$/.test(String(s||''));
    if (!isISO(dateFrom.value) || !isISO(dateTo.value)) {
      const threeMonthsAgo = new Date();
      threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);
      dateFrom.value = threeMonthsAgo.toISOString().slice(0, 10);
      dateTo.value = todayString;
    }
  } else if (chartType === 'correlation_matrix') {
    // Set date inputs for correlation matrix
    dateFrom.type = 'date';
    dateTo.type = 'date';
    dateFrom.removeAttribute('min');
    dateTo.removeAttribute('min');
    dateFrom.removeAttribute('placeholder');
    dateTo.removeAttribute('placeholder');
    // Restore max date to today for date inputs
    const todayString = new Date().toISOString().slice(0, 10);
    dateFrom.max = todayString;
    dateTo.max = todayString;
    
    // Set default date range to oldest available date to today
    try {
      const sleepN = normalizeSleepRows(rawSleep);
      const hrv = tryLoadHRV();
      const steps = tryLoadSteps();
      const rhr = tryLoadRHR();
      
      // Find the oldest date across all datasets
      let oldestDate = null;
      
      if (sleepN && sleepN.length > 0) {
        const sleepOldest = sleepN[0].dateISO;
        if (!oldestDate || sleepOldest < oldestDate) oldestDate = sleepOldest;
      }
      
      if (hrv && hrv.length > 0) {
        const hrvOldest = hrv[0].dateISO;
        if (!oldestDate || hrvOldest < oldestDate) oldestDate = hrvOldest;
      }
      
      if (steps && steps.length > 0) {
        const stepsOldest = steps[0].dateISO;
        if (!oldestDate || stepsOldest < oldestDate) oldestDate = stepsOldest;
      }
      
      if (rhr && rhr.length > 0) {
        const rhrOldest = rhr[0].dateISO;
        if (!oldestDate || rhrOldest < oldestDate) oldestDate = rhrOldest;
      }
      
      if (oldestDate) {
        dateFrom.value = oldestDate;
        dateTo.value = todayString;
      } else {
        // Fallback to 6 months ago if no data
        const sixMonthsAgo = new Date();
        sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
        dateFrom.value = sixMonthsAgo.toISOString().slice(0, 10);
        dateTo.value = todayString;
      }
    } catch(_) {
      // Fallback to 6 months ago if error
      const sixMonthsAgo = new Date();
      sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
      dateFrom.value = sixMonthsAgo.toISOString().slice(0, 10);
      dateTo.value = todayString;
    }
  } else {
    dateFrom.type = 'date';
    dateTo.type = 'date';
    dateFrom.removeAttribute('min');
    dateTo.removeAttribute('min');
    dateFrom.removeAttribute('placeholder');
    dateTo.removeAttribute('placeholder');
    // Restore max date to today for date inputs
    const todayString = new Date().toISOString().slice(0, 10);
    dateFrom.max = todayString;
    dateTo.max = todayString;
    // If switching from a numeric-year view, inputs may contain bad values.
    // For the histogram view, auto-populate the range with the displayed default.
    const isISO = (s)=> /^\d{4}-\d{2}-\d{2}$/.test(String(s||''));
    // Daily Minutes Asleep: default to last 6 months if inputs invalid
    if (chartType === 'daily_minutes'){
      // Honor open start: if From is empty and To is valid, do not auto-fill
      if ((!isISO(dateFrom.value) || !isISO(dateTo.value)) && !(dateFrom.value === '' && isISO(dateTo.value))){
        const today = new Date();
        const six = new Date(); six.setMonth(today.getMonth()-6);
        dateFrom.value = six.toISOString().slice(0,10);
        dateTo.value = today.toISOString().slice(0,10);
      }
    }
    // Daily RHR: default to last 6 months if inputs invalid
    if (chartType === 'daily_rhr'){
      // Honor open start: if From is empty and To is valid, do not auto-fill
      if ((!isISO(dateFrom.value) || !isISO(dateTo.value)) && !(dateFrom.value === '' && isISO(dateTo.value))){
        const today = new Date();
        const six = new Date(); six.setMonth(today.getMonth()-6);
        dateFrom.value = six.toISOString().slice(0,10);
        dateTo.value = today.toISOString().slice(0,10);
      }
    }
    // Steps correlation after yearly view: default last 6 months if inputs invalid
    if (chartType === 'corr_steps_hrv'){
      // Honor open start: if From is empty and To is valid, do not auto-fill
      if ((!isISO(dateFrom.value) || !isISO(dateTo.value)) && !(dateFrom.value === '' && isISO(dateTo.value))){
        const today = new Date();
        const six = new Date(); six.setMonth(today.getMonth()-6);
        dateFrom.value = six.toISOString().slice(0,10);
        dateTo.value = today.toISOString().slice(0,10);
      }
    }
    // RHR charts after yearly view: default last 6 months if inputs invalid
    if (chartType === 'hist_rhr'){
      // Honor open start: if From is empty and To is valid, do not auto-fill
      if ((!isISO(dateFrom.value) || !isISO(dateTo.value)) && !(dateFrom.value === '' && isISO(dateTo.value))){
        const today = new Date();
        const six = new Date(); six.setMonth(today.getMonth()-6);
        dateFrom.value = six.toISOString().slice(0,10);
        dateTo.value = today.toISOString().slice(0,10);
      }
    }
  }
  
  render();
}); document.getElementById('dateFrom').addEventListener('change',render); document.getElementById('dateTo').addEventListener('change',render); document.getElementById('mainOnly').addEventListener('change',render); document.getElementById('stepsViewToggle').addEventListener('input',()=>{ updateTriStateLabels(); if(document.getElementById('chartType').value === 'daily_steps') render() }); document.getElementById('rhrViewToggle').addEventListener('input',()=>{ updateTriStateLabels(); if(document.getElementById('chartType').value === 'daily_rhr') { syncRHRDateInputs(); render(); } }); document.getElementById('sleepViewToggle').addEventListener('input',()=>{ updateTriStateLabels(); if(document.getElementById('chartType').value === 'daily_score') render() }); document.getElementById('minutesViewToggle').addEventListener('input',()=>{ updateTriStateLabels(); if(document.getElementById('chartType').value === 'daily_minutes') render() }); document.getElementById('hrvCusumIgnoreZero').addEventListener('change',()=>{ if(document.getElementById('chartType').value === 'hrv_heatmap') render() });
document.getElementById('downloadMonthly').addEventListener('click',()=>{
  const ct = document.getElementById('chartType').value;
  if (ct === 'daily_steps'){
    try{
      const rows1 = (window.stepsMonthlySummary||[]).map(r=>({ period:r.key, average_steps:Math.round(r.steps||0) }));
      const rows2 = (window.nonSedMonthlySummary||[]).map(r=>({ period:r.key, non_sedentary_minutes:Math.round(r.nonSedentaryMinutes||0) }));
      const merged = mergeByKey(rows1, rows2, 'period');
      downloadCSV(merged,'monthly_steps_non_sedentary.csv');
    }catch(e){ console.error('downloadMonthly failed',e) }
  } else {
    const {mRows}=buildSummaries(); downloadCSV(mRows,'average_sleep_per_month.csv');
  }
});
document.getElementById('downloadYearly').addEventListener('click',()=>{
  const ct = document.getElementById('chartType').value;
  if (ct === 'daily_steps'){
    try{
      const rows1 = (window.stepsYearlySummary||[]).map(r=>({ period:r.key, average_steps:Math.round(r.steps||0) }));
      const rows2 = (window.nonSedYearlySummary||[]).map(r=>({ period:r.key, non_sedentary_minutes:Math.round(r.nonSedentaryMinutes||0) }));
      const merged = mergeByKey(rows1, rows2, 'period');
      downloadCSV(merged,'yearly_steps_non_sedentary.csv');
    }catch(e){ console.error('downloadYearly failed',e) }
  } else {
    const {yRows}=buildSummaries(); downloadCSV(yRows,'average_sleep_per_year.csv');
  }
});
document.getElementById('downloadAnalytics').addEventListener('click',()=>{ const analytics = computeAnalytics(); const from = document.getElementById('dateFrom').value || 'start'; const to = document.getElementById('dateTo').value || 'end'; downloadCSV(analytics,`analytics_summary_${from}to${to}.csv`) }); document.getElementById('sleepHistogramDownloadBtn').addEventListener('click',()=>{ if(window.sleepHistogramPreview && window.sleepHistogramPreview.length > 0) { const from = document.getElementById('dateFrom').value || 'start'; const to = document.getElementById('dateTo').value || 'end'; downloadCSV(window.sleepHistogramPreview,`sleep_histogram_${from}to${to}.csv`) } else { alert('No histogram data available. Please ensure sleep data is loaded and Sleep Score chart is selected.') } }); render(); }

// Update tri-state toggle labels
function updateTriStateLabels() {
  // Update Steps toggle labels
  const stepsToggle = document.getElementById('stepsViewToggle');
  const stepsLabels = stepsToggle.closest('.tri-state-toggle').querySelectorAll('.toggle-labels span');
  const stepsValue = parseInt(stepsToggle.value);
  
  stepsLabels.forEach((label, index) => {
    if (index === stepsValue) {
      label.classList.add('active');
    } else {
      label.classList.remove('active');
    }
  });
  
  // Update RHR toggle labels
  const rhrToggle = document.getElementById('rhrViewToggle');
  const rhrLabels = rhrToggle.closest('.tri-state-toggle').querySelectorAll('.toggle-labels span');
  const rhrValue = parseInt(rhrToggle.value);
  
  rhrLabels.forEach((label, index) => {
    if (index === rhrValue) {
      label.classList.add('active');
    } else {
      label.classList.remove('active');
    }
  });
  
  // Update Sleep toggle labels
  const sleepToggle = document.getElementById('sleepViewToggle');
  const sleepLabels = sleepToggle.closest('.tri-state-toggle').querySelectorAll('.toggle-labels span');
  const sleepValue = parseInt(sleepToggle.value);
  
  sleepLabels.forEach((label, index) => {
    if (index === sleepValue) {
      label.classList.add('active');
    } else {
      label.classList.remove('active');
    }
  });
  
  // Update Minutes toggle labels
  const minutesToggle = document.getElementById('minutesViewToggle');
  const minutesLabels = minutesToggle.closest('.tri-state-toggle').querySelectorAll('.toggle-labels span');
  const minutesValue = parseInt(minutesToggle.value);
  
  minutesLabels.forEach((label, index) => {
    if (index === minutesValue) {
      label.classList.add('active');
    } else {
      label.classList.remove('active');
    }
  });
}

// Initialize tri-state labels on page load
if (!window.SKIP_MAIN_INIT) {
  updateTriStateLabels();
}

// Modal functionality
function initModal() {
  const modal = document.getElementById('logoModal');
  const closeBtn = document.getElementById('modalClose');
  
  console.log('Modal elements:', { modal, closeBtn }); // Debug log
  
  // Function to open modal
  function openModal() {
    console.log('Opening modal...'); // Debug log
    modal.classList.add('active');
    document.body.style.overflow = 'hidden'; // Prevent background scrolling
  }
  
  // Function to close modal
  function closeModal() {
    console.log('Closing modal...'); // Debug log
    modal.classList.remove('active');
    document.body.style.overflow = ''; // Restore scrolling
  }
  
  // No Profile Modal functionality
  const noProfileModal = document.getElementById('noProfileModal');
  const noProfileCloseBtn = document.getElementById('noProfileModalClose');
  const createProfileForm = document.getElementById('createProfileForm');
  const profileCreationForm = document.getElementById('profileCreationForm');
  const profileCreatedSuccess = document.getElementById('profileCreatedSuccess');
  const profileCreationStatus = document.getElementById('profileCreationStatus');
  const authorizeBtn = document.getElementById('authorizeBtn');
  const authorizationStatus = document.getElementById('authorizationStatus');
  
  // Tab elements
  const tabBtns = document.querySelectorAll('.tab-btn');
  const tabContents = document.querySelectorAll('.tab-content');
  const newProfileTab = document.getElementById('newProfileTab');
  const existingProfilesTab = document.getElementById('existingProfilesTab');
  const profilesList = document.getElementById('profilesList');
  const profilesLoading = document.getElementById('profilesLoading');
  const profileDeletionStatus = document.getElementById('profileDeletionStatus');
  
  // Function to show no-profile modal
  window.showNoProfileModal = function(hasExistingProfiles = false) {
    if (noProfileModal) {
      noProfileModal.classList.add('active');
      document.body.style.overflow = 'hidden';
      
      // Show/hide close button based on whether profiles exist
      const closeBtn = document.getElementById('noProfileModalClose');
      if (closeBtn) {
        closeBtn.style.display = hasExistingProfiles ? 'block' : 'none';
      }
      
      // Store the state for ESC key handling
      noProfileModal.dataset.hasExistingProfiles = hasExistingProfiles.toString();
    }
  };
  
  // Function to hide no-profile modal
  function hideNoProfileModal() {
    if (noProfileModal) {
      noProfileModal.classList.remove('active');
      document.body.style.overflow = '';
    }
  }
  
  // Close button event listener
  if (noProfileCloseBtn) {
    noProfileCloseBtn.addEventListener('click', hideNoProfileModal);
  }
  
  // Tab switching functionality
  tabBtns.forEach(btn => {
    btn.addEventListener('click', function() {
      const targetTab = this.getAttribute('data-tab');
      
      // Remove active class from all tabs and buttons
      tabBtns.forEach(b => b.classList.remove('active'));
      tabContents.forEach(c => c.classList.remove('active'));
      
      // Add active class to clicked button
      this.classList.add('active');
      
      // Show corresponding tab content
      if (targetTab === 'new-profile') {
        newProfileTab.classList.add('active');
      } else if (targetTab === 'existing-profiles') {
        existingProfilesTab.classList.add('active');
        loadExistingProfiles();
      }
    });
  });
  
  // Load existing profiles
  async function loadExistingProfiles() {
    if (!profilesList) return;
    
    profilesLoading.style.display = 'block';
    profilesList.innerHTML = '';
    profilesList.appendChild(profilesLoading);
    
    try {
      const response = await fetch('/api/profiles');
      const profiles = await response.json();
      
      profilesLoading.style.display = 'none';
      
      if (profiles.length === 0) {
        profilesList.innerHTML = '<div class="status-message info">No profiles found. Create a new profile to get started.</div>';
        return;
      }
      
      profilesList.innerHTML = '';
      profiles.forEach(profile => {
        
        // Handle both old format (string) and new format (object)
        const profileName = typeof profile === 'string' ? profile : profile.name;
        const profileCreated = typeof profile === 'string' ? 'Unknown' : profile.created;
        
        const profileItem = document.createElement('div');
        profileItem.className = 'profile-item';
        profileItem.innerHTML = `
          <div class="profile-info">
            <div class="profile-name">${profileName}</div>
            <div class="profile-details">Profile created ${profileCreated}</div>
          </div>
          <div class="profile-actions">
            <button class="btn-secondary" onclick="authorizeExistingProfile('${profileName}')" id="auth-${profileName}">Auth</button>
            <button class="btn-danger" onclick="deleteProfile('${profileName}')" id="delete-${profileName}">
              Delete
            </button>
          </div>
          <div id="auth-status-${profileName}" class="status-message" style="display:none;"></div>
        `;
        profilesList.appendChild(profileItem);
      });
    } catch (error) {
      console.error('Error loading profiles:', error);
      profilesLoading.style.display = 'none';
      profilesList.innerHTML = '<div class="status-message error">Failed to load profiles. Please try again.</div>';
    }
  }

  // Authorization modal helpers
  function openAuthorizeProfileModal(profileName, intro) {
    const m = document.getElementById('authorizeProfileModal');
    const title = document.getElementById('authorizeProfileTitle');
    const introEl = document.getElementById('authorizeProfileIntro');
    const content = document.getElementById('authorizeProfileContent');
    const status = document.getElementById('authorizeProfileStatus');
    if (title) title.textContent = `Authorize ${profileName}`;
    if (introEl) { introEl.textContent = intro || ''; introEl.style.display = intro ? 'block' : 'none'; }
    if (content) content.innerHTML = '';
    if (status) { status.textContent = ''; status.style.display = 'none'; status.className = 'status-message'; }
    if (m) m.classList.add('active');
  }
  function closeAuthorizeProfileModal(){ const m = document.getElementById('authorizeProfileModal'); if (m) m.classList.remove('active'); }
  (function(){ const btn = document.getElementById('authorizeProfileModalClose'); if (btn) btn.addEventListener('click', closeAuthorizeProfileModal); })();

  // Authorization acknowledgement popup (returns Promise<boolean>)
  function showAuthAcknowledgement(){
    return new Promise((resolve) => {
      const modal = document.getElementById('authAckModal');
      const okBtn = document.getElementById('authAckOkBtn');
      const closeBtn = document.getElementById('authAckClose');
      if (!modal || !okBtn){ resolve(true); return; }
      function cleanup(){
        if (okBtn) okBtn.removeEventListener('click', onOk);
        if (closeBtn) closeBtn.removeEventListener('click', onClose);
        modal.removeEventListener('click', onBackdrop);
      }
      function onOk(){ cleanup(); modal.classList.remove('active'); resolve(true); }
      function onClose(){ cleanup(); modal.classList.remove('active'); resolve(false); }
      function onBackdrop(e){ if (e.target === modal){ onClose(); } }
      okBtn.addEventListener('click', onOk);
      if (closeBtn) closeBtn.addEventListener('click', onClose);
      modal.addEventListener('click', onBackdrop);
      modal.classList.add('active');
    });
  }

  // Authorization for existing profiles (opens dedicated modal)
  window.authorizeExistingProfile = async function(profileName){
    try{
      const existingModal = document.getElementById('noProfileModal');
      if (existingModal) existingModal.classList.remove('active');
      // Require acknowledgement before proceeding
      const ok = await showAuthAcknowledgement();
      if (!ok){ if (existingModal) existingModal.classList.add('active'); return; }
      openAuthorizeProfileModal(profileName);

      const authBtn = document.getElementById(`auth-${profileName}`);
      if (authBtn) { authBtn.disabled = true; authBtn.textContent = 'Starting...'; }

      const content = document.getElementById('authorizeProfileContent');
      const status = document.getElementById('authorizeProfileStatus');
      if (status) { status.style.display = 'block'; status.className = 'status-message info'; status.textContent = 'Checking authorization mode...'; }

      // Determine mode and authorization URL
      const modeResp = await fetch(`/api/authorize/${profileName}`, { method: 'GET' });
      const mode = await modeResp.json();
      if (!modeResp.ok){
        if (status) { status.textContent = mode.error || 'Failed to start authorization'; status.className = 'status-message error'; }
        if (authBtn) { authBtn.disabled = false; authBtn.textContent = 'Auth'; }
        return;
      }

      if (mode.mode === 'manual'){
        // Open URL and present paste UI in the new modal
        const url = mode.auth_url || mode.authUrl;
        if (url) window.open(url, '_blank');
        if (status) { status.textContent = ''; status.className = 'status-message'; status.style.display = 'none'; }
        if (content){
          content.innerHTML = `
            <div class="form-group" style="margin-top:8px">
              <label for="authorizeProfilePaste">Paste redirected URL (or code):</label>
              <input type="text" id="authorizeProfilePaste" placeholder="Paste the full https://localhost:... URL or the code value" style="width:100%;box-sizing:border-box" />
            </div>
            <div class="form-actions" style="margin-top:8px; text-align:right">
              <button class="btn-primary" id="authorizeProfileSubmit">Submit</button>
            </div>
          `;
          const submitBtn = document.getElementById('authorizeProfileSubmit');
          submitBtn.addEventListener('click', async ()=>{
            const pasted = (document.getElementById('authorizeProfilePaste').value || '').trim();
            if (!pasted){ if (status){ status.textContent = 'Please paste the redirected URL or code.'; status.className = 'status-message error'; } return; }
            submitBtn.disabled = true; submitBtn.textContent = 'Submitting...';
            try{
              const exResp = await fetch('/api/authorize-exchange', { method: 'POST', headers: { 'Content-Type':'application/json' }, body: JSON.stringify({ profileName, redirectUrl: pasted }) });
              const ex = await exResp.json();
              if (exResp.ok){
                try { sessionStorage.setItem('fitbaus:justAuthorized', profileName); } catch(_) {}
                if (status){ status.textContent = 'Authorization complete!'; status.className = 'status-message success'; }
                // Close modal and show confirmation under profile selector
                try { closeAuthorizeProfileModal(); } catch(_) {}
                try { const fs = document.getElementById('fetchStatus'); if (fs){ fs.textContent = 'user authorized - press ↻ to fetch data!'; fs.style.color = '#7bffbf'; fs.style.opacity='1'; fs.style.transition=''; } } catch(_) {}
                try { initProfileControl(); } catch(_) {}
                // Set URL to this profile for convenience
                if (PROFILE_ID !== profileName){
                  const params = new URLSearchParams(window.location.search);
                  params.set('profile', profileName);
                  const qs = params.toString();
                  const url = location.pathname + (qs ? ('?' + qs) : '');
                  location.assign(url);
                }
              } else {
                if (status){ status.textContent = ex.error || 'Failed to exchange code.'; status.className = 'status-message error'; }
              }
            } catch(e) {
              if (status){ status.textContent = 'Network error during exchange.'; status.className = 'status-message error'; }
            } finally {
              submitBtn.disabled = false; submitBtn.textContent = 'Submit'; if (authBtn){ authBtn.disabled = false; authBtn.textContent = 'Auth'; }
            }
          });
        }
      } else {
        // Background mode in new modal
        if (status) { status.textContent = 'Starting authorization... A browser window may open.'; status.className = 'status-message info'; }
        try{
          const startResp = await fetch(`/api/authorize/${profileName}`, { method: 'POST' });
          const start = await startResp.json();
          if (!startResp.ok){
            if (status) { status.textContent = start.error || 'Failed to start authorization'; status.className = 'status-message error'; }
            if (authBtn) { authBtn.disabled = false; authBtn.textContent = 'Auth'; }
            return;
          }
          const jobId = start.job_id;
          const pollIntervalMs = 1500;
          const timeoutMs = 15*60*1000; // 15 min
          const begin = Date.now();
          async function poll(){
            try{
              const s = await fetch(`/api/authorize-status/${jobId}`);
              const st = await s.json();
              if (!s.ok){ if (status){ status.textContent = st.error || 'Authorization status error'; status.className = 'status-message error'; } if (authBtn){ authBtn.disabled=false; authBtn.textContent='Auth'; } return; }
              if (st.status === 'completed'){
                try { sessionStorage.setItem('fitbaus:justAuthorized', profileName); } catch(_) {}
                if (status){ status.textContent = 'Authorization complete!'; status.className = 'status-message success'; }
                // Close modal and show confirmation under profile selector
                try { closeAuthorizeProfileModal(); } catch(_) {}
                try { const fs = document.getElementById('fetchStatus'); if (fs){ fs.textContent = 'user authorized - press ↻ to fetch data!'; fs.style.color = '#7bffbf'; fs.style.opacity='1'; fs.style.transition=''; } } catch(_) {}
                try { initProfileControl(); } catch(_) {}
                if (PROFILE_ID !== profileName){
                  const params = new URLSearchParams(window.location.search);
                  params.set('profile', profileName);
                  const qs = params.toString();
                  const url = location.pathname + (qs ? ('?' + qs) : '');
                  location.assign(url);
                  return;
                }
                if (authBtn){ authBtn.disabled=false; authBtn.textContent='Auth'; }
                return;
              }
              if (st.status === 'failed' || st.status === 'error' || st.status === 'timeout'){
                if (status){ status.textContent = st.error || 'Authorization failed.'; status.className = 'status-message error'; }
                if (authBtn){ authBtn.disabled=false; authBtn.textContent='Auth'; }
                return;
              }
              if (Date.now() - begin > timeoutMs){ if (status){ status.textContent = 'Authorization timed out. Please try again.'; status.className = 'status-message error'; } if (authBtn){ authBtn.disabled=false; authBtn.textContent='Auth'; } return; }
              setTimeout(poll, pollIntervalMs);
            }catch(e){ if (status){ status.textContent = 'Network error during authorization.'; status.className = 'status-message error'; } if (authBtn){ authBtn.disabled=false; authBtn.textContent='Auth'; } }
          }
          setTimeout(poll, pollIntervalMs);
        }catch(err){ if (status){ status.textContent = 'Network error. Please try again.'; status.className = 'status-message error'; } if (authBtn){ authBtn.disabled=false; authBtn.textContent='Auth'; } }
      }
    }catch(e){ console.error('authorizeExistingProfile error', e); }
  };
  
  // Utility: download JSON
  function downloadJSON(name, obj){ try{ const blob=new Blob([JSON.stringify(obj,null,2)],{type:'application/json'}); const url=URL.createObjectURL(blob); const a=document.createElement('a'); a.href=url; a.download=name; a.click(); URL.revokeObjectURL(url);}catch(e){ console.error('downloadJSON failed',e) } }

  // Life Events helpers (outside Life Events view)
  function loadLifeEventsForProfile(profileName){ try{ const key = `fitbaus:events:${profileName}`; const raw = localStorage.getItem(key); if(!raw) return null; const parsed = JSON.parse(raw); if(!parsed || !Array.isArray(parsed.events)) return null; return parsed; } catch(_){ return null } }
  function exportLifeEventsForProfile(profileName){ const data = loadLifeEventsForProfile(profileName); if(!data) return false; const name = `life_events_${profileName}.json`; downloadJSON(name, data); return true; }

  // Confirm delete modal flow with optional life events export
  function openConfirmDeleteModal(profileName){
    const modal = document.getElementById('confirmDeleteModal');
    const title = document.getElementById('confirmDeleteTitle');
    const body = document.getElementById('confirmDeleteBody');
    const actions = document.getElementById('confirmDeleteActions');
    const closeBtn = document.getElementById('confirmDeleteClose');
    const cancelBtn = document.getElementById('confirmDeleteCancelBtn');
    const proceedBtn = document.getElementById('confirmDeleteProceedBtn');
    if (!modal) return;
    if (title) title.textContent = `Delete ${profileName}`;
    if (body) { body.className = 'status-message info'; body.style.display='block'; body.textContent = `Are you sure you want to delete profile "${profileName}"? This will remove their CSVs and tokens. This action cannot be undone.`; }
    if (modal) modal.classList.add('active');

    function close(){ modal.classList.remove('active'); }
    if (closeBtn) { closeBtn.onclick = close; }
    if (cancelBtn) { cancelBtn.onclick = close; }

    function proceedDelete(){
      // Stage 2: if life events exist, prompt to export
      const le = loadLifeEventsForProfile(profileName);
      if (le && Array.isArray(le.events) && le.events.length > 0){
        if (body){ body.className = 'status-message info'; body.style.display='block'; body.textContent = 'Wait! Life Events data exists for this user. Would you like to export it before deletion?'; }
        if (proceedBtn) { proceedBtn.textContent = 'Skip and Delete'; }
        // Create/replace an export-and-delete button
        let exportBtn = document.getElementById('confirmDeleteExportBtn');
        if (!exportBtn){
          exportBtn = document.createElement('button');
          exportBtn.id = 'confirmDeleteExportBtn';
          exportBtn.className = 'btn-primary';
          exportBtn.textContent = 'Export and Delete';
          if (actions) actions.insertBefore(exportBtn, proceedBtn);
        }
        exportBtn.onclick = async ()=>{
          try{ exportLifeEventsForProfile(profileName); }catch(_){ }
          // continue to actual delete after export
          await performDelete(profileName);
          close();
        };
        // Skip-and-delete path
        if (proceedBtn){ proceedBtn.onclick = async ()=>{ await performDelete(profileName); close(); } };
        return; // hold here until user chooses
      }
      // No life events; proceed directly
      (async ()=>{ await performDelete(profileName); close(); })();
    }

    if (proceedBtn){ proceedBtn.onclick = proceedDelete; }
  }

  async function performDelete(profileName){
    const deleteBtn = document.getElementById(`delete-${profileName}`);
    if (deleteBtn) { deleteBtn.disabled = true; deleteBtn.textContent = 'Deleting...'; }
    profileDeletionStatus.textContent = 'Deleting profile...';
    profileDeletionStatus.className = 'status-message info';
    profileDeletionStatus.style.display = 'block';
    try {
      const response = await fetch('/api/delete-profile', { method: 'POST', headers: { 'Content-Type': 'application/json', }, body: JSON.stringify({ profileName }) });
      const result = await response.json();
      if (response.ok) {
        profileDeletionStatus.textContent = result.message;
        profileDeletionStatus.className = 'status-message success';
        setTimeout(() => {
          loadExistingProfiles();
          try { initProfileControl(); } catch(_) {}
          if (PROFILE_ID === profileName) {
            const params = new URLSearchParams(window.location.search);
            params.delete('profile');
            const qs = params.toString();
            const url = location.pathname + (qs ? ('?' + qs) : '');
            location.assign(url);
          }
          profileDeletionStatus.style.display = 'none';
        }, 1500);
      } else {
        profileDeletionStatus.textContent = result.error || 'Failed to delete profile';
        profileDeletionStatus.className = 'status-message error';
      }
    } catch (error) {
      console.error('Error deleting profile:', error);
      profileDeletionStatus.textContent = 'Network error. Please try again.';
      profileDeletionStatus.className = 'status-message error';
    } finally {
      if (deleteBtn) { deleteBtn.disabled = false; deleteBtn.textContent = 'Delete'; }
    }
  }

  // Delete profile function (opens custom modal)
  window.deleteProfile = function(profileName){ openConfirmDeleteModal(profileName); };
  
  // Profile creation form handling
  if (createProfileForm) {
    createProfileForm.addEventListener('submit', async function(e) {
      e.preventDefault();
      
      const profileName = document.getElementById('profileName').value.trim();
      const clientId = document.getElementById('clientId').value.trim();
      const clientSecret = document.getElementById('clientSecret').value.trim();
      const createBtn = document.getElementById('createProfileBtn');
      
      // Disable form and show loading
      createBtn.disabled = true;
      createBtn.textContent = 'Creating...';
      profileCreationStatus.textContent = 'Creating profile...';
      profileCreationStatus.className = 'status-message info';
      
      try {
        const response = await fetch('/api/create-profile', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            profileName: profileName,
            clientId: clientId,
            clientSecret: clientSecret
          })
        });
        
        const result = await response.json();
        
        if (response.ok) {
          // Success - show success screen
          profileCreationForm.style.display = 'none';
          profileCreatedSuccess.style.display = 'block';
          profileCreationStatus.textContent = '';
          
          // Store the created profile name for authorization
          window.createdProfileName = profileName;
        } else {
          // Error
          profileCreationStatus.textContent = result.error || 'Failed to create profile';
          profileCreationStatus.className = 'status-message error';
        }
      } catch (error) {
        console.error('Error creating profile:', error);
        profileCreationStatus.textContent = 'Network error. Please try again.';
        profileCreationStatus.className = 'status-message error';
      } finally {
        // Re-enable form
        createBtn.disabled = false;
        createBtn.textContent = 'Create Profile';
      }
    });
  }
  
  // Authorization button handling (seamless flow: start backend job and poll)
  if (authorizeBtn) {
    authorizeBtn.addEventListener('click', async function() {
      const profileName = window.createdProfileName;
      if (!profileName) {
        authorizationStatus.textContent = 'No profile selected';
        authorizationStatus.className = 'status-message error';
        return;
      }

      // Require acknowledgement before proceeding
      const ok = await showAuthAcknowledgement();
      if (!ok){ return; }

      const authBtn = this;
      authBtn.disabled = true;
      authBtn.textContent = 'Starting...';
      authorizationStatus.textContent = 'Checking authorization mode...';
      authorizationStatus.className = 'status-message info';

      try {
        // First query mode and authorization URL
        const modeResp = await fetch(`/api/authorize/${profileName}`, { method: 'GET' });
        const mode = await modeResp.json();
        if (!modeResp.ok) {
          authorizationStatus.textContent = mode.error || 'Failed to start authorization';
          authorizationStatus.className = 'status-message error';
          return;
        }

        if (mode.mode === 'manual') {
          // Show manual UI: open URL and provide paste box
          window.open(mode.auth_url || mode.authUrl || mode.authUrl, '_blank');
          authorizationStatus.innerHTML = '';
          const container = document.createElement('div');
          container.style.marginTop = '8px';
          container.innerHTML = `
            <div class="form-group">
              <label for="pastedRedirectUrl">Paste redirected URL (or code):</label>
              <input type="text" id="pastedRedirectUrl" placeholder="Paste the full https://localhost:... URL or the code value" style="width:100%;box-sizing:border-box" />
            </div>
            <div class="form-actions" style="margin-top:8px">
              <button class="btn btn-primary" id="submitPastedUrlBtn">Submit</button>
            </div>
          `;
          authorizationStatus.appendChild(container);

          const submitBtn = document.getElementById('submitPastedUrlBtn');
          submitBtn.addEventListener('click', async () => {
            const pasted = document.getElementById('pastedRedirectUrl').value.trim();
            if (!pasted) {
              authorizationStatus.textContent = 'Please paste the redirected URL or code.';
              authorizationStatus.className = 'status-message error';
              return;
            }
            submitBtn.disabled = true;
            submitBtn.textContent = 'Submitting...';
            try {
              const exResp = await fetch('/api/authorize-exchange', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ profileName, redirectUrl: pasted })
              });
              const ex = await exResp.json();
              if (exResp.ok) { try { sessionStorage.setItem('fitbaus:justAuthorized', profileName); } catch(_) {}
                authorizationStatus.textContent = '✅ Authorization complete! You can close this dialog and fetch data.';
                authorizationStatus.className = 'status-message success';
                // Refresh profiles dropdown
                try { initProfileControl(); } catch(_) {}
                // If we just created this profile, set it active in URL
                if (window.createdProfileName && window.createdProfileName !== PROFILE_ID) {
                  const params = new URLSearchParams(window.location.search);
                  params.set('profile', window.createdProfileName);
                  const qs = params.toString();
                  const url = location.pathname + (qs ? ('?' + qs) : '');
                  location.assign(url);
                  return;
                }
              } else {
                authorizationStatus.textContent = ex.error || 'Failed to exchange code.';
                authorizationStatus.className = 'status-message error';
              }
            } catch (e) {
              authorizationStatus.textContent = 'Network error during exchange.';
              authorizationStatus.className = 'status-message error';
            } finally {
              submitBtn.disabled = false;
              submitBtn.textContent = 'Submit';
            }
          });

          authBtn.disabled = false;
          authBtn.textContent = 'Authorize with Fitbit';
          return;
        }

        // Background mode: start job
        authorizationStatus.textContent = 'Starting authorization... A browser window may open.';
        const startResp = await fetch(`/api/authorize/${profileName}`, { method: 'POST' });
        const startResult = await startResp.json();
        if (!startResp.ok) {
          authorizationStatus.textContent = startResult.error || 'Failed to start authorization';
          authorizationStatus.className = 'status-message error';
          return;
        }

        const jobId = startResult.job_id;
        authorizationStatus.textContent = 'Authorization in progress...';

        // Poll status until completion
        const pollIntervalMs = 2000;
        const timeoutMs = 15 * 60 * 1000; // 15 minutes
        const startTime = Date.now();

        async function poll() {
          try {
            const s = await fetch(`/api/authorize-status/${jobId}`);
            const st = await s.json();
            if (!s.ok) {
              authorizationStatus.textContent = st.error || 'Authorization status error';
              authorizationStatus.className = 'status-message error';
              authBtn.disabled = false;
              authBtn.textContent = 'Authorize with Fitbit';
              return;
            }

            if (st.status === 'completed') { try { sessionStorage.setItem('fitbaus:justAuthorized', profileName); } catch(_) {}
              authorizationStatus.textContent = '✅ Authorization complete! You can close this dialog and fetch data.';
              authorizationStatus.className = 'status-message success';
              // Refresh profiles dropdown
              try { initProfileControl(); } catch(_) {}
              // If we just created this profile, set it active in URL
              if (window.createdProfileName && window.createdProfileName !== PROFILE_ID) {
                const params = new URLSearchParams(window.location.search);
                params.set('profile', window.createdProfileName);
                const qs = params.toString();
                const url = location.pathname + (qs ? ('?' + qs) : '');
                location.assign(url);
                return;
              }
              authBtn.disabled = false;
              authBtn.textContent = 'Authorize with Fitbit';
              return;
            }
            if (st.status === 'failed' || st.status === 'error' || st.status === 'timeout') {
              const err = st.error || 'Authorization failed.';
              authorizationStatus.textContent = `❌ ${err}`;
              authorizationStatus.className = 'status-message error';
              authBtn.disabled = false;
              authBtn.textContent = 'Authorize with Fitbit';
              return;
            }

            if (Date.now() - startTime > timeoutMs) {
              authorizationStatus.textContent = 'Authorization timed out. Please try again.';
              authorizationStatus.className = 'status-message error';
              authBtn.disabled = false;
              authBtn.textContent = 'Authorize with Fitbit';
              return;
            }

            // Keep polling
            setTimeout(poll, pollIntervalMs);
          } catch (e) {
            console.error('Polling error', e);
            authorizationStatus.textContent = 'Network error during authorization.';
            authorizationStatus.className = 'status-message error';
            authBtn.disabled = false;
            authBtn.textContent = 'Authorize with Fitbit';
          }
        }
        setTimeout(poll, pollIntervalMs);
      } catch (error) {
        console.error('Error starting authorization:', error);
        authorizationStatus.textContent = 'Network error. Please try again.';
        authorizationStatus.className = 'status-message error';
      }
    });
  }
  
  // Click on inline brand/logo to open modal
  const inlineLogo = document.querySelector('.inline-logo');
  if (inlineLogo) {
    inlineLogo.addEventListener('click', function(e) {
      e.stopPropagation();
      openModal();
    });
  }
  
  // Close button click
  closeBtn.addEventListener('click', closeModal);
  
  // No Profile Modal close button click - DISABLED (users must create profile)
  // if (noProfileCloseBtn) {
  //   noProfileCloseBtn.addEventListener('click', hideNoProfileModal);
  // }
  
  
  // Click outside modal to close
  modal.addEventListener('click', function(e) {
    if (e.target === modal) {
      closeModal();
    }
  });
  
  // Click outside no-profile modal to close - DISABLED (users must create profile)
  // if (noProfileModal) {
  //   noProfileModal.addEventListener('click', function(e) {
  //     if (e.target === noProfileModal) {
  //       hideNoProfileModal();
  //     }
  //   });
  // }
  
  // Escape key to close
  document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape') {
      if (modal.classList.contains('active')) {
        closeModal();
      }
      // No Profile Modal can be closed with Escape key only if profiles exist
      else if (noProfileModal && noProfileModal.classList.contains('active')) {
        const hasExistingProfiles = noProfileModal.dataset.hasExistingProfiles === 'true';
        if (hasExistingProfiles) {
          hideNoProfileModal();
        }
      }
    }
  });
}

// Fetch Output Modal functionality
let currentFetchJobId = null;


if (!window.SKIP_MAIN_INIT) {
  init();
  initModal();
}
