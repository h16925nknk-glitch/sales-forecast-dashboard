function iso(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({
      error: "Method not allowed",
    });
  }

  const { date } = req.query;

  if (!date) {
    return res.status(400).json({
      error: "date is required",
    });
  }

  if (!process.env.OPENAI_API_KEY) {
    return res.status(503).json({
      error: "OPENAI_API_KEY is not configured",
    });
  }

  const start = new Date(`${date}T12:00:00+09:00`);

  if (Number.isNaN(start.getTime())) {
    return res.status(400).json({
      error: "invalid date",
    });
  }

  const end = new Date(start);
  end.setDate(end.getDate() + 6);

  const endDate = iso(end);

  const prompt = `
東京都港区南青山の飲食店の来客予測に使うため、
以下の2施設について対象期間中の公開情報だけをWeb検索してください。

対象期間:
${date} 〜 ${endDate}

【1. 小原流会館】

対象期間中に開催される、

・展示
・催事
・イベント
・講習会
・大会
・一般来場者が増える催し

を確認してください。

category:
ohara

【2. 根津美術館】

対象期間中の、

・特別展
・企画展
・展示
・イベント
・休館情報

を確認してください。

category:
nezu

【重要】

・この2施設以外は検索対象にしない
・対象期間外の情報は入れない
・開催日が確認できないものは入れない
・推測は禁止
・同じイベントを重複させない
・公式サイト、施設公式情報を優先
・該当情報がなければ無理に作らない
・7日間合計で最大6件

impactScore:

0 = ほぼ影響なし
1 = 小
2 = 中
3 = 大

小原流会館や根津美術館で一般来場者が増える催しは、
特にランチ客への影響を考慮してください。

必ずJSONだけ返してください。
Markdownや説明文は禁止です。

{
  "days": [
    {
      "date": "YYYY-MM-DD",
      "events": [
        {
          "name": "イベント名",
          "time": "",
          "venue": "",
          "category": "ohara",
          "impactScore": 2,
          "description": "来客への影響理由",
          "sourceName": "情報元"
        }
      ]
    }
  ]
}
`.trim();

  try {
    const apiRes = await fetch(
      "https://api.openai.com/v1/responses",
      {
        method: "POST",

        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        },

        body: JSON.stringify({
          model: "gpt-5.6-luna",

          reasoning: {
            effort: "none",
          },

          tools: [
            {
              type: "web_search",
              search_context_size: "low",

              user_location: {
                type: "approximate",
                country: "JP",
                city: "Tokyo",
                region: "Tokyo",
                timezone: "Asia/Tokyo",
              },
            },
          ],

          input: prompt,

          max_output_tokens: 900,
        }),
      }
    );

    if (!apiRes.ok) {
      const detail = await apiRes.text();

      console.error(
        "OpenAI API error:",
        apiRes.status,
        detail
      );

      return res.status(apiRes.status).json({
        error: "OpenAI request failed",
        status: apiRes.status,
      });
    }

    const response = await apiRes.json();

    const text = (response.output || [])
      .filter((item) => item.type === "message")
      .flatMap((item) => item.content || [])
      .filter((item) => item.type === "output_text")
      .map((item) => item.text || "")
      .join("\n")
      .trim();

    const cleaned = (text || '{"days":[]}')
      .replace(/^```json\s*/i, "")
      .replace(/^```\s*/i, "")
      .replace(/```$/i, "")
      .trim();

    let parsed;

    try {
      parsed = JSON.parse(cleaned);
    } catch (error) {
      console.error(
        "JSON parse failed:",
        cleaned
      );

      parsed = {
        days: [],
      };
    }

    const allowedCategories = new Set([
      "ohara",
      "nezu",
    ]);

    const days = Array.isArray(parsed.days)
      ? parsed.days
          .map((day, dayIndex) => {
            const dayDate = String(
              day.date || ""
            ).slice(0, 10);

            const events = Array.isArray(day.events)
              ? day.events
                  .slice(0, 6)
                  .map((e, i) => ({
                    id: `ai-${dayDate}-${dayIndex}-${i}`,

                    date: dayDate,

                    name: String(
                      e.name || ""
                    ).slice(0, 120),

                    time: String(
                      e.time || ""
                    ).slice(0, 60),

                    venue: String(
                      e.venue || ""
                    ).slice(0, 100),

                    category: allowedCategories.has(
                      e.category
                    )
                      ? e.category
                      : "ohara",

                    impactScore: Math.max(
                      0,
                      Math.min(
                        3,
                        Number(e.impactScore) || 0
                      )
                    ),

                    description: String(
                      e.description || ""
                    ).slice(0, 180),

                    sourceName: String(
                      e.sourceName || ""
                    ).slice(0, 100),
                  }))
                  .filter((e) => e.name)
              : [];

            return {
              date: dayDate,
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

    const events = days.flatMap(
      (day) => day.events
    );

    return res.status(200).json({
      startDate: date,
      endDate,
      area: "小原流会館・根津美術館",
      days,
      events,
    });

  } catch (error) {
    console.error(
      "Public event search error:",
      error
    );

    return res.status(500).json({
      error: "Public event search failed",
    });
  }
}