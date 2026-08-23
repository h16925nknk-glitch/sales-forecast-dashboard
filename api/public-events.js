function iso(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getRetryDelayMs(detail) {
  const text = String(detail || "");

  // 例: "Please try again in 7.906s"
  const secondsMatch = text.match(
    /try again in\s+([\d.]+)s/i
  );

  if (secondsMatch) {
    const seconds = Number(secondsMatch[1]);

    if (Number.isFinite(seconds)) {
      return Math.ceil(seconds * 1000) + 2000;
    }
  }

  // 例: "Please try again in 800ms"
  const msMatch = text.match(
    /try again in\s+([\d.]+)ms/i
  );

  if (msMatch) {
    const ms = Number(msMatch[1]);

    if (Number.isFinite(ms)) {
      return Math.ceil(ms) + 2000;
    }
  }

  // 待ち時間が取れない場合
  return 15000;
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
次の2施設だけについて公開情報をWeb検索してください。

対象期間:
${date} 〜 ${endDate}

【小原流会館】

対象期間中の、
・展示
・催事
・イベント
・一般来場者が増える催し

category は "ohara"

【根津美術館】

対象期間中の、
・特別展
・企画展
・展示
・イベント
・休館情報

category は "nezu"

重要:
・この2施設以外は検索しない
・対象期間内だけ
・日付を確認できる情報だけ
・推測禁止
・公式情報を優先
・同じイベントを重複させない
・細かい情報を大量に集める必要はない
・来客予測に影響しそうな主要情報だけ
・7日間合計で最大4件程度
・該当情報がなければ空でよい

impactScore:
0 = ほぼ影響なし
1 = 小
2 = 中
3 = 大

複数日にわたる展示については、
対象期間内の開催日に反映してください。
`.trim();

  async function makeOpenAIRequest() {
    return fetch(
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
                          maxItems: 4,

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

          max_output_tokens: 1200,
        }),
      }
    );
  }

  try {
    let apiRes = null;

    /*
     * 最大3回。
     * 429ならOpenAIが指定した時間を待って再試行。
     */
    for (let attempt = 1; attempt <= 3; attempt++) {
      apiRes = await makeOpenAIRequest();

      if (apiRes.ok) {
        break;
      }

      const detail = await apiRes.text();

      console.error(
        `OpenAI API error attempt ${attempt}:`,
        apiRes.status,
        detail
      );

      if (apiRes.status !== 429) {
        return res.status(apiRes.status).json({
          error: "OpenAI request failed",
          status: apiRes.status,
        });
      }

      if (attempt === 3) {
        return res.status(429).json({
          error: "OpenAI rate limit exceeded",
          status: 429,
        });
      }

      const waitMs = getRetryDelayMs(detail);

      console.log(
        `Rate limit hit. Waiting ${waitMs}ms before retry.`
      );

      await sleep(waitMs);
    }

    if (!apiRes || !apiRes.ok) {
      return res.status(502).json({
        error: "OpenAI request failed",
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
    ]);

    const days = Array.isArray(parsed.days)
      ? parsed.days
          .map((day, dayIndex) => {
            const dayDate = String(
              day.date || ""
            ).slice(0, 10);

            const events = Array.isArray(day.events)
              ? day.events
                  .slice(0, 4)
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