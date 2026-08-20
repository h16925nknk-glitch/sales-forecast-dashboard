import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import Papa from 'papaparse';
import './styles.css';

const STORAGE_KEY = 'sales-forecast-history-v2';
const RESERVATIONS_KEY = 'sales-forecast-group-reservations-v1';
const PUBLIC_EVENTS_CACHE_KEY = 'sales-forecast-public-events-cache-v1';
const STORE_AREA = '東京都港区南青山・表参道周辺';
const SEAT_COUNT = 37;
const weekdayJa = ['日','月','火','水','木','金','土'];

const yen = (n) => Number.isFinite(n) ? `¥${Math.round(n).toLocaleString('ja-JP')}` : '—';
const people = (n) => Number.isFinite(n) ? `${Math.round(n)}名` : '—';
const iso = (d) => {
  const y=d.getFullYear();
  const m=String(d.getMonth()+1).padStart(2,'0');
  const day=String(d.getDate()).padStart(2,'0');
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
const median = (xs) => {
  if (!xs.length) return null;
  const a = [...xs].sort((x,y)=>x-y);
  const mid = Math.floor(a.length/2);
  return a.length % 2 ? a[mid] : (a[mid-1] + a[mid]) / 2;
};
const percentile = (xs, p) => {
  if (!xs.length) return null;
  const a = [...xs].sort((x,y)=>x-y);
  const idx = (a.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return a[lo];
  return a[lo] + (a[hi] - a[lo]) * (idx - lo);
};

// 越前蟹シーズン: 11/8〜翌年4/10
function getSeason(dateString) {
  const d = new Date(`${dateString}T12:00:00`);
  const month = d.getMonth() + 1;
  const day = d.getDate();
  if (
    (month === 11 && day >= 8) ||
    month === 12 ||
    month <= 3 ||
    (month === 4 && day <= 10)
  ) return 'crab';
  return 'off';
}

function seasonLabel(dateString) {
  return getSeason(dateString) === 'crab' ? '越前蟹シーズン' : 'オフシーズン';
}

function isRegularClosedDay(dateString) {
  const wd = new Date(`${dateString}T12:00:00`).getDay();
  return wd === 2 || wd === 3; // 火・水
}

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
    weekday: d.getDay(),
    // 売上0円の日は曜日に関係なく休業日として扱う
    open: sales > 0,
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
  const anchor = new Date(t);
  anchor.setFullYear(y);
  const targetSeason = getSeason(target);
  return rows.filter(r => {
    const d = new Date(`${r.date}T12:00:00`);
    return (
      d.getFullYear() === y &&
      d.getDay() === t.getDay() &&
      Math.abs(d-anchor)/86400000 <= 10 &&
      r.sales > 0 &&
      getSeason(r.date) === targetSeason
    );
  }).sort((a,b)=>
    Math.abs(new Date(`${a.date}T12:00:00`)-anchor) -
    Math.abs(new Date(`${b.date}T12:00:00`)-anchor)
  )[0] || null;
}

function exactPriorYear(rows, target) {
  const d = new Date(`${target}T12:00:00`);
  d.setFullYear(d.getFullYear()-1);
  const row = rows.find(r=>r.date===iso(d)) || null;
  return row && row.sales > 0 && getSeason(row.date) === getSeason(target) ? row : null;
}

function forecast(rows, reservations, publicEvents, target) {
  const t = new Date(`${target}T12:00:00`);
  const wd = t.getDay();
  const targetSeason = getSeason(target);
  const targetPublic = publicEvents.filter(e=>e.date===target);
  const groupReservations = reservations.filter(r=>r.date===target);
  const groupGuests = groupReservations.reduce((s,r)=>s + Number(r.guests || 0), 0);

  // 過去実績は同じシーズンの「営業日」だけを使用
  const before = rows.filter(r =>
    r.date < target &&
    r.sales > 0 &&
    getSeason(r.date) === targetSeason
  );
  const sameWeekday = before.filter(r=>r.weekday===wd).slice(-8);
  const recent28 = before.slice(-28);
  const prior = closestPriorYear(rows, target);
  const fourSame = sameWeekday.slice(-4);

  // 火曜・水曜は基本定休日。団体予約が入っている場合だけ臨時営業として計算する。
  if (isRegularClosedDay(target) && groupGuests === 0) {
    return {
      guests: 0,
      sales: 0,
      baseGuests: 0,
      baseSales: 0,
      groupGuests: 0,
      groupReservations,
      publicEvents: targetPublic,
      publicImpactPct: 0,
      prior,
      exactPrior: exactPriorYear(rows, target),
      fourWeekSales: avg(fourSame.map(r=>r.sales)),
      fourWeekGuests: avg(fourSame.map(r=>r.guests)),
      samples: sameWeekday.length,
      closed: true,
      season: targetSeason,
    };
  }

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

  const recentSpend = avg(recent28.filter(r=>r.avgSpend>0).map(r=>r.avgSpend));
  const estimatedSpend = recentSpend || (baseGuests && baseSales ? baseSales/baseGuests : 0);

  // 公開イベントの補正は最大+12%まで。AIのイベント数だけで暴走させない。
  const publicImpactPct = Math.min(
    0.12,
    targetPublic.reduce((s,e)=>s + (Number(e.impactScore)||0) * 0.015, 0)
  );

  let adjustedBaseGuests = baseGuests == null ? null : baseGuests * (1 + publicImpactPct);
  let adjustedBaseSales = baseSales == null ? null : baseSales * (1 + publicImpactPct);

  // 外れ値安全装置: 同じシーズンの実績から大きく外れる通常予測を抑える。
  // 団体予約人数はこの上限の対象外で、そのまま加算する。
  const historicalGuests = before.map(r=>r.guests).filter(n=>Number.isFinite(n) && n>0);
  if (adjustedBaseGuests != null && historicalGuests.length >= 4) {
    const med = median(historicalGuests);
    const p90 = percentile(historicalGuests, 0.9);
    const statisticalCap = Math.max(
      Number.isFinite(p90) ? p90 * 1.5 : 0,
      Number.isFinite(med) ? med * 2.0 : 0,
      20
    );
    // 37席の店なので、通常営業だけで数百名になる予測は明らかな異常。
    // 1日合計はランチ＋ディナーで37名を超え得るため、37名で固定はせず、
    // 店舗規模から見た安全上限（4回転相当）も併用する。
    const capacitySafetyCap = SEAT_COUNT * 4;
    const softCap = Math.min(statisticalCap, capacitySafetyCap);
    if (adjustedBaseGuests > softCap) {
      const ratio = softCap / adjustedBaseGuests;
      adjustedBaseGuests = softCap;
      if (adjustedBaseSales != null) adjustedBaseSales *= ratio;
    }
  }

  const finalGuests = adjustedBaseGuests == null
    ? (groupGuests || null)
    : adjustedBaseGuests + groupGuests;
  const finalSales = adjustedBaseSales == null
    ? (groupGuests ? groupGuests * estimatedSpend : null)
    : adjustedBaseSales + groupGuests * estimatedSpend;

  return {
    guests: finalGuests,
    sales: finalSales,
    baseGuests,
    baseSales,
    groupGuests,
    groupReservations,
    publicEvents: targetPublic,
    publicImpactPct,
    prior,
    exactPrior: exactPriorYear(rows, target),
    fourWeekSales: avg(fourSame.map(r=>r.sales)),
    fourWeekGuests: avg(fourSame.map(r=>r.guests)),
    samples: sameWeekday.length,
    closed: false,
    season: targetSeason,
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
  const [showDataEditor,setShowDataEditor] = useState(false);
  const [dataMonth,setDataMonth] = useState('');

  useEffect(()=>localStorage.setItem(STORAGE_KEY,JSON.stringify(rows)),[rows]);
  useEffect(()=>localStorage.setItem(RESERVATIONS_KEY,JSON.stringify(reservations)),[reservations]);
  useEffect(()=>localStorage.setItem(PUBLIC_EVENTS_CACHE_KEY,JSON.stringify(publicEvents)),[publicEvents]);

  const result = useMemo(()=>forecast(rows,reservations,publicEvents,target),[rows,reservations,publicEvents,target]);
  const next7 = useMemo(()=>Array.from({length:7},(_,i)=>{
    const d = new Date(`${target}T12:00:00`);
    d.setDate(d.getDate()+i);
    const date=iso(d);
    return {date, ...forecast(rows,reservations,publicEvents,date)};
  }),[rows,reservations,publicEvents,target]);

  const importCsv = (file) => {
    Papa.parse(file,{header:true,skipEmptyLines:true,encoding:'Shift_JIS',complete:(res)=>{
      const normalized = res.data.map(normalizeRow).filter(Boolean);
      if (!normalized.length) {
        Papa.parse(file,{header:true,skipEmptyLines:true,complete:(r2)=>finish(r2.data.map(normalizeRow).filter(Boolean))});
      } else finish(normalized);
    }});
  };
  const finish = (normalized) => {
    if(!normalized.length){setStatus('日付・純売上・客数を読み取れませんでした。');return;}
    setRows(prev=>dedupe([...prev,...normalized]));
    const closed = normalized.filter(r=>!r.open).length;
    setStatus(`${normalized.length}日分を取り込みました。うち売上0円の${closed}日は休業日として除外します。`);
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
    setEventLoading(true);
    setEventStatus('選択日から7日間の公開情報を確認しています…');
    try {
      const res = await fetch(`/api/public-events?date=${encodeURIComponent(target)}&area=${encodeURIComponent(STORE_AREA)}`);
      if(!res.ok) throw new Error('取得できませんでした');
      const data = await res.json();
      const incoming = Array.isArray(data.events) ? data.events : [];

      const rangeDates = Array.from({length:7},(_,i)=>{
        const d = new Date(`${target}T12:00:00`);
        d.setDate(d.getDate()+i);
        return iso(d);
      });
      const rangeSet = new Set(rangeDates);

      setPublicEvents(prev=>[
        ...prev.filter(e=>!rangeSet.has(e.date)),
        ...incoming
          .filter(e=>rangeSet.has(e.date))
          .map((e,i)=>({ ...e, id:e.id || `ai-${e.date}-${i}` }))
      ]);
      setEventStatus(
        incoming.length
          ? `7日間で${incoming.length}件の周辺情報を反映しました。`
          : '7日間で予測に使う大きな周辺イベントは見つかりませんでした。'
      );
    } catch(err) {
      setEventStatus('AI周辺情報を取得できませんでした。VercelのAPI設定を確認してください。');
    } finally {
      setEventLoading(false);
    }
  };

  const updateHistoryRow = (date, field, value) => {
    setRows(prev => dedupe(prev.map(r => {
      if (r.date !== date) return r;
      const next = { ...r };
      if (field === 'date') {
        const d = parseDate(value);
        if (!d) return r;
        next.date = iso(d);
        next.weekday = d.getDay();
      } else {
        next[field] = toNum(value);
      }
      if (field === 'sales') next.open = next.sales > 0;
      if ((field === 'sales' || field === 'guests') && next.guests > 0) {
        next.avgSpend = next.sales / next.guests;
      }
      return next;
    })));
  };

  const deleteHistoryRow = (date) => {
    if (!confirm(`${date} の実績データを削除しますか？`)) return;
    setRows(prev => prev.filter(r => r.date !== date));
  };

  const availableMonths = useMemo(() => [...new Set(rows.map(r=>r.date.slice(0,7)))].sort().reverse(), [rows]);
  const visibleHistory = useMemo(() => {
    const filtered = dataMonth ? rows.filter(r=>r.date.startsWith(dataMonth)) : rows;
    return [...filtered].sort((a,b)=>b.date.localeCompare(a.date)).slice(0,100);
  }, [rows, dataMonth]);

  const dataRange = rows.length ? `${rows[0].date} 〜 ${rows[rows.length-1].date}` : '未取込';
  const wd = weekdayJa[new Date(`${target}T12:00:00`).getDay()];
  const selectedReservations = reservations.filter(r=>r.date===target).sort((a,b)=>a.time.localeCompare(b.time));
  const selectedPublicEvents = publicEvents.filter(e=>e.date===target);

  return <main>
    <header>
      <div><p className="eyebrow">GUEST FORECAST</p><h1>来店予測ダッシュボード</h1><p className="muted">実績データ × シーズン × 曜日傾向 × 団体予約 × AI周辺情報 ・ 37席</p></div>
      <div className="dateBox"><label>予測日</label><input type="date" value={target} onChange={e=>setTarget(e.target.value)}/><span>{wd}曜日 ・ {seasonLabel(target)}</span></div>
    </header>

    <section className="heroGrid">
      <div className="forecastCard">
        <div className="cardTitle">GUEST FORECAST</div>
        <div className="forecastHero"><span>予測来客数</span><strong>{people(result.guests)}</strong></div>
        <div className="forecastBreakdown">
          <div><span>通常予測</span><b>{result.closed ? '定休日' : people(result.baseGuests)}</b></div>
          <div><span>団体予約</span><b>{result.groupGuests ? `+${result.groupGuests}名` : '0名'}</b></div>
          <div><span>周辺補正</span><b>{result.closed ? 'なし' : (result.publicImpactPct ? `+${Math.round(result.publicImpactPct*100)}%` : 'なし')}</b></div>
        </div>
        <div className="confidence">
          {result.closed
            ? '火曜・水曜は原則定休日として予測。団体予約が入った日は臨時営業として計算します。'
            : `${seasonLabel(target)}の同曜日サンプル ${result.samples}日を中心に算出`}
        </div>
      </div>
      <div className="statsGrid">
        <Stat label="予測売上" value={yen(result.sales)} sub={result.closed ? '定休日' : '参考値'} />
        <Stat label="前年の近い同曜日" value={result.prior ? people(result.prior.guests) : '—'} sub={result.prior?.date || 'データなし'} />
        <Stat label="直近4回 同曜日平均" value={people(result.fourWeekGuests)} sub={yen(result.fourWeekSales)} />
        <Stat label="蓄積データ" value={`${rows.filter(r=>r.sales>0).length}営業日`} sub={dataRange} />
        <Stat label="店舗席数" value={`${SEAT_COUNT}席`} sub="異常値チェックに使用" />
      </div>
    </section>

    <section className="twoCol">
      <div className="panel">
        <div className="panelHead"><div><h2>7日間の来店予測</h2><p>火・水は原則休業 / 団体予約・公開イベントを反映</p></div></div>
        <div className="forecastTable tableHead"><div>日付</div><div>予測</div><div>団体</div><div>周辺情報</div></div>
        <div className="forecastTable">
          {next7.map(x=>{
            const d=new Date(`${x.date}T12:00:00`);
            return <div className="trow" key={x.date}>
              <div><b>{x.date.slice(5).replace('-','/')}</b><span>{weekdayJa[d.getDay()]}</span></div>
              <div className="forecastNumber">{x.closed ? '休業' : people(x.guests)}</div>
              <div>{x.groupGuests ? `${x.groupGuests}名` : '—'}</div>
              <div className="eventMini">{x.publicEvents.length ? x.publicEvents.map(e=>e.name).join(' / ') : '—'}</div>
            </div>;
          })}
        </div>
      </div>

      <div className="panel aiPanel">
        <div className="panelHead">
          <div><h2>AI周辺情報</h2><p>選択日から7日間・{STORE_AREA} の公開情報のみ</p></div>
          <button className="secondaryButton" disabled={eventLoading} onClick={collectPublicEvents}>{eventLoading?'収集中…':'7日分をAIで更新'}</button>
        </div>
        <div className="eventList">
          {selectedPublicEvents.length===0 ? <div className="empty">この日の大きな周辺イベントは未取得です</div> : selectedPublicEvents.map(e=><div className="aiEventItem" key={e.id}>
            <div className="spark">✦</div><div><b>{e.name}</b><small>{e.time || '時間未定'}{e.venue ? ` ・ ${e.venue}` : ''}</small></div><span className="impact">影響 {['小','小','中','大'][Math.max(0,Math.min(3,Number(e.impactScore)||0))]}</span>
          </div>)}
        </div>
        {eventStatus && <p className="status neutral">{eventStatus}</p>}
        <p className="note">右上の日付を変えると、先の日付に取得済みのイベントも確認できます。</p>
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
        <p className="muted">スマレジCSVの「日付」「純売上」「客数」を自動認識。売上0円の日は休業日として学習対象から除外します。</p>
        <div className="dataActions">
          <label className="upload"><input type="file" accept=".csv,text/csv" onChange={e=>e.target.files?.[0]&&importCsv(e.target.files[0])}/><span>CSVを追加</span></label>
          {rows.length>0 && <button className="secondaryButton" onClick={()=>setShowDataEditor(v=>!v)}>{showDataEditor?'一覧を閉じる':'データを見る・編集'}</button>}
        </div>
        {status && <p className="status">{status}</p>}
        <div className="dataSummary"><span>登録済み</span><strong>{rows.length}日分</strong><small>{dataRange}</small></div>
      </div>
    </section>

    {showDataEditor && <section className="panel historyEditor">
      <div className="panelHead historyEditorHead">
        <div><h2>取り込み済みデータ</h2><p>値を変更すると即座に保存され、来店予測にも再反映されます。</p></div>
        <select value={dataMonth} onChange={e=>setDataMonth(e.target.value)}>
          <option value="">すべての月</option>
          {availableMonths.map(m=><option key={m} value={m}>{m.replace('-', '年')}月</option>)}
        </select>
      </div>
      <div className="historyTableWrap">
        <table className="historyTable">
          <thead><tr><th>日付</th><th>曜日</th><th>売上</th><th>客数</th><th>客単価</th><th>状態</th><th></th></tr></thead>
          <tbody>
            {visibleHistory.map(r=><tr key={r.date}>
              <td><input className="dateInput" type="date" value={r.date} onChange={e=>updateHistoryRow(r.date,'date',e.target.value)}/></td>
              <td>{weekdayJa[r.weekday]}</td>
              <td><input type="number" min="0" value={Math.round(r.sales)} onChange={e=>updateHistoryRow(r.date,'sales',e.target.value)}/></td>
              <td><input type="number" min="0" value={Math.round(r.guests)} onChange={e=>updateHistoryRow(r.date,'guests',e.target.value)}/></td>
              <td>{yen(r.avgSpend)}</td>
              <td><span className={r.open?'openPill':'closedPill'}>{r.open?'営業':'休業'}</span></td>
              <td><button className="rowDelete" onClick={()=>deleteHistoryRow(r.date)}>削除</button></td>
            </tr>)}
          </tbody>
        </table>
      </div>
      {visibleHistory.length===100 && <p className="note">表示は最大100件です。月を選ぶと絞り込めます。</p>}
    </section>}
  </main>;
}

createRoot(document.getElementById('root')).render(<App/>);
