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
東京都港区南青山・表参道周辺で、
飲食店の来客人数に影響しそうな公開情報をWeb検索してください。

対象期間:
${date} 〜 ${endDate}

【検索対象エリア】

特に次の地域を優先してください。

・南青山5丁目
・南青山6丁目
・北青山3丁目
・神宮前4丁目
・神宮前5丁目
・神宮前6丁目
・表参道駅周辺
・青山通り周辺

厳密な距離計算は不要です。

南青山5-4-41の店舗から徒歩圏・近隣と考えられる
南青山、表参道、青山周辺の情報を対象にしてください。

【探す情報】

来客人数に影響しそうな公開情報を幅広く探してください。

例:

・美術館の企画展、特別展、展示
・ギャラリーの展示
・会館、ホールの催事やイベント
・学校の公開行事
・商業施設の催事
・ポップアップ
・マーケット
・展示会
・講演会
・ファッション関連イベント
・文化イベント
・地域イベント
・施設の休館
・その他、人流が増減しそうな公開情報

小原流会館、根津美術館、青南小学校など、
このエリアにある施設の公開情報も検索対象です。

【重要】

・対象期間内の情報だけ
・開催日が確認できるものだけ
・推測は禁止
・公式サイト、施設公式サイト、自治体などを優先
・同じ情報を重複登録しない
・小規模すぎて飲食店の来客にほぼ影響しないものは不要
・情報が少ない場合でも、検索を1施設だけで終わらせず、
  南青山・表参道周辺の複数施設を確認する
・7日間合計最大10件

impactScore:

0 = ほぼ影響なし
1 = 小
2 = 中
3 = 大

category:

museum
gallery
hall
school
commercial
event
closed
other

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
          "category": "event",
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

          max_output_tokens: 1200,
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
      "museum",
      "gallery",
      "hall",
      "school",
      "commercial",
      "event",
      "closed",
      "other",
    ]);

    const days = Array.isArray(parsed.days)
      ? parsed.days
          .map((day, dayIndex) => {
            const dayDate = String(
              day.date || ""
            ).slice(0, 10);

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

                    category: allowedCategories.has(
                      e.category
                    )
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

    const events = days.flatMap(
      (day) => day.events
    );

    return res.status(200).json({
      startDate: date,
      endDate,
      area: "東京都港区南青山5-4-41から約1km以内",
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