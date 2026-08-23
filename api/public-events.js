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
東京都港区南青山の飲食店の来客予測に使用するため、
次の2施設についてWeb検索してください。

対象期間:
${date} 〜 ${endDate}

【小原流会館】

対象期間中の、

・展示
・催事
・イベント
・講習会
・大会
・一般来場者が増える催し

を確認してください。

category は "ohara"。

【根津美術館】

対象期間中の、

・特別展
・企画展
・展示
・イベント
・休館情報

を確認してください。

category は "nezu"。

【重要】

・この2施設以外の情報は不要
・対象期間外の情報は入れない
・開催日が確認できるものだけ
・推測は禁止
・公式サイト、施設公式情報を優先
・同じイベントを重複登録しない
・該当情報がなければ無理に作らない

impactScore:

0 = ほぼ影響なし
1 = 小
2 = 中
3 = 大

小原流会館または根津美術館で
一般来場者が増える催しがある場合、
南青山の飲食店のランチ来客への影響を考慮してください。

複数日にわたる展示の場合は、
対象期間内の各開催日について日付ごとに登録してください。
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

          /*
           * ここが今回の重要な変更。
           *
           * 「JSONで返して」と文章で頼むだけではなく、
           * API側でJSON Schemaを強制する。
           */
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

          max_output_tokens: 1600,
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

    /*
     * OpenAIが返したoutput_textだけ取り出す。
     */
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

    /*
     * Structured Outputsなので、
     * ここでは正常なら必ずJSONとして解析できる。
     */
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

                  category:
                    e.category === "nezu"
                      ? "nezu"
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
              : [];

            return {
              date: dayDate,
              events,
            };
          })

          /*
           * 対象期間外の日付を除外
           */
          .filter(
            (day) =>
              /^\d{4}-\d{2}-\d{2}$/.test(day.date) &&
              day.date >= date &&
              day.date <= endDate
          )
      : [];

    /*
     * 重複除去
     */
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

    /*
     * days側も重複除去後のeventsに合わせる
     */
    const cleanedDays = days.map((day) => ({
      date: day.date,

      events: events.filter(
        (event) => event.date === day.date
      ),
    }));

    console.log(
      "Public events found:",
      events.length
    );

    return res.status(200).json({
      startDate: date,
      endDate,
      area: "小原流会館・根津美術館",
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