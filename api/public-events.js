function iso(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function classifyWeather(code, rain) {
  if (code >= 95) {
    return "storm";
  }

  if (
    code === 65 ||
    code === 67 ||
    code === 82 ||
    Number(rain) >= 20
  ) {
    return "heavy_rain";
  }

  if (
    (code >= 51 && code <= 67) ||
    (code >= 80 && code <= 82)
  ) {
    return "rain";
  }

  return "clear";
}

function weatherLabel(type) {
  if (type === "storm") {
    return "雷雨・荒天";
  }

  if (type === "heavy_rain") {
    return "強い雨";
  }

  if (type === "rain") {
    return "雨";
  }

  return "晴れ・曇り";
}

export default async function handler(req, res) {
  res.setHeader(
  "Cache-Control",
  "no-store, no-cache, must-revalidate"
);
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

    /*
     * 天気APIが対応範囲外などで失敗しても
     * 来客予測全体を止めない。
     */
    if (!weatherRes.ok) {
      const detail = await weatherRes.text();

      console.warn(
        "Weather API unavailable:",
        weatherRes.status,
        detail
      );

      return res.status(200).json({
        startDate: date,
        endDate,
        weather: [],
        weatherAvailable: false,
      });
    }

    const data = await weatherRes.json();

    const times = Array.isArray(data.daily?.time)
      ? data.daily.time
      : [];

    const codes = Array.isArray(data.daily?.weather_code)
      ? data.daily.weather_code
      : [];

    const rain = Array.isArray(data.daily?.precipitation_sum)
      ? data.daily.precipitation_sum
      : [];

    const probability = Array.isArray(
      data.daily?.precipitation_probability_max
    )
      ? data.daily.precipitation_probability_max
      : [];

    const weather = times.map((day, index) => {
      const code = Number(codes[index]);
      const rainAmount = Number(rain[index]) || 0;

      const type = classifyWeather(
        code,
        rainAmount
      );

      return {
        date: String(day).slice(0, 10),

        weather: type,

        weatherSummary: weatherLabel(type),

        precipitationMm: rainAmount,

        precipitationProbability:
          Number(probability[index]) || 0,
      };
    });

    return res.status(200).json({
      startDate: date,
      endDate,
      weather,
      weatherAvailable: true,
    });

  } catch (error) {
    /*
     * 通信エラー等でもアプリ全体は止めない
     */
    console.warn(
      "Weather fetch failed:",
      error
    );

    return res.status(200).json({
      startDate: date,
      endDate,
      weather: [],
      weatherAvailable: false,
    });
  }
}