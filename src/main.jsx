import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import Papa from 'papaparse';
import './styles.css';
import { doc, getDoc, setDoc } from 'firebase/firestore';
import { db } from './firebase';

const STORAGE_KEY = 'sales-forecast-history-v2';
const RESERVATIONS_KEY = 'sales-forecast-group-reservations-v1';
const PUBLIC_EVENTS_CACHE_KEY = 'sales-forecast-public-events-cache-v1';
const WEATHER_CACHE_KEY = 'sales-forecast-weather-cache-v1';
const FIRESTORE_COLLECTION = 'salesForecast';
const FIRESTORE_DOCUMENT = 'storeData';
const STORE_AREA = '東京都港区南青山・表参道周辺';

const weekdayJa = ['日', '月', '火', '水', '木', '金', '土'];

const yen = (n) =>
  Number.isFinite(n)
    ? `¥${Math.round(n).toLocaleString('ja-JP')}`
    : '—';

const people = (n) =>
  Number.isFinite(n)
    ? `${Math.round(n)}名`
    : '—';

const iso = (d) => {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
};

const parseDate = (v) => {
  if (!v) return null;
  const s = String(v).trim().replace(/\//g, '-');
  const d = new Date(`${s}T12:00:00`);
  return Number.isNaN(d.getTime()) ? null : d;
};

const toNum = (v) => {
  if (v === null || v === undefined || v === '') return 0;
  const n = Number(
    String(v)
      .replace(/,/g, '')
      .replace(/[¥￥%]/g, '')
  );
  return Number.isFinite(n) ? n : 0;
};

const avg = (xs) =>
  xs.length
    ? xs.reduce((a, b) => a + b, 0) / xs.length
    : null;

const median = (xs) => {
  if (!xs.length) return null;
  const a = [...xs].sort((x, y) => x - y);
  const mid = Math.floor(a.length / 2);
  return a.length % 2
    ? a[mid]
    : (a[mid - 1] + a[mid]) / 2;
};

const percentile = (xs, p) => {
  if (!xs.length) return null;
  const a = [...xs].sort((x, y) => x - y);
  const idx = (a.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);

  if (lo === hi) return a[lo];

  return a[lo] + (a[hi] - a[lo]) * (idx - lo);
};

function getSeason(dateString) {
  const d = new Date(`${dateString}T12:00:00`);
  const month = d.getMonth() + 1;
  const day = d.getDate();

  if (
    (month === 11 && day >= 8) ||
    month === 12 ||
    month <= 3 ||
    (month === 4 && day <= 10)
  ) {
    return 'crab';
  }

  return 'off';
}

function seasonLabel(dateString) {
  return getSeason(dateString) === 'crab'
    ? '越前蟹シーズン'
    : 'オフシーズン';
}

function isRegularClosedDay(dateString) {
  const wd = new Date(`${dateString}T12:00:00`).getDay();
  return wd === 2 || wd === 3;
}

function normalizeRow(row) {
  const dateRaw =
    row['日付'] ??
    row['date'] ??
    row['Date'];

  const d = parseDate(dateRaw);

  if (!d) return null;

  const sales = toNum(
    row['純売上'] ??
    row['売上'] ??
    row['総売上'] ??
    row['sales']
  );

  const guests = toNum(
    row['客数'] ??
    row['来客数'] ??
    row['customers'] ??
    row['guests']
  );

  const transactions = toNum(
    row['取引数'] ??
    row['transactions']
  );

  const avgSpend = toNum(
    row['客単価'] ??
    row['customerUnitPrice'] ??
    row['客単価（税込）']
  );

  return {
    date: iso(d),
    sales,
    guests,
    transactions,
    avgSpend:
      avgSpend ||
      (guests ? sales / guests : 0),
    weekday: d.getDay(),
    open: sales > 0,
  };
}

function dedupe(rows) {
  const m = new Map();

  rows.forEach((r) => {
    const prev = m.get(r.date);

    if (
      !prev ||
      r.sales + r.guests >
        prev.sales + prev.guests
    ) {
      m.set(r.date, r);
    }
  });

  return [...m.values()].sort((a, b) =>
    a.date.localeCompare(b.date)
  );
}

function closestPriorYear(rows, target) {
  const t = new Date(`${target}T12:00:00`);
  const y = t.getFullYear() - 1;
  const anchor = new Date(t);

  anchor.setFullYear(y);

  const targetSeason = getSeason(target);

  return (
    rows
      .filter((r) => {
        const d = new Date(`${r.date}T12:00:00`);

        return (
          d.getFullYear() === y &&
          d.getDay() === t.getDay() &&
          Math.abs(d - anchor) / 86400000 <= 10 &&
          r.sales > 0 &&
          getSeason(r.date) === targetSeason
        );
      })
      .sort(
        (a, b) =>
          Math.abs(
            new Date(`${a.date}T12:00:00`) - anchor
          ) -
          Math.abs(
            new Date(`${b.date}T12:00:00`) - anchor
          )
      )[0] || null
  );
}

function exactPriorYear(rows, target) {
  const d = new Date(`${target}T12:00:00`);
  d.setFullYear(d.getFullYear() - 1);

  const row =
    rows.find((r) => r.date === iso(d)) || null;

  return (
    row &&
    row.sales > 0 &&
    getSeason(row.date) === getSeason(target)
      ? row
      : null
  );
}

function forecast(
  rows,
  reservations,
  publicEvents,
  weatherData,
  target
) {
  const t = new Date(`${target}T12:00:00`);
  const wd = t.getDay();
  const targetSeason = getSeason(target);

  const targetPublic = publicEvents.filter(
    (e) => e.date === target
  );

  const targetWeather =
    weatherData.find(
      (w) => w.date === target
    ) || null;

  const groupReservations =
    reservations.filter(
      (r) => r.date === target
    );

  const groupGuests =
    groupReservations.reduce(
      (sum, r) =>
        sum + Number(r.guests || 0),
      0
    );

  const before = rows.filter(
    (r) =>
      r.date < target &&
      r.sales > 0 &&
      getSeason(r.date) === targetSeason
  );

  const sameWeekday = before
    .filter((r) => r.weekday === wd)
    .slice(-8);

  const recent28 = before.slice(-28);

  const prior =
    closestPriorYear(
      rows,
      target
    );

  const fourSame =
    sameWeekday.slice(-4);

  if (
    isRegularClosedDay(target) &&
    groupGuests === 0
  ) {
    return {
      guests: 0,
      sales: 0,

      baseGuests: 0,
      baseSales: 0,

      groupGuests,
      groupReservations,

      publicEvents: targetPublic,

      weather: targetWeather,

      publicImpactPct: 0,

      fridayImpactPct: 0,

      weatherImpactPct: 0,

      specialEventImpactPct: 0,

      restaurantImpactPct: 0,

      reasons: [
        {
          label: '定休日',
          value: '火曜・水曜',
          pct: 0,
        },
      ],

      prior,

      exactPrior:
        exactPriorYear(
          rows,
          target
        ),

      fourWeekSales:
        avg(
          fourSame.map(
            (r) => r.sales
          )
        ),

      fourWeekGuests:
        avg(
          fourSame.map(
            (r) => r.guests
          )
        ),

      samples:
        sameWeekday.length,

      closed: true,

      season:
        targetSeason,
    };
  }

  const weighted = (parts) => {
    const valid =
      parts.filter(([v]) =>
        Number.isFinite(v)
      );

    const totalW =
      valid.reduce(
        (sum, [, weight]) =>
          sum + weight,
        0
      );

    return totalW
      ? valid.reduce(
          (sum, [value, weight]) =>
            sum + value * weight,
          0
        ) / totalW
      : null;
  };

  const weekdayAverage =
    avg(
      sameWeekday.map(
        (r) => r.guests
      )
    );

  const recentAverage =
    avg(
      recent28.map(
        (r) => r.guests
      )
    );

  const baseGuests =
    weighted([
      [
        weekdayAverage,
        0.55,
      ],

      [
        prior?.guests ?? null,
        0.25,
      ],

      [
        recentAverage,
        0.20,
      ],
    ]);

  const baseSales =
    weighted([
      [
        avg(
          sameWeekday.map(
            (r) => r.sales
          )
        ),
        0.55,
      ],

      [
        prior?.sales ?? null,
        0.25,
      ],

      [
        avg(
          recent28.map(
            (r) => r.sales
          )
        ),
        0.20,
      ],
    ]);

  const recentSpend =
    avg(
      recent28
        .filter(
          (r) => r.avgSpend > 0
        )
        .map(
          (r) => r.avgSpend
        )
    );

  const estimatedSpend =
    recentSpend ||
    (
      baseGuests &&
      baseSales
        ? baseSales /
          baseGuests
        : 0
    );


  // ==================================
  // 特定施設イベント
  // ==================================

  let specialEventImpactPct = 0;

  const specialReasons = [];

  targetPublic.forEach((event) => {
    if (event.category === 'ohara') {
      specialEventImpactPct += 0.06;

      specialReasons.push({
        label: '小原流会館',
        value: event.name,
        pct: 0.06,
      });
    }

    if (event.category === 'nezu') {
      specialEventImpactPct += 0.06;

      specialReasons.push({
        label: '根津美術館',
        value: event.name,
        pct: 0.06,
      });
    }

    if (
      event.category ===
      'seinan_school'
    ) {
      specialEventImpactPct += 0.08;

      specialReasons.push({
        label: '青南小学校',
        value: event.name,
        pct: 0.08,
      });
    }

    if (
      event.category ===
      'large_event'
    ) {
      const pct =
        Math.min(
          0.06,
          Number(
            event.impactScore || 0
          ) * 0.02
        );

      specialEventImpactPct += pct;

      if (pct > 0) {
        specialReasons.push({
          label: '周辺イベント',
          value: event.name,
          pct,
        });
      }
    }
  });

  // イベント補正は最大15%
  specialEventImpactPct =
    Math.min(
      specialEventImpactPct,
      0.15
    );


  // ==================================
  // 金曜日
  // ==================================

  const fridayImpactPct =
    wd === 5
      ? 0.03
      : 0;


  // ==================================
  // 天気
  //
  // 晴れ・曇り → 0%
  // 雨 → -10%
  // 強雨 → -20%
  // 荒天 → -30%
  // ==================================

  let weatherImpactPct = 0;

  if (targetWeather) {
    if (
      targetWeather.weather ===
      'rain'
    ) {
      weatherImpactPct = -0.10;
    }

    if (
      targetWeather.weather ===
      'heavy_rain'
    ) {
      weatherImpactPct = -0.20;
    }

    if (
      targetWeather.weather ===
      'storm'
    ) {
      weatherImpactPct = -0.30;
    }
  }


  // ==================================
  // 周辺飲食店休業
  // ==================================

  const restaurantClosedEvents =
    targetPublic.filter(
      (e) =>
        e.category ===
        'restaurant_closed'
    );

  const restaurantImpactPct =
    restaurantClosedEvents.length
      ? Math.min(
          0.08,
          restaurantClosedEvents.length *
            0.03
        )
      : 0;


  // ==================================
  // 合計補正
  // ==================================

  const totalImpactPct =
    specialEventImpactPct +
    fridayImpactPct +
    weatherImpactPct +
    restaurantImpactPct;


  let adjustedBaseGuests =
    baseGuests == null
      ? null
      : baseGuests *
        (
          1 +
          totalImpactPct
        );


  let adjustedBaseSales =
    baseSales == null
      ? null
      : baseSales *
        (
          1 +
          totalImpactPct
        );


  // ==================================
  // 異常値安全装置
  // ==================================

  const historicalGuests =
    before
      .map(
        (r) => r.guests
      )
      .filter(
        (n) =>
          Number.isFinite(n) &&
          n > 0
      );

  if (
    adjustedBaseGuests != null &&
    historicalGuests.length >= 4
  ) {
    const med =
      median(
        historicalGuests
      );

    const p90 =
      percentile(
        historicalGuests,
        0.9
      );

    const statisticalCap =
      Math.max(
        Number.isFinite(p90)
          ? p90 * 1.5
          : 0,

        Number.isFinite(med)
          ? med * 2
          : 0,

        20
      );

    if (
      adjustedBaseGuests >
      statisticalCap
    ) {
      const ratio =
        statisticalCap /
        adjustedBaseGuests;

      adjustedBaseGuests =
        statisticalCap;

      if (
        adjustedBaseSales != null
      ) {
        adjustedBaseSales *=
          ratio;
      }
    }
  }


  // ==================================
  // 団体予約
  // ==================================

  const finalGuests =
    adjustedBaseGuests == null
      ? groupGuests || null
      : adjustedBaseGuests +
        groupGuests;

  const finalSales =
    adjustedBaseSales == null
      ? groupGuests
        ? groupGuests *
          estimatedSpend
        : null
      : adjustedBaseSales +
        groupGuests *
          estimatedSpend;


  // ==================================
  // 予測根拠
  // ==================================

  const reasons = [
    {
      label:
        '直近同曜日平均',
      value:
        people(
          weekdayAverage
        ),
      weight:
        '55%',
    },

    {
      label:
        '前年同時期',
      value:
        prior
          ? people(
              prior.guests
            )
          : 'データなし',
      weight:
        '25%',
    },

    {
      label:
        '直近28営業日平均',
      value:
        people(
          recentAverage
        ),
      weight:
        '20%',
    },

    ...specialReasons,
  ];


  if (fridayImpactPct) {
    reasons.push({
      label:
        '金曜夜の傾向',
      value:
        '夜が混みやすい',
      pct:
        fridayImpactPct,
    });
  }


  if (targetWeather) {
    reasons.push({
      label:
        '天気',
      value:
        targetWeather.weatherSummary ||
        targetWeather.weather,
      pct:
        weatherImpactPct,
    });
  }


  restaurantClosedEvents.forEach(
    (event) => {
      reasons.push({
        label:
          '周辺飲食店休業',
        value:
          event.name,
        pct:
          Math.min(
            0.03,
            restaurantImpactPct
          ),
      });
    }
  );


  if (groupGuests) {
    reasons.push({
      label:
        '団体予約',
      value:
        `+${groupGuests}名`,
    });
  }


  return {
    guests:
      finalGuests,

    sales:
      finalSales,

    baseGuests,

    adjustedBaseGuests,

    baseSales,

    groupGuests,

    groupReservations,

    publicEvents:
      targetPublic,

    weather:
      targetWeather,

    publicImpactPct:
      totalImpactPct,

    specialEventImpactPct,

    fridayImpactPct,

    weatherImpactPct,

    restaurantImpactPct,

    prior,

    exactPrior:
      exactPriorYear(
        rows,
        target
      ),

    fourWeekSales:
      avg(
        fourSame.map(
          (r) => r.sales
        )
      ),

    fourWeekGuests:
      avg(
        fourSame.map(
          (r) => r.guests
        )
      ),

    samples:
      sameWeekday.length,

    reasons,

    closed: false,

    season:
      targetSeason,
  };
}

function Stat({ label, value, sub }) {
  return (
    <div className="stat">
      <div className="label">
        {label}
      </div>

      <div className="value">
        {value}
      </div>

      {sub && (
        <div className="sub">
          {sub}
        </div>
      )}
    </div>
  );
}

function App() {
  const [rows, setRows] = useState(() => {
    try {
      return JSON.parse(
        localStorage.getItem(
          STORAGE_KEY
        ) || '[]'
      );
    } catch {
      return [];
    }
  });

  const [
    reservations,
    setReservations,
  ] = useState(() => {
    try {
      return JSON.parse(
        localStorage.getItem(
          RESERVATIONS_KEY
        ) || '[]'
      );
    } catch {
      return [];
    }
  });

  const [
    publicEvents,
    setPublicEvents,
  ] = useState(() => {
    try {
      return JSON.parse(
        localStorage.getItem(
          PUBLIC_EVENTS_CACHE_KEY
        ) || '[]'
      );
    } catch {
      return [];
    }
  });
  const [weatherData, setWeatherData] = useState(() => {
  try {
    return JSON.parse(
      localStorage.getItem(WEATHER_CACHE_KEY) || '[]'
    );
  } catch {
    return [];
  }
});

  const [target, setTarget] =
    useState(iso(new Date()));

  const [status, setStatus] =
    useState('');

  const [
    eventStatus,
    setEventStatus,
  ] = useState('');

  const [
    eventLoading,
    setEventLoading,
  ] = useState(false);

  const [
    reservationForm,
    setReservationForm,
  ] = useState({
    name: '',
    time: '18:00',
    guests: '',
  });

  const [
    showDataEditor,
    setShowDataEditor,
  ] = useState(false);

  const [dataMonth, setDataMonth] =
    useState('');

  const [draftRows, setDraftRows] =
    useState([]);

  const [
    editStatus,
    setEditStatus,
  ] = useState('');

  const [
    expandedEvents,
    setExpandedEvents,
  ] = useState([]);

  const [firestoreReady, setFirestoreReady] = useState(false);

useEffect(() => {
  const loadSharedData = async () => {
    try {
      const ref = doc(
        db,
        FIRESTORE_COLLECTION,
        FIRESTORE_DOCUMENT
      );

      // このURLに残っている既存データ
      const localRows = JSON.parse(
        localStorage.getItem(STORAGE_KEY) || '[]'
      );

      const localReservations = JSON.parse(
        localStorage.getItem(RESERVATIONS_KEY) || '[]'
      );

      const localPublicEvents = JSON.parse(
        localStorage.getItem(PUBLIC_EVENTS_CACHE_KEY) || '[]'
      );

      const localWeatherData = JSON.parse(
        localStorage.getItem(WEATHER_CACHE_KEY) || '[]'
      );

      const snap = await getDoc(ref);

      if (snap.exists()) {
        const data = snap.data();

        const remoteRows =
          Array.isArray(data.rows) ? data.rows : [];

        const remoteReservations =
          Array.isArray(data.reservations)
            ? data.reservations
            : [];

        const remotePublicEvents =
          Array.isArray(data.publicEvents)
            ? data.publicEvents
            : [];

        const remoteWeatherData =
          Array.isArray(data.weatherData)
            ? data.weatherData
            : [];

        // Firestoreが空で、この端末に既存データがある場合
        // 既存データをFirestoreへ救出
        if (
          remoteRows.length === 0 &&
          localRows.length > 0
        ) {
          setRows(localRows);
          setReservations(localReservations);
          setPublicEvents(localPublicEvents);
          setWeatherData(localWeatherData);

          await setDoc(
            ref,
            {
              rows: localRows,
              reservations: localReservations,
              publicEvents: localPublicEvents,
              weatherData: localWeatherData,
              updatedAt: new Date().toISOString(),
            },
            { merge: true }
          );
        } else {
          setRows(remoteRows);
          setReservations(remoteReservations);
          setPublicEvents(remotePublicEvents);
          setWeatherData(remoteWeatherData);
        }
      } else {
        // Firestore自体がまだない場合
        setRows(localRows);
        setReservations(localReservations);
        setPublicEvents(localPublicEvents);
        setWeatherData(localWeatherData);

        await setDoc(ref, {
          rows: localRows,
          reservations: localReservations,
          publicEvents: localPublicEvents,
          weatherData: localWeatherData,
          updatedAt: new Date().toISOString(),
        });
      }

      setFirestoreReady(true);
    } catch (err) {
      console.error('Firestore読み込みエラー', err);

      setStatus(
        '共有データの読み込みに失敗しました。'
      );
    }
  };

  loadSharedData();
}, []);
useEffect(() => {
  if (!firestoreReady) return;

  const saveSharedData = async () => {
    try {
      await setDoc(
        doc(
          db,
          FIRESTORE_COLLECTION,
          FIRESTORE_DOCUMENT
        ),
        {
          rows,
          reservations,
          publicEvents,
          weatherData,
          updatedAt: new Date().toISOString(),
        },
        {
          merge: true,
        }
      );
    } catch (err) {
      console.error('Firestore保存エラー', err);
    }
  };

  saveSharedData();
}, [
  rows,
  reservations,
  publicEvents,
  weatherData,
  firestoreReady,
]);
  const result = useMemo(
    () =>
      forecast(
        rows,
        reservations,
        publicEvents,
        weatherData,
        target
      ),
    [
      rows,
      reservations,
      publicEvents,
      weatherData,
      target,
    ]
  );

  const next7 = useMemo(
    () =>
      Array.from(
        { length: 7 },
        (_, i) => {
          const d = new Date(
            `${target}T12:00:00`
          );

          d.setDate(
            d.getDate() + i
          );

          const date = iso(d);

          return {
            date,
            ...forecast(
              rows,
              reservations,
              publicEvents,
              weatherData,
              date
            ),
          };
        }
      ),
    [
      rows,
      reservations,
      publicEvents,
      weatherData,
      target,
    ]
  );

  const importCsv = (file) => {
    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      encoding: 'Shift_JIS',

      complete: (res) => {
        const normalized =
          res.data
            .map(normalizeRow)
            .filter(Boolean);

        if (!normalized.length) {
          Papa.parse(file, {
            header: true,
            skipEmptyLines: true,

            complete: (r2) =>
              finish(
                r2.data
                  .map(normalizeRow)
                  .filter(Boolean)
              ),
          });
        } else {
          finish(normalized);
        }
      },
    });
  };

  const finish = (normalized) => {
    if (!normalized.length) {
      setStatus(
        '日付・純売上・客数を読み取れませんでした。'
      );
      return;
    }

    setRows((prev) =>
      dedupe([
        ...prev,
        ...normalized,
      ])
    );

    const closed = normalized.filter(
      (r) => !r.open
    ).length;

    setStatus(
      `${normalized.length}日分を取り込みました。うち売上0円の${closed}日は休業日として除外します。データはこのブラウザに保存されています。`
    );
  };

  const addReservation = (e) => {
    e.preventDefault();

    if (
      !reservationForm.name.trim() ||
      !reservationForm.time ||
      Number(
        reservationForm.guests
      ) <= 0
    ) {
      return;
    }

    const item = {
      id: crypto.randomUUID(),
      date: target,
      name:
        reservationForm.name.trim(),
      time: reservationForm.time,
      guests: Number(
        reservationForm.guests
      ),
    };

    setReservations((prev) => [
      ...prev,
      item,
    ]);

    setReservationForm({
      name: '',
      time: '18:00',
      guests: '',
    });
  };

  const collectPublicEvents =
    async () => {
      setEventLoading(true);

      setEventStatus(
        '選択日から7日間の公開情報を確認しています…'
      );

      try {
       const [eventRes, weatherRes] = await Promise.all([
  fetch(
    `/api/public-events?date=${encodeURIComponent(
      target
    )}&area=${encodeURIComponent(
      STORE_AREA
    )}&t=${Date.now()}`,
    {
      cache: "no-store",
    }
  ),

  fetch(
    `/api/weather?date=${encodeURIComponent(
      target
    )}&t=${Date.now()}`,
    {
      cache: "no-store",
    }
  ),
]);

if (!eventRes.ok) {
  throw new Error(
    "周辺情報を取得できませんでした"
  );
}


const eventData = await eventRes.json();
const weatherData = await weatherRes.json();

const data = {
  ...eventData,
  weather: Array.isArray(weatherData.weather)
    ? weatherData.weather
    : [],
};

      

        const incoming =
          Array.isArray(data.events)
            ? data.events
            : [];
            const incomingWeather =
  Array.isArray(data.weather)
    ? data.weather
    : [];

        const rangeDates =
          Array.from(
            { length: 7 },
            (_, i) => {
              const d =
                new Date(
                  `${target}T12:00:00`
                );

              d.setDate(
                d.getDate() + i
              );

              return iso(d);
            }
          );

        const rangeSet =
          new Set(rangeDates);

        setPublicEvents((prev) => [
          ...prev.filter(
            (e) =>
              !rangeSet.has(e.date)
          ),

          ...incoming
            .filter((e) =>
              rangeSet.has(e.date)
            )
            .map((e, i) => ({
              ...e,
              id:
                e.id ||
                `ai-${e.date}-${i}`,
            })),
        ]);
setWeatherData((prev) => [
  ...prev.filter(
    (w) => !rangeSet.has(w.date)
  ),

  ...incomingWeather.filter(
    (w) => rangeSet.has(w.date)
  ),
]);
        setEventStatus(
          incoming.length
            ? `7日間で${incoming.length}件の周辺情報を反映しました。`
            : '7日間で予測に使う大きな周辺イベントは見つかりませんでした。'
        );
      } catch (err) {
        console.error(err);

        setEventStatus(
          'AI周辺情報を取得できませんでした。VercelのAPI設定を確認してください。'
        );
      } finally {
        setEventLoading(false);
      }
    };

  const toggleEventDetail = (id) => {
    setExpandedEvents((prev) =>
      prev.includes(id)
        ? prev.filter(
            (x) => x !== id
          )
        : [...prev, id]
    );
  };

  const toggleDataEditor = () => {
    if (!showDataEditor) {
      setDraftRows(
        rows.map((r) => ({
          ...r,
        }))
      );

      setEditStatus('');
    }

    setShowDataEditor((v) => !v);
  };

  const updateHistoryRow = (
    date,
    field,
    value
  ) => {
    setDraftRows((prev) =>
      dedupe(
        prev.map((r) => {
          if (r.date !== date) {
            return r;
          }

          const next = {
            ...r,
          };

          if (field === 'date') {
            const d =
              parseDate(value);

            if (!d) return r;

            next.date = iso(d);
            next.weekday =
              d.getDay();
          } else {
            next[field] =
              toNum(value);
          }

          if (field === 'sales') {
            next.open =
              next.sales > 0;
          }

          if (
            (field === 'sales' ||
              field === 'guests') &&
            next.guests > 0
          ) {
            next.avgSpend =
              next.sales /
              next.guests;
          }

          return next;
        })
      )
    );

    setEditStatus(
      '変更があります。保存ボタンを押してください。'
    );
  };

  const saveHistoryChanges = () => {
    const cleaned = dedupe(
      draftRows.map((r) => {
        const next = {
          ...r,
        };

        next.open =
          next.sales > 0;

        next.avgSpend =
          next.guests > 0
            ? next.sales /
              next.guests
            : 0;

        return next;
      })
    );

    setRows(cleaned);

    setDraftRows(
      cleaned.map((r) => ({
        ...r,
      }))
    );

    setEditStatus(
      '変更を保存しました。'
    );
  };

  const cancelHistoryChanges =
    () => {
      setDraftRows(
        rows.map((r) => ({
          ...r,
        }))
      );

      setEditStatus(
        '未保存の変更を元に戻しました。'
      );
    };

  const deleteHistoryRow = (
    date
  ) => {
    if (
      !confirm(
        `${date} の実績データを編集画面から削除しますか？\n※「変更を保存」を押すまで確定しません。`
      )
    ) {
      return;
    }

    setDraftRows((prev) =>
      prev.filter(
        (r) => r.date !== date
      )
    );

    setEditStatus(
      '削除予定です。「変更を保存」を押すと確定します。'
    );
  };

  const availableMonths =
    useMemo(
      () => [
        ...new Set(
          draftRows.map((r) =>
            r.date.slice(0, 7)
          )
        ),
      ]
        .sort()
        .reverse(),
      [draftRows]
    );

  const visibleHistory =
    useMemo(() => {
      const filtered = dataMonth
        ? draftRows.filter((r) =>
            r.date.startsWith(
              dataMonth
            )
          )
        : draftRows;

      return [...filtered]
        .sort((a, b) =>
          b.date.localeCompare(
            a.date
          )
        )
        .slice(0, 100);
    }, [draftRows, dataMonth]);

  const dataRange = rows.length
    ? `${rows[0].date} 〜 ${
        rows[rows.length - 1].date
      }`
    : '未取込';

  const wd =
    weekdayJa[
      new Date(
        `${target}T12:00:00`
      ).getDay()
    ];

  const selectedReservations =
    reservations
      .filter(
        (r) =>
          r.date === target
      )
      .sort((a, b) =>
        a.time.localeCompare(
          b.time
        )
      );

  const selectedPublicEvents =
    publicEvents.filter(
      (e) =>
        e.date === target
    );

  return (
    <main>
      <header>
        <div>
          <p className="eyebrow">
            GUEST FORECAST
          </p>

          <h1>
            来店予測ダッシュボード
          </h1>

          <p className="muted">
            実績データ × シーズン × 曜日傾向 × 団体予約 × AI周辺情報
          </p>
        </div>

        <div className="dateBox">
          <label>
            予測日
          </label>

          <input
            type="date"
            value={target}
            onChange={(e) =>
              setTarget(
                e.target.value
              )
            }
          />

          <span>
            {wd}曜日 ・{' '}
            {seasonLabel(
              target
            )}
          </span>
        </div>
      </header>

      <section className="heroGrid">
        <div className="forecastCard">
          <div className="cardTitle">
            GUEST FORECAST
          </div>

          <div className="forecastHero">
            <span>
              予測来客数
            </span>

            <strong>
              {people(
                result.guests
              )}
            </strong>
          </div>

          <div className="forecastBreakdown">
            <div>
              <span>
                通常予測
              </span>

              <b>
                {result.closed
                  ? '定休日'
                  : people(
                      result.baseGuests
                    )}
              </b>
            </div>

            <div>
              <span>
                団体予約
              </span>

              <b>
                {result.groupGuests
                  ? `+${result.groupGuests}名`
                  : '0名'}
              </b>
            </div>

            <div>
              <span>
                周辺補正
              </span>

              <b>
                {result.closed
                  ? 'なし'
                  : result.publicImpactPct
                    ? `+${Math.round(
                        result.publicImpactPct *
                          100
                      )}%`
                    : 'なし'}
              </b>
            </div>
          </div>

          <div className="confidence">
            {result.closed
              ? '火曜・水曜は原則定休日として予測。団体予約が入った日は臨時営業として計算します。'
              : `${seasonLabel(
                  target
                )}の同曜日サンプル ${
                  result.samples
                }日を中心に算出`}
          </div>
        </div>

        <div className="statsGrid">
          <Stat
            label="予測売上"
            value={yen(
              result.sales
            )}
            sub={
              result.closed
                ? '定休日'
                : '参考値'
            }
          />

          <Stat
            label="前年の近い同曜日"
            value={
              result.prior
                ? people(
                    result.prior.guests
                  )
                : '—'
            }
            sub={
              result.prior?.date ||
              'データなし'
            }
          />

          <Stat
            label="直近4回 同曜日平均"
            value={people(
              result.fourWeekGuests
            )}
            sub={yen(
              result.fourWeekSales
            )}
          />

          <Stat
            label="蓄積データ"
            value={`${
              rows.filter(
                (r) =>
                  r.sales > 0
              ).length
            }営業日`}
            sub={dataRange}
          />
        </div>
      </section>

      <section className="twoCol">
        <div className="panel">
          <div className="panelHead">
            <div>
              <h2>
                7日間の来店予測
              </h2>

              <p>
                火・水は原則休業 / 団体予約・公開イベントを反映
              </p>
            </div>
          </div>

          <div className="forecastTable tableHead">
            <div>日付</div>
            <div>予測</div>
            <div>団体</div>
            <div>
              周辺情報
            </div>
          </div>

          <div className="forecastTable">
            {next7.map((x) => {
              const d = new Date(
                `${x.date}T12:00:00`
              );

              return (
                <div
                  className="trow"
                  key={x.date}
                >
                  <div>
                    <b>
                      {x.date
                        .slice(5)
                        .replace(
                          '-',
                          '/'
                        )}
                    </b>

                    <span>
                      {
                        weekdayJa[
                          d.getDay()
                        ]
                      }
                    </span>
                  </div>

                  <div className="forecastNumber">
                    {x.closed
                      ? '休業'
                      : people(
                          x.guests
                        )}
                  </div>

                  <div>
                    {x.groupGuests
                      ? `${x.groupGuests}名`
                      : '—'}
                  </div>

                  <div className="eventMini">
                    {x.publicEvents.length
                      ? x.publicEvents
                          .map(
                            (e) =>
                              e.name
                          )
                          .join(
                            ' / '
                          )
                      : '—'}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <div className="panel aiPanel">
          <div className="panelHead">
            <div>
              <h2>
                AI周辺情報
              </h2>

              <p>
                選択日から7日間・
                {STORE_AREA}{' '}
                の公開情報のみ
              </p>
            </div>

            <button
              className="secondaryButton"
              disabled={
                eventLoading
              }
              onClick={
                collectPublicEvents
              }
            >
              {eventLoading
                ? '収集中…'
                : '7日分をAIで更新'}
            </button>
          </div>

          <div className="eventList">
            {selectedPublicEvents.length ===
            0 ? (
              <div className="empty">
                この日の大きな周辺イベントは未取得です
              </div>
            ) : (
              selectedPublicEvents.map(
                (e) => {
                  const expanded =
                    expandedEvents.includes(
                      e.id
                    );

                  return (
                    <div
                      className="aiEventItem aiEventCard"
                      key={e.id}
                    >
                      <div className="aiEventTop">
                        <div className="spark">
                          ✦
                        </div>

                        <div className="aiEventMain">
                          <b>
                            {e.name}
                          </b>

                          <small>
                            {e.time ||
                              '時間未定'}

                            {e.venue
                              ? ` ・ ${e.venue}`
                              : ''}
                          </small>
                        </div>

                        <span className="impact">
                          影響{' '}
                          {
                            [
                              '小',
                              '小',
                              '中',
                              '大',
                            ][
                              Math.max(
                                0,
                                Math.min(
                                  3,
                                  Number(
                                    e.impactScore
                                  ) || 0
                                )
                              )
                            ]
                          }
                        </span>
                      </div>

                      <button
                        type="button"
                        className="eventDetailButton"
                        onClick={() =>
                          toggleEventDetail(
                            e.id
                          )
                        }
                      >
                        {expanded
                          ? '詳細を閉じる'
                          : '詳細を見る'}
                      </button>

                      {expanded && (
                        <div className="eventDetails">
                          <div>
                            <span>
                              日付
                            </span>

                            <b>
                              {e.date ||
                                target}
                            </b>
                          </div>

                          <div>
                            <span>
                              時間
                            </span>

                            <b>
                              {e.time ||
                                '未定'}
                            </b>
                          </div>

                          <div>
                            <span>
                              場所
                            </span>

                            <b>
                              {e.venue ||
                                '詳細情報なし'}
                            </b>
                          </div>

                          <div>
                            <span>
                              予測への影響
                            </span>

                            <b>
                              {Number(
                                e.impactScore
                              ) > 0
                                ? `補正値 +${Math.round(
                                    Number(
                                      e.impactScore
                                    ) *
                                      1.5
                                  )}%相当`
                                : '影響小'}
                            </b>
                          </div>

                          {(e.description ||
                            e.details ||
                            e.reason) && (
                            <div className="eventDescription">
                              <span>
                                内容
                              </span>

                              <p>
                                {e.description ||
                                  e.details ||
                                  e.reason}
                              </p>
                            </div>
                          )}

                          {(e.source ||
                            e.sourceName) && (
                            <div>
                              <span>
                                情報元
                              </span>

                              <b>
                                {e.sourceName ||
                                  e.source}
                              </b>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                }
              )
            )}
          </div>

          {eventStatus && (
            <p className="status neutral">
              {eventStatus}
            </p>
          )}

          <p className="note">
            「詳細を見る」を押すと、日時・場所・予測への影響などを確認できます。
          </p>
        </div>
      </section>

      <section className="twoCol bottom">
        <div className="panel reservationPanel compactReservation">
          <div className="panelHead">
            <div>
              <h2>
                団体予約を登録
              </h2>

              <p>
                {target}{' '}
                の予測に直接加算
              </p>
            </div>
          </div>

          <form
            onSubmit={
              addReservation
            }
            className="reservationForm"
          >
            <label>
              <span>
                団体名・予約名
              </span>

              <input
                placeholder="例：福井県○○会"
                value={
                  reservationForm.name
                }
                onChange={(e) =>
                  setReservationForm({
                    ...reservationForm,
                    name:
                      e.target.value,
                  })
                }
              />
            </label>

            <div className="formRow">
              <label>
                <span>
                  時間
                </span>

                <input
                  type="time"
                  value={
                    reservationForm.time
                  }
                  onChange={(e) =>
                    setReservationForm({
                      ...reservationForm,
                      time:
                        e.target.value,
                    })
                  }
                />
              </label>

              <label>
                <span>
                  人数
                </span>

                <input
                  type="number"
                  min="1"
                  inputMode="numeric"
                  placeholder="20"
                  value={
                    reservationForm.guests
                  }
                  onChange={(e) =>
                    setReservationForm({
                      ...reservationForm,
                      guests:
                        e.target.value,
                    })
                  }
                />
              </label>
            </div>

            <button>
              この日に登録
            </button>
          </form>

          <div className="reservationList">
            {selectedReservations.length ===
            0 ? (
              <div className="empty smallEmpty">
                団体予約なし
              </div>
            ) : (
              selectedReservations.map(
                (r) => (
                  <div
                    className="reservationItem"
                    key={r.id}
                  >
                    <div className="timePill">
                      {r.time}
                    </div>

                    <div>
                      <b>
                        {r.name}
                      </b>

                      <small>
                        {r.guests}名
                      </small>
                    </div>

                    <button
                      type="button"
                      aria-label="削除"
                      onClick={() =>
                        setReservations(
                          (prev) =>
                            prev.filter(
                              (x) =>
                                x.id !==
                                r.id
                            )
                        )
                      }
                    >
                      削除
                    </button>
                  </div>
                )
              )
            )}
          </div>
        </div>

        <div className="panel">
          <h2>
            実績データ
          </h2>

          <p className="muted">
            スマレジCSVの「日付」「純売上」「客数」を自動認識。売上0円の日は休業日として学習対象から除外します。
          </p>

          <div className="dataActions">
            <label className="upload">
              <input
                type="file"
                accept=".csv,text/csv"
                onChange={(e) =>
                  e.target.files?.[0] &&
                  importCsv(
                    e.target.files[0]
                  )
                }
              />

              <span>
                CSVを追加
              </span>
            </label>

            {rows.length > 0 && (
              <button
                type="button"
                className="secondaryButton"
                onClick={
                  toggleDataEditor
                }
              >
                {showDataEditor
                  ? '一覧を閉じる'
                  : 'データを見る・編集'}
              </button>
            )}
          </div>

          {status && (
            <p className="status">
              {status}
            </p>
          )}

          <div className="dataSummary">
            <span>
              登録済み
            </span>

            <strong>
              {rows.length}日分
            </strong>

            <small>
              {dataRange}
            </small>
          </div>
        </div>
      </section>

      {showDataEditor && (
        <section className="panel historyEditor">
          <div className="panelHead historyEditorHead">
            <div>
              <h2>
                取り込み済みデータ
              </h2>

              <p>
                内容を編集したあと「変更を保存」を押すと予測に反映されます。
              </p>
            </div>

            <select
              value={dataMonth}
              onChange={(e) =>
                setDataMonth(
                  e.target.value
                )
              }
            >
              <option value="">
                すべての月
              </option>

              {availableMonths.map(
                (m) => (
                  <option
                    key={m}
                    value={m}
                  >
                    {m.replace(
                      '-',
                      '年'
                    )}
                    月
                  </option>
                )
              )}
            </select>
          </div>

          <div className="historySaveBar">
            <button
              type="button"
              className="saveHistoryButton"
              onClick={
                saveHistoryChanges
              }
            >
              変更を保存
            </button>

            <button
              type="button"
              className="secondaryButton"
              onClick={
                cancelHistoryChanges
              }
            >
              元に戻す
            </button>

            {editStatus && (
              <span className="editStatus">
                {editStatus}
              </span>
            )}
          </div>

          <div className="historyTableWrap">
            <table className="historyTable">
              <thead>
                <tr>
                  <th>日付</th>
                  <th>曜日</th>
                  <th>売上</th>
                  <th>客数</th>
                  <th>客単価</th>
                  <th>状態</th>
                  <th></th>
                </tr>
              </thead>

              <tbody>
                {visibleHistory.map(
                  (r) => (
                    <tr key={r.date}>
                      <td>
                        <input
                          className="dateInput"
                          type="date"
                          value={
                            r.date
                          }
                          onChange={(e) =>
                            updateHistoryRow(
                              r.date,
                              'date',
                              e.target.value
                            )
                          }
                        />
                      </td>

                      <td>
                        {
                          weekdayJa[
                            r.weekday
                          ]
                        }
                      </td>

                      <td>
                        <input
                          type="number"
                          min="0"
                          value={Math.round(
                            r.sales
                          )}
                          onChange={(e) =>
                            updateHistoryRow(
                              r.date,
                              'sales',
                              e.target.value
                            )
                          }
                        />
                      </td>

                      <td>
                        <input
                          type="number"
                          min="0"
                          value={Math.round(
                            r.guests
                          )}
                          onChange={(e) =>
                            updateHistoryRow(
                              r.date,
                              'guests',
                              e.target.value
                            )
                          }
                        />
                      </td>

                      <td>
                        {yen(
                          r.avgSpend
                        )}
                      </td>

                      <td>
                        <span
                          className={
                            r.open
                              ? 'openPill'
                              : 'closedPill'
                          }
                        >
                          {r.open
                            ? '営業'
                            : '休業'}
                        </span>
                      </td>

                      <td>
                        <button
                          type="button"
                          className="rowDelete"
                          onClick={() =>
                            deleteHistoryRow(
                              r.date
                            )
                          }
                        >
                          削除
                        </button>
                      </td>
                    </tr>
                  )
                )}
              </tbody>
            </table>
          </div>

          {visibleHistory.length ===
            100 && (
            <p className="note">
              表示は最大100件です。月を選ぶと絞り込めます。
            </p>
          )}
        </section>
      )}
    </main>
  );
}

createRoot(
  document.getElementById(
    'root'
  )
).render(<App />);