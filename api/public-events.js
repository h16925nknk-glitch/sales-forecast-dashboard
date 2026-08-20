function iso(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  const { date, area = '東京都港区南青山・表参道周辺' } = req.query;
  if (!date) return res.status(400).json({ error: 'date is required' });
  if (!process.env.OPENAI_API_KEY) return res.status(503).json({ error: 'OPENAI_API_KEY is not configured' });

  const start = new Date(`${date}T12:00:00+09:00`);
  if (Number.isNaN(start.getTime())) return res.status(400).json({ error: 'invalid date' });
  const end = new Date(start);
  end.setDate(end.getDate() + 6);
  const endDate = iso(end);

  try {
    const apiRes = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'gpt-5.6-luna',
        tools: [{
          type: 'web_search',
          search_context_size: 'low',
          user_location: { type:'approximate', country:'JP', city:'Tokyo', region:'Tokyo', timezone:'Asia/Tokyo' }
        }],
        input: `あなたは高級飲食店の来客予測を補助するリサーチャーです。\n${date} から ${endDate} までの7日間について、${area} 周辺で開催される公開イベントをウェブ検索してください。\n\n対象:\n- 美術館・博物館・ギャラリーの主要企画展\n- コンサート・ライブ・公演\n- 展示会・大型催事\n- 商業施設の集客イベント\n- 地域イベント\n- その他、南青山・表参道周辺の飲食店への人流に影響しそうな催し\n\n除外:\n- 通常営業そのもの\n- 小規模で人流への影響がほぼない日常イベント\n- 日付が確認できない情報\n\nイベントごとに開催日を必ず YYYY-MM-DD で返してください。複数日にまたがる企画展は、期間内で該当する日を必要に応じて日別に返して構いません。推測で作らず、公開情報で確認できたものだけにしてください。\n\n必ずJSONだけを返してください。形式:\n{"events":[{"date":"YYYY-MM-DD","name":"イベント名","time":"開始時刻または時間帯","venue":"会場","impactScore":0}]}\n\nimpactScore は 0=ほぼ影響なし、1=小、2=中、3=大。最大20件。`,
      }),
    });

    if (!apiRes.ok) {
      const detail = await apiRes.text();
      console.error(detail);
      return res.status(502).json({ error: 'OpenAI request failed' });
    }

    const response = await apiRes.json();
    const text = (response.output || [])
      .filter(item => item.type === 'message')
      .flatMap(item => item.content || [])
      .filter(item => item.type === 'output_text')
      .map(item => item.text || '')
      .join('\n')
      .trim();

    const cleaned = (text || '{"events":[]}').replace(/^```json\s*/i,'').replace(/```$/,'').trim();
    let parsed;
    try { parsed = JSON.parse(cleaned); } catch { parsed = { events: [] }; }

    const events = Array.isArray(parsed.events)
      ? parsed.events.slice(0,20).map(e=>({
          date: String(e.date || '').slice(0,10),
          name: String(e.name || '').slice(0,120),
          time: String(e.time || '').slice(0,60),
          venue: String(e.venue || '').slice(0,100),
          impactScore: Math.max(0, Math.min(3, Number(e.impactScore)||0)),
        })).filter(e=>e.name && /^\d{4}-\d{2}-\d{2}$/.test(e.date) && e.date >= date && e.date <= endDate)
      : [];

    return res.status(200).json({ startDate: date, endDate, area, events });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Public event search failed' });
  }
}
