function iso(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({
      error: "Method not allowed",
    });
  }

  const {
    date,
    area = "東京都港区南青山・表参道周辺",
  } = req.query;

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
東京都港区南青山の飲食店向けに、
${date} 〜 ${endDate} の公開イベント情報をWeb検索してください。

調査対象は次の5種類だけです。

1. 小原流会館
対象期間中の展示・催事・イベント・講習会など。

2. 根津美術館
対象期間中の特別展・企画展・展示・イベント・休館情報。

3. 港区立青南小学校
公開情報で確認できる
保護者会・運動会・学校公開・説明会・父兄が集まる行事。
公開情報がなければ無理に追加しないこと。

4. 選挙
対象期間に投票日がある主要選挙。
衆院選、参院選、東京都知事選、東京都議選、
港区長選、港区議選など。

5. 大規模な祭り・花火大会
港区または東京都心で開催され、
南青山周辺の人流や飲食需要に影響しそうな
大規模な祭り・花火大会。

距離だけを理由に除外しないこと。

例:
麻布十番納涼まつり級のイベントは必ず確認対象に含める。

重要:
・対象期間外は入れない
・開催日不明のものは入れない
・推測は禁止
・重複禁止
・公式サイト、自治体、施設公式情報を優先
・7日間合計最大10件

impactScore:
0 = ほぼ影響なし
1 = 小
2 = 中
3 = 大

category:
ohara
nezu
seinan_school
election
festival
fireworks
other

JSONだけ返してください。

{
  "days": [
    {
      "date": "YYYY-MM-DD",
      "events": [
        {
          "name": "イベント名",
          "time": "",
          "venue": "",
          "category": "festival",
          "impactScore": 2,
          "description": "来客への影響理由",
          "sourceName": "情報元"
        }
      ]
    }
  ]
}
`.trim();

  async function callOpenAI() {
    return fetch("https://api.openai.com/v1/responses", {
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

        max_output_tokens: 1200,
      }),
    });
  }

  try {
    let apiRes = await callOpenAI();

    if (apiRes.status === 429) {
      const firstError = await apiRes.text();

      console.warn(
        "OpenAI rate limit hit. Retrying once:",
        firstError
      );

      await sleep(10000);

      apiRes = await callOpenAI();
    }

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
      console.error("JSON parse failed:", cleaned);

      parsed = {
        days: [],
      };
    }

    const allowedCategories = new Set([
      "ohara",
      "nezu",
      "seinan_school",
      "election",
      "festival",
      "fireworks",
      "other",
    ]);

    const days = Array.isArray(parsed.days)
      ? parsed.days
          .map((day, dayIndex) => {
            const dayDate = String(day.date || "").slice(0, 10);

            const events = Array.isArray(day.events)
              ? day.events
                  .slice(0, 10)
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

                    category: allowedCategories.has(e.category)
                      ? e.category
                      : "other",

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

    const events = days.flatMap((day) => day.events);

    return res.status(200).json({
      startDate: date,
      endDate,
      area,
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