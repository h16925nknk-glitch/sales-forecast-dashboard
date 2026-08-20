export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  const { date, area = '東京都港区南青山・表参道周辺' } = req.query;
  if (!date) return res.status(400).json({ error: 'date is required' });
  if (!process.env.OPENAI_API_KEY) return res.status(503).json({ error: 'OPENAI_API_KEY is not configured' });

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
        input: `あなたは飲食店の来客予測補助です。${date} に ${area} で開催される、飲食店の人流に影響しそうな公開イベントだけをウェブ検索してください。美術館・展示会・コンサート・大型催事・地域イベント等を対象にし、通常営業や小規模な日常イベントは除外してください。\n\n必ずJSONだけを返してください。形式: {"events":[{"name":"イベント名","time":"開始時刻または時間帯","venue":"会場","impactScore":0}]}\nimpactScore は 0=ほぼ影響なし、1=小、2=中、3=大。確認できない情報は推測せず省略してください。最大5件。`,
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

    const events = Array.isArray(parsed.events) ? parsed.events.slice(0,5).map(e=>({
      name: String(e.name || '').slice(0,120),
      time: String(e.time || '').slice(0,60),
      venue: String(e.venue || '').slice(0,100),
      impactScore: Math.max(0, Math.min(3, Number(e.impactScore)||0)),
    })).filter(e=>e.name) : [];

    return res.status(200).json({ date, area, events });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Public event search failed' });
  }
}
