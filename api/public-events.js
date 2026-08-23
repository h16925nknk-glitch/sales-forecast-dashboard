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
東京都港区南青山にある飲食店の来客予測に使用するため、
対象期間中の公開情報をWeb検索してください。

対象期間:
${date} 〜 ${endDate}

調査対象は次の4種類です。

【1. 小原流会館】

対象期間中の、

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

【3. 港区立青南小学校】

公開情報として確認できる対象期間中の、

・保護者会
・運動会
・学校公開
・説明会
・保護者が来校する行事
・その他、来校者が増える学校行事

を確認してください。

公開情報で確認できない場合は追加しないでください。
推測は禁止です。

category:
seinan_school

【4. 南青山・表参道周辺の主要イベント】

対象地域:

・南青山
・表参道
・北青山
・外苑前
・神宮前の表参道周辺

対象となる情報:

・大規模または集客力のあるイベント
・商業施設の主要催事
・展示会
・マーケット
・ポップアップ
・ファッションイベント
・文化イベント
・ホールや会館の主要イベント
・その他、周辺の人流に影響しそうな催し

小規模なイベントを大量に拾う必要はありません。

飲食店の来客数に影響する可能性があるものを優先し、
このカテゴリは7日間合計で最大5件までにしてください。

category:
local_event

【重要ルール】

・対象期間内の情報だけ
・開催日が確認できるものだけ
・推測は禁止
・同じイベントを重複登録しない
・公式サイト、自治体、施設公式情報を優先
・小規模すぎて人流への影響がほぼないものは不要
・情報が存在しないカテゴリは空で構わない
・7日間全体で最大12件程度
・複数日にわたる企画展やイベントは、
  対象期間内の各開催日に登録してください

impactScore:

0 = ほぼ影響なし
1 = 小
2 = 中
3 = 大

小原流会館、根津美術館、青南小学校については、
特にランチ来客への影響を考慮してください。
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

          text: {
            format: {
              type: "json_schema",
              name: "public_events",
              strict: true,

              schema: {
                type: "object",
                additionalProperties: false,

                properties: {
                  days: {
                    type: "array",

                    items: {
                      type: "object",
                      additionalProperties: false,

                      properties: {
                        date: {
                          type: "string",
                        },

                        events: {
                          type: "array",

                          items: {
                            type: "object",
                            additionalProperties: false,

                            properties: {
                              name: {
                                type: "string",
                              },

                              time: {
                                type: "string",
                              },

                              venue: {
                                type: "string",
                              },

                              category: {
                                type: "string",
                                enum: [
                                  "ohara",
                                  "nezu",
                                  "seinan_school",
                                  "local_event",
                                ],
                              },

                              impactScore: {
                                type: "integer",
                                minimum: 0,
                                maximum: 3,
                              },

                              description: {
                                type: "string",
                              },

                              sourceName: {
                                type: "string",
                              },
                            },

                            required: [
                              "name",
                              "time",
                              "venue",
                              "category",
                              "impactScore",
                              "description",
                              "sourceName",
                            ],
                          },
                        },
                      },

                      required: [
                        "date",
                        "events",
                      ],
                    },
                  },
                },

                required: [
                  "days",
                ],
              },
            },
          },

          max_output_tokens: 1800,
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
        detail,
      });
    }

    const response = await apiRes.json();

    const text = (response.output || [])
      .filter((item) => item.type === "message")
      .flatMap((item) => item.content || [])
      .filter((item) => item.type === "output_text")
      .map((item) => item.text || "")
      .join("")
      .trim();

    if (!text) {
      console.error(
        "OpenAI returned no output text:",
        JSON.stringify(response)
      );

      return res.status(502).json({
        error: "OpenAI returned empty response",
      });
    }

    let parsed;

    try {
      parsed = JSON.parse(text);
    } catch (error) {
      console.error(
        "Structured JSON parse failed:",
        text
      );

      return res.status(502).json({
        error: "Structured output parse failed",
      });
    }

    const allowedCategories = new Set([
      "ohara",
      "nezu",
      "seinan_school",
      "local_event",
    ]);

    const days = Array.isArray(parsed.days)
      ? parsed.days
          .map((day, dayIndex) => {
            const dayDate = String(
              day.date || ""
            ).slice(0, 10);

            const events = Array.isArray(day.events)
              ? day.events.map((e, i) => ({
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
                    : "local_event",

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

    const seen = new Set();

    const events = days
      .flatMap((day) => day.events)
      .filter((event) => {
        const key = [
          event.date,
          event.name,
          event.venue,
        ]
          .join("|")
          .toLowerCase();

        if (seen.has(key)) {
          return false;
        }

        seen.add(key);
        return true;
      });

    const cleanedDays = [];

    for (
      let d = new Date(start);
      d <= end;
      d.setDate(d.getDate() + 1)
    ) {
      const dayDate = iso(d);

      cleanedDays.push({
        date: dayDate,

        events: events.filter(
          (event) => event.date === dayDate
        ),
      });
    }

    console.log(
      "Public events found:",
      events.length
    );

    return res.status(200).json({
      startDate: date,
      endDate,
      area:
        "小原流会館・根津美術館・青南小学校・南青山表参道周辺",
      days: cleanedDays,
      events,
    });

  } catch (error) {
    console.error(
      "Public event search error:",
      error
    );

    return res.status(500).json({
      error: "Public event search failed",
      message: String(
        error?.message || error
      ),
    });
  }
}