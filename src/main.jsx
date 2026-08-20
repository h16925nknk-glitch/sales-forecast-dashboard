import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import Papa from 'papaparse';
import './styles.css';

const STORAGE_KEY = 'sales-forecast-history-v2';
const RESERVATIONS_KEY = 'sales-forecast-group-reservations-v1';
const PUBLIC_EVENTS_CACHE_KEY = 'sales-forecast-public-events-cache-v1';
const STORE_AREA = '東京都港区南青山・表参道周辺';
const weekdayJa = ['日','月','火','水','木','金','土'];

const yen = (n) => Number.isFinite(n) ? `¥${Math.round(n).toLocaleString('ja-JP')}` : '—';
const people = (n) => Number.isFinite(n) ? `${Math.round(n)}名` : '—';
const iso = (d) => {
  const y=d.getFullYear(); const m=String(d.getMonth()+1).padStart(2,'0'); const day=String(d.getDate()).padStart(2,'0');
  return `${y}-${m}-${day}`;
};
const parseDate = (v) => {
  if (!v) return null;
  const s = String(v).trim().replace(/\//g,'-');
  const d = new Date(`${s}T12:00:00`);
  return Number.isNaN(d.getTime()) ? null : d;
};
const toNum = (v) => {
  if (v === null || v === undefined || v === '') return 0;
  const n = Number(String(v).replace(/,/g,'').replace(/[¥￥%]/g,''));
  return Number.isFinite(n) ? n : 0;
};
const avg = (xs) => xs.length ? xs.reduce((a,b)=>a+b,0)/xs.length : null;

function normalizeRow(row) {
  const dateRaw = row['日付'] ?? row['date'] ?? row['Date'];
  const d = parseDate(dateRaw);
  if (!d) return null;
  const sales = toNum(row['純売上'] ?? row['売上'] ?? row['総売上'] ?? row['sales']);
  const guests = toNum(row['客数'] ?? row['来客数'] ?? row['customers'] ?? row['guests']);
  const transactions = toNum(row['取引数'] ?? row['transactions']);
  const avgSpend = toNum(row['客単価'] ?? row['customerUnitPrice'] ?? row['客単価（税込）']);
  return {
    date: iso(d), sales, guests, transactions,
    avgSpend: avgSpend || (guests ? sales / guests : 0),
    weekday: d.getDay(), open: sales > 0 || guests > 0,
  };
}

function dedupe(rows) {
  const m = new Map();
  rows.forEach(r => {
    const prev = m.get(r.date);
    if (!prev || (r.sales + r.guests) > (prev.sales + prev.guests)) m.set(r.date, r);
  });
  return [...m.values()].sort((a,b)=>a.date.localeCompare(b.date));
}

function closestPriorYear(rows, target) {
  const t = new Date(`${target}T12:00:00`);
  const y = t.getFullYear()-1;
  const anchor = new Date(t); anchor.setFullYear(y);
  return rows.filter(r => {
    const d = new Date(`${r.date}T12:00:00`);
    return d.getFullYear()===y && d.getDay()===t.getDay() && Math.abs(d-anchor)/86400000 <= 10 && r.open;
  }).sort((a,b)=>Math.abs(new Date(a.date)-anchor)-Math.abs(new Date(b.date)-anchor))[0] || null;
}

function exactPriorYear(rows, target) {
  const d = new Date(`${target}T12:00:00`); d.setFullYear(d.getFullYear()-1);
  return rows.find(r=>r.date===iso(d)) || null;
}

function forecast(rows, reservations, publicEvents, target) {
  const t = new Date(`${target}T12:00:00`);
  const wd = t.getDay();
  const before = rows.filter(r=>r.date < target && r.open);
  const sameWeekday = before.filter(r=>r.weekday===wd).slice(-8);
  const recent28 = before.slice(-28);
  const prior = closestPriorYear(rows, target);
  const fourSame = sameWeekday.slice(-4);

  const weighted = (parts) => {
    const valid = parts.filter(([v])=>Number.isFinite(v));
    const totalW = valid.reduce((s,[,w])=>s+w,0);
    return totalW ? valid.reduce((s,[v,w])=>s+v*w,0)/totalW : null;
  };

  const baseGuests = weighted([
    [avg(sameWeekday.map(r=>r.guests)), .55],
    [prior?.guests ?? null, .25],
    [avg(recent28.map(r=>r.guests)), .20],
  ]);
  const baseSales = weighted([
    [avg(sameWeekday.map(r=>r.sales)), .55],
    [prior?.sales ?? null, .25],
    [avg(recent28.map(r=>r.sales)), .20],
  ]);

  const groupReservations = reservations.filter(r=>r.date===target);
  const groupGuests = groupReservations.reduce((s,r)=>s + Number(r.guests || 0), 0);
  const recentSpend = avg(recent28.filter(r=>r.avgSpend>0).map(r=>r.avgSpend));
  const estimatedSpend = recentSpend || (baseGuests && baseSales ? baseSales/baseGuests : 0);

  // Public event impact is deliberately conservative. AI returns an impact score 0–3.
  const targetPublic = publicEvents.filter(e=>e.date===target);
  const publicImpactPct = Math.min(0.12, targetPublic.reduce((s,e)=>s + (Number(e.impactScore)||0) * 0.015, 0));

  const eventAdjustedGuests = baseGuests == null ? null : baseGuests * (1 + publicImpactPct);
  const eventAdjustedSales = baseSales == null ? null : baseSales * (1 + publicImpactPct);

  return {
    guests: eventAdjustedGuests == null ? (groupGuests || null) : eventAdjustedGuests + groupGuests,
    sales: eventAdjustedSales == null ? null : eventAdjustedSales + groupGuests * estimatedSpend,
    baseGuests, baseSales, groupGuests, groupReservations, publicEvents: targetPublic,
    publicImpactPct, prior, exactPrior: exactPriorYear(rows, target),
    fourWeekSales: avg(fourSame.map(r=>r.sales)),
    fourWeekGuests: avg(fourSame.map(r=>r.guests)),
    samples: sameWeekday.length,
  };
}

function Stat({label, value, sub}) {
  return <div className="stat"><div className="label">{label}</div><div className="value">{value}</div>{sub && <div className="sub">{sub}</div>}</div>;
}

function App(){
  const [rows,setRows] = useState(()=>JSON.parse(localStorage.getItem(STORAGE_KEY)||'[]'));
  const [reservations,setReservations] = useState(()=>JSON.parse(localStorage.getItem(RESERVATIONS_KEY)||'[]'));
  const [publicEvents,setPublicEvents] = useState(()=>JSON.parse(localStorage.getItem(PUBLIC_EVENTS_CACHE_KEY)||'[]'));
  const [target,setTarget] = useState(iso(new Date()));
  const [status,setStatus] = useState('');
  const [eventStatus,setEventStatus] = useState('');
  const [eventLoading,setEventLoading] = useState(false);
  const [reservationForm,setReservationForm] = useState({name:'',time:'18:00',guests:''});

  useEffect(()=>localStorage.setItem(STORAGE_KEY,JSON.stringify(rows)),[rows]);
  useEffect(()=>localStorage.setItem(RESERVATIONS_KEY,JSON.stringify(reservations)),[reservations]);
  useEffect(()=>localStorage.setItem(PUBLIC_EVENTS_CACHE_KEY,JSON.stringify(publicEvents)),[publicEvents]);

  const result = useMemo(()=>forecast(rows,reservations,publicEvents,target),[rows,reservations,publicEvents,target]);
  const next7 = useMemo(()=>Array.from({length:7},(_,i)=>{
    const d = new Date(`${target}T12:00:00`); d.setDate(d.getDate()+i);
    const date=iso(d); return {date, ...forecast(rows,reservations,publicEvents,date)};
  }),[rows,reservations,publicEvents,target]);

  const importCsv = (file) => {
    Papa.parse(file,{header:true,skipEmptyLines:true,encoding:'Shift_JIS',complete:(res)=>{
      let normalized = res.data.map(normalizeRow).filter(Boolean);
      if (!normalized.length) {
        Papa.parse(file,{header:true,skipEmptyLines:true,complete:(r2)=>finish(r2.data.map(normalizeRow).filter(Boolean))});
      } else finish(normalized);
    }});
  };
  const finish = (normalized) => {
    if(!normalized.length){setStatus('日付・純売上・客数を読み取れませんでした。');return;}
    setRows(prev=>dedupe([...prev,...normalized]));
    setStatus(`${normalized.length}日分を取り込みました。`);
  };

  const addReservation = (e)=>{
    e.preventDefault();
    if(!reservationForm.name.trim() || !reservationForm.time || Number(reservationForm.guests)<=0) return;
    const item = {
      id: crypto.randomUUID(), date: target,
      name: reservationForm.name.trim(), time: reservationForm.time,
      guests: Number(reservationForm.guests),
    };
    setReservations(prev=>[...prev,item]);
    setReservationForm({name:'',time:'18:00',guests:''});
  };

  const collectPublicEvents = async ()=>{
    setEventLoading(true); setEventStatus('公開情報を確認しています…');
    try {
      const res = await fetch(`/api/public-events?date=${encodeURIComponent(target)}&area=${encodeURIComponent(STORE_AREA)}`);
      if(!res.ok) throw new Error('取得できませんでした');
      const data = await res.json();
      const incoming = Array.isArray(data.events) ? data.events : [];
      setPublicEvents(prev=>[
        ...prev.filter(e=>e.date!==target),
        ...incoming.map((e,i)=>({ ...e, id:e.id || `ai-${target}-${i}`, date:target }))
      ]);
      setEventStatus(incoming.length ? `${incoming.length}件の周辺情報を反映しました。` : '予測に使う大きな周辺イベントは見つかりませんでした。');
    } catch(err) {
      setEventStatus('AI自動収集はAPI設定後に利用できます。団体予約の登録と売上予測はこのまま使えます。');
    } finally { setEventLoading(false); }
  };

  const dataRange = rows.length ? `${rows[0].date} 〜 ${rows[rows.length-1].date}` : '未取込';
  const wd = weekdayJa[new Date(`${target}T12:00:00`).getDay()];
  const selectedReservations = reservations.filter(r=>r.date===target).sort((a,b)=>a.time.localeCompare(b.time));
  const selectedPublicEvents = publicEvents.filter(e=>e.date===target);

  return <main>
    <header>
      <div><p className="eyebrow">GUEST FORECAST</p><h1>来店予測ダッシュボード</h1><p className="muted">実績データ × 曜日傾向 × 団体予約 × AI周辺情報</p></div>
      <div className="dateBox"><label>予測日</label><input type="date" value={target} onChange={e=>setTarget(e.target.value)}/><span>{wd}曜日</span></div>
    </header>

    <section className="heroGrid">
      <div className="forecastCard">
        <div className="cardTitle">GUEST FORECAST</div>
        <div className="forecastHero"><span>予測来客数</span><strong>{people(result.guests)}</strong></div>
        <div className="forecastBreakdown">
          <div><span>通常予測</span><b>{people(result.baseGuests)}</b></div>
          <div><span>団体予約</span><b>{result.groupGuests ? `+${result.groupGuests}名` : '0名'}</b></div>
          <div><span>周辺補正</span><b>{result.publicImpactPct ? `+${Math.round(result.publicImpactPct*100)}%` : 'なし'}</b></div>
        </div>
        <div className="confidence">同曜日サンプル {result.samples}日を中心に算出</div>
      </div>
      <div className="statsGrid">
        <Stat label="予測売上" value={yen(result.sales)} sub="参考値" />
        <Stat label="前年の近い同曜日" value={result.prior ? people(result.prior.guests) : '—'} sub={result.prior?.date || 'データなし'} />
        <Stat label="直近4回 同曜日平均" value={people(result.fourWeekGuests)} sub={yen(result.fourWeekSales)} />
        <Stat label="蓄積データ" value={`${rows.filter(r=>r.open).length}営業日`} sub={dataRange} />
      </div>
    </section>

    <section className="twoCol">
      <div className="panel">
        <div className="panelHead"><div><h2>7日間の来店予測</h2><p>団体予約も自動で加算</p></div></div>
        <div className="forecastTable tableHead"><div>日付</div><div>予測</div><div>団体</div><div>周辺情報</div></div>
        <div className="forecastTable">
          {next7.map(x=>{
            const d=new Date(`${x.date}T12:00:00`);
            return <div className="trow" key={x.date}>
              <div><b>{x.date.slice(5).replace('-','/')}</b><span>{weekdayJa[d.getDay()]}</span></div>
              <div className="forecastNumber">{people(x.guests)}</div>
              <div>{x.groupGuests ? `${x.groupGuests}名` : '—'}</div>
              <div className="eventMini">{x.publicEvents.length ? x.publicEvents.map(e=>e.name).join(' / ') : '—'}</div>
            </div>;
          })}
        </div>
      </div>

      <div className="panel aiPanel">
        <div className="panelHead">
          <div><h2>AI周辺情報</h2><p>{STORE_AREA} の公開情報のみを使用</p></div>
          <button className="secondaryButton" disabled={eventLoading} onClick={collectPublicEvents}>{eventLoading?'収集中…':'AIで更新'}</button>
        </div>
        <div className="eventList">
          {selectedPublicEvents.length===0 ? <div className="empty">大きな周辺イベントは未取得です</div> : selectedPublicEvents.map(e=><div className="aiEventItem" key={e.id}>
            <div className="spark">✦</div><div><b>{e.name}</b><small>{e.time || '時間未定'}{e.venue ? ` ・ ${e.venue}` : ''}</small></div><span className="impact">影響 {['小','小','中','大'][Math.max(0,Math.min(3,Number(e.impactScore)||0))]}</span>
          </div>)}
        </div>
        {eventStatus && <p className="status neutral">{eventStatus}</p>}
        <p className="note">公開情報から取得した周辺イベントだけを予測材料にします。</p>
      </div>
    </section>

    <section className="twoCol bottom">
      <div className="panel reservationPanel compactReservation">
        <div className="panelHead"><div><h2>団体予約を登録</h2><p>{target} の予測に直接加算</p></div></div>
        <form onSubmit={addReservation} className="reservationForm">
          <label><span>団体名・予約名</span><input placeholder="例：福井県○○会" value={reservationForm.name} onChange={e=>setReservationForm({...reservationForm,name:e.target.value})}/></label>
          <div className="formRow">
            <label><span>時間</span><input type="time" value={reservationForm.time} onChange={e=>setReservationForm({...reservationForm,time:e.target.value})}/></label>
            <label><span>人数</span><input type="number" min="1" inputMode="numeric" placeholder="20" value={reservationForm.guests} onChange={e=>setReservationForm({...reservationForm,guests:e.target.value})}/></label>
          </div>
          <button>この日に登録</button>
        </form>
        <div className="reservationList">
          {selectedReservations.length===0 ? <div className="empty smallEmpty">団体予約なし</div> : selectedReservations.map(r=><div className="reservationItem" key={r.id}>
            <div className="timePill">{r.time}</div><div><b>{r.name}</b><small>{r.guests}名</small></div>
            <button aria-label="削除" onClick={()=>setReservations(prev=>prev.filter(x=>x.id!==r.id))}>削除</button>
          </div>)}
        </div>
      </div>

      <div className="panel">
        <h2>実績データ</h2>
        <p className="muted">スマレジCSVの「日付」「純売上」「客数」を自動認識します。</p>
        <div className="dataActions">
          <label className="upload"><input type="file" accept=".csv,text/csv" onChange={e=>e.target.files?.[0]&&importCsv(e.target.files[0])}/><span>CSVを追加</span></label>
          {rows.length>0 && <button className="textButton" onClick={()=>{if(confirm('取り込んだ実績データを削除しますか？'))setRows([])}}>データをリセット</button>}
        </div>
        {status && <p className="status">{status}</p>}
        <div className="dataSummary"><span>登録済み</span><strong>{rows.length}日分</strong><small>{dataRange}</small></div>
      </div>
    </section>
  </main>;
}

createRoot(document.getElementById('root')).render(<App/>);
