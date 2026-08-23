function iso(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function classifyWeather(code, rain) {
  // 雷雨
  if (code >= 95) {
    return "storm";
  }

  // 強い雨
  if (
    code === 65 ||
    code === 67 ||
    code === 82 ||
    Number(rain) >= 20
  ) {
    return "heavy_rain";
  }

  // 雨・霧雨・にわか雨
  if (
    (code >= 51 && code <= 67) ||
    (code >= 80 && code <= 82)
  ) {
    return "rain";
  }

  return "clear";
}

function weatherLabel(type) {
  if (type === "storm") return "雷雨・荒天";
  if (type === "heavy_rain") return "強い雨";
  if (type === "rain") return "雨";
  return "晴れ・曇り";
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

  const start = new Date(`${date}T12:00:00+09:00`);

  if (Number.isNaN(start.getTime())) {
    return res.status(400).json({
      error: "invalid date",
    });
  }

  const end = new Date(start);
  end.setDate(end.getDate() + 6);

  const endDate = iso(end);

  try {
    // 南青山周辺
    const latitude = 35.663;
    const longitude = 139.716;

    const url =
      "https://api.open-meteo.com/v1/forecast" +
      `?latitude=${latitude}` +
      `&longitude=${longitude}` +
      `&daily=weather_code,precipitation_sum,precipitation_probability_max` +
      `&timezone=Asia%2FTokyo` +
      `&start_date=${date}` +
      `&end_date=${endDate}`;

    const weatherRes = await fetch(url);

    if (!weatherRes.ok) {
      const detail = await weatherRes.text();

      console.error(
        "Weather API error:",
        weatherRes.status,
        detail
      );

      return res.status(502).json({
        error: "Weather request failed",
      });
    }

    const data = await weatherRes.json();

    const times = data.daily?.time || [];
    const codes = data.daily?.weather_code || [];
    const rain = data.daily?.precipitation_sum || [];
    const probability =
      data.daily?.precipitation_probability_max || [];

    const weather = times.map((day, index) => {
      const type = classifyWeather(
        Number(codes[index]),
        Number(rain[index])
      );

      return {
        date: day,

        weather: type,

        weatherSummary: weatherLabel(type),

        precipitationMm:
          Number(rain[index]) || 0,

        precipitationProbability:
          Number(probability[index]) || 0,
      };
    });

    return res.status(200).json({
      startDate: date,
      endDate,
      weather,
    });
  } catch (error) {
    console.error(
      "Weather fetch error:",
      error
    );

    return res.status(500).json({
      error: "Weather fetch failed",
    });
  }
}