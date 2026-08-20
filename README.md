# 来店予測ダッシュボード

スマレジ実績・曜日傾向・団体予約・周辺公開イベントを使って来店人数を予測する Vite / React ダッシュボードです。

## 起動

```bash
npm install
npm run dev
```

## 団体予約

予測日を選び、団体名・時間・人数だけを登録します。登録人数は当日の予測来客数へ直接加算されます。

## AI周辺情報

手動登録はありません。Vercel の `/api/public-events` が OpenAI Responses API の Web Search を使って公開情報を検索します。

Vercel の Environment Variables に以下を設定してください。

```text
OPENAI_API_KEY=...
```

APIキー未設定でも、CSV取込・予測・団体予約機能は動作します。

## CSV

`日付`、`純売上`（または `売上`）、`客数`（または `来客数`）を含むCSVを読み込めます。
