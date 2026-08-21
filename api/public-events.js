function iso(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({
      error: 'Method not allowed',
    });
  }

  const {
    date,
    area = '東京都港区南青山・表参道周辺',
  } = req.query;

  if (!date) {
    return res.status(400).json({
      error: 'date is required',
    });
  }

  if (!process.env.OPENAI_API_KEY) {
    return res.status(503).json({
      error: 'OPENAI_API_KEY is not configured',
    });
  }

  const start = new Date(`${date}T12:00:00+09:00`);

  if (Number.isNaN(start.getTime())) {
    return res.status(400).json({
      error: 'invalid date',
    });
  }

  const end = new Date(start);
  end.setDate(end.getDate() + 6);

  const endDate = iso(end);

  try {
    const prompt = `
あなたは東京都港区南青山の飲食店の来客予測を補助するリサーチ担当です。

対象地域:
${area}

対象期間:
${date} 〜 ${endDate}

この飲食店には以下の特徴があります。

【重要な店舗特性】

1.
小原流会館でイベント・展示・催事などがある日は、
特にランチの来客数が増える傾向があります。

2.
根津美術館でイベント・特別展・企画展などがある日は、
特にランチの来客数が増える傾向があります。

3.
港区立青南小学校で、
保護者会・運動会・学校行事・父兄が集まるイベントなどがある日は、
特にランチの来客数が増える傾向があります。

4.
天気が悪い日は来客数がかなり落ちます。
ただし晴天だからといってプラス補正はしません。

5.
周辺の主要飲食店が休業している日は、
この店に来客が流れる可能性があります。

対象期間7日間について、Web検索を使い、
来客予測に使える情報だけを調査してください。

特に優先して調べること:

・小原流会館
・根津美術館
・青南小学校
・表参道
・南青山
・外苑前
・周辺の大型イベント
・天気予報
・周辺飲食店の休業情報

天気については以下で分類してください。

clear
晴れ・曇りなど通常営業に悪影響が少ない

rain
雨

heavy_rain
強い雨・大雨

storm
台風・暴風・非常に悪い天候

晴れ・曇りは来客へのプラス補正をしません。

周辺飲食店については、
検索で確認できる明確な臨時休業・定休日・休館等のみ対象としてください。
推測は禁止です。

イベントは最大10件まで。

impactScore:
0 = ほぼ影響なし
1 = 小
2 = 中
3 = 大

category は以下のいずれか:

ohara
nezu
seinan_school
large_event
restaurant_closed
other

必ず次のJSONだけを返してください。
Markdownや説明文は禁止です。

{
  "days": [
    {
      "date": "YYYY-MM-DD",
      "weather": "clear",
      "weatherSummary": "晴れ",
      "events": [
        {
          "name": "イベント名",
          "time": "",
          "venue": "",
          "category": "nezu",
          "impactScore": 2,
          "description": "来客への影響理由",
          "sourceName": "情報元"
        }
      ]
    }
  ]
}
`.trim();

    const apiRes = await fetch(
      'https://api.openai.com/v1/responses',
      {
        method: 'POST',

        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        },

        body: JSON.stringify({
          model: 'gpt-5.6-luna',

          reasoning: {
            effort: 'none',
          },

          tools: [
            {
              type: 'web_search',
              search_context_size: 'low',

              user_location: {
                type: 'approximate',
                country: 'JP',
                city: 'Tokyo',
                region: 'Tokyo',
                timezone: 'Asia/Tokyo',
              },
            },
          ],

          input: prompt,

          max_output_tokens: 2500,
        }),
      }
    );

    if (!apiRes.ok) {
      const detail = await apiRes.text();

      console.error(
        'OpenAI API error:',
        apiRes.status,
        detail
      );

      return res.status(apiRes.status).json({
        error: 'OpenAI request failed',
        status: apiRes.status,
      });
    }

    const response = await apiRes.json();

    const text = (response.output || [])
      .filter((item) => item.type === 'message')
      .flatMap((item) => item.content || [])
      .filter((item) => item.type === 'output_text')
      .map((item) => item.text || '')
      .join('\n')
      .trim();

    const cleaned = (
      text || '{"days":[]}'
    )
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/i, '')
      .replace(/```$/i, '')
      .trim();

    let parsed;

    try {
      parsed = JSON.parse(cleaned);
    } catch (error) {
      console.error('JSON parse failed:', cleaned);

      parsed = {
        days: [],
      };
    }

    const allowedWeather = new Set([
      'clear',
      'rain',
      'heavy_rain',
      'storm',
    ]);

    const allowedCategories = new Set([
      'ohara',
      'nezu',
      'seinan_school',
      'large_event',
      'restaurant_closed',
      'other',
    ]);

    const days = Array.isArray(parsed.days)
      ? parsed.days
          .map((day, dayIndex) => {
            const dayDate = String(day.date || '').slice(0, 10);

            const weather = allowedWeather.has(day.weather)
              ? day.weather
              : 'clear';

            const events = Array.isArray(day.events)
              ? day.events
                  .slice(0, 10)
                  .map((e, i) => ({
                    id: `ai-${dayDate}-${dayIndex}-${i}`,

                    date: dayDate,

                    name: String(
                      e.name || ''
                    ).slice(0, 120),

                    time: String(
                      e.time || ''
                    ).slice(0, 60),

                    venue: String(
                      e.venue || ''
                    ).slice(0, 100),

                    category: allowedCategories.has(e.category)
                      ? e.category
                      : 'other',

                    impactScore: Math.max(
                      0,
                      Math.min(
                        3,
                        Number(e.impactScore) || 0
                      )
                    ),

                    description: String(
                      e.description || ''
                    ).slice(0, 180),

                    sourceName: String(
                      e.sourceName || ''
                    ).slice(0, 100),
                  }))
                  .filter((e) => e.name)
              : [];

            return {
              date: dayDate,

              weather,

              weatherSummary: String(
                day.weatherSummary || ''
              ).slice(0, 100),

              events,
            };
          })
          .filter(
            (day) =>
              /^\d{4}-\d{2}-\d{2}$/.test(day.date) &&
              day.date >= date &&
              day.date <= endDate
          )
      : [];

    const events = days.flatMap((day) =>
      day.events.map((event) => ({
        ...event,

        weather: day.weather,

        weatherSummary: day.weatherSummary,
      }))
    );

    const weather = days.map((day) => ({
      date: day.date,
      weather: day.weather,
      weatherSummary: day.weatherSummary,
    }));

    return res.status(200).json({
      startDate: date,
      endDate,
      area,
      days,
      events,
      weather,
    });

  } catch (error) {
    console.error(
      'Public event search error:',
      error
    );

    return res.status(500).json({
      error: 'Public event search failed',
    });
  }
}